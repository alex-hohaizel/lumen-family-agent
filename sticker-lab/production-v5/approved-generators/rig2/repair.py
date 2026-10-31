#!/usr/bin/env python3
"""Scene-specific temporal repairs from *derived decoded video*, never original art.

Only isolated candidates are written. There is no staging/upload/bot code here.
RGBA uses one shared spatial correspondence in premultiplied space. No separate
black/white learned interpolation and no independently interpolated alpha.
"""
from __future__ import annotations
import argparse, hashlib, io, json, math, os, subprocess, time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from scipy.interpolate import RBFInterpolator

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
FPS, N = 30, 84


def atomic_save(im, path):
    buffer = io.BytesIO()
    im.save(buffer, format='PNG')
    path = Path(path)
    temporary = path.with_name(path.name+'.temporary')
    temporary.write_bytes(buffer.getvalue())
    with Image.open(temporary) as check:
        check.verify()
    os.replace(temporary, path)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], check=True, **kwargs)


def rgba(path):
    return np.asarray(Image.open(path).convert('RGBA'), dtype=np.float32) / 255


def premult(im):
    out = im.copy()
    out[..., :3] *= out[..., 3:4]
    return out


def straight(im):
    out = np.clip(im, 0, 1).copy()
    out[..., :3] = np.divide(out[..., :3], np.maximum(out[..., 3:4], 1e-5))
    out[out[..., 3] < .005] = 0
    return np.uint8(np.rint(np.clip(out, 0, 1) * 255))


def sample(im, yy, xx):
    return np.stack([ndi.map_coordinates(im[..., c], [yy, xx], order=1,
                                        mode='constant', cval=0)
                     for c in range(im.shape[-1])], axis=-1)


def features(im):
    # Alpha is a second feature. RGB+alpha share exactly the resulting mapping.
    p = premult(im)
    lum = np.sum(p[..., :3] * np.array([.299, .587, .114]), axis=-1)
    return np.stack([lum, p[..., 3] * .6], axis=-1)


def correspondence(a, b):
    """Pyramidal windowed multichannel Lucas-Kanade, target B sampled from A.

    The implementation is deterministic and local; it is a candidate generator,
    not a semantic or anatomy validator. Only curated compatible close poses are
    eligible. Large correspondence cannot be accepted using an error metric.
    """
    fa = ndi.zoom(features(a), (.5, .5, 1), order=1)
    fb = ndi.zoom(features(b), (.5, .5, 1), order=1)
    fy = fx = None
    for level in [3, 2, 1, 0]:
        factor = 1 / (2 ** level)
        aa = ndi.zoom(fa, (factor, factor, 1), order=1)
        bb = ndi.zoom(fb, (factor, factor, 1), order=1)
        h, w = aa.shape[:2]
        if fy is None:
            fy = np.zeros((h, w), np.float32)
            fx = np.zeros_like(fy)
        else:
            fy = ndi.zoom(fy, (h / fy.shape[0], w / fy.shape[1]), order=1) * 2
            fx = ndi.zoom(fx, (h / fx.shape[0], w / fx.shape[1]), order=1) * 2
        yy, xx = np.mgrid[:h, :w].astype(np.float32)
        gy, gx = np.gradient(bb, axis=(0, 1))
        for _ in range(12):
            warped = sample(bb, yy + fy, xx + fx)
            ix = sample(gx, yy + fy, xx + fx)
            iy = sample(gy, yy + fy, xx + fx)
            residual = aa - warped
            def avg(v):
                return ndi.uniform_filter(np.sum(v, axis=-1), 7)
            axx, ayy, axy = avg(ix*ix)+1e-5, avg(iy*iy)+1e-5, avg(ix*iy)
            bx, by = avg(ix*residual), avg(iy*residual)
            det = np.maximum(axx*ayy-axy*axy, 1e-9)
            dx = np.clip((ayy*bx-axy*by)/det, -1.5, 1.5)
            dy = np.clip((axx*by-axy*bx)/det, -1.5, 1.5)
            fx = ndi.gaussian_filter(fx+dx, .65)
            fy = ndi.gaussian_filter(fy+dy, .65)
    return ndi.zoom(np.stack([fy, fx], axis=-1), (2, 2, 1), order=1)*2


def registered_rgba(a, b, flow, t):
    if t <= 0:
        return np.uint8(np.rint(a*255))
    if t >= 1:
        return np.uint8(np.rint(b*255))
    yy, xx = np.mgrid[:a.shape[0], :a.shape[1]].astype(np.float32)
    qy, qx = yy.copy(), xx.copy()
    # Invert the intermediate point y = x + t*flow(x).
    for _ in range(5):
        f = sample(flow, qy, qx)
        qy, qx = yy - t*f[..., 0], xx - t*f[..., 1]
    f = sample(flow, qy, qx)
    pa = sample(premult(a), qy, qx)
    pb = sample(premult(b), qy+f[..., 0], qx+f[..., 1])
    return straight((1-t)*pa+t*pb)


