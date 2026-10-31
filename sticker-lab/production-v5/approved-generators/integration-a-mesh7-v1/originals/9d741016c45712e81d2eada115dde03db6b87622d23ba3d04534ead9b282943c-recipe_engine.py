#!/usr/bin/env python3
"""Portable, source-checked RGBA recipe renderer. It never reads canonical video.

Authors supply item-specific scene/part recipes and exact decoded input PNGs.
This engine owns correspondence/sampling/encoding; a recipe is not approval.
"""
from __future__ import annotations
import argparse, hashlib, json, math, platform, subprocess
from pathlib import Path
import numpy as np
import scipy
from scipy import ndimage as ndi
from scipy.interpolate import CubicSpline, RBFInterpolator
from PIL import Image
import PIL
import repair as core


def read(path):
    return json.loads(Path(path).read_text())


def project_root():
    return next(p for p in Path(__file__).resolve().parents
                if (p/'assets/stickers/manifest.json').is_file())


def field(points, motion):
    yy, xx = np.mgrid[:512, :512].astype(np.float32)
    coords = np.stack([xx.ravel(), yy.ravel()], axis=-1)
    return RBFInterpolator(np.asarray(points, float), np.asarray(motion, float),
                           kernel='thin_plate_spline', smoothing=.1)(coords).reshape(512,512,2).astype(np.float32)


def wave(spec, i, n):
    phase = 2*math.pi*i/n
    if spec['kind'] == 'sin':
        return math.sin(phase*spec.get('repeats', 1))
    if spec['kind'] == 'periodic_cubic_pulse':
        pulse = CubicSpline(spec['times'], spec['values'], bc_type='periodic')
        value = float(pulse((i/n*spec['repeats']) % 1))
        mod = spec.get('amplitude_modulation', {'base':1., 'cosine':0.})
        return value*(mod['base']+mod['cosine']*math.cos(phase))
    raise ValueError('Unsupported wave; add an independently reviewed engine change')


def mesh_frames(recipe, images, folder):
    spec = recipe['local_mesh']; src = images[spec['source_frame']]
    fields = [field(spec['points_xy'], p['displacement_xy_px']) for p in spec['parts']]
    fluid = None
    if spec.get('fluid_texture'):
        f = spec['fluid_texture']; yy0, xx0 = np.mgrid[:512,:512]
        g=src[...,1]; r=src[...,0]; b=src[...,2]
        x0,y0,x1,y1 = f['mask_bounds_exclusive_xyxy']
        mask=(g>r*f['green_over_red'])&(g>b*f['green_over_blue'])&(g>f['minimum_green'])&(xx0>x0)&(xx0<x1)&(yy0>y0)&(yy0<y1)
        assert mask.sum() > f['minimum_mask_pixels']
        idx=ndi.distance_transform_edt(~mask,return_distances=False,return_indices=True)
        green=src[idx[0],idx[1],:3]
        start,end=f['tile_y_interval']; tile=green[start:end].copy()
        tile=(tile+tile[::-1])/2
        fluid={'mask':mask,'tile':tile,'y0':start,'period':end-start,'cycles':f['downward_periods_per_loop']}
    n=recipe['output']['frames']; yy,xx=np.mgrid[:512,:512].astype(np.float32)
    minimum=100.; maximum=0.
    for i in range(n):
        weights=[wave(p['wave'],i,n) for p in spec['parts']]
        displacement=weights[0]*fields[0]
        for weight,ff in zip(weights[1:],fields[1:]): displacement=displacement+weight*ff
        dx,dy=displacement[...,0],displacement[...,1]
        dxy,dxx=np.gradient(dx);dyy,dyx=np.gradient(dy)
        jac=(1+dxx)*(1+dyy)-dxy*dyx
        minimum=min(minimum,float(jac.min())); maximum=max(maximum,float(np.sqrt(dx*dx+dy*dy).max()))
        assert float(jac.min()) > spec['minimum_jacobian'], 'Reject folding/local strain'
        qy,qx=yy.copy(),xx.copy()
        for _ in range(5):
            qx=xx-ndi.map_coordinates(dx,[qy,qx],order=1,mode='nearest')
            qy=yy-ndi.map_coordinates(dy,[qy,qx],order=1,mode='nearest')
        animated_src=src
        if fluid:
            animated_src=src.copy();my,mx=np.where(fluid['mask'])
            sy=(my-fluid['y0']-fluid['cycles']*fluid['period']*i/n)%fluid['period']
            colors=np.stack([ndi.map_coordinates(fluid['tile'][...,c],[sy,mx],order=1,mode='grid-wrap') for c in range(3)],axis=-1)
            animated_src[my,mx,:3]=colors
        arr=core.straight(core.sample(core.premult(animated_src),qy,qx))
        core.atomic_save(Image.fromarray(arr,'RGBA'),folder/f'{i:03d}.png')
    return {'minimum_jacobian':minimum,'maximum_displacement_px':maximum}


