"""Turn raw Blender renders into a finished stimulus set for the app.

    python tools/build_set.py RAW_DIR [RAW_DIR ...] OUT_DIR

Steps:
  1. size: each object is zoomed so that its projected area (mean over views) matches a common target,
     as far as it still fits inside the flat part of the picture's soft-edged window;
  2. pair: base objects are paired within their family with the most similar partner on area, edge
     density and elongation; half of each family goes to the image-novelty test, half to object-novelty;
  3. noise + matching: every picture is put on its own sample of low-contrast 1/f noise, then all
     pictures of a pair are equalised together on gray-level histogram and spatial-frequency amplitude;
  4. forms: two fixed trial sequences (A, B) that differ only in which object of each pair is the
     familiar one. Everyone given the same form sees exactly the same trials in the same order.
Writes greyscale JPEGs, three tileable noise images for the screen background, and set.json.
"""
import json
import os
import random
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import image_stats as ist  # noqa: E402
import shine_match as sm  # noqa: E402

PATCH = 384          # picture size in pixels
NOISE_SD = 4.0       # background noise contrast in gray levels (about 1.6% RMS); lowest level without matching halos
OBJ_SD = 30.0        # object contrast before matching
TARGET_AREA = 0.11   # object area as a fraction of the picture
FLAT = 0.78          # objects must stay within this fraction of the half-width (the window is flat out to 0.8)
BG = 128.0


def load_views(folder, obj):
    return {v: np.asarray(Image.open(os.path.join(folder, f)).convert("RGBA"), dtype=np.float64) for v, f in obj["files"].items()}


def zoom_for(views):
    areas, reach = [], []
    for a in views.values():
        m = a[..., 3] > 127
        n = a.shape[0]
        ys, xs = np.nonzero(m)
        areas.append(m.mean())
        reach.append(np.hypot(xs - n / 2, ys - n / 2).max() / (n / 2))
    z = np.sqrt(TARGET_AREA / np.mean(areas))
    return float(min(z, FLAT / max(reach))), float(np.mean(areas))


