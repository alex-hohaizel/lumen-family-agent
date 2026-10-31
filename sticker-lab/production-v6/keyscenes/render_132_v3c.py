#!/usr/bin/env python3
"""Bounded two-bone reach and flexible cloth, from immutable generated layers.

No raster content is painted or generated here. One material map carries RGB
and alpha together; the two declared cloth grip pixels remain pinned.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import math
import subprocess
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
REPO = next(p for p in HERE.parents if (p / 'assets/stickers/manifest.json').is_file())
P5 = REPO / 'sticker-lab/production-v5'
N, FPS = 84, 30


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def load_generator(name, relative):
    path = P5 / relative
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BASE132 = 'approved-generators/integration-layer132-r2-v1/lumen_132/layer_renderer_132_v1.py'
BASE138 = 'approved-generators/integration-layer138-r4-v1/lumen_138/layer_renderer_138_side_r4.py'
b132 = load_generator('immutable132', BASE132)
b138 = load_generator('immutable138', BASE138)
support = b132.support
original_arm132 = b132.arm_layer
current_u = 0.0
current_body_alpha = None
new_arm_parts = {}
new_arm_images = {}


def fixed_arm132(image, source_a, source_b, shoulder, hand, side, upper_image, authored_elbow=False):
    # Pillow's body rotation is about (256,410), before its dy translation.
    # Recover the untransformed socket, then use that exact same rigid map.
    pop = b132.curve(current_u, [(0, 0), (.20, 0), (.29, 1), (.44, 0), (1, 0)])
    dy, angle = -7 * pop, math.radians(1.3 * pop)
    p = np.asarray(shoulder, float) - np.array([256., 410. + dy])
    shoulder = np.array([256., 410. + dy]) + np.array([
        math.cos(angle) * p[0] + math.sin(angle) * p[1],
        -math.sin(angle) * p[0] + math.cos(angle) * p[1]])
    part_side = 'left' if side < 0 else 'right'
    upper_part = new_arm_parts['upper_arm_'+part_side]
    fore_part = new_arm_parts['forearm_'+part_side]
    a = np.asarray(fore_part['anchors_crop']['elbow'], float)
    b = np.asarray(fore_part['anchors_crop']['paw_middle'], float)
    baseline_hand_request = np.asarray(hand, float).copy()
    hand = baseline_hand_request.copy()
    # The baseline straight celebration->star path crosses its own shoulder
    # in frames40/41, inside the unequal-bone minimum reach. Route the same
    # endpoints around the torso instead of stretching or flipping the elbow.
    if side > 0 and .42 < current_u < .56:
        q = b132.smooth((current_u-.42)/.14)
        hand[1] += 200*q*(1-q)
    s, h = np.asarray(shoulder, float), np.asarray(hand, float)
    v = h-s
    distance = float(np.linalg.norm(v))
    upper_length, lower_length = 62., 72.
    reach = upper_length+lower_length-.5
    if distance > reach:
        h = s+v*reach/distance
        v, distance = h-s, reach
    minimum_reach = abs(upper_length-lower_length)+.5
    if distance < minimum_reach:
        h = s+v*minimum_reach/max(distance,1e-8)
        v, distance = h-s, minimum_reach
    d = v/max(distance, 1e-9)
    normal = np.array([-d[1], d[0]])
    along = (upper_length**2-lower_length**2+distance**2)/(2*distance)
    radius = math.sqrt(max(0., upper_length**2-along**2))
    center = s+along*d
    desired = s+np.array([side*48., 36.])
    cosine = .88*math.tanh(float(np.dot(desired-center, normal))/max(radius,1e-8)/.88)
    e = center+radius*cosine*normal
    elbow_z = radius*math.sqrt(1-cosine*cosine)
    projected_lower_length = float(np.linalg.norm(h-e))
    fore_direction = (h-e)/projected_lower_length
    scale = .14
    upper_image = new_arm_images['upper_arm_'+part_side]
    upper = b132.affine_part(upper_image, upper_part['anchors_crop']['shoulder'], upper_part['anchors_crop']['elbow'], s, e, scale, np.ones(upper_image.shape[:2], np.float32))
    elbow_vector = e-s
    axial = ((b132.XX-s[0])*elbow_vector[0]+(b132.YY-s[1])*elbow_vector[1])/max(float(np.dot(elbow_vector,elbow_vector)),1e-8)
    root_depth = 1-np.clip((axial-.10)/.45,0,1)
    upper[...,3] *= 1-current_body_alpha*root_depth
    fore = b132.affine_part(image, a, b, e, h, scale, np.ones(image.shape[:2], np.float32))
    v = h-e
    t = ((b132.XX-e[0])*v[0]+(b132.YY-e[1])*v[1])/float(np.dot(v,v))
    # Split depth after one complete common native map. The two masks are
    # complementary in target pixels; no source-cut seam or alpha crossfade.
    lower, paw = fore.copy(), fore.copy()
    lower[...,3] *= t <= .66
    paw[...,3] *= t > .66
    wrist = e+.66*v
    state = {'shoulder':s.tolist(), 'elbow':e.tolist(), 'wrist':wrist.tolist(), 'hand':h.tolist(),
             'hand_scale':scale, 'requested_hand':np.asarray(hand).tolist(),
             'target_error':float(np.linalg.norm(h-hand)),
             'baseline_hand_request':baseline_hand_request.tolist(),
             'wrist_path':'same contact endpoints; continuous lower arc around shoulder during reach',
             'source_proximal_cap':'new opaque rounded cream elbow, no teal cut and no hard trim',
             'upper_arm_depth':'only shoulder root under native cloak; continuous 3D outward/downward elbow',
             'elbow_overlap':'matched28px cream girth with rounded interior anchors, original generated alpha'}
    s, e, h = (np.asarray(state[k], float) for k in ('shoulder', 'elbow', 'hand'))
    state.update(upper_bone_length=float(math.sqrt(np.linalg.norm(e-s)**2+elbow_z**2)),
                 lower_bone_length=float(math.sqrt(np.linalg.norm(h-e)**2+elbow_z**2)),
                 elbow_depth=elbow_z,
                 projected_upper_length=float(np.linalg.norm(e-s)),
                 projected_lower_length=projected_lower_length,
                 elbow_policy='fixed 3D two-bone lengths; continuous outward/downward pole circle; projection foreshortens without elongation',
                 shoulder_policy='same full rotation and translation as body material')
    # The baseline compositor put upper arms behind the open lid and the
    # matching forearms in front. Keep each connected arm on one depth plane;
    # its final front-box/paw occlusion remains owned by the scene compositor.
    state['depth_policy'] = 'upper and forearm together in front of open lid; front box still occludes inserted limb'
    return b132.canvas(), b132.over(upper, lower), paw, state


b132.arm_layer = fixed_arm132


def cloth_displacement(x, y, u, scale):
    # Deflection is exactly zero on the source grip line y=365. The free
    # upper and lower material responds with a phase lag, rather than moving
    # as one rigid card. All functions are periodic with matching velocity.
    v = (y - 365.) / 365.
    t = (x - 67.) / 526.
    lag = 18. * math.sin(2*math.pi*u) * math.sin(math.pi*u)**2 / scale
    sag = 7. * (1-math.cos(4*math.pi*u)) / (2*scale)
    dx = lag * v * np.sin(math.pi*t)
    dy = sag * v*v * np.sin(math.pi*t)
    return dx, dy


def render_cloth138(u, layers):
    cover = .5 - .5*math.cos(2*math.pi*u)
    theta = math.radians(-90*(1-cover))
    cs, sn = math.cos(theta), math.sin(theta)
    scale = 310 / layers['cloth'].width
    grip = np.array([593., 365.])
    right_hand = np.array([396-cover, 202+69*cover])
    dx, dy = b138.XX-right_hand[0], b138.YY-right_hand[1]
    qx = grip[0] + (dx*cs+dy*sn)/scale
    qy = grip[1] + (-dx*sn+dy*cs)/scale
    sx, sy = qx.copy(), qy.copy()
    for _ in range(8):
        wx, wy = cloth_displacement(sx, sy, u, scale)
        sx, sy = qx-wx, qy-wy
    source = np.array(layers['cloth'], np.float32)/255
    cloth = support.straight(support.sample(support.premult(source), sy, sx)).astype(np.float32)/255
    delta = np.array([67., 365.])-grip
    left_grip = right_hand + scale*np.array([cs*delta[0]-sn*delta[1], sn*delta[0]+cs*delta[1]])
    wave = 0.
    if .66 < u < .94:
        q = (u-.66)/.28
        wave = math.sin(math.pi*q)**2 * math.sin(2*math.pi*q)
    free_hand = np.array([115+20*wave, 216+3*abs(wave)])
    holding = b138.smooth((cover-.60)/.25)
    left_hand = free_hand*(1-holding)+left_grip*holding
    lu, ll, lf, lp = b138.arm_layer(layers['arm_left'], [252, 286], [101, 82], [177, 335], left_hand, -1, layers['upper_arm'])
    ru, rl, rf, rp = b138.arm_layer(layers['arm_right'], [46, 235], [225, 71], [337, 335], right_hand, 1, layers['upper_arm'])
    frame = b138.body_layer(layers['body'])
    for layer in (lu, ru, ll, rl, cloth, lf, rf):
        frame = b138.over(frame, layer)
    grid_y, grid_x = np.mgrid[0:515:5, 0:625:5].astype(float)
    wx, wy = cloth_displacement(grid_x, grid_y, u, scale)
    dx_y, dx_x = np.gradient(wx, 5, 5)
    dy_y, dy_x = np.gradient(wy, 5, 5)
    jac = (1+dx_x)*(1+dy_y)-dx_y*dy_x
    grip_errors = [float(np.linalg.norm(cloth_displacement(x, 365., u, scale))) for x in (67., 593.)]
    yy, xx = np.nonzero(cloth[..., 3] > 1/255)
    return frame, {'cover': cover, 'wave': wave, 'left_arm': lp, 'right_arm': rp,
                   'cloth_angle_degrees': math.degrees(theta), 'cloth_uniform_scale': scale,
                   'cloth_material_jacobian_min': float(jac.min()),
                   'cloth_material_max_deflection_pixels': float(scale*np.hypot(wx, wy).max()),
                   'cloth_grip_residual_pixels': grip_errors,
                   'cloth_bbox': [int(xx.min()), int(yy.min()), int(xx.max()+1), int(yy.max()+1)],
                   'cloth_motion': 'continuous lift/reveal with pinned grip line, flexible drape and delayed free-edge bend',
                   'cloth_opacity_fade': False}


def checked_inputs(sticker_id):
    recipe_name = 'lumen_132_explicit_layers_v1.json' if sticker_id == 'lumen_132' else 'lumen_138_rigid_sheet_side_r4.json'
    recipe_path = P5/'approved-recipes'/recipe_name
    recipe = json.loads(recipe_path.read_text())
    extraction_path = REPO/recipe['extraction_path']
    assert sha(extraction_path) == recipe['extraction_sha256']
    meta = json.loads(extraction_path.read_text())
    inputs = [{'path': str(recipe_path.relative_to(REPO)), 'sha256': sha(recipe_path)},
              {'path': str(extraction_path.relative_to(REPO)), 'sha256': sha(extraction_path)}]
    gp = REPO/meta['generation_metadata_path']
    assert sha(gp) == meta['generation_metadata_sha256']
    inputs.append({'path': str(gp.relative_to(REPO)), 'sha256': sha(gp)})
    layers = {}
    for row in meta['source_anchors']:
        path = REPO/row['path']
        assert sha(path) == row['sha256']
        layers[row['key']] = b132.rgba(path) if row['key'] in ('arm_left', 'arm_right', 'upper_arm') else Image.open(path).convert('RGBA')
        inputs.append({'path': row['path'], 'sha256': sha(path)})
    for path in (P5/BASE132, P5/BASE138, Path(support.__file__)):
        inputs.append({'path': str(path.relative_to(REPO)), 'sha256': sha(path)})
    if sticker_id == 'lumen_132':
        arm_dir = HERE/'arm-sources-v3'
        anchors_path = arm_dir/'rig-anchors.json'
        source_contract = json.loads(anchors_path.read_text())
        for key, part in source_contract['parts'].items():
            file = arm_dir/(key+'.png')
            assert sha(file) == part['sha256']
            new_arm_parts[key] = part
            new_arm_images[key] = b132.rgba(file)
            inputs.append({'path':str(file.relative_to(REPO)), 'sha256':sha(file), 'role':'new imagegen anatomical component'})
        for name in ['rig-anchors.json','FINAL-source.json','pre-generation.json','generation-result.json','prompt.txt','arm-atlas-native.png']:
            file = arm_dir/name
            inputs.append({'path':str(file.relative_to(REPO)), 'sha256':sha(file), 'role':'new source generation lineage'})
        layers['arm_left'] = new_arm_images['forearm_left']
        layers['arm_right'] = new_arm_images['forearm_right']
    return layers, inputs


def board(folder, output, indices, size=200):
    cols = 7
    rows = math.ceil(len(indices)/cols)
    result = Image.new('RGB', (cols*size, rows*(size+22)), '#253345')
    draw = ImageDraw.Draw(result)
    for k, i in enumerate(indices):
        im = Image.open(folder/f'{i:03d}.png').convert('RGBA').resize((size, size), Image.Resampling.LANCZOS)
        x, y = (k%cols)*size, (k//cols)*(size+22)
        result.paste(im, (x, y), im)
        draw.text((x+5, y+size+3), str(i), fill='white')
    result.save(output)


def main():
    global current_u, current_body_alpha
    p = argparse.ArgumentParser()
    p.add_argument('id', choices=['lumen_132', 'lumen_138'])
    p.add_argument('--output', type=Path)
    args = p.parse_args()
    out = (args.output or HERE/args.id).resolve()
    out.mkdir(parents=True, exist_ok=True)
    raw = out/'frames-rgba'
    assert not raw.exists(), 'New output revision required; do not overwrite a frozen candidate'
    raw.mkdir()
    layers, inputs = checked_inputs(args.id)
    states = []
    for i in range(N):
        current_u = i/N
        if args.id == 'lumen_132':
            pop = b132.curve(current_u, [(0,0),(.20,0),(.29,1),(.44,0),(1,0)])
            current_body_alpha = b132.body_layer(layers['body'], -7*pop, 1.3*pop)[..., 3]
            frame, state = b132.render_132(current_u, layers, {})
        else:
            frame, state = render_cloth138(current_u, layers)
        support.atomic_save(Image.fromarray(support.straight(support.premult(frame)), 'RGBA'), raw/f'{i:03d}.png')
        states.append(state)
        if i % 21 == 0:
            print(f'{args.id} rendered {i+1}/{N}', flush=True)
    video = out/'candidate.webm'
    for crf in (25, 28, 31, 34, 37):
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-framerate', str(FPS), '-i', str(raw/'%03d.png'),
                        '-c:v', 'libvpx-vp9', '-threads', '2', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
                        '-b:v', '0', '-crf', str(crf), '-deadline', 'good', '-cpu-used', '2', '-an', '-frames:v', str(N), str(video)], check=True)
        if video.stat().st_size <= 262144:
            break
    assert video.stat().st_size <= 262144
    decoded = out/'decoded'
    decoded.mkdir()
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-c:v', 'libvpx-vp9', '-i', str(video), '-vsync', '0', '-start_number', '0', str(decoded/'%03d.png')], check=True)
    # ffmpeg's output pattern defaults to 1; normalize the independently decoded
    # filename sequence without changing any bytes.
    files = sorted(decoded.glob('*.png'))
    assert len(files) == N
    if files[0].stem == '001':
        for i, f in enumerate(files):
            f.rename(decoded/f'{i:03d}.png')
    states_path = out/'states.json'
    states_path.write_text(json.dumps(states, indent=2)+'\n')
    preview_index = 28 if args.id == 'lumen_132' else 42
    Image.open(decoded/f'{preview_index:03d}.png').save(out/'preview.png')
    board(decoded, out/'all84.jpg', list(range(N)), 140)
    board(decoded, out/'phases.jpg', list(range(0, N, 6)), 256)
    raw_hashes = [sha(raw/f'{i:03d}.png') for i in range(N)]
    result = {'schema_version': 1, 'id': args.id, 'revision': 3, 'actual_actor_id': '/root',
              'baseline_sha256': sha(REPO/'assets/stickers'/f'{args.id}.webm'),
              'video': {'path': str(video.relative_to(REPO)), 'sha256': sha(video), 'bytes': video.stat().st_size},
              'preview': {'path': str((out/'preview.png').relative_to(REPO)), 'sha256': sha(out/'preview.png')},
              'renderer': {'path': str(Path(__file__).relative_to(REPO)), 'sha256': sha(__file__)},
              'source_dependencies': inputs, 'raw_frame_sha256': raw_hashes,
              'decoded_frame_sha256': [sha(decoded/f'{i:03d}.png') for i in range(N)],
              'states_sha256': sha(states_path), 'encoding': {'frames': N, 'fps': FPS, 'duration': N/FPS, 'crf': crf, 'alpha': True, 'audio': False},
              'new_raster_art': args.id == 'lumen_132', 'new_source_author': '/root/arm_source_repair',
              'geometry': 'orthographic projection of constant 3D bones, continuous elbow pole and source component overlap',
              'all_encoders_finished': True, 'full_decode': '84 frames without errors',
              'scope': 'author self-check only; independent review pending',
              'native_normal_slow_playback': 'not_observed', 'human_mobile': 'not_observed'}
    if args.id == 'lumen_132':
        lengths = [s[side][key] for s in states for side in ('left_arm', 'right_arm') for key in ('upper_bone_length', 'lower_bone_length')]
        result['bone_length_range'] = [min(lengths), max(lengths)]
        assert max(abs(s[side][key]-length) for s in states for side in ('left_arm','right_arm') for key,length in [('upper_bone_length',62),('lower_bone_length',72)]) < 1e-8
    else:
        result['cloth_jacobian_min'] = min(s['cloth_material_jacobian_min'] for s in states)
        result['cloth_max_deflection_pixels'] = max(s['cloth_material_max_deflection_pixels'] for s in states)
        assert result['cloth_jacobian_min'] > .5
        assert max(max(s['cloth_grip_residual_pixels']) for s in states) < 1e-10
    (out/'render-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ('raw_frame_sha256', 'decoded_frame_sha256', 'source_dependencies')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