def temporal_frames(recipe, images, folder):
    spec=recipe['temporal_edit']; order=spec['source_order']; cache={}
    def interp(a_id,b_id,t):
        if a_id==b_id:return np.uint8(np.rint(images[a_id]*255))
        key=(a_id,b_id)
        if key not in cache:
            ff=core.correspondence(images[a_id],images[b_id]); limit=spec['local_flow_limit_px']
            ff=ndi.gaussian_filter(ff,(3,3,0));mag=np.linalg.norm(ff,axis=-1,keepdims=True)
            ff*=np.minimum(1,limit/np.maximum(mag,1e-6))
            for sigma in [1,2,3,5,8]:
                ff=ndi.gaussian_filter(ff,(sigma,sigma,0));fy,fx=ff[...,0],ff[...,1]
                fyy,fyx=np.gradient(fy);fxy,fxx=np.gradient(fx)
                if np.min((1+fxx)*(1+fyy)-fxy*fyx)>.7:break
            cache[key]=ff
        return core.registered_rgba(images[a_id],images[b_id],cache[key],t)
    action=spec['action_output_frames'];closure=spec['closure_output_frames']
    assert action+closure==recipe['output']['frames']
    for i in range(action):
        pos=core.smooth(i/(action-1))*(len(order)-1);lo=int(math.floor(pos));hi=min(lo+1,len(order)-1)
        arr=interp(order[lo],order[hi],pos-lo)
        core.atomic_save(Image.fromarray(arr,'RGBA'),folder/f'{i:03d}.png')
    for j in range(closure):
        arr=interp(order[-1],order[0],core.smooth((j+1)/(closure+1)))
        core.atomic_save(Image.fromarray(arr,'RGBA'),folder/f'{action+j:03d}.png')
    return {'flow_limit_px':spec['local_flow_limit_px'],'registered_pairs':len(cache)}


def render(recipe_path, output, repo_root=None, encode=True):
    recipe_path=Path(recipe_path).resolve(); recipe=read(recipe_path)
    repo=Path(repo_root).resolve() if repo_root else project_root();output=Path(output).resolve()
    assert recipe['schema_version']==1 and recipe['source_provenance']['kind']=='derived_decoded_video'
    outspec=recipe['output']
    assert (outspec['width'],outspec['height'],outspec['fps'],outspec['frames'])==(512,512,30,84)
    assert outspec['duration']==2.8 and outspec['no_audio'] is True
    assert not output.is_relative_to(repo/'assets'), 'Renderer cannot write canonical assets'
    assert not output.exists() or not any(output.iterdir()), 'Render into an empty isolated folder'
    generator=recipe.get('generator')
    if generator:
        assert core.sha(__file__)==generator['engine_sha256']
        assert core.sha(Path(core.__file__))==generator['support_sha256']
    hashes=[];images={}
    for f in sorted(recipe['source_frames'],key=lambda f:f['index']):
        source=(repo/f['path']).resolve(); assert core.sha(source)==f['sha256']
        hashes.append(f['sha256']);images[f['index']]=core.rgba(source)
    bundle=hashlib.sha256(''.join(hashes).encode('ascii')).hexdigest()
    assert bundle==recipe['source_provenance']['derived_source_bundle_sha256']
    output.mkdir(parents=True,exist_ok=True);frames=output/'frames-rgba';frames.mkdir()
    if recipe['engine_mode']=='shared_local_mesh_v1':stats=mesh_frames(recipe,images,frames)
    elif recipe['engine_mode']=='curated_shared_flow_v1':stats=temporal_frames(recipe,images,frames)
    else:raise ValueError('Unsupported engine mode')
    png_hashes=[core.sha(frames/f'{i:03d}.png') for i in range(recipe['output']['frames'])]
    expected=recipe.get('expected',{}); raw_match=None
    if expected.get('frames_rgba_png_sha256'):
        raw_match=png_hashes==expected['frames_rgba_png_sha256'];assert raw_match,'Raw RGBA rerender differs'
    report={'schema_version':1,'id':recipe['id'],'recipe_path':str(recipe_path),'recipe_sha256':core.sha(recipe_path),
            'source_kind':'derived_decoded_video','canonical_video_read':False,'canonical_assets_changed':False,
            'frames_rgba_png_sha256':png_hashes,'raw_rgba_exact_match':raw_match,'statistics':stats,
            'environment':{'python':platform.python_version(),'numpy':np.__version__,'scipy':scipy.__version__,'Pillow':PIL.__version__},
            'native_realtime_slow_device_playback':'pending','approval_inferred':False}
    if encode:
        o=recipe['output']; out=output/'candidate.webm'
        core.run(['ffmpeg','-v','error','-y','-framerate',o['fps'],'-i',frames/'%03d.png',
                  '-c:v','libvpx-vp9','-threads',2,'-pix_fmt','yuva420p','-auto-alt-ref',0,'-b:v',0,
                  '-crf',o['crf'],'-deadline','good','-cpu-used',2,'-an','-frames:v',o['frames'],out])
        assert out.stat().st_size<=262144
        decoded=output/'decoded';core.decode(out,decoded)
        decoded_hashes=[core.sha(decoded/f'{i:03d}.png') for i in range(o['frames'])]
        report.update({'output_sha256':core.sha(out),'output_bytes':out.stat().st_size,
                       'decoded_png_sha256':decoded_hashes,
                       'encoded_frame_exact_match':decoded_hashes==expected['decoded_png_sha256'] if expected.get('decoded_png_sha256') else None,
                       'container_bytes_exact_match':core.sha(out)==expected['output_sha256'] if expected.get('output_sha256') else None,
                       'ffmpeg':subprocess.check_output(['ffmpeg','-version'],text=True).splitlines()[0]})
        if expected.get('decoded_png_sha256'):assert report['encoded_frame_exact_match'],'Encoded frame rerender differs'
    (output/'rerender-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return report


def main():
    p=argparse.ArgumentParser();p.add_argument('recipe',type=Path);p.add_argument('output',type=Path)
    p.add_argument('--repo-root',type=Path);p.add_argument('--no-encode',action='store_true');args=p.parse_args()
    report=render(args.recipe,args.output,args.repo_root,not args.no_encode)
    print(json.dumps({k:v for k,v in report.items() if not k.endswith('png_sha256')},ensure_ascii=False))


if __name__=='__main__':main()