def mesh_rgba(a, b, anchors, t):
    """One explicit anatomical/prop mesh, shared by all premult RGBA channels.

    Anchors are observed source pixel positions, not newly generated artwork.
    It deliberately avoids correspondence in the fluid-appearance occlusion.
    """
    aa, bb = np.asarray(anchors[0],float), np.asarray(anchors[1],float)
    mid = (1-t)*aa+t*bb
    yy, xx = np.mgrid[:a.shape[0], :a.shape[1]].astype(np.float32)
    points = np.stack([xx.ravel(),yy.ravel()],axis=-1)
    srca = RBFInterpolator(mid, aa-mid, kernel='thin_plate_spline',smoothing=.1)(points)+points
    srcb = RBFInterpolator(mid, bb-mid, kernel='thin_plate_spline',smoothing=.1)(points)+points
    pa = sample(premult(a),srca[:,1].reshape(512,512),srca[:,0].reshape(512,512))
    pb = sample(premult(b),srcb[:,1].reshape(512,512),srcb[:,0].reshape(512,512))
    return straight((1-t)*pa+t*pb)


def smooth(t):
    return t*t*(3-2*t)


def decode(source, target):
    target.mkdir(parents=True, exist_ok=True)
    # A repeated run must not count stale files or mix shifted frame IDs.
    # Only this isolated derived output directory is mutable here.
    for old in target.glob('*.png'):
        old.unlink()
    run(['ffmpeg', '-v', 'error', '-y', '-threads', '2', '-c:v', 'libvpx-vp9',
         '-i', source, '-vsync', '0', '-start_number', '0', target/'%03d.png'])


def encode(folder):
    frames = folder/'frames-rgba'
    output = folder/'candidate.webm'
    for crf in [22, 26, 30, 34, 38, 42, 46, 50]:
        run(['ffmpeg', '-v', 'error', '-y', '-framerate', FPS,
             '-i', frames/'%03d.png', '-c:v', 'libvpx-vp9', '-threads', 2,
             '-pix_fmt', 'yuva420p', '-auto-alt-ref', 0, '-b:v', 0,
             '-crf', crf, '-deadline', 'good', '-cpu-used', 2,
             '-an', '-frames:v', N, output])
        if output.stat().st_size <= 261900:
            break
    assert output.stat().st_size <= 262144
    return crf


