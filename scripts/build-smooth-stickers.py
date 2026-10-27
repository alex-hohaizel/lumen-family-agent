#!/usr/bin/env python3
"""Animate the existing Lumen artwork with continuous body, head, paw, ear and cape rigs at native 30 FPS."""
import argparse, hashlib, json, math, shutil, subprocess, tempfile
from pathlib import Path
from PIL import Image, ImageFilter, ImageDraw, ImageFont
import numpy as np
from scipy import ndimage

parser=argparse.ArgumentParser();parser.add_argument('--sources',required=True);parser.add_argument('--output',default='assets/stickers');parser.add_argument('--limit',type=int,default=0);parser.add_argument('--only',default='');parser.add_argument('--review-dir',default='');parser.add_argument('--frames',type=int,default=84);args=parser.parse_args()
rows=json.loads(Path(args.sources).read_text());rows=[r for r in rows if not args.only or r['id'] in args.only.split(',')];rows=rows[:args.limit] if args.limit else rows
out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
binary=Path('node_modules/ffmpeg-static/ffmpeg');ffmpeg=str(binary.resolve()) if binary.exists() else shutil.which('ffmpeg');assert ffmpeg
import cv2
cv2.setNumThreads(2)
FPS=30;COUNT=84;DURATION=COUNT/FPS
YY,XX=np.mgrid[:512,:512].astype(np.float32)
# Pose, head angle, head nod, hand motion, cape sway, bounce, gesture cycles.
RIGS={
'01_wave':(3,3,2,20,8,5,3),'02_laugh':(1,4,7,7,9,10,4),'03_rofl':(2,2,4,12,8,8,3),
'04_loveeyes':(2,4,3,7,7,5,2),'05_hug':(2,3,3,11,7,4,2),'06_heart':(2,3,3,5,6,4,2),
'07_kiss':(2,5,3,14,7,4,2),'08_cool':(2,5,2,4,9,3,2),'09_think':(2,5,4,8,6,2,3),
'10_suspect':(2,6,4,11,6,2,2),'11_smirk':(2,5,3,8,8,3,2),'12_eyeroll':(2,7,3,3,8,2,2),
'13_phew':(2,5,3,17,8,4,3),'14_cringe':(2,3,4,8,10,3,4),'15_melt':(2,2,2,0,14,0,2),
'16_braveface':(2,4,3,11,6,3,2),'17_drama':(2,6,7,6,10,5,3),'18_angry':(2,5,5,9,12,7,4),
'19_mindblown':(2,4,8,10,14,10,2),'20_panic':(2,5,6,12,12,11,4),'21_facepalm':(2,5,10,4,7,2,3),
'22_shrug':(2,6,3,13,9,3,2),'23_yes':(3,3,10,9,7,4,3),'24_no':(2,7,3,7,9,3,3),
'25_clap':(1,4,4,18,9,7,4),'26_please':(2,4,5,6,7,4,2),'27_strong':(1,4,4,20,12,8,3),
'28_fire':(2,4,5,13,10,5,3),'29_party':(2,5,5,17,14,13,3),'30_sleep':(2,1.5,1.5,0,4,0,2)}
MOTION_NOTES=['махає лапкою, похитує головою й вухами; плащ підхоплює рух','сміється, здригається плечима й лапками','котиться від сміху з рухом лап і плаща','ніжно погойдується й притискає лапки','стискає велике серце, погойдуючись','ніжно тримає сердечко, світиться амулет','повітряний поцілунок із рухом лапки та голови','самовдоволено хитає головою в окулярах','нахиляє голову й торкається підборіддя','придивляється через лупу, рухає нею','хитро похитує головою й ховає усмішку в плащ','закочує очі й невдоволено хитає головою','витирає чоло, здригається від полегшення','кутається в каптур і ніяково здригається','розтікається м’якими хвилями в калюжку','піднімає чашку й намагається тримати усмішку','ридає в басейні власних сліз, хвилюється вода','обурено підстрибує й жестикулює','підстрибує від здивування, розлітаються частинки','панікує й тріпоче плащем','киває з лапою на лобі','розводить лапки й похитує головою','киває зі схвальним великим пальцем','хитає головою й знаком заборони','швидко плескає лапками й радіє','притискає лапки й просить з ангельським виглядом','надривно підіймає зефірну гантелю, тремтять лапки','із задоволенням піднімає вогняний напій','радісно стрибає, махає лапками; летить конфеті','спить у плащі, м’яко дихає й ворушить вухами']

