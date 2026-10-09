"""Generate novel 3D objects in Blender and render them from several viewpoints.

Run headless:
    /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/make_objects.py -- \
        --out renders/test --n 1 --seed 1 --views -30 0 30

Each object is a smooth body with a few attached parts, fused into one surface. An object is fully
described by a parameter dictionary, so two objects can later be blended to make pairs of graded
similarity. Images are greyscale renders on a transparent background.
"""
import argparse
import json
import math
import os
import random
import sys
import time

import bpy
from mathutils import Vector, noise

PART_KINDS = ["cone", "cylinder", "sphere", "torus"]


def random_params(rng):
    """Parameter dictionary for one object."""
    parts = []
    for _ in range(rng.randint(3, 5)):
        parts.append({
            "kind": rng.choice(PART_KINDS),
            "theta": rng.uniform(0, 2 * math.pi),          # where on the body it attaches
            "phi": rng.uniform(0.15 * math.pi, 0.85 * math.pi),
            "length": rng.uniform(0.7, 1.5),
            "radius": rng.uniform(0.16, 0.34),
            "tilt": rng.uniform(-0.5, 0.5),
        })
    return {
        "body_scale": [rng.uniform(0.4, 0.75), rng.uniform(0.4, 0.75), rng.uniform(0.55, 1.1)],
        "bump_amp": rng.uniform(0.08, 0.25),
        "bump_freq": rng.uniform(0.8, 1.8),
        "bump_seed": rng.uniform(0, 100),
        "parts": parts,
    }


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
        for item in list(block):
            block.remove(item)


def build_object(p):
    sx, sy, sz = p["body_scale"]
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=5, radius=1.0)
    body = bpy.context.active_object
    for v in body.data.vertices:
        d = v.co.normalized()
        bump = noise.noise(d * p["bump_freq"] + Vector((p["bump_seed"], 0, 0)))
        v.co = Vector((d.x * sx, d.y * sy, d.z * sz)) * (1 + p["bump_amp"] * bump)
    pieces = [body]

    for part in p["parts"]:
        th, ph = part["theta"], part["phi"]
        direction = Vector((math.sin(ph) * math.cos(th), math.sin(ph) * math.sin(th), math.cos(ph)))
        anchor = Vector((direction.x * sx, direction.y * sy, direction.z * sz))
        L, r = part["length"], part["radius"]
        if part["kind"] == "cone":
            bpy.ops.mesh.primitive_cone_add(vertices=48, radius1=r, radius2=0.25 * r, depth=L)
        elif part["kind"] == "cylinder":
            bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.7 * r, depth=L)
        elif part["kind"] == "sphere":
            bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=1.3 * r)
            L = 1.3 * r
        else:
            bpy.ops.mesh.primitive_torus_add(major_radius=1.4 * r, minor_radius=0.45 * r)
            L = 0.6 * r
        ob = bpy.context.active_object
        axis = (direction + Vector((0, 0, part["tilt"]))).normalized()
        ob.rotation_mode = "QUATERNION"
        ob.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(axis)
        ob.location = anchor * 0.85 + axis * (0.5 * L)
        pieces.append(ob)

    bpy.ops.object.select_all(action="DESELECT")
    for ob in pieces:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = body
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
    bsdf.inputs["Base Color"].default_value = (0.42, 0.42, 0.42, 1)
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
    light_data.energy = 420
    light_data.size = 2.5
    light = bpy.data.objects.new("key", light_data)
    scene.collection.objects.link(light)
    return cam, light


def aim(ob, position, target=Vector((0, 0, 0))):
    ob.location = position
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = (target - position).to_track_quat("-Z", "Y")


def render_views(name, out, views, elevation, cam, light):
    files = []
    for az in views:
        a, e, dist = math.radians(az), math.radians(elevation), 9.0
        pos = Vector((dist * math.sin(a) * math.cos(e), -dist * math.cos(a) * math.cos(e), dist * math.sin(e)))
        aim(cam, pos)
        right = pos.cross(Vector((0, 0, 1))).normalized()
        aim(light, pos * 0.7 + Vector((0, 0, 4)) - right * 3)
        path = os.path.join(out, f"{name}_az{az:+04d}.png")
        bpy.context.scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        files.append(os.path.basename(path))
    return files


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="renders/test")
    ap.add_argument("--n", type=int, default=1)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--views", type=int, nargs="+", default=[-30, 0, 30])
    ap.add_argument("--elevation", type=float, default=15)
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--engine", default="BLENDER_EEVEE_NEXT")
    args = ap.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)
    rng = random.Random(args.seed)
    manifest = []
    for i in range(args.n):
        t0 = time.time()
        clear_scene()
        params = random_params(rng)
        build_object(params)
        cam, light = setup_render(args.size, args.engine)
        name = f"obj{args.seed:03d}_{i:03d}"
        files = render_views(name, args.out, args.views, args.elevation, cam, light)
        manifest.append({"name": name, "params": params, "files": files, "seconds": round(time.time() - t0, 1)})
        print(f"ORBIT {name}: {len(files)} views in {time.time() - t0:.1f} s")
    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)


main()
