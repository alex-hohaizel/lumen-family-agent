#!/usr/bin/env python3
"""Produce transparent, whole-pose VP9 loops. Never uploads or runs the bot.

Keep the generated anatomy intact. RIFE interpolates full frames twice, over
black and white, so a real alpha matte can be reconstructed without a key color.
"""
import argparse,hashlib,json,subprocess,time,shutil,fcntl
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw,ImageFont
from scipy import ndimage

ROOT=Path(__file__).resolve().parent
REPO=ROOT.parents[1]
RUNTIME=REPO.parent/'rife-runtime/rife-ncnn-vulkan-20221029-ubuntu'
SIZE=512;FPS=30;FRAMES=84;DURATION=2.8;RIFE_FRAMES=95

def run(args,**kw):return subprocess.run([str(x) for x in args],check=True,**kw)
def asset_dir(rank):return ROOT/'work'/f'lumen_{rank:02d}'
def prepare(rank):
    d=asset_dir(rank);d.mkdir(parents=True,exist_ok=True)
    source=ROOT/'sources'/f'lumen_{rank:02d}.png'
    im=Image.open(source).convert('RGBA');a=np.asarray(im).copy();h,w=a.shape[:2]
    assert w/h>1.3 and w/h<2.1, f'Unexpected sheet proportions {im.size}'
    assert (a[:,:,3]<10).mean()>.10,'Source needs real transparency'
    cw=w/4;ch=h/2
    for folder in ['poses','input-black','input-white','interpolated-black','interpolated-white','frames-rgba']:(d/folder).mkdir(exist_ok=True)
    poses=[];notes=[]
    # Group all connected art elements by their cell, including detached stars,
    # confetti, petals and hearts. Each retains its original local position.
    labs,n=ndimage.label(a[:,:,3]>24);sizes=np.bincount(labs.ravel())
    groups=[[] for _ in range(8)]
    for k in range(1,n+1):
        if sizes[k]<12:continue
        yy,xx=np.where(labs==k);cell=min(1,int(np.median(yy)/ch))*4+min(3,int(np.median(xx)/cw));groups[cell].append(k)
    localbounds=[]
    for cell in range(8):
        yy,xx=np.where(np.isin(labs,groups[cell]));assert len(xx),f'No pose {cell}'
        localbounds.append((float(xx.min())-(cell%4)*cw,float(yy.min())-(cell//4)*ch,float(xx.max()+1)-(cell%4)*cw,float(yy.max()+1)-(cell//4)*ch))
    union=(min(b[0] for b in localbounds)-4,min(b[1] for b in localbounds)-4,max(b[2] for b in localbounds)+4,max(b[3] for b in localbounds)+4)
    scale=min(464/(union[2]-union[0]),464/(union[3]-union[1]));padx=(SIZE-(union[2]-union[0])*scale)/2;pady=(SIZE-(union[3]-union[1])*scale)/2
    for cell in range(8):
        ids=groups[cell];assert ids,f'No pose {cell}'
        mask=np.isin(labs,ids);yy,xx=np.where(mask);x0=max(0,int(xx.min())-3);x1=min(w,int(xx.max())+4);y0=max(0,int(yy.min())-3);y1=min(h,int(yy.max())+4)
        assert sizes[ids].max()>12000,f'Character absent in cell {cell}'
        # Neighbouring actors must never merge. Reject rather than cut a paw.
        assert (x1-x0)<cw*1.16 and (y1-y0)<ch*1.13,f'Overlapping poses in cell {cell}'
        crop=a[y0:y1,x0:x1].copy();crop[:,:,3]*=ndimage.binary_dilation(mask,iterations=2)[y0:y1,x0:x1]
        piece=Image.fromarray(crop).resize((round((x1-x0)*scale),round((y1-y0)*scale)),Image.Resampling.LANCZOS)
        originx=(cell%4)*cw;originy=(cell//4)*ch
        x=round(padx+(x0-originx-union[0])*scale);y=round(pady+(y0-originy-union[1])*scale)
        canvas=Image.new('RGBA',(SIZE,SIZE));canvas.alpha_composite(piece,(x,y));bounds=canvas.getchannel('A').getbbox()
        assert bounds and min(bounds[:2])>0 and max(bounds[2:])<SIZE,f'Clipped pose {cell}: {bounds}'
        canvas.save(d/'poses'/f'{cell:02d}.png');poses.append(canvas);notes.append({'cell':cell,'bounds':bounds,'components':len(ids)})
    # The large side-roll drawings have an excessive angle change between 3/4.
    # Use the coherent rocking poses rather than accepting a ghosted crossfade.
    sequence={3:[0,1,2,3,2,1,0,7,0],18:[0,1,6,7,6,1,0,1,0],20:[0,7,6,7,0,7,6,7,0],28:[0,7,6,7,0,2,0,7,0],34:[0,1,5,7,5,1,0,1,0],35:[0,1,2,3,4,3,2,1,0]}.get(rank,list(range(8))+[0])
    for mode,col in [('black','black'),('white','white')]:
        for i,k in enumerate(sequence):
            bg=Image.new('RGBA',(SIZE,SIZE),col);bg.alpha_composite(poses[k]);bg.convert('RGB').save(d/('input-'+mode)/f'{i:03d}.png')
    (d/'extraction.json').write_text(json.dumps({'rank':rank,'source_size':im.size,'uniform_scale':scale,'sequence':sequence,'poses':notes},indent=2)+'\n')
    board=Image.new('RGB',(1024,512),'#e9edf4')
    for i,p in enumerate(poses):
        p=p.resize((256,256),Image.Resampling.LANCZOS);board.paste(p,((i%4)*256,(i//4)*256),p)
    board.save(ROOT/'review'/f'lumen_{rank:02d}_keyposes.jpg',quality=94)
    return d

def interpolate(d,threads):
    for mode in ['black','white']:
        folder=d/('interpolated-'+mode)
        fingerprint=hashlib.sha256(b''.join(p.read_bytes() for p in sorted((d/('input-'+mode)).glob('*.png')))).hexdigest()
        cache=d/f'rife-{mode}-inputs.json'
        state=json.loads(cache.read_text()) if cache.exists() else {}
        if len(list(folder.glob('*.png')))==RIFE_FRAMES and state.get('sha256')==fingerprint:continue
        with (d/f'rife-{mode}.log').open('w') as log:
            run([RUNTIME/'rife-ncnn-vulkan','-i',d/('input-'+mode),'-o',folder,'-n',RIFE_FRAMES,'-m',RUNTIME/'rife-v4.6','-g','-1','-j',f'1:{threads}:1','-f','%03d.png'],stdout=log,stderr=log)
        assert len(list(folder.glob('*.png')))==RIFE_FRAMES
        cache.write_text(json.dumps({'sha256':fingerprint,'frames':RIFE_FRAMES})+'\n')

def matte(d):
    blacks=sorted((d/'interpolated-black').glob('*.png'));whites=sorted((d/'interpolated-white').glob('*.png'))
    assert len(blacks)==len(whites)==RIFE_FRAMES
    # This runtime maps N outputs across input_count, including a final hold.
    # 95 / 9 * 8 = 84.44: keep the 84 actual moving frames, omit the tail hold.
    # Native output is still exactly 84 frames / 30fps = 2.8 seconds.
    for i,(bp,wp) in enumerate(zip(blacks[:FRAMES],whites[:FRAMES])):
        b=np.asarray(Image.open(bp).convert('RGB'),dtype=np.float32)/255
        w=np.asarray(Image.open(wp).convert('RGB'),dtype=np.float32)/255
        a=np.clip(1-np.median(w-b,axis=2),0,1)
        # Retain all substantive components, including deliberately detached props.
        labels,n=ndimage.label(a>.025);counts=np.bincount(labels.ravel());keepids=np.flatnonzero(counts>=8);keepids=keepids[keepids!=0]
        keep=ndimage.binary_dilation(np.isin(labels,keepids),iterations=1)
        a*=keep;a[a<.018]=0;a[a>.985]=1
        rgb=np.clip((b+w-(1-a[:,:,None]))/(2*np.maximum(a[:,:,None],.02)),0,1)
        rgba=Image.fromarray(np.rint(np.dstack([rgb,a])*255).astype('uint8'),'RGBA');rgba.save(d/'frames-rgba'/f'{i:03d}.png')
    (d/'frame-phase.json').write_text(json.dumps({'phase':0})+'\n')

def encode(rank,d):
    frames=d/'frames-rgba';webm=d/f'lumen_{rank:02d}.webm'
    # One fixed crop and uniform scale for the ENTIRE scene and ENTIRE loop.
    # This makes previews legible without independently moving body parts or
    # fitting each pose (which would introduce artificial zoom/bobbing).
    images=[Image.open(frames/f'{i:03d}.png').convert('RGBA') for i in range(FRAMES)]
    phasefile=d/'frame-phase.json';phase=json.loads(phasefile.read_text()).get('phase',0) if phasefile.exists() else (42 if rank==1 else 0)
    wanted={1:42,27:42,44:42}.get(rank,0);shift=(wanted-phase)%FRAMES
    images=images[shift:]+images[:shift]
    boxes=[im.getchannel('A').getbbox() for im in images]
    box=(min(b[0] for b in boxes),min(b[1] for b in boxes),max(b[2] for b in boxes),max(b[3] for b in boxes))
    factor=min(464/(box[2]-box[0]),464/(box[3]-box[1]));target=(round((box[2]-box[0])*factor),round((box[3]-box[1])*factor))
    for i,im in enumerate(images):
        piece=im.crop(box).resize(target,Image.Resampling.LANCZOS);canvas=Image.new('RGBA',(SIZE,SIZE));canvas.alpha_composite(piece,((SIZE-target[0])//2,(SIZE-target[1])//2));canvas.save(frames/f'{i:03d}.png')
    phasefile.write_text(json.dumps({'phase':wanted})+'\n')
    # Begin at an expressive keypose, not at an unrelated neutral lead-in.
    first=Image.open(frames/'000.png').convert('RGBA');first.save(d/'poster.png')
    # Find the best integer CRF that fits, rather than leaving a large unused
    # quality budget after a coarse four-step jump. Slower VP9 mode preserves fur.
    low,high=22,60;crf=None;candidate=d/'encode-candidate.webm'
    while low<=high:
        q=(low+high)//2
        run(['ffmpeg','-v','error','-y','-framerate',FPS,'-i',frames/'%03d.png','-c:v','libvpx-vp9','-threads','2','-pix_fmt','yuva420p','-auto-alt-ref','0','-b:v','0','-crf',q,'-deadline','good','-cpu-used','2','-an','-t',DURATION,candidate])
        if candidate.stat().st_size<=261900:shutil.copyfile(candidate,webm);crf=q;high=q-1
        else:low=q+1
    assert crf is not None,'Cannot encode within Telegram limit'
    candidate.unlink(missing_ok=True)
    assert webm.stat().st_size<=262144,'Sticker exceeds Telegram budget'
    run(['ffmpeg','-v','error','-y','-threads','2','-filter_complex_threads','1','-framerate',FPS,'-i',frames/'%03d.png','-f','lavfi','-i','color=c=0xe9edf4:s=512x512:r=30','-filter_complex','[1:v][0:v]overlay=shortest=1:format=auto,format=yuv420p','-c:v','libx264','-threads','2','-crf','16','-preset','fast','-an','-t',DURATION,'-movflags','+faststart',d/'review.mp4'])
    info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(webm)]))
    assert len(info['streams'])==1 and info['streams'][0]['codec_name']=='vp9' and info['streams'][0]['avg_frame_rate']=='30/1'
    raw=subprocess.check_output(['ffmpeg','-v','error','-threads','2','-c:v','libvpx-vp9','-i',str(webm),'-vf','alphaextract','-frames:v','1','-f','rawvideo','-pix_fmt','gray','-'])
    assert min(raw)==0 and max(raw)==255
    samples=[0,10,21,31,42,52,63,73];board=Image.new('RGB',(1024,512),'#e9edf4')
    for k,i in enumerate(samples):
        im=Image.open(frames/f'{i:03d}.png').resize((256,256),Image.Resampling.LANCZOS);board.paste(im,((k%4)*256,(k//4)*256),im)
    board.save(ROOT/'review'/f'lumen_{rank:02d}_motion.jpg',quality=94)
    hashes=[hashlib.sha256((frames/f'{i:03d}.png').read_bytes()).hexdigest() for i in range(FRAMES)]
    loop=float(np.mean(np.abs(np.asarray(first,dtype=float)-np.asarray(Image.open(frames/'083.png'),dtype=float))))
    trailing=0
    for i in range(FRAMES-1,0,-1):
        if hashes[i]!=hashes[i-1]:break
        trailing+=1
    assert trailing<=1,'Unexpected frozen animation tail'
    proof={'rank':rank,'fps':FPS,'frames':FRAMES,'duration':DURATION,'bytes':webm.stat().st_size,'sha256':hashlib.sha256(webm.read_bytes()).hexdigest(),'crf':crf,'alpha_decoded':True,'unique_frames':len(set(hashes)),'trailing_repeated_frames':trailing,'loop_rgba_mae':loop,'method':'whole-pose RIFE v4.6 CPU; no detached parts','technical_pass':True,'visual_review':'pending','cadence_version':2,'encoding_version':2,'preview_phase':wanted}
    (d/'quality.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof),flush=True)

def main():
    p=argparse.ArgumentParser();p.add_argument('rank',type=int);p.add_argument('--prepare-only',action='store_true');p.add_argument('--encode-only',action='store_true');p.add_argument('--threads',type=int,default=4);args=p.parse_args();rank=args.rank
    locked=asset_dir(rank);locked.mkdir(parents=True,exist_ok=True);lock=(locked/'render.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX)
    if args.encode_only:
        qpath=locked/'quality.json';q=json.loads(qpath.read_text()) if qpath.exists() else {};wanted={1:42,27:42,44:42}.get(rank,0);native=locked/f'lumen_{rank:02d}.webm'
        if q.get('encoding_version')==2 and q.get('cadence_version')==2 and q.get('preview_phase')==wanted and native.exists() and hashlib.sha256(native.read_bytes()).hexdigest()==q.get('sha256'):return
        encode(rank,locked);return
    if rank==1:
        d=asset_dir(rank)
        for folder in ['input-black','input-white','interpolated-black','interpolated-white','frames-rgba']:(d/folder).mkdir(parents=True,exist_ok=True)
        for mode in ['black','white']:
            for p in (ROOT.parent/'recovery-v2'/('input-'+mode)).glob('*.png'):shutil.copyfile(p,d/('input-'+mode)/p.name)
        interpolate(d,args.threads);matte(d)
    else:
        d=prepare(rank)
        if args.prepare_only:return
        interpolate(d,args.threads);matte(d)
    encode(rank,d)
if __name__=='__main__':main()
