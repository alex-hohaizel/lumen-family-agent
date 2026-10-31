#!/usr/bin/env python3
"""Explicit, bounded local acting rig over an intact derived RGBA frame.

This is a causal alternative to synthesising transitions between incompatible
anatomy/prop topologies. It never advertises recovered original art. The authored
mesh is named in provenance and acceptance still requires expressive review.
"""
from __future__ import annotations
import argparse, hashlib, json, math
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.interpolate import RBFInterpolator
from scipy.interpolate import CubicSpline
from scipy import ndimage as ndi
import repair as core


def field(points, motion):
    yy,xx=np.mgrid[:512,:512].astype(np.float32)
    coords=np.stack([xx.ravel(),yy.ravel()],axis=-1)
    # Matrix channels are x/y displacement. RGBA uses this one common field.
    val=RBFInterpolator(np.asarray(points,float),np.asarray(motion,float),
                        kernel='thin_plate_spline',smoothing=.1)(coords)
    return val.reshape(512,512,2).astype(np.float32)


def build(rank,variant='rig1'):
    name=f'lumen_{rank:02d}_local-acting_{variant}'
    folder=core.ROOT/'candidates'/name
    folder.mkdir(parents=True,exist_ok=True)
    source=core.REPO/'assets/stickers'/f'lumen_{rank:02d}.webm'
    before=folder/'before'
    core.decode(source,before)
    src=core.rgba(before/'000.png')
    corners=[[0,0],[511,0],[0,511],[511,511],[256,0],[0,256],[511,256],[256,511]]
    if rank==94:
        points=corners+[[164,76],[92,141],[158,191],[230,140],[322,136],[417,167],[465,231],
                        [215,260],[341,295],[285,309],[247,330],[292,339],[281,360],
                        [273,382],[188,386],[348,386],[204,473],[330,473],[271,440],
                        [150,368],[352,371],[123,464],[77,422],[59,352],[109,303],[186,404]]
        heave=[[0,0]]*8+[[1,4],[1,4],[1,5],[2,5],[2,5],[2,5],[2,5],
                           [2,6],[2,6],[2,7],[2,7],[2,7],[1,4],
                           [0,0],[0,0],[0,0],[0,0],[0,0],[0,0],
                           [0,1],[0,1],[0,0],[0,0],[-2,1],[1,3],[0,0]]
        sway=[[0,0]]*8+[[0,-1],[-1,0],[-1,0],[0,0],[0,0],[1,0],[1,0],
                          [0,0],[0,0],[0,0],[0,0],[0,0],[0,0],
                          [0,0],[0,0],[0,0],[0,0],[0,0],[0,0],
                          [-1,0],[1,0],[0,0],[0,0],[-3,1],[-1,0],[0,0]]
        semantic='Continuous nauseated heave while vomiting into the same bucket; eyes squeezed, paws braced. Bucket and planted feet pinned.'
        removed='Cheerful recovery and moving-bucket return omitted; unique vomiting scene retained. Fluid stays attached mouth→bucket under a bounded deformation, no reversed frame trajectory.'
    else:
        points=corners+[[303,47],[76,149],[131,226],[272,125],[351,134],[210,190],[307,166],
                        [272,184],[251,208],[290,202],[275,255],[281,276],[305,291],
                        [126,292],[182,315],[406,247],[432,241],[390,313],[420,332],
                        [322,361],[300,414],[348,460],[74,386],[135,416],[82,333]]
        heave=[[0,0]]*8+[[1,-3],[0,-3],[1,-3],[1,-3],[1,-3],[1,-3],[1,-3],
                           [1,-3],[1,-2],[1,-2],[1,2],[1,2],[1,0],
                           [-2,-5],[0,-1],[3,-3],[3,-3],[3,-3],[3,-3],
                           [0,0],[2,-3],[0,0],[-5,-2],[-3,-1],[-3,-1]]
        sway=[[0,0]]*8+[[1,0],[-1,0],[-1,0],[0,0],[1,0],[0,0],[0,0],
                          [0,0],[0,0],[0,0],[0,0],[0,0],[0,0],
                          [-2,1],[-1,0],[0,-1],[0,-1],[0,-1],[0,-1],
                          [0,0],[1,0],[0,0],[-5,2],[-3,1],[-3,1]]
        semantic='Jaw-dropped startled reaction with an open free paw, locally opening jaw, tense raised foot and held scroll; scroll remains attached to the same paw throughout.'
        removed='Falling-scroll episode omitted; no gravity reversal, retrieval or teleportation. Main surprise+scroll scene retained, reduction of prop action requires explicit semantic review.'
    assert len(points)==len(heave)==len(sway)
    if variant=='rig2':
        if rank==94:
            heave=(np.asarray(heave)*1.9).tolist()
            sway=(np.asarray(sway)*1.4).tolist()
            # The paws brace the rim while the shoulders/head visibly retch.
            # Bucket/base/feet anchors remain exactly zero.
            semantic='Two distinct visible nauseated heaves of head and shoulders over the pinned bucket, braced paws, and green fluid texture advecting continuously downward into the bucket.'
        else:
            heave=[[0,0]]*8+[[ -6,-9],[-7,-8],[-6,-7],[-6,-9],[-5,-9],[-6,-9],[-5,-9],
                                  [-5,-9],[-5,-7],[-4,-7],[-3,3],[-2,5],[0,1],
                                  [-12,-14],[-3,-3],[6,-8],[6,-8],[6,-8],[6,-8],
                                  [2,0],[7,-8],[0,0],[-15,-7],[-9,-3],[-8,-4]]
            sway=(np.asarray(sway)*1.2).tolist()
            semantic='Quick startled recoil with opening jaw, flaring free paw, head/shoulder recoil, tense raised foot and cape response; scroll moves with its gripping paw as one coherent held object.'
    hf,sf=field(points,heave),field(points,sway)
    fluid=None
    if rank==94 and variant=='rig2':
        yy0,xx0=np.mgrid[:512,:512]
        g=src[...,1];r=src[...,0];b=src[...,2]
        mask=(g>r*1.15)&(g>b*1.25)&(g>.3)&(xx0>232)&(xx0<337)&(yy0>329)&(yy0<389)
        assert mask.sum()>500
        # This is the original green fluid's own texture. Extend only its RGB
        # internally, then advect inside the unchanged fluid silhouette. No new
        # liquid shape or image model is invented and no falling frames reverse.
        idx=ndi.distance_transform_edt(~mask,return_distances=False,return_indices=True)
        green=src[idx[0],idx[1],:3]
        y0,y1=330,386
        tile=green[y0:y1].copy()
        tile=(tile+tile[::-1])/2  # periodic endpoint colour, no anatomy blend
        fluid={'mask':mask,'tile':tile,'y0':y0,'period':y1-y0,
               'speed_px_per_second':2*(y1-y0)/2.8}
    pulse=CubicSpline([0,.08,.24,.45,.72,.9,1],
                      [0,-.08,1,.58,.08,0,0],bc_type='periodic')
    yy,xx=np.mgrid[:512,:512].astype(np.float32)
    frames=folder/'frames-rgba';frames.mkdir(exist_ok=True)
    min_jac=100.;max_disp=0.;lineage=[]
    for i in range(core.N):
        phase=2*math.pi*i/core.N
        # One asymmetric acting cycle with a second cape/paw component. This
        # gives different internal part trajectories, not global image wobble.
        h=.5*(1-math.cos(phase))
        s=math.sin(phase)
        if variant=='rig2':
            if rank==94:
                h=float(pulse((i/core.N*2)%1))*(.9+.1*math.cos(phase))
            else:
                h=float(pulse(i/core.N))
        displacement=h*hf+s*sf
        dx,dy=displacement[...,0],displacement[...,1]
        dxy,dxx=np.gradient(dx);dyy,dyx=np.gradient(dy)
        jac=(1+dxx)*(1+dyy)-dxy*dyx
        min_jac=min(min_jac,float(jac.min()))
        max_disp=max(max_disp,float(np.sqrt(dx*dx+dy*dy).max()))
        qy,qx=yy.copy(),xx.copy()
        for _ in range(5):
            qx=xx-ndi.map_coordinates(dx,[qy,qx],order=1,mode='nearest')
            qy=yy-ndi.map_coordinates(dy,[qy,qx],order=1,mode='nearest')
        animated_src=src
        if fluid:
            animated_src=src.copy()
            # The signed y velocity is always positive (toward the bucket).
            # Two complete texture periods per loop make the seam exact.
            mask=fluid['mask'];my,mx=np.where(mask)
            sy=(my-fluid['y0']-2*fluid['period']*i/core.N)%fluid['period']
            # Pixel interpolation at the final row must wrap too; constant
            # sampling there would draw a travelling black seam into the fluid.
            colors=np.stack([ndi.map_coordinates(fluid['tile'][...,c],
                              [sy,mx],order=1,mode='grid-wrap')
                             for c in range(3)],axis=-1)
            animated_src[my,mx,:3]=colors
        arr=core.straight(core.sample(core.premult(animated_src),qy,qx))
        core.atomic_save(Image.fromarray(arr,'RGBA'),frames/f'{i:03d}.png')
        lineage.append({'output_frame':i,'source_frames':[0],
                        'source_seconds':[0.0],'method':'explicit_shared_rgba_local_mesh',
                        'heave_weight':h,'sway_weight':s,
                        'fluid_advection_source_y_offset_px':-2*fluid['period']*i/core.N if fluid else None})
    assert min_jac>.5,'Reject folding or excessive local strain'
    crf=core.encode(folder)
    decoded=folder/'decoded';core.decode(folder/'candidate.webm',decoded)
    assert len(list(decoded.glob('*.png')))==core.N
    Image.open(frames/'000.png').save(folder/'poster.png')
    arrays=[np.asarray(Image.open(p).convert('RGBA'),dtype=np.float32)
            for p in sorted(decoded.glob('*.png'))]
    composites=[a[...,:3]*a[...,3:4]/255+233*(1-a[...,3:4]/255) for a in arrays]
    deltas=[float(np.abs(composites[i]-composites[(i+1)%core.N]).mean()) for i in range(core.N)]
    item=next(x for x in json.loads((core.REPO/'assets/stickers/manifest.json').read_text())
              if x['id']==f'lumen_{rank:02d}')
    bbox=[]
    for a in arrays:
        y,x=np.where(a[...,3]>16);bbox.append([int(x.min()),int(y.min()),int(x.max()+1),int(y.max()+1)])
    proof={'schema_version':1,'id':item['id'],'candidate':name,
           'created_at':datetime.now(timezone.utc).isoformat(),
           'source_kind':'derived_decoded_video','source_path':str(source),
           'source_video_sha256':core.sha(source),
           'source_original_keyposes_status':'unresolved_original_not_recovered',
           'ancestor_original_keyposes_sha256':item['source_keyposes_sha256'],
           'derived_source_frames':[{'index':0,'seconds':0.,'decoded_png_sha256':core.sha(before/'000.png')}],
           'derived_keyframes_bundle_sha256':hashlib.sha256(core.sha(before/'000.png').encode()).hexdigest(),
           'source_frame_count':84,'source_action_frames':[0],
           'method':'single clean derived RGBA frame; explicitly authored bounded anatomical local mesh; periodic part-specific displacement; shared premult RGB+alpha sampling',
           'character_semantics':semantic,'semantic_tradeoff':removed,
           'not_recovered_original_art':True,'not_rigid_global_transform':True,
           'points_xy':points,'heave_xy_px':heave,'sway_xy_px':sway,
           'fluid_advection':{'source':'green texture from exact original decoded f000','direction':'positive_y_toward_bucket','reversed_frames':False,'speed_px_per_second':fluid['speed_px_per_second'],'period_px':fluid['period']} if fluid else None,
           'jacobian_min':min_jac,'maximum_displacement_px':max_disp,
           'lineage':lineage,'candidate_sha256':core.sha(folder/'candidate.webm'),
           'poster_sha256':core.sha(folder/'poster.png'),'crf':crf,
           'bytes':(folder/'candidate.webm').stat().st_size,'frames':len(arrays),
           'fps':30,'duration':2.8,'bounding_boxes':bbox,
           'unique_decoded_frames':len({hashlib.sha256(a.tobytes()).hexdigest() for a in arrays}),
           'alpha_range':[int(min(a[...,3].min() for a in arrays)),int(max(a[...,3].max() for a in arrays))],
           'blank_frames':[i for i,a in enumerate(arrays) if not np.any(a[...,3]>16)],
           'adjacent_composite_mae':deltas[:-1],'seam_composite_mae':deltas[-1],
           'source_review':'author individually inspected all84 source frames at224px; native512px selected defects/anchors',
           'candidate_visual_review':'pending','independent_review':'pending',
           'native_playback':'pending','device_playback':'pending','canonical_assets_changed':False,
           'telegram_limits_source':{'url':'https://core.telegram.org/stickers/webm-vp9-encoding','verified_at':'2026-10-30'}}
    (folder/'proof.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
    core.review_assets(folder,decoded)
    core.review_assets(folder/'source-review',before)
    print(json.dumps({'folder':str(folder),'hash':proof['candidate_sha256'],'bytes':proof['bytes'],
                      'jacobian_min':min_jac,'max_displacement_px':max_disp,'seam':deltas[-1]}),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('rank',type=int,choices=[94,113]);p.add_argument('--variant',choices=['rig1','rig2'],default='rig1');args=p.parse_args()
    build(args.rank,args.variant)