def review_assets(folder, decoded):
    """Complete native frames + a fully enumerated review sheet, not acceptance."""
    views = folder/'views'
    views.mkdir(parents=True, exist_ok=True)
    for i, p in enumerate(sorted(decoded.glob('*.png'))):
        im = Image.open(p).convert('RGBA')
        canvas = Image.new('RGB', (512, 536), '#e9edf4')
        canvas.paste(im, (0, 24), im)
        ImageDraw.Draw(canvas).text((6, 5), f'{folder.name} f{i:03d} {i/FPS:.3f}s', fill='#101820')
        canvas.save(views/f'{i:03d}.jpg', quality=94)
    for page in range(7):
        board = Image.new('RGB', (1536, 1206), '#e9edf4')
        for j in range(12):
            i = page*12+j
            if i >= N:
                break
            im = Image.open(views/f'{i:03d}.jpg').resize((384, 536//4*3), Image.Resampling.LANCZOS)
            # Native per-frame files remain separately available.
            board.paste(im, ((j%4)*384, (j//4)*(536//4*3)))
        board.save(folder/f'all-frames-{page+1}.jpg', quality=94)
    # Review video is explicitly made from candidate's decoded native output.
    for speed, name in [(1, 'normal'), (2, 'slow')]:
        run(['ffmpeg', '-v', 'error', '-y', '-framerate', FPS,
             '-i', views/'%03d.jpg', '-vf', f'setpts={speed}*PTS,format=yuv420p',
             '-c:v', 'libx264', '-threads', 2, '-crf', 16, '-an',
             '-movflags', '+faststart', folder/f'review-{name}.mp4'])


def candidate(rank, name, source_frames, action_count, closure_count, notes, closure_anchors=None, local_flow_limit=None):
    folder = ROOT/'candidates'/name
    folder.mkdir(parents=True, exist_ok=True)
    source = REPO/'assets/stickers'/f'lumen_{rank:02d}.webm'
    manifest = json.loads((REPO/'assets/stickers/manifest.json').read_text())
    item = next(x for x in manifest if x['id'] == f'lumen_{rank:02d}')
    before = folder/'before'
    if not (before/'083.png').exists():
        decode(source, before)
    images = {f: rgba(before/f'{f:03d}.png') for f in set(source_frames)}
    out = folder/'frames-rgba'
    out.mkdir(exist_ok=True)
    cache = {}
    lineage = []
    def interpolate_pair(a_id, b_id, t):
        if a_id == b_id:
            return np.uint8(np.rint(images[a_id]*255))
        key = (a_id, b_id)
        if key not in cache:
            cache[key] = correspondence(images[a_id], images[b_id])
            if local_flow_limit:
                # Close actual source frames do not justify unconstrained
                # aperture-region flow. Bound and smooth the shared map before
                # inversion, then require a nonfolding field. This removes the
                # numerical cause of holes/speckles, not anatomy in the source.
                ff=ndi.gaussian_filter(cache[key],(3,3,0))
                mag=np.linalg.norm(ff,axis=-1,keepdims=True)
                ff*=np.minimum(1,local_flow_limit/np.maximum(mag,1e-6))
                for sigma in [1,2,3,5,8]:
                    ff=ndi.gaussian_filter(ff,(sigma,sigma,0))
                    fy,fx=ff[...,0],ff[...,1]
                    fyy,fyx=np.gradient(fy);fxy,fxx=np.gradient(fx)
                    if np.min((1+fxx)*(1+fyy)-fxy*fyx)>.7:break
                cache[key]=ff
        return registered_rgba(images[a_id], images[b_id], cache[key], t)
    # Ease the *actual ordered action*, never reverse a falling prop or fluid.
    # Quantities are exact output-frame counts, not inferred from FPS metadata.
    for i in range(action_count):
        t = i/(action_count-1)
        p = smooth(t)*(len(source_frames)-1)
        lo, hi = int(math.floor(p)), min(int(math.floor(p))+1, len(source_frames)-1)
        a_id, b_id, weight = source_frames[lo], source_frames[hi], p-lo
        arr = interpolate_pair(a_id, b_id, weight)
        atomic_save(Image.fromarray(arr, 'RGBA'),out/f'{i:03d}.png')
        lineage.append({'output_frame':i,'source_frames':[a_id,b_id],
                        'source_seconds':[a_id/FPS,b_id/FPS],
                        'fraction':weight,'kind':'ordered_action_registered_rgba'})
    for j in range(closure_count):
        i = action_count+j
        t = smooth((j+1)/(closure_count+1))
        a_id, b_id = source_frames[-1], source_frames[0]
        arr = (mesh_rgba(images[a_id],images[b_id],closure_anchors,t)
               if closure_anchors else interpolate_pair(a_id, b_id, t))
        atomic_save(Image.fromarray(arr, 'RGBA'),out/f'{i:03d}.png')
        lineage.append({'output_frame':i,'source_frames':[a_id,b_id],
                        'source_seconds':[a_id/FPS,b_id/FPS],
                        'fraction':t,'kind':'curated_closure_anatomical_mesh_rgba' if closure_anchors else 'curated_closure_registered_rgba'})
    assert len(lineage)==N
    crf = encode(folder)
    decoded = folder/'decoded'
    decode(folder/'candidate.webm', decoded)
    assert len(list(decoded.glob('*.png')))==N, 'Incomplete decode is a hard failure'
    Image.open(out/'000.png').save(folder/'poster.png')
    arrays = [np.asarray(Image.open(p).convert('RGBA'),dtype=np.float32)
              for p in sorted(decoded.glob('*.png'))]
    composited = [a[...,:3]*a[...,3:4]/255+233*(1-a[...,3:4]/255) for a in arrays]
    deltas = [float(np.abs(composited[i]-composited[(i+1)%N]).mean()) for i in range(N)]
    proof = {
        'schema_version':1, 'id':item['id'], 'candidate':name,
        'created_at':datetime.now(timezone.utc).isoformat(),
        'source_kind':'derived_decoded_video',
        'source_path':str(source), 'source_video_sha256':sha(source),
        'source_original_keyposes_status':'unresolved_original_not_recovered',
        'ancestor_original_keyposes_sha256':item['source_keyposes_sha256'],
        'derived_source_frames':[{'index':f,'seconds':f/FPS,
                                 'decoded_png_sha256':sha(before/f'{f:03d}.png')}
                                 for f in sorted(images)],
        'derived_keyframes_bundle_sha256':hashlib.sha256(''.join(sha(before/f'{f:03d}.png') for f in sorted(images)).encode()).hexdigest(),
        'source_frame_count':84,'source_action_frames':source_frames,
        'action_output_frames':action_count,'closure_output_frames':closure_count,
        'method':'scene-curated ordered temporal edit; shared multichannel Lucas-Kanade RGBA correspondence; premultiplied registered sampling; eased closure',
        'notes':notes, 'lineage':lineage, 'closure_anchors':closure_anchors,
        'local_flow_limit_px':local_flow_limit,
        'candidate_sha256':sha(folder/'candidate.webm'),
        'poster_sha256':sha(folder/'poster.png'), 'crf':crf,
        'bytes':(folder/'candidate.webm').stat().st_size,
        'frames':len(arrays),'fps':FPS,'duration':N/FPS,
        'unique_decoded_frames':len({hashlib.sha256(a.tobytes()).hexdigest() for a in arrays}),
        'alpha_range':[int(min(a[...,3].min() for a in arrays)),int(max(a[...,3].max() for a in arrays))],
        'blank_frames':[i for i,a in enumerate(arrays) if not np.any(a[...,3]>16)],
        'adjacent_composite_mae':deltas[:-1], 'seam_composite_mae':deltas[-1],
        'source_review':'author individually inspected every84 source frames at224px; native512px relevant defect/anchors',
        'candidate_visual_review':'pending',
        'independent_review':'pending', 'native_playback':'pending',
        'device_playback':'pending','canonical_assets_changed':False,
        'telegram_limits_source':{'url':'https://core.telegram.org/stickers/webm-vp9-encoding','verified_at':'2026-10-30','limits':{'max_seconds':3,'max_fps':30,'max_bytes':262144,'codec':'vp9','no_audio':True,'one_side_px':512}},
    }
    (folder/'proof.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
    review_assets(folder, decoded)
    review_assets(folder/'source-review', before)
    print(json.dumps({'folder':str(folder),'hash':proof['candidate_sha256'],
                      'bytes':proof['bytes'],'seam_mae':deltas[-1]},ensure_ascii=False),flush=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('trial',choices=['51a','51b','94a','94b','113a'])
    args=parser.parse_args()
    if args.trial in ['51a','51b']:
        bounce=list(range(13))+list(range(11,-1,-1))
        candidate(51,'lumen_51_curated-bounce_'+args.trial[-1],bounce+bounce[1:-1],78,6,
                  ['Source0–12 preserves actual welcoming paws, smiling blink, moving torso/legs and cushion.',
                   'Two cheerful bounce cycles from an explicitly reversible local body rise/fall; no independent prop/fluid/particle dynamics reversed.',
                   'Damaged arm transitions46–49 and57–59 omitted; main greeting/cushion/bounce retained.',
                   'Nonrigid shape/face acting comes from multiple actual decoded source poses, not a whole-image transform.'],
                   local_flow_limit=6 if args.trial=='51b' else None)
    elif args.trial in ['94a','94b']:
        # Every pair is observed in native023/000 PNGs: ear boundary/face,
        # nose/eyes, cape/hand, feet and bucket rim/base. Canvas corners pin the
        # exterior; there is no global translation/rotation/scale animation.
        frame23=[[0,0],[511,0],[0,511],[511,511],[180,74],[91,147],[154,207],[245,144],[324,140],[407,143],[466,208],[405,278],[110,249],[220,273],[343,309],[290,319],[290,356],[95,334],[157,369],[350,377],[36,372],[90,428],[125,466],[187,383],[334,384],[212,477],[329,476]]
        frame0 =[[0,0],[511,0],[0,511],[511,511],[166,60],[81,135],[146,197],[240,135],[325,126],[417,149],[473,219],[399,291],[111,230],[220,259],[341,296],[286,309],[276,347],[89,319],[158,366],[352,380],[29,354],[85,421],[123,466],[187,384],[348,385],[206,484],[331,485]]
        anchors=[frame23,frame0] if args.trial=='94b' else None
        candidate(94,'lumen_94_forward-vomit_'+args.trial[-1],list(range(24)),56,28,
                  ['Principal nausea/vomiting/bucket scene retained.',
                   'Joyful recovery and incompatible bucket/whole-body return excluded.',
                   'Fluid/props are not temporally reversed. Closure introduces next vomiting pulse from consistent close poses; requires visual fluid check.',
                   'No global transform or rigid whole-image wiggle.'], anchors)
    else:
        candidate(113,'lumen_113_held-surprise_a',list(range(75,84))+list(range(6)),56,28,
                  ['Jaw-dropped surprise with scroll-held startled reaction retained.',
                   'Falling-scroll episode excluded to avoid unmotivated reverse gravity/retrieval.',
                   'Semantic tradeoff: reduced scroll action; acceptance is explicitly pending lead/root review.',
                   'Actual close-range hand/cape/body acting retained; no rigid global wiggle.'])


if __name__=='__main__':
    main()
