#!/usr/bin/env python3
"""Package generated character keyframes as small transparent VP9 sticker loops."""
import argparse, hashlib, json, math, shutil, subprocess, tempfile
from pathlib import Path
from PIL import Image, ImageFilter, ImageDraw, ImageFont
import numpy as np
from scipy import ndimage

parser=argparse.ArgumentParser();parser.add_argument('--sources',required=True);parser.add_argument('--output',default='assets/stickers');parser.add_argument('--limit',type=int,default=0);args=parser.parse_args()
rows=json.loads(Path(args.sources).read_text());rows=rows[:args.limit] if args.limit else rows
out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
binary=Path('node_modules/ffmpeg-static/ffmpeg');ffmpeg=str(binary.resolve()) if binary.exists() else shutil.which('ffmpeg');assert ffmpeg
results=[]
for row in rows:
    sheet=Image.open(row['source']).convert('RGBA');w,h=sheet.size
    cells=[sheet.crop((x*w//2,y*h//2,(x+1)*w//2,(y+1)*h//2)) for y in range(2) for x in range(2)]
    # Sprite-sheet boundaries can contain a disconnected foot from the adjacent
    # cell. Keep the actor and nearby accents, preserving original alpha edges.
    for cell in cells:
        alpha=np.asarray(cell.getchannel('A'));components,count=ndimage.label(alpha>12)
        if count:
            sizes=np.bincount(components.ravel());sizes[0]=0;main=int(sizes.argmax());objects=ndimage.find_objects(components);my,mx=objects[main-1];keep=[main]
            for index,obj in enumerate(objects,1):
                if obj is None or index==main:continue
                cy,cx=obj;dx=max(mx.start-cx.stop,cx.start-mx.stop,0);dy=max(my.start-cy.stop,cy.start-my.stop,0)
                if dx*dx+dy*dy<=32*32:keep.append(index)
            allowed=ndimage.binary_dilation(np.isin(components,keep),iterations=3)
            cell.putalpha(Image.fromarray(np.where(allowed,alpha,0).astype('uint8')))
    boxes=[cell.getchannel('A').point(lambda a:255 if a>12 else 0).getbbox() for cell in cells]
    assert all(boxes),row['id']
    scale=min(456/max(b[2]-b[0] for b in boxes),456/max(b[3]-b[1] for b in boxes))
    poses=[]
    for cell,b in zip(cells,boxes):
        cropped=cell.crop(b);cropped=cropped.resize((max(1,round(cropped.width*scale)),max(1,round(cropped.height*scale))),Image.Resampling.LANCZOS)
        canvas=Image.new('RGBA',(512,512));canvas.alpha_composite(cropped,((512-cropped.width)//2,480-cropped.height))
        alpha=canvas.getchannel('A');border=alpha.filter(ImageFilter.MaxFilter(7));white=Image.new('RGBA',(512,512),(255,255,255,0));white.putalpha(border);white.alpha_composite(canvas);poses.append(white)
    poster=poses[2];poster.save(out/(row['id']+'.png'))
    # Distinct acting poses plus a small eased settle. Return to pose 0 for a clean loop.
    segments=[(0,8),(1,10),(2,13),(3,13),(1,6),(0,6)];frames=[]
    for index,count in segments:
        for n in range(count):
            dy=round(-3*math.sin(math.pi*n/max(1,count-1)))
            frame=Image.new('RGBA',(512,512));frame.alpha_composite(poses[index],(0,dy));frames.append(frame)
    with tempfile.TemporaryDirectory(prefix='lumen-sticker-') as tmp:
        directory=Path(tmp)
        for i,frame in enumerate(frames):frame.save(directory/f'{i:03}.png')
        target=out/(row['id']+'.webm')
        for crf in [34,39,44,49,54]:
            subprocess.run([ffmpeg,'-v','error','-y','-threads','2','-framerate','20','-i',str(directory/'%03d.png'),'-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0','-b:v','0','-crf',str(crf),'-deadline','good','-cpu-used','4','-an','-t','2.8',str(target)],check=True)
            if target.stat().st_size<=256*1024:break
        assert target.stat().st_size<=256*1024,(row['id'],target.stat().st_size)
    results.append({k:v for k,v in row.items() if k!='source'}|{'file':target.name,'poster':row['id']+'.png','bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'duration':2.8,'fps':20,'frames':len(frames),'format':'video'})
    print(f"{row['id']}: {target.stat().st_size} bytes",flush=True)
(out/'manifest.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
preview=Image.new('RGB',(1000,math.ceil(len(results)/5)*220),'#f0f4f8');draw=ImageDraw.Draw(preview)
fontpath=Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');font=ImageFont.truetype(str(fontpath),13) if fontpath.exists() else ImageFont.load_default()
for i,row in enumerate(results):
    pose=Image.open(out/row['poster']).convert('RGBA');pose.thumbnail((185,185));x=(i%5)*200+(200-pose.width)//2;y=(i//5)*220+4;preview.paste(pose,(x,y),pose);draw.text(((i%5)*200+8,(i//5)*220+193),f"{i+1:02}. {row.get('label',row['id'])}",fill='#182844',font=font)
preview.save(out/'preview.jpg',quality=90)
print(json.dumps({'stickers':len(results),'total_bytes':sum(x['bytes'] for x in results)},ensure_ascii=False),flush=True)
