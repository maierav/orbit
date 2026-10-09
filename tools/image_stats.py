"""Low-level image statistics and salience balance for rendered object images.

    python tools/image_stats.py renders/pilot

Reads manifest.json written by make_objects.py and writes two tables into the same folder:
  image_stats.csv  one row per image: size, shape and spectral measures AFTER the same brightness and
                   contrast equalisation the app applies (object mean = screen gray, fixed RMS contrast)
  pair_stats.csv   one row per candidate pair: how different the two images are, and what share of the
                   display's salience falls on each, for two salience models (0.5 = balanced)

Salience is computed on the display as the app shows it (two pictures at the far left and right of a
gray 16:9 screen), averaged over both left/right arrangements. Two classic models are used: spectral
residual (Hou & Zhang 2007) and a simplified Itti-Koch intensity + orientation centre-surround model.
Neither is validated for isolated objects on a blank screen, so treat the numbers as a screen for
gross imbalance, to be checked against real looking data from trials without a study phase.
"""
import csv
import itertools
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

BG, TARGET_SD = 128.0, 30.0
DISPLAY_W, DISPLAY_H = 1280, 720


def load_equalised(path, size=384):
    """Greyscale image on screen gray with object mean = BG and whole-image RMS contrast = TARGET_SD."""
    im = Image.open(path).convert("RGBA").resize((size, size), Image.LANCZOS)
    a = np.asarray(im, dtype=np.float64)
    alpha = a[..., 3] / 255.0
    lum = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    mask = alpha > 0.5
    g = np.full(lum.shape, BG)
    for _ in range(2):
        obj = lum[mask]
        k = TARGET_SD / (np.sqrt(((obj - obj.mean()) ** 2).sum() / lum.size) or 1.0)
        g[mask] = np.clip((obj - obj.mean()) * k + BG, 0, 255)
        lum = g.copy()
    return g, mask


