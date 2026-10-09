"""Generate novel 3D objects in Blender and render them from several viewpoints.

Run headless (from the repository folder):
    /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/make_objects.py -- \
        --out renders/set1 --bases 32 --variant-bases 2 --views -30 0 30 --seed 1

Design, following the object-recognition-ability (O) literature:
  * several object FAMILIES built by different rules (blob with parts, stacked segments, branching
    tubes), so that no single feature rule transfers from one family to the next;
  * within a family, each BASE object has VARIANTS that lie on a straight line in parameter space
    between the base and a strongly perturbed version of it. `level` (0-1) is the position on that line,
    so pairs of graded similarity come from one base and are the same kind of object;
  * every object is a small dictionary of numbers, saved in manifest.json, so sets can be regenerated;
    parts are placed relative to what they attach to, so variants never fall apart.
Images are greyscale renders on a transparent background, lit from near the camera.
"""
import argparse
import copy
import json
import math
import os
import random
import sys
import time

import bpy
from mathutils import Vector, noise

FAMILIES = ["blob", "stack", "branch"]
SOLIDS = ["cone", "cylinder", "sphere", "torus"]


def unit(rng):
    v = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1)))
    return v.normalized()


# ---- object parameters ---------------------------------------------------------------------------
# An object is {"family": ..., plus numbers and lists of numbers}. Parts are described RELATIVE to what
# they attach to (an angle on the body, a height in the stack, a fraction along the trunk), so that a
# blended or perturbed object always stays in one piece.

def gen_blob(rng):
    """A bumpy body with three to five parts sticking out of it."""
    return {
        "family": "blob",
        "scale": [rng.uniform(0.4, 0.75), rng.uniform(0.4, 0.75), rng.uniform(0.55, 1.1)],
        "bump_amp": rng.uniform(0.08, 0.25), "bump_freq": rng.uniform(0.8, 1.8), "bump_seed": rng.uniform(0, 100),
        "parts": [{"kind": rng.choice(SOLIDS), "theta": rng.uniform(0, 2 * math.pi), "phi": rng.uniform(0.15 * math.pi, 0.85 * math.pi),
                   "tilt": rng.uniform(-0.5, 0.5), "length": rng.uniform(0.7, 1.5), "radius": rng.uniform(0.16, 0.34)}
                  for _ in range(rng.randint(3, 5))],
    }


def gen_stack(rng):
    """Three to five segments stacked along a slightly wandering vertical axis."""
    return {
        "family": "stack",
        "parts": [{"kind": rng.choice(SOLIDS), "dx": rng.uniform(-0.15, 0.15), "dy": rng.uniform(-0.15, 0.15),
                   "lean": list(0.25 * unit(rng)), "length": rng.uniform(0.35, 0.8), "radius": rng.uniform(0.25, 0.6)}
                  for _ in range(rng.randint(3, 5))],
    }


def gen_branch(rng):
    """A bent trunk with two to four curved limbs."""
    limbs = []
    for _ in range(rng.randint(2, 4)):
        d = unit(rng)
        limbs.append({"at": rng.uniform(0.2, 0.9), "dir": [d.x, d.y, abs(d.z) * 0.6], "reach": rng.uniform(0.8, 1.4),
                      "bend": list(0.4 * unit(rng)), "r0": rng.uniform(0.12, 0.22), "r1": rng.uniform(0.05, 0.16)})
    return {
        "family": "branch",
        "trunk_bend": list(0.5 * unit(rng)), "trunk_top": [rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), 0.7],
        "trunk_r0": rng.uniform(0.22, 0.34), "trunk_r1": rng.uniform(0.14, 0.24), "parts": limbs,
    }


GENERATORS = {"blob": gen_blob, "stack": gen_stack, "branch": gen_branch}
# How strongly each parameter changes at the far end of an object's variant line: ("add", sd) or ("mul", sd of log).
CHANGE = {
    "scale": ("mul", 0.3), "bump_amp": ("mul", 0.5), "bump_seed": ("add", 1.0),
    "theta": ("add", 0.5), "phi": ("add", 0.3), "tilt": ("add", 0.35), "length": ("mul", 0.45), "radius": ("mul", 0.4),
    "dx": ("add", 0.12), "dy": ("add", 0.12), "lean": ("add", 0.25),
    "trunk_bend": ("add", 0.4), "trunk_top": ("add", 0.25), "trunk_r0": ("mul", 0.3), "trunk_r1": ("mul", 0.3),
    "at": ("add", 0.2), "dir": ("add", 0.5), "reach": ("mul", 0.35), "bend": ("add", 0.35), "r0": ("mul", 0.35), "r1": ("mul", 0.35),
}


