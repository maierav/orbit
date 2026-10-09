"""Build the graded object-novelty set from raw Blender renders.

    python tools/build_graded.py RAW_DIR OUT_DIR

Each trial shows two views of one object, then that object beside a comparison object:
  * graded trials: the comparison is a VARIANT of the same base object, 5-40% of the way along its
    variant line, so the two differ by a controlled amount;
  * easy trials: the comparison is a different base object of the same family (each person's ceiling).
Two conditions separate object recognition from image similarity:
  * standard: study views -30 and +30; test shows both objects from the front (0);
  * opposed:  study views -30 and 0; test shows the new object from the front, a studied viewpoint, and
    the familiar object from +30, a new viewpoint. Image similarity to what was studied then favours
    looking at the FAMILIAR object, object recognition favours the new one.
Trials come in balanced blocks of ten (four levels x two conditions, plus two easy trials), in a fixed
order. Forms A and B differ only in which object of each pair is the familiar one.
"""
import json
import os
import random
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_set as bs  # noqa: E402
import image_stats as ist  # noqa: E402
import shine_match as sm  # noqa: E402


def main():
    raw, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for old in os.listdir(out):
        os.remove(os.path.join(out, old))
    man = json.load(open(os.path.join(raw, "manifest.json")))
    views = sorted(man["views"])
    lo, front, hi = [str(v) for v in views]
    rng = np.random.default_rng(man["seed"] + 2)
    order_rng = random.Random(man["seed"] + 2)

    by_base = {}
    for o in man["objects"]:
        by_base.setdefault(o["base"], []).append(o)

    # Size every object by its base, so a variant keeps its natural size relative to the base.
    placed, zoom = {}, {}
    for base, objs in by_base.items():
        b0 = next(o for o in objs if o["level"] == 0)
        z, _ = bs.zoom_for(bs.load_views(raw, b0))
        zoom[base] = z
        for o in objs:
            placed[o["name"]] = {v: bs.place(a, z * 0.97) for v, a in bs.load_views(raw, o).items()}

    # Pairs: (familiar-in-form-A, comparison, level, family)
    graded, plain = [], {}
    for base, objs in sorted(by_base.items()):
        b0 = next(o for o in objs if o["level"] == 0)
        var = [o for o in objs if o["level"] > 0]
        if var:
            graded.append((b0, var[0], var[0]["level"], b0["family"]))
        else:
            plain.setdefault(b0["family"], []).append(b0)
    easy = []
    for fam, objs in sorted(plain.items()):
        for i in range(0, len(objs) - 1, 2):
            easy.append((objs[i], objs[i + 1], "easy", fam))

    # Balanced blocks of ten: each level in both conditions, plus one easy trial per condition. Family
    # alternates between the two conditions from block to block, so over the whole test every level and
    # condition has the same number of objects from each family.
    levels = sorted({g[2] for g in graded})
    fams = sorted({g[3] for g in graded})
    pool = {(lv, fam): [g for g in graded if g[2] == lv and g[3] == fam] for lv in levels for fam in fams}
    pool.update({("easy", fam): [e for e in easy if e[3] == fam] for fam in fams})
    for items in pool.values():
        order_rng.shuffle(items)
    n_blocks = min(len(v) for v in pool.values())
    trials = []
    for b in range(n_blocks):
        block = []
        for i, lv in enumerate(levels + ["easy"]):
            f_std = fams[(b + i) % len(fams)]
            f_opp = fams[(b + i + 1) % len(fams)]
            block.append((pool[(lv, f_std)].pop(), "standard"))
            block.append((pool[(lv, f_opp)].pop(), "opposed"))
        order_rng.shuffle(block)
        trials += block
    # Sides: balanced within each condition, never more than three in a row.
    while True:
        sides = [None] * len(trials)
        for cond in ("standard", "opposed"):
            idx = [k for k, t in enumerate(trials) if t[1] == cond]
            seq = ["L", "R"] * (len(idx) // 2)
            order_rng.shuffle(seq)
            for k, sd in zip(idx, seq):
                sides[k] = sd
        if all(len(set(sides[k:k + 4])) > 1 for k in range(len(sides) - 3)):
            break

    forms = {"A": {"graded_novelty": []}, "B": {"graded_novelty": []}}
    rows = []
    for k, ((x, y, level, fam), cond) in enumerate(trials):
        pid = f"gra{k + 1:02d}"
        keys = [(o["name"], v) for o in (x, y) for v in (lo, front, hi)]
        before = [bs.on_noise(*placed[n][v], rng) for n, v in keys]
        sb, _ = sm.mismatch(before)
        after = sm.shine(before)
        sa, _ = sm.mismatch(after)
        files = {}
        for (n, v), g in zip(keys, after):
            fn = f"{pid}_{n}_az{int(v):+04d}.jpg"
            bs.save(g, os.path.join(out, fn))
            files[(n, v)] = fn
        img = {key: g for key, g in zip(keys, after)}
        gx, gy = img[(x["name"], front)], img[(y["name"], front)]
        rows.append({
            "pair": pid, "family": fam, "level": level, "condition": cond, "x": x["name"], "y": y["name"],
            "pixel_rms_diff_front": float(np.sqrt(((gx - gy) ** 2).mean())),
            # How different the 30-degree-rotated view of the same object is, for comparison with the line above.
            "pixel_rms_diff_view": float(np.sqrt(((gx - img[(x["name"], hi)]) ** 2).mean())),
            "sal_share_x_itti": ist.share_on_a(gx, gy, ist.sal_itti),
            "spectrum_mismatch_before": sb, "spectrum_mismatch_after": sa,
        })
        for form, (f_o, n_o) in (("A", (x, y)), ("B", (y, x))):
            f, n = f_o["name"], n_o["name"]
            study = [files[(f, lo)], files[(f, hi)]] if cond == "standard" else [files[(f, lo)], files[(f, front)]]
            forms[form]["graded_novelty"].append({
                "pair": pid, "family": fam, "level": level, "condition": cond, "familiar": f, "novel": n, "novel_side": sides[k],
                "study": study, "test_familiar": files[(f, front if cond == "standard" else hi)], "test_novel": files[(n, front)],
            })

    tiles = []
    for i in range(3):
        fn = f"noise_tile_{i + 1}.png"
        bs.save(sm.pink_noise(1024, rng, sd=bs.NOISE_SD), os.path.join(out, fn))
        tiles.append(fn)
    spec = {
        "name": os.path.basename(os.path.normpath(out)), "patch_px": bs.PATCH, "window": {"flat": 0.8, "edge": 1.0},
        "noise": {"sd_gray_levels": bs.NOISE_SD, "tile_px": 1024, "tiles": tiles}, "object_contrast_sd": bs.OBJ_SD,
        "views_deg": man["views"], "generator_seed": man["seed"], "levels": levels, "block_size": 2 * len(levels) + 2,
        "forms": forms, "pairs": rows,
    }
    with open(os.path.join(out, "set.json"), "w") as f:
        json.dump(spec, f, indent=1)

    mb = sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out)) / 1e6
    print(f"{len(trials)} trials in {n_blocks} blocks of {spec['block_size']}; {len([f for f in os.listdir(out) if f.endswith('.jpg')])} pictures, {mb:.1f} MB")
    print("level     n   pixel difference: comparison object vs same object rotated 30 deg")
    for lv in levels + ["easy"]:
        sel = [r for r in rows if r["level"] == lv]
        print(f"{str(lv):6s} {len(sel):4d}   {np.mean([r['pixel_rms_diff_front'] for r in sel]):5.1f}  vs {np.mean([r['pixel_rms_diff_view'] for r in sel]):5.1f}"
              f"   salience imbalance {np.mean([abs(r['sal_share_x_itti'] - 0.5) for r in sel]):.3f}")


if __name__ == "__main__":
    main()