def soft(a,b,x):
    t=np.clip((x-a)/(b-a),0,1);return t*t*(3-2*t)

def eyes_of(pose,box):
    rgb=np.asarray(pose);x0,y0,x1,y1=box;w=x1-x0;h=y1-y0
    gray=cv2.cvtColor(rgb[:,:,:3],cv2.COLOR_RGB2GRAY)
    mask=((gray<73)&(rgb[:,:,3]>245)&(YY>y0+h*.18)&(YY<y0+h*.51)&(XX>x0+w*.22)&(XX<x0+w*.79)).astype(np.uint8)
    count,labels,stats,centers=cv2.connectedComponentsWithStats(mask,8)
    found=[]
    for fraction in [.37,.64]:
        candidates=[]
        for i in range(1,count):
            x,y,ew,eh,area=stats[i];cx,cy=centers[i]
            if 22<area<2600 and 8<eh<65 and ew>5 and .55<eh/ew<3 and abs(cx-(x0+w*fraction))<w*.16:
                candidates.append((area/(1+abs(cx-(x0+w*fraction))+abs(cy-(y0+h*.36))),cx,cy,ew,eh))
        if candidates:
            _,x,y,ew,eh=max(candidates);found.append((x,y,max(9,ew*.75),max(8,eh*.8)))
    return found