def perturb(obj, rng):
    """A strongly changed version of an object with the same parts (the far end of its variant line)."""
    def walk(d):
        out = {}
        for k, v in d.items():
            if k == "parts":
                out[k] = [walk(p) for p in v]
            elif k in CHANGE:
                how, sd = CHANGE[k]
                f = (lambda x: x + sd * rng.gauss(0, 1)) if how == "add" else (lambda x: x * math.exp(sd * rng.gauss(0, 1)))
                out[k] = [f(x) for x in v] if isinstance(v, list) else f(v)
            else:
                out[k] = copy.deepcopy(v)
        return out
    return walk(obj)


def blend(a, b, t):
    """Linear interpolation between two objects with the same parts."""
    def walk(x, y):
        if isinstance(x, dict):
            return {k: walk(x[k], y[k]) for k in x}
        if isinstance(x, list):
            return [walk(p, q) for p, q in zip(x, y)]
        if isinstance(x, (int, float)) and not isinstance(x, bool):
            return x + t * (y - x)
        return x
    return walk(a, b)


def bezier(p0, p1, p2, t):
    return (1 - t) ** 2 * p0 + 2 * t * (1 - t) * p1 + t ** 2 * p2


def realise(obj):
    """Turn object parameters into placed primitives: bodies, solids and tubes."""
    els = []
    if obj["family"] == "blob":
        sx, sy, sz = [max(0.25, v) for v in obj["scale"]]
        els.append({"kind": "body", "scale": [sx, sy, sz], "bump_amp": obj["bump_amp"], "bump_freq": obj["bump_freq"], "bump_seed": obj["bump_seed"]})
        for p in obj["parts"]:
            ph = min(0.9 * math.pi, max(0.1 * math.pi, p["phi"]))
            d = Vector((math.sin(ph) * math.cos(p["theta"]), math.sin(ph) * math.sin(p["theta"]), math.cos(ph)))
            axis = (d + Vector((0, 0, p["tilt"]))).normalized()
            # Balls and rings sit on the surface; spikes and rods reach out by half their length.
            out = {"sphere": 0.9 * p["radius"], "torus": 0.5 * p["radius"]}.get(p["kind"], 0.5 * p["length"])
            pos = Vector((d.x * sx, d.y * sy, d.z * sz)) * 0.85 + axis * out
            els.append({"kind": p["kind"], "pos": pos, "axis": axis, "length": p["length"], "radius": p["radius"]})
    elif obj["family"] == "stack":
        z = -1.0
        for p in obj["parts"]:
            L = max(0.2, p["length"])
            axis = (Vector((0, 0, 1)) + Vector(p["lean"])).normalized()
            els.append({"kind": p["kind"], "pos": Vector((p["dx"], p["dy"], z + L / 2)), "axis": axis, "length": L, "radius": p["radius"]})
            z += 0.75 * L
    else:
        t0, t1, t2 = Vector((0, 0, -1.0)), Vector(obj["trunk_bend"]), Vector(obj["trunk_top"])
        els.append({"kind": "tube", "p0": t0, "p1": t1, "p2": t2, "r0": obj["trunk_r0"], "r1": obj["trunk_r1"]})
        for p in obj["parts"]:
            start = bezier(t0, t1, t2, min(0.95, max(0.1, p["at"])))
            d = Vector(p["dir"])
            end = start + (d.normalized() if d.length > 1e-6 else Vector((1, 0, 0))) * p["reach"]
            els.append({"kind": "tube", "p0": start, "p1": (start + end) / 2 + Vector(p["bend"]), "p2": end, "r0": p["r0"], "r1": p["r1"]})
    return els


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
        for item in list(block):
            block.remove(item)


def add_element(e):
    made = []
    if e["kind"] == "body":
        sx, sy, sz = e["scale"]
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=5, radius=1.0)
        ob = bpy.context.active_object
        for v in ob.data.vertices:
            d = v.co.normalized()
            bump = noise.noise(d * e["bump_freq"] + Vector((e["bump_seed"], 0, 0)))
            v.co = Vector((d.x * sx, d.y * sy, d.z * sz)) * (1 + e["bump_amp"] * bump)
        return [ob]
    if e["kind"] == "tube":
        # Closely spaced spheres along the curve; the voxel fusion turns them into a smooth tube.
        for i in range(41):
            t = i / 40
            r = max(0.04, e["r0"] + t * (e["r1"] - e["r0"]))
            bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=r, location=bezier(e["p0"], e["p1"], e["p2"], t))
            made.append(bpy.context.active_object)
        return made
    L, r = max(0.15, e["length"]), max(0.06, e["radius"])
    if e["kind"] == "cone":
        bpy.ops.mesh.primitive_cone_add(vertices=48, radius1=r, radius2=0.25 * r, depth=L)
    elif e["kind"] == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.7 * r, depth=L)
    elif e["kind"] == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=1.3 * r)
    else:
        bpy.ops.mesh.primitive_torus_add(major_radius=1.4 * r, minor_radius=0.45 * r)
    ob = bpy.context.active_object
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(e["axis"])
    ob.location = e["pos"]
    return [ob]


