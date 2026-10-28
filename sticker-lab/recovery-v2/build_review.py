#!/usr/bin/env python3
"""Assemble a whole-pose animation study; never edits or uploads the live pack.

Art keyposes are made by the built-in image generator from the original Lumen.
RIFE v4.6 (CPU) interpolates complete images. Two-background reconstruction
preserves an alpha channel for a Telegram VP9 draft. No detached-parts rig.
"""
import json,hashlib,subprocess
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw,ImageFont
from scipy import ndimage

ROOT=Path(__file__).resolve().parent

def run(args):subprocess.run(args,check=True)

def main():
    blacks=sorted((ROOT/'interpolated-black').glob('*.png'));whites=sorted((ROOT/'interpolated-white').glob('*.png'))
    assert len(blacks)==len(whites)==84
    output=ROOT/'frames-rgba';output.mkdir(exist_ok=True);frames=[];proof=[]
    for i,(bp,wp) in enumerate(zip(blacks,whites)):
        b=np.asarray(Image.open(bp).convert('RGB')).astype(np.float32)/255
        w=np.asarray(Image.open(wp).convert('RGB')).astype(np.float32)/255
        alpha=np.clip(1-np.median(w-b,axis=2),0,1)
        # Remove only disconnected background reconstruction noise; preserve the
        # single whole-character silhouette and all internal face/clothing pixels.
        labels,n=ndimage.label(alpha>.025);sizes=np.bincount(labels.ravel());sizes[0]=0;main=int(sizes.argmax())
        keep=ndimage.binary_fill_holes(labels==main);keep=ndimage.binary_dilation(keep,iterations=2)
        alpha*=keep;alpha[alpha<.018]=0;alpha[alpha>.985]=1
        rgb=np.clip((b+w-(1-alpha[:,:,None]))/(2*np.maximum(alpha[:,:,None],.02)),0,1)
        result=np.dstack([rgb,alpha]);im=Image.fromarray(np.rint(result*255).astype('uint8'),'RGBA');im.save(output/f'{i:03}.png');frames.append(im)
        proof.append({'frame':i,'bounds':im.getchannel('A').getbbox(),'face_alpha':float(np.median(alpha[150:280,190:330]))})
    assert all(x['bounds'][0]>0 and x['bounds'][1]>0 and x['bounds'][2]<512 and x['bounds'][3]<512 for x in proof)
    frames[34].save(ROOT/'poster.png')
    review=[]
    for frame in frames:
        bg=Image.new('RGBA',frame.size,'#e9edf4');bg.alpha_composite(frame);review.append(bg.convert('RGB'))
    pal=Image.new('RGB',(512*6,512))
    for n,i in enumerate([0,16,32,48,64,83]):pal.paste(review[i],(n*512,0))
    palette=pal.quantize(colors=224);indexed=[x.quantize(palette=palette,dither=Image.Dither.NONE) for x in review]
    indexed[0].save(ROOT/'Lumen_Laugh_Recovery_v2.gif',save_all=True,append_images=indexed[1:],duration=[30 if i%3!=2 else 40 for i in range(84)],loop=0,optimize=False,disposal=2)
    run(['ffmpeg','-v','error','-y','-threads','2','-filter_complex_threads','1','-framerate','30','-i',str(output/'%03d.png'),'-f','lavfi','-i','color=c=0xe9edf4:s=512x512:r=30','-filter_complex','[1:v][0:v]overlay=shortest=1:format=auto,format=yuv420p','-c:v','libx264','-crf','16','-preset','fast','-an','-t','2.8','-movflags','+faststart',str(ROOT/'Lumen_Laugh_Recovery_v2.mp4')])
    for crf in [30,34,38,42,46,50]:
        run(['ffmpeg','-v','error','-y','-threads','2','-framerate','30','-i',str(output/'%03d.png'),'-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0','-b:v','0','-crf',str(crf),'-deadline','good','-cpu-used','4','-an','-t','2.8',str(ROOT/'Lumen_Laugh_Recovery_v2.webm')])
        if (ROOT/'Lumen_Laugh_Recovery_v2.webm').stat().st_size<=262144:break
    assert (ROOT/'Lumen_Laugh_Recovery_v2.webm').stat().st_size<=262144
    board=Image.new('RGB',(1024,768),'#e9edf4');font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',15)
    for n,i in enumerate([0,9,20,32,44,60]):
        frame=frames[i].resize((341,341),Image.Resampling.LANCZOS);x=n%3*341;y=n//3*384;board.paste(frame,(x,y),frame);ImageDraw.Draw(board).text((x+12,y+353),f'{i/30:.2f}s',fill='#243b5d',font=font)
    board.save(ROOT/'contact-sheet.jpg',quality=95)
    original=Image.open(ROOT.parents[1]/'assets/lumen.png')
    original=original.convert('RGBA');box=original.getchannel('A').getbbox();original=original.crop(box);original.thumbnail((400,450),Image.Resampling.LANCZOS);ref=Image.new('RGBA',(512,512),'#e9edf4');ref.alpha_composite(original,((512-original.width)//2,480-original.height));ref.convert('RGB').save(ROOT/'original-reference.png')
    run(['ffmpeg','-v','error','-y','-threads','2','-filter_complex_threads','1','-loop','1','-framerate','30','-i',str(ROOT/'original-reference.png'),'-stream_loop','2','-i',str(ROOT/'Lumen_Laugh_Recovery_v2.mp4'),'-filter_complex',"[0:v][1:v]hstack=inputs=2,pad=1024:570:0:58:color=0xe9edf4,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='Оригінальний Люмен':x=30:y=17:fontsize=23:fontcolor=0x233c61,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='Нова проба руху':x=545:y=17:fontsize=23:fontcolor=0x233c61",'-c:v','libx264','-crf','18','-preset','fast','-an','-t','8.4','-movflags','+faststart',str(ROOT/'Lumen_Original_vs_Recovery_v2.mp4')])
    info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(ROOT/'Lumen_Laugh_Recovery_v2.webm')]))
    assert len(info['streams'])==1 and info['streams'][0]['codec_name']=='vp9' and info['streams'][0]['avg_frame_rate']=='30/1'
    alpha=subprocess.check_output(['ffmpeg','-v','error','-c:v','libvpx-vp9','-i',str(ROOT/'Lumen_Laugh_Recovery_v2.webm'),'-vf','alphaextract','-frames:v','1','-f','rawvideo','-pix_fmt','gray','-']);assert min(alpha)==0 and max(alpha)==255
    loop=float(np.mean(abs(np.asarray(frames[0]).astype(float)-np.asarray(frames[-1]).astype(float))))
    data={'status':'unapproved_recovery_study','previous_vector_pair':'rejected_by_user','whole_pose_interpolation':True,'detached_limb_rig':False,'original_character_reference':'assets/lumen.png','keypose_image_tool':'built-in image_gen','interpolator':'RIFE v4.6 on CPU','fps':30,'duration':2.8,'frames':84,'vp9_bytes':(ROOT/'Lumen_Laugh_Recovery_v2.webm').stat().st_size,'vp9_crf':crf,'vp9_alpha_decoded':True,'loop_pixel_difference':loop,'file_checks_passed':True,'artistic_quality_approved':False,'production_pack_changed':False,'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in ROOT.glob('Lumen_*') if p.is_file()},'frame_observations':proof}
    (ROOT/'REVIEW_STATUS.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in data.items() if k not in ['files','frame_observations']},ensure_ascii=False))

if __name__=='__main__':main()
