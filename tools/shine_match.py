"""Put rendered objects on a noise background and equalise low-level statistics within a set of images.

    python tools/shine_match.py OUT_DIR image1.png image2.png [...]

Follows the logic of the SHINE toolbox (Willenbockel et al., 2010, Behavior Research Methods):
  * histogram matching: every image gets the same distribution of gray levels (the set average);
  * spatial-frequency matching: every image gets the same rotationally averaged Fourier amplitude
    spectrum (the set average), keeping its own phase;
  * the two are alternated for a few passes, because each slightly undoes the other.
The noise background (1/f, a fresh sample per image) fills the whole picture, so spectrum matching has
no blank region to leave ripples in and the object's outline no longer dominates the spectrum.
This is our own implementation, not the SHINE code; outputs are greyscale PNGs.
"""
import os
import sys

import numpy as np
from PIL import Image

BG = 128.0


def pink_noise(n, rng, sd=22.0, exponent=1.0):
    fy, fx = np.meshgrid(np.fft.fftfreq(n), np.fft.fftfreq(n), indexing="ij")
    f = np.hypot(fx, fy)
    f[0, 0] = 1.0
    spec = (rng.standard_normal((n, n)) + 1j * rng.standard_normal((n, n))) / f ** exponent
    spec[0, 0] = 0
    x = np.real(np.fft.ifft2(spec))
    return BG + sd * x / x.std()


def on_noise(path, rng, size=512, obj_sd=38.0):
    """Object (mean = BG, fixed contrast) composited over a fresh noise sample."""
    a = np.asarray(Image.open(path).convert("RGBA").resize((size, size), Image.LANCZOS), dtype=np.float64)
    alpha = a[..., 3] / 255.0
    lum = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    m = alpha > 0.5
    obj = BG + (lum - lum[m].mean()) * (obj_sd / lum[m].std())
    return np.clip(alpha * obj + (1 - alpha) * pink_noise(size, rng), 0, 255), alpha


def rot_avg(amp):
    n = amp.shape[0]
    yy, xx = np.indices(amp.shape)
    r = np.hypot(xx - n // 2, yy - n // 2).round().astype(int)
    prof = np.bincount(r.ravel(), np.fft.fftshift(amp).ravel()) / np.maximum(1, np.bincount(r.ravel()))
    return prof, r


def sf_match(imgs):
    specs = [np.fft.fft2(g - g.mean()) for g in imgs]
    profs = [rot_avg(np.abs(s)) for s in specs]
    target = np.mean([p for p, _ in profs], axis=0)
    out = []
    for g, s, (p, r) in zip(imgs, specs, profs):
        gain = np.fft.ifftshift((target / np.maximum(p, 1e-9))[r])
        out.append(np.real(np.fft.ifft2(s * gain)) + g.mean())
    return out


def hist_match(imgs):
    target = np.mean([np.sort(g.ravel()) for g in imgs], axis=0)
    out = []
    for g in imgs:
        flat = np.empty(g.size)
        flat[np.argsort(g.ravel(), kind="stable")] = target
        out.append(flat.reshape(g.shape))
    return out


def shine(imgs, passes=5):
    for _ in range(passes):
        imgs = hist_match(sf_match(imgs))
    return [np.clip(g, 0, 255) for g in imgs]


def mismatch(imgs):
    """Spread across images of the log amplitude profile (0 = identical spectra) and of the sorted gray levels."""
    profs = np.array([rot_avg(np.abs(np.fft.fft2(g - g.mean())))[0][1:200] for g in imgs])
    hists = np.array([np.sort(g.ravel()) for g in imgs])
    return float(np.log(profs).std(axis=0).mean()), float(hists.std(axis=0).mean())


def main():
    out, paths = sys.argv[1], sys.argv[2:]
    os.makedirs(out, exist_ok=True)
    rng = np.random.default_rng(1)
    before = [on_noise(p, rng)[0] for p in paths]
    after = shine(before)
    for p, b, a in zip(paths, before, after):
        stem = os.path.splitext(os.path.basename(p))[0]
        Image.fromarray(b.round().astype(np.uint8)).save(os.path.join(out, f"{stem}_noise.png"))
        Image.fromarray(a.round().astype(np.uint8)).save(os.path.join(out, f"{stem}_matched.png"))
    sb, hb = mismatch(before)
    sa, ha = mismatch(after)
    print(f"spectrum mismatch {sb:.3f} -> {sa:.3f} (log units); gray-level mismatch {hb:.2f} -> {ha:.2f}")


if __name__ == "__main__":
    main()
