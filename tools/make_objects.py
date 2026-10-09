"""Generate novel 3D objects in Blender and render them from several viewpoints.

Run headless (from the repository folder):
    /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/make_objects.py -- \
        --out renders/pilot --bases 2 --levels 0.2 0.5 1.0 --views -30 0 30 --seed 1

Design, following the object-recognition-ability (O) literature:
  * several object FAMILIES built by different rules (blob with parts, stacked segments, branching
    tubes), so that no single feature rule transfers from one family to the next;
  * within a family, each BASE object has VARIANTS that lie on a straight line in parameter space
    between the base and a strongly perturbed version of it. `level` (0-1) is the position on that line,
    so pairs of graded similarity come from one base and are the same kind of object;
  * every object is a list of numeric elements, saved in manifest.json, so sets can be regenerated.
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


def gen_blob(rng):
    """A bumpy body with three to five parts sticking out of it."""
    sx, sy, sz = rng.uniform(0.4, 0.75), rng.uniform(0.4, 0.75), rng.uniform(0.55, 1.1)
    els = [{"kind": "body", "scale": [sx, sy, sz], "bump_amp": rng.uniform(0.08, 0.25),
            "bump_freq": rng.uniform(0.8, 1.8), "bump_seed": rng.uniform(0, 100)}]
    for _ in range(rng.randint(3, 5)):
        th, ph = rng.uniform(0, 2 * math.pi), rng.uniform(0.15 * math.pi, 0.85 * math.pi)
        d = Vector((math.sin(ph) * math.cos(th), math.sin(ph) * math.sin(th), math.cos(ph)))
        axis = (d + Vector((0, 0, rng.uniform(-0.5, 0.5)))).normalized()
        length = rng.uniform(0.7, 1.5)
        pos = Vector((d.x * sx, d.y * sy, d.z * sz)) * 0.85 + axis * (0.5 * length)
        els.append({"kind": rng.choice(SOLIDS), "pos": list(pos), "axis": list(axis),
                    "length": length, "radius": rng.uniform(0.16, 0.34)})
    return els


def gen_stack(rng):
    """Three to five segments stacked along a slightly wandering vertical axis."""
    els, z = [], -1.0
    for _ in range(rng.randint(3, 5)):
        length = rng.uniform(0.35, 0.8)
        axis = (Vector((0, 0, 1)) + 0.25 * unit(rng)).normalized()
        els.append({"kind": rng.choice(SOLIDS), "pos": [rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), z + length / 2],
                    "axis": list(axis), "length": length, "radius": rng.uniform(0.25, 0.6)})
        z += 0.8 * length
    return els


def gen_branch(rng):
    """A bent trunk with two to four curved limbs; each tube is a quadratic Bezier with tapering radius."""
    top = Vector((rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), 0.7))
    els = [{"kind": "tube", "p0": [0, 0, -1.0], "p1": list(0.5 * unit(rng)), "p2": list(top),
            "r0": rng.uniform(0.22, 0.34), "r1": rng.uniform(0.14, 0.24)}]
    for _ in range(rng.randint(2, 4)):
        start = Vector((0, 0, rng.uniform(-0.5, 0.6)))
        d = unit(rng)
        d.z = abs(d.z) * 0.6
        end = start + d.normalized() * rng.uniform(0.8, 1.4)
        mid = (start + end) / 2 + 0.4 * unit(rng)
        els.append({"kind": "tube", "p0": list(start), "p1": list(mid), "p2": list(end),
                    "r0": rng.uniform(0.12, 0.22), "r1": rng.uniform(0.05, 0.16)})
    return els


GENERATORS = {"blob": gen_blob, "stack": gen_stack, "branch": gen_branch}


def perturb(els, rng):
    """A strongly changed version of an object with the same elements (the far end of its variant line)."""
    out = copy.deepcopy(els)
    jit = lambda v, s: [a + s * rng.gauss(0, 1) for a in v]
    mul = lambda x, s: x * math.exp(s * rng.gauss(0, 1))
    for e in out:
        if e["kind"] == "body":
            e["scale"] = [mul(a, 0.3) for a in e["scale"]]
            e["bump_amp"] = mul(e["bump_amp"], 0.5)
            e["bump_seed"] += rng.uniform(0.5, 1.5)
        elif e["kind"] == "tube":
            e["p1"], e["p2"] = jit(e["p1"], 0.4), jit(e["p2"], 0.35)
            e["r0"], e["r1"] = mul(e["r0"], 0.35), mul(e["r1"], 0.35)
        else:
            e["pos"], e["axis"] = jit(e["pos"], 0.3), jit(e["axis"], 0.5)
            e["length"], e["radius"] = mul(e["length"], 0.45), mul(e["radius"], 0.4)
    return out


def blend(a, b, t):
    """Element-wise linear interpolation between two objects with the same elements."""
    out = copy.deepcopy(a)
    for ea, eb, eo in zip(a, b, out):
        for k, va in ea.items():
            if isinstance(va, (int, float)):
                eo[k] = va + t * (eb[k] - va)
            elif isinstance(va, list):
                eo[k] = [x + t * (y - x) for x, y in zip(va, eb[k])]
    return out


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
        p0, p1, p2 = Vector(e["p0"]), Vector(e["p1"]), Vector(e["p2"])
        for i in range(15):
            t = i / 14
            p = (1 - t) ** 2 * p0 + 2 * t * (1 - t) * p1 + t ** 2 * p2
            bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=max(0.03, e["r0"] + t * (e["r1"] - e["r0"])), location=p)
            made.append(bpy.context.active_object)
        return made
    L, r = max(0.1, e["length"]), max(0.04, e["radius"])
    if e["kind"] == "cone":
        bpy.ops.mesh.primitive_cone_add(vertices=48, radius1=r, radius2=0.25 * r, depth=L)
    elif e["kind"] == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.7 * r, depth=L)
    elif e["kind"] == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=1.3 * r)
    else:
        bpy.ops.mesh.primitive_torus_add(major_radius=1.4 * r, minor_radius=0.45 * r)
    ob = bpy.context.active_object
    axis = Vector(e["axis"])
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(axis.normalized() if axis.length > 1e-6 else Vector((0, 0, 1)))
    ob.location = Vector(e["pos"])
    return [ob]


def build_object(els):
    pieces = [ob for e in els for ob in add_element(e)]
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
    corners = [Vector(c) for c in obj.bound_box]
    centre = sum(corners, Vector()) / 8
    size = max((max(c[i] for c in corners) - min(c[i] for c in corners)) for i in range(3))
    for v in obj.data.vertices:
        v.co = (v.co - centre) * (2.0 / size)

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
    ap.add_argument("--levels", type=float, nargs="*", default=[0.2, 0.5, 1.0], help="variant levels per base (0-1)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--views", type=int, nargs="+", default=[-30, 0, 30])
    ap.add_argument("--elevation", type=float, default=15)
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--engine", default="CYCLES", help="CYCLES is reliable without a window; EEVEE stalled in testing")
    args = ap.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)
    rng = random.Random(args.seed)
    todo = []
    for fam in args.families:
        for b in range(args.bases):
            base = GENERATORS[fam](rng)
            far = perturb(base, rng)
            bid = f"{fam}{b + 1:02d}"
            todo.append({"name": f"{bid}_L000", "family": fam, "base": bid, "level": 0.0, "elements": base})
            for lv in args.levels:
                todo.append({"name": f"{bid}_L{round(100 * lv):03d}", "family": fam, "base": bid, "level": lv, "elements": blend(base, far, lv)})

    manifest = {"seed": args.seed, "views": args.views, "elevation": args.elevation, "size": args.size, "objects": []}
    for o in todo:
        t0 = time.time()
        clear_scene()
        build_object(o["elements"])
        cam, light = setup_render(args.size, args.engine)
        o["files"] = render_views(o["name"], args.out, args.views, args.elevation, cam, light)
        manifest["objects"].append(o)
        print(f"ORBIT {o['name']}: {len(o['files'])} views in {time.time() - t0:.1f} s", flush=True)
        with open(os.path.join(args.out, "manifest.json"), "w") as f:
            json.dump(manifest, f, indent=1)


main()