def build_object(params):
    pieces = [ob for e in realise(params) for ob in add_element(e)]
    bpy.ops.object.select_all(action="DESELECT")
    for ob in pieces:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = pieces[0]
    bpy.ops.object.join()
    obj = bpy.context.active_object

    # Fuse the pieces into a single smooth surface.
    remesh = obj.modifiers.new("fuse", "REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = 0.03
    smooth = obj.modifiers.new("smooth", "SMOOTH")
    smooth.factor = 0.6
    smooth.iterations = 5
    bpy.ops.object.modifier_apply(modifier="fuse")
    bpy.ops.object.modifier_apply(modifier="smooth")
    bpy.ops.object.shade_smooth()

    # Centre on the bounding box and scale to a common size.
    lo = Vector([min(v.co[i] for v in obj.data.vertices) for i in range(3)])
    hi = Vector([max(v.co[i] for v in obj.data.vertices) for i in range(3)])
    centre, size = (lo + hi) / 2, max(hi - lo)
    for v in obj.data.vertices:
        v.co = (v.co - centre) * (2.0 / size)
    obj.location = (0, 0, 0)  # the joined object inherits the first piece's position; put it at the centre

    mat = bpy.data.materials.new("matte")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.5, 0.5, 0.5, 1)
    bsdf.inputs["Roughness"].default_value = 0.65
    obj.data.materials.append(mat)
    return obj


def setup_render(size, engine):
    scene = bpy.context.scene
    scene.render.engine = engine
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    if engine == "CYCLES":
        scene.cycles.samples = 48
        scene.cycles.use_denoising = True

    world = bpy.data.worlds.new("world") if not bpy.data.worlds else bpy.data.worlds[0]
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.5, 0.5, 0.5, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35

    # One key light fixed relative to the camera, so shading does not give away the viewpoint.
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 85
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    light_data = bpy.data.lights.new("key", "AREA")
    light_data.energy = 600
    light_data.size = 2.5
    light = bpy.data.objects.new("key", light_data)
    scene.collection.objects.link(light)
    return cam, light


def aim(ob, position, target=Vector((0, 0, 0))):
    ob.location = position
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = (target - position).to_track_quat("-Z", "Y")


def render_views(name, out, views, elevation, cam, light):
    files = {}
    for az in views:
        a, e, dist = math.radians(az), math.radians(elevation), 9.0
        pos = Vector((dist * math.sin(a) * math.cos(e), -dist * math.cos(a) * math.cos(e), dist * math.sin(e)))
        aim(cam, pos)
        right = pos.cross(Vector((0, 0, 1))).normalized()
        aim(light, pos * 0.7 + Vector((0, 0, 4)) - right * 3)
        path = os.path.join(out, f"{name}_az{az:+04d}.png")
        bpy.context.scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        files[str(az)] = os.path.basename(path)
    return files


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="renders/pilot")
    ap.add_argument("--bases", type=int, default=2, help="base objects per family")
    ap.add_argument("--families", nargs="+", default=FAMILIES)
    ap.add_argument("--first", type=int, default=1, help="number of the first base object")
    ap.add_argument("--levels", type=float, nargs="*", default=[0.05, 0.1, 0.2, 0.4], help="variant levels (0-1)")
    ap.add_argument("--variant-bases", type=int, default=0, help="how many bases per family also get variants")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--views", type=int, nargs="+", default=[-30, 0, 30])
    ap.add_argument("--elevation", type=float, default=15)
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--engine", default="CYCLES", help="CYCLES is reliable without a window; EEVEE stalled in testing")
    args = ap.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)
    todo = []
    for fam in args.families:
        for b in range(args.first, args.first + args.bases):
            # Each base has its own random stream, so adding bases or levels never changes existing objects.
            rng = random.Random(f"{args.seed}-{fam}-{b}")
            base = GENERATORS[fam](rng)
            far = perturb(base, rng)
            bid = f"{fam}{b:02d}"
            todo.append({"name": f"{bid}_L000", "family": fam, "base": bid, "level": 0.0, "params": base})
            for lv in (args.levels if b < args.first + args.variant_bases else []):
                todo.append({"name": f"{bid}_L{round(100 * lv):03d}", "family": fam, "base": bid, "level": lv, "params": blend(base, far, lv)})

    manifest = {"seed": args.seed, "views": args.views, "elevation": args.elevation, "size": args.size, "objects": []}
    for o in todo:
        t0 = time.time()
        clear_scene()
        build_object(o["params"])
        cam, light = setup_render(args.size, args.engine)
        o["files"] = render_views(o["name"], args.out, args.views, args.elevation, cam, light)
        manifest["objects"].append(o)
        print(f"ORBIT {o['name']}: {len(o['files'])} views in {time.time() - t0:.1f} s", flush=True)
        with open(os.path.join(args.out, "manifest.json"), "w") as f:
            json.dump(manifest, f, indent=1)


main()