def render_rig(pose,box,eye_points,preset,t,kind):
    x0,y0,x1,y1=box;w=x1-x0;h=y1-y0;cx=(x0+x1)/2;feet=y1-4
    head,nod,hands,cape,bounce,cycles=preset[1:]
    q=2*math.pi*t
    breath=.012*np.sin(2*q)+.004*np.sin(q)
    body=soft(y0+h*.35,y0+h*.8,YY)
    mx=cx+(XX-cx)/(1+breath*body)
    hop=bounce*max(0,np.sin(cycles*q))**2
    my=feet+(YY-feet)/(1-breath*.7)-hop
    # The head is one rigid patch. Its ears and the cape have separate soft bones.
    neck=y0+h*.59;head_mask=1-soft(y0+h*.44,y0+h*.65,YY)
    angle=math.radians(head)*np.sin(q)+math.radians(head*.25)*np.sin(2*q)
    dx=mx-cx;dy=my-neck;c=np.cos(angle);sn=np.sin(angle)
    rx=c*dx-sn*dy+cx;ry=sn*dx+c*dy+neck+nod*np.sin(cycles*q)
    mx+=(rx-mx)*head_mask;my+=(ry-my)*head_mask
    outer=np.clip((np.abs(XX-cx)/max(1,w*.5)-.28)/.5,0,1)
    cape_mask=soft(y0+h*.48,y0+h*.68,YY)*(1-soft(y0+h*.92,y1,YY))*outer
    mx+=cape*np.sin(2*q+(YY-y0)/h*5)*cape_mask
    my+=cape*.28*np.cos(2*q+(XX-cx)/w*4)*cape_mask
    face_guard=1-np.exp(-((XX-cx)/(w*.22))**4-((YY-(y0+h*.32))/(h*.18))**4)
    for side in [-1,1]:
        hx=cx+side*w*.31;hy=y0+h*(.36 if kind=='01_wave' and side<0 else .61)
        if kind in ['25_clap','26_please','27_strong']:hx=cx+side*w*.16;hy=y0+h*.58
        hand=np.exp(-((XX-hx)/(w*.17))**2-((YY-hy)/(h*.19))**2)*face_guard
        phase=cycles*q+(0 if kind in ['05_hug','25_clap','26_please','27_strong'] else side*.5)
        mx+=side*hands*.45*np.sin(phase)*hand
        my+=hands*np.sin(phase+side*.18)*hand
        ex=cx+side*w*.34;ey=y0+h*.16
        ear=np.exp(-((XX-ex)/(w*.17))**2-((YY-ey)/(h*.16))**2)
        mx+=side*3.5*np.sin(2*q+side*.4)*ear
        my+=2*np.sin(3*q+side)*ear
    if kind=='15_melt':
        mx+=12*np.sin(2*q+(YY-y0)/h*5)*soft(y0+h*.35,y0+h*.8,YY)
        my+=4*np.sin(2*q+(XX-cx)/w*5)*soft(y0+h*.7,y1,YY)
    if kind=='27_strong':
        bar=np.exp(-((XX-cx)/(w*.47))**4-((YY-(y0+h*.57))/(h*.14))**4)
        my+=15*np.sin(cycles*q)*bar
    blink=math.exp(-((t-.34)/.018)**2)+.9*math.exp(-((t-.79)/.017)**2)
    for ex,ey,ew,eh in eye_points:
        e=np.exp(-((mx-ex)/ew)**4-((my-ey)/(eh*1.55))**4)
        my+=(my-ey)*blink*4.8*e
    rgba=cv2.remap(np.asarray(pose),mx.astype(np.float32),my.astype(np.float32),cv2.INTER_CUBIC,borderMode=cv2.BORDER_CONSTANT)
    if kind=='03_rofl':
        mat=cv2.getRotationMatrix2D((256,256),360*t,.78);rgba=cv2.warpAffine(rgba,mat,(512,512),flags=cv2.INTER_CUBIC,borderMode=cv2.BORDER_CONSTANT)
    # Stable transparency: no subpixel alpha noise across the solid character.
    alpha=rgba[:,:,3];alpha[alpha>245]=255;alpha[alpha<10]=0
    rgba[:,:,3]=((alpha.astype(np.uint16)+4)//8*8).clip(0,255).astype(np.uint8);rgba[alpha==0,:3]=0
    return rgba

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
    preset=RIGS[row['id']];pose=poses[preset[0]];pose.save(out/(row['id']+'.png'))
    box=pose.getchannel('A').point(lambda a:255 if a>32 else 0).getbbox();eye_points=[]  # Preserve authored eyes; no synthetic eyelid warping.
    if row['id'] in ['03_rofl','05_hug','14_cringe','15_melt','17_drama','21_facepalm','30_sleep']:eye_points=[]
    count=72 if row['id']=='03_rofl' else max(60,min(90,args.frames))
    frames=[render_rig(pose,box,eye_points,preset,i/count,row['id']) for i in range(count)]
    if args.only or args.review_dir:
        preview=Image.new('RGB',(6*192,3*204),'#edf2f7');draw=ImageDraw.Draw(preview)
        for j in range(18):
            index=round(j*(count-1)/17);im=Image.fromarray(frames[index]);im.thumbnail((190,190));preview.paste(im,((j%6)*192,(j//6)*204),im);draw.text(((j%6)*192+5,(j//6)*204+190),str(round(index/FPS,2)),fill='#1b2a3a')
        review=Path(args.review_dir) if args.review_dir else out;review.mkdir(parents=True,exist_ok=True);preview.save(review/(row['id']+'-motion.jpg'),quality=90)
    target=out/(row['id']+'.webm')
    for crf in [30,34,38,42,46,50,54]:
        command=[ffmpeg,'-v','error','-y','-threads','2','-f','rawvideo','-pix_fmt','rgba','-s','512x512','-r',str(FPS),'-i','-','-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0','-b:v','0','-crf',str(crf),'-deadline','good','-cpu-used','4','-an',str(target)]
        process=subprocess.Popen(command,stdin=subprocess.PIPE)
        try:
            for frame in frames:process.stdin.write(frame.tobytes())
            process.stdin.close();assert process.wait()==0
        except:process.kill();raise
        if target.stat().st_size<=256*1024:break
    assert target.stat().st_size<=256*1024,(row['id'],target.stat().st_size)
    diffs=[float(np.abs(frames[(i+1)%count].astype(np.float32)-frames[i]).mean()) for i in range(count)]
    unique=len({hashlib.sha256(f.tobytes()).hexdigest() for f in frames})
    result={k:v for k,v in row.items() if k!='source'}|{'description':'Люмен '+MOTION_NOTES[int(row['id'][:2])-1]+'.','file':target.name,'poster':row['id']+'.png','bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'duration':count/FPS,'fps':FPS,'frames':count,'unique_frames':unique,'format':'video','motion_version':2,'animation':'continuous_articulated_raster_rig','crf':crf,'motion':{'mean_delta':round(float(np.mean(diffs)),4),'maximum_delta':round(max(diffs),4),'loop_delta':round(diffs[-1],4)},'pose':preset[0],'articulated_parts':['head','paws','ears','cape','body'],'detected_blink_eyes':len(eye_points)}
    results.append(result)
    (out/'manifest.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'id':row['id'],'bytes':target.stat().st_size,'unique':unique,'crf':crf,'motion':result['motion']}),flush=True)
(out/'manifest.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'stickers':len(results),'bytes':sum(x['bytes'] for x in results),'fps':FPS,'frames':COUNT}),flush=True)