def image_stats(g, mask):
    h, w = g.shape
    ys, xs = np.nonzero(mask)
    area = mask.mean()
    cx, cy = xs.mean() / w - 0.5, ys.mean() / h - 0.5
    cov = np.cov(np.vstack([xs, ys]))
    ev = np.sort(np.linalg.eigvalsh(cov))
    gx, gy = ndi.sobel(g, axis=1), ndi.sobel(g, axis=0)
    edge = np.hypot(gx, gy)
    perimeter = np.logical_xor(mask, ndi.binary_erosion(mask)).sum()
    # Radially averaged amplitude spectrum: share of energy above 8 cycles per image, and log-log slope.
    amp = np.abs(np.fft.fftshift(np.fft.fft2(g - BG)))
    yy, xx = np.indices(g.shape)
    r = np.hypot(xx - w / 2, yy - h / 2).astype(int)
    radial = np.bincount(r.ravel(), amp.ravel() ** 2)[1:w // 2]
    f = np.arange(1, w // 2)
    slope = np.polyfit(np.log(f[1:64]), 0.5 * np.log(radial[1:64] / np.bincount(r.ravel())[2:65]), 1)[0]
    return {
        "area_frac": area, "centroid_x": cx, "centroid_y": cy,
        "elongation": float(np.sqrt(ev[1] / ev[0])), "compactness": float(4 * np.pi * mask.sum() / perimeter ** 2),
        "edge_density": float(edge.mean()), "highsf_share": float(radial[8:].sum() / radial.sum()), "spectral_slope": float(slope),
        "obj_mean": float(g[mask].mean()), "rms_contrast": float(np.sqrt(((g - BG) ** 2).mean())),
    }


def display(left, right):
    d = np.full((DISPLAY_H, DISPLAY_W), BG)
    s = int(min(0.32 * DISPLAY_W, 0.7 * DISPLAY_H) * 0.9)
    for img, fx in ((left, 0.2), (right, 0.8)):
        im = np.asarray(Image.fromarray(img.astype(np.uint8)).resize((s, s), Image.LANCZOS), dtype=np.float64)
        x0, y0 = int(fx * DISPLAY_W - s / 2), int(DISPLAY_H / 2 - s / 2)
        d[y0:y0 + s, x0:x0 + s] = im
    return d


def sal_spectral_residual(d):
    small = np.asarray(Image.fromarray(d.astype(np.uint8)).resize((128, 72), Image.LANCZOS), dtype=np.float64)
    F = np.fft.fft2(small)
    logamp = np.log(np.abs(F) + 1e-9)
    resid = logamp - ndi.uniform_filter(logamp, 3)
    s = np.abs(np.fft.ifft2(np.exp(resid + 1j * np.angle(F)))) ** 2
    return ndi.gaussian_filter(s, 2.5)


def _normalise(m):
    m = m - m.min()
    if m.max() <= 0:
        return m
    m = m / m.max()
    return m * (1 - m.mean()) ** 2  # promotes maps with a few strong peaks, after Itti et al. (1998)


def sal_itti(d):
    small = np.asarray(Image.fromarray(d.astype(np.uint8)).resize((320, 180), Image.LANCZOS), dtype=np.float64) / 255.0
    total = np.zeros_like(small)
    cs = lambda m, c, s: np.abs(ndi.gaussian_filter(m, c) - ndi.gaussian_filter(m, s))
    inten = sum(_normalise(cs(small, c, s)) for c, s in ((1, 4), (2, 8), (4, 16)))
    total += _normalise(inten)
    orient = np.zeros_like(small)
    yy, xx = np.mgrid[-7:8, -7:8]
    for th in (0, 45, 90, 135):
        t = np.deg2rad(th)
        xr = xx * np.cos(t) + yy * np.sin(t)
        env = np.exp(-(xx ** 2 + yy ** 2) / (2 * 3.0 ** 2))
        even, odd = env * np.cos(2 * np.pi * xr / 6), env * np.sin(2 * np.pi * xr / 6)
        energy = np.hypot(ndi.convolve(small, even - even.mean()), ndi.convolve(small, odd))
        orient += sum(_normalise(cs(energy, c, s)) for c, s in ((1, 4), (2, 8)))
    total += _normalise(orient)
    return total


def share_on_a(a, b, model):
    """Share of salience on picture a, averaged over a-left and a-right arrangements."""
    out = []
    for left, right, a_left in ((a, b, True), (b, a, False)):
        s = model(display(left, right))
        l, r = s[:, : s.shape[1] // 2].sum(), s[:, s.shape[1] // 2:].sum()
        out.append((l if a_left else r) / (l + r))
    return float(np.mean(out))


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else "renders/pilot"
    man = json.load(open(os.path.join(folder, "manifest.json")))
    front = str(min(man["views"], key=abs))
    imgs, rows = {}, []
    for o in man["objects"]:
        for view, fn in o["files"].items():
            g, mask = load_equalised(os.path.join(folder, fn))
            imgs[(o["name"], view)] = g
            rows.append({"image": fn, "object": o["name"], "family": o["family"], "base": o["base"], "level": o["level"], "view": view, **image_stats(g, mask)})
    with open(os.path.join(folder, "image_stats.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    stat = {(r["object"], r["view"]): r for r in rows}

    pairs = []
    objs = man["objects"]
    for a, b in itertools.combinations(objs, 2):
        same_base = a["base"] == b["base"]
        both_bases = a["level"] == 0 and b["level"] == 0
        if not (both_bases or (same_base and 0 in (a["level"], b["level"]))):
            continue
        ga, gb = imgs[(a["name"], front)], imgs[(b["name"], front)]
        sa, sb = stat[(a["name"], front)], stat[(b["name"], front)]
        pairs.append({
            "a": a["name"], "b": b["name"],
            "kind": "same base" if same_base else ("same family" if a["family"] == b["family"] else "different family"),
            "level": abs(a["level"] - b["level"]) if same_base else "",
            "pixel_rms_diff": float(np.sqrt(((ga - gb) ** 2).mean())),
            "area_ratio": sa["area_frac"] / sb["area_frac"], "edge_ratio": sa["edge_density"] / sb["edge_density"],
            "sal_share_a_spectral": share_on_a(ga, gb, sal_spectral_residual),
            "sal_share_a_itti": share_on_a(ga, gb, sal_itti),
        })
    with open(os.path.join(folder, "pair_stats.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(pairs[0]))
        w.writeheader()
        w.writerows(pairs)

    print(f"{len(rows)} images, {len(pairs)} pairs")
    for kind in ("same base", "same family", "different family"):
        sel = [p for p in pairs if p["kind"] == kind]
        if not sel:
            continue
        dev = lambda k: np.mean([abs(p[k] - 0.5) for p in sel])
        ar = np.mean([abs(np.log(p["area_ratio"])) for p in sel])
        print(f"{kind:17s} n={len(sel):3d}  mean |salience share - 0.5|: spectral {dev('sal_share_a_spectral'):.3f}, itti {dev('sal_share_a_itti'):.3f};"
              f"  mean area difference {100 * (np.exp(ar) - 1):.0f}%;  pixel RMS diff {np.mean([p['pixel_rms_diff'] for p in sel]):.1f}")
    for lv in sorted({p["level"] for p in pairs if p["level"] != ""}):
        sel = [p for p in pairs if p["level"] == lv]
        print(f"  same base, level {lv}: pixel RMS diff {np.mean([p['pixel_rms_diff'] for p in sel]):.1f}, |salience share - 0.5| itti {np.mean([abs(p['sal_share_a_itti'] - 0.5) for p in sel]):.3f}")


if __name__ == "__main__":
    main()