def place(a, z):
    """RGBA render -> (object luminance, alpha) at PATCH size, zoomed by z about the centre."""
    n = a.shape[0]
    s = max(8, int(round(PATCH * z)))
    im = Image.fromarray(a.astype(np.uint8), "RGBA").resize((s, s), Image.LANCZOS)
    canvas = Image.new("RGBA", (PATCH, PATCH), (0, 0, 0, 0))
    canvas.paste(im, ((PATCH - s) // 2, (PATCH - s) // 2))
    c = np.asarray(canvas, dtype=np.float64)
    return c[..., 0], c[..., 3] / 255.0


def on_noise(lum, alpha, rng):
    m = alpha > 0.5
    obj = BG + (lum - lum[m].mean()) * (OBJ_SD / lum[m].std())
    return np.clip(alpha * obj + (1 - alpha) * sm.pink_noise(PATCH, rng, sd=NOISE_SD), 0, 255)


def save(g, path):
    Image.fromarray(np.clip(g, 0, 255).round().astype(np.uint8), "L").save(path, quality=95)


def greedy_pairs(names, feats):
    """Pair each object with its most similar unused partner (z-scored features)."""
    X = np.array([feats[n] for n in names])
    X = (X - X.mean(0)) / (X.std(0) + 1e-9)
    left, pairs = list(range(len(names))), []
    while len(left) > 1:
        i = left.pop(0)
        j = min(left, key=lambda k: np.linalg.norm(X[i] - X[k]))
        left.remove(j)
        pairs.append((names[i], names[j]))
    return pairs


def side_sequence(n, rng):
    """Balanced left/right sequence with no more than three in a row."""
    while True:
        seq = ["L", "R"] * (n // 2)
        rng.shuffle(seq)
        if all(len(set(seq[i:i + 4])) > 1 for i in range(n - 3)):
            return seq


def main():
    raws, out = sys.argv[1:-1], sys.argv[-1]
    os.makedirs(out, exist_ok=True)
    for old in os.listdir(out):
        os.remove(os.path.join(out, old))
    man = json.load(open(os.path.join(raws[0], "manifest.json")))
    for o in man["objects"]:
        o["folder"] = raws[0]
    for extra in raws[1:]:
        more = json.load(open(os.path.join(extra, "manifest.json")))
        for o in more["objects"]:
            o["folder"] = extra
        man["objects"] += more["objects"]
    views = [str(v) for v in man["views"]]
    front = str(min(man["views"], key=abs))
    side_views = [v for v in views if v != front][:2]
    rng = np.random.default_rng(man["seed"])
    bases = [o for o in man["objects"] if o["level"] == 0]

    # 1. size
    objs = {}
    for o in bases:
        vs = load_views(o["folder"], o)
        z, area = zoom_for(vs)
        placed = {v: place(a, z) for v, a in vs.items()}
        lum, alpha = placed[front]
        g = on_noise(lum, alpha, np.random.default_rng(0))
        st = ist.image_stats(g, alpha > 0.5)
        objs[o["name"]] = {"family": o["family"], "base": o["base"], "zoom": z, "placed": placed, "stats": st}
    areas = np.array([o["stats"]["area_frac"] for o in objs.values()])
    print(f"{len(objs)} base objects; area after sizing: mean {areas.mean():.3f}, SD {areas.std():.3f} (CV {100 * areas.std() / areas.mean():.0f}%)")

    # 2. pair, within family and within test
    tests = {"image_novelty": [], "object_novelty": []}
    for fam in sorted({o["family"] for o in objs.values()}):
        names = sorted(n for n, o in objs.items() if o["family"] == fam)
        half = len(names) // 2
        feats = {n: [np.log(objs[n]["stats"]["area_frac"]), np.log(objs[n]["stats"]["edge_density"]), objs[n]["stats"]["elongation"]] for n in names}
        tests["image_novelty"] += greedy_pairs(names[:half], feats)
        tests["object_novelty"] += greedy_pairs(names[half:], feats)

    # 3. noise + matching, 4. forms
    order_rng = random.Random(man["seed"])
    forms = {"A": {}, "B": {}}
    pair_rows = []
    for test, pairs in tests.items():
        order_rng.shuffle(pairs)
        sides = side_sequence(len(pairs), order_rng)
        for form in forms:
            forms[form][test] = []
        for k, (x, y) in enumerate(pairs):
            pid = f"{test[:3]}{k + 1:02d}"
            px, py = objs[x]["placed"], objs[y]["placed"]
            if test == "image_novelty":
                keys = [(x, front, 1), (x, front, 2), (y, front, 1), (y, front, 2)]
            else:
                keys = [(o, v, 1) for o in (x, y) for v in views]
            before = [on_noise(*objs[o]["placed"][v], rng) for o, v, _ in keys]
            sb, hb = sm.mismatch(before)
            after = sm.shine(before)
            sa, ha = sm.mismatch(after)
            files = {}
            for (o, v, ver), g in zip(keys, after):
                fn = f"{pid}_{objs[o]['base']}_az{int(v):+04d}_n{ver}.jpg"
                save(g, os.path.join(out, fn))
                files[(o, v, ver)] = fn
            gx, gy = after[keys.index((x, front, 1))], after[keys.index((y, front, 1))]
            row = {
                "pair": pid, "test": test, "x": objs[x]["base"], "y": objs[y]["base"], "family": objs[x]["family"],
                "area_ratio": objs[x]["stats"]["area_frac"] / objs[y]["stats"]["area_frac"],
                "pixel_rms_diff": float(np.sqrt(((gx - gy) ** 2).mean())),
                "sal_share_x_spectral": ist.share_on_a(gx, gy, ist.sal_spectral_residual),
                "sal_share_x_itti": ist.share_on_a(gx, gy, ist.sal_itti),
                "spectrum_mismatch_before": sb, "spectrum_mismatch_after": sa, "gray_mismatch_before": hb, "gray_mismatch_after": ha,
            }
            pair_rows.append(row)
            for form, (fam_o, nov_o) in (("A", (x, y)), ("B", (y, x))):
                t = {"pair": pid, "family": row["family"], "familiar": objs[fam_o]["base"], "novel": objs[nov_o]["base"], "novel_side": sides[k]}
                if test == "image_novelty":
                    t.update(study=[files[(fam_o, front, 1)]] * 2, test_familiar=files[(fam_o, front, 2)], test_novel=files[(nov_o, front, 1)])
                else:
                    t.update(study=[files[(fam_o, side_views[0], 1)], files[(fam_o, side_views[1], 1)]],
                             test_familiar=files[(fam_o, front, 1)], test_novel=files[(nov_o, front, 1)])
                forms[form][test].append(t)

    tiles = []
    for i in range(3):
        fn = f"noise_tile_{i + 1}.png"
        save(sm.pink_noise(1024, rng, sd=NOISE_SD), os.path.join(out, fn))
        tiles.append(fn)

    spec = {
        "name": os.path.basename(os.path.normpath(out)), "patch_px": PATCH, "window": {"flat": 0.8, "edge": 1.0},
        "noise": {"sd_gray_levels": NOISE_SD, "tile_px": 1024, "tiles": tiles}, "object_contrast_sd": OBJ_SD,
        "views_deg": man["views"], "generator_seed": man["seed"], "forms": forms, "pairs": pair_rows,
        "objects": {o["base"]: {"family": o["family"], "zoom": o["zoom"], **{k: round(v, 4) for k, v in o["stats"].items()}} for o in objs.values()},
    }
    with open(os.path.join(out, "set.json"), "w") as f:
        json.dump(spec, f, indent=1)

    n_img = len([f for f in os.listdir(out) if f.endswith(".jpg")])
    mb = sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out)) / 1e6
    dev = lambda k: np.mean([abs(r[k] - 0.5) for r in pair_rows])
    print(f"{len(pair_rows)} pairs, {n_img} pictures, {mb:.1f} MB")
    print(f"mean |salience share - 0.5|: spectral {dev('sal_share_x_spectral'):.3f}, itti {dev('sal_share_x_itti'):.3f}; worst itti {max(abs(r['sal_share_x_itti'] - 0.5) for r in pair_rows):.3f}")
    print(f"mean area difference within pairs: {100 * (np.exp(np.mean([abs(np.log(r['area_ratio'])) for r in pair_rows])) - 1):.0f}%")
    print(f"spectrum mismatch {np.mean([r['spectrum_mismatch_before'] for r in pair_rows]):.3f} -> {np.mean([r['spectrum_mismatch_after'] for r in pair_rows]):.3f}")


if __name__ == "__main__":
    main()
