#!/usr/bin/env python3
"""Explicit limbs and full-sheet side swing from pinned generated components.

138 acting continuation by /root/artisan_layers_resume; original source/renderer
work by /root/artisan_stickers_occlusion. No new raster generation or repaint.

This renderer never reads canonical output or paints missing raster content.
All pixels originate in the declared generated component crops. Depth order is
authored; no whole-frame dissolve, eye morph or independent alpha interpolation.
"""
from __future__ import annotations
import argparse,hashlib,json,math,subprocess,sys
from pathlib import Path
import numpy as np
from scipy import ndimage as ndi
from PIL import Image,ImageDraw

HERE=Path(__file__).resolve().parent
REPO=next(path for path in Path(__file__).resolve().parents if (path/'assets/stickers/manifest.json').is_file())
sys.path.insert(0,str(HERE))
import support_snapshot as support
N=84;FPS=30
YY,XX=np.mgrid[:512,:512].astype(np.float32)

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def smooth(x):x=max(0.,min(1.,x));return x*x*x*(x*(x*6-15)+10)
def curve(u,keys):
    for (x,a),(y,b) in zip(keys,keys[1:]):
        if x<=u<=y:return a+(b-a)*smooth((u-x)/(y-x))
    return keys[-1][1]
def rgba(path):return np.array(Image.open(path).convert('RGBA'),np.float32)/255
def canvas():return np.zeros((512,512,4),np.float32)
def over(back,front):
    fa=front[...,3:4];ba=back[...,3:4];a=fa+ba*(1-fa)
    rgb=np.divide(front[...,:3]*fa+back[...,:3]*ba*(1-fa),np.maximum(a,1e-8))
    return np.concatenate([rgb,a],axis=-1)
def place(im,xy,size=None):
    if not isinstance(im,Image.Image):im=Image.fromarray(np.uint8(np.rint(np.clip(im,0,1)*255)),'RGBA')
    if size:im=im.resize(tuple(map(lambda x:max(1,int(round(x))),size)),Image.Resampling.LANCZOS)
    out=Image.new('RGBA',(512,512));out.alpha_composite(im,tuple(int(round(x)) for x in xy));return np.array(out,np.float32)/255
def body_layer(image,dy=0,angle=0):
    height=440;w=round(image.width*height/image.height);layer=Image.new('RGBA',(512,512));layer.alpha_composite(image.resize((w,height),Image.Resampling.LANCZOS),(256-w//2,44))
    if angle:layer=layer.rotate(angle,resample=Image.Resampling.BICUBIC,center=(256,410))
    return place(layer,(0,dy))

def affine_part(image,source_a,source_b,target_a,target_b,width_scale,mask):
    a=np.asarray(source_a,float);b=np.asarray(source_b,float);p=np.asarray(target_a,float);q=np.asarray(target_b,float)
    sv=b-a;sw=float(np.linalg.norm(sv));su=sv/sw;sn=np.array([-su[1],su[0]])
    dv=q-p;dw=float(np.linalg.norm(dv));du=dv/max(dw,1e-6);dn=np.array([-du[1],du[0]])
    dx=XX-p[0];dy=YY-p[1];long=(dx*du[0]+dy*du[1])*(sw/max(dw,1e-6));lat=(dx*dn[0]+dy*dn[1])/width_scale
    sx=a[0]+long*su[0]+lat*sn[0];sy=a[1]+long*su[1]+lat*sn[1]
    cut=image.copy();cut[...,3]*=mask
    return support.straight(support.sample(support.premult(cut),sy,sx)).astype(np.float32)/255

def arm_layer(image,source_a,source_b,shoulder,hand,side,upper_image,authored_elbow=False):
    """Three rigid existing-pixel parts, with an explicit two-bone elbow."""
    a=np.asarray(source_a,float);b=np.asarray(source_b,float);S=np.asarray(shoulder,float);H=np.asarray(hand,float)
    v=H-S;distance=float(np.linalg.norm(v));length=74.
    if distance>146:H=S+v*146/distance;v=H-S;distance=146.
    direction=v/max(distance,1e-6);normal=np.array([-direction[1],direction[0]])
    E=(S+H)/2+side*normal*math.sqrt(max(1.,length*length-distance*distance/4))
    if authored_elbow:
        across=smooth(max(0.,min(1.,side*(S[0]-H[0])/80)))
        E=S+np.array([side*(65-45*across),35+15*across])
    orig=b-a;orig_length=float(np.linalg.norm(orig));source_wrist=a+.65*orig;scale=.30
    fy,fx=np.mgrid[:image.shape[0],:image.shape[1]];t=((fx-a[0])*orig[0]+(fy-a[1])*orig[1])/(orig_length*orig_length)
    shaft=(t<.67).astype(np.float32);paw=(t>.59).astype(np.float32)
    fore_direction=(H-E)/np.linalg.norm(H-E);W=H-fore_direction*(.35*orig_length*scale)
    upper=affine_part(upper_image,[89,641],[733,126],S,E,.09,np.ones(upper_image.shape[:2],np.float32))
    lower=affine_part(image,a,source_wrist,E,W,scale,shaft)
    hand_part=affine_part(image,a,b,H-fore_direction*orig_length*scale,H,scale,paw)
    return upper,lower,hand_part,{'shoulder':S.tolist(),'elbow':E.tolist(),'wrist':W.tolist(),'hand':H.tolist(),'hand_scale':scale,'raster_parts':'explicit generated cream upper-arm component plus existing forearm/paw split; paw rigid, no content cloning into underlying body'}

def affine_plane_layer(image,source_quad,target_quad):
    # A rigid plane uses one affine correspondence: an arbitrary projective
    # denominator outside the top quad could fold the protruding rim into spikes.
    source_quad=np.asarray(source_quad,float);source_quad[2]=source_quad[1]+source_quad[3]-source_quad[0]
    plane_mask=Image.new('L',image.size);ImageDraw.Draw(plane_mask).polygon([tuple(point) for point in source_quad],fill=255)
    image=image.copy();image.putalpha(Image.fromarray(np.minimum(np.array(image)[:,:,3],np.array(plane_mask)).astype('uint8')))
    src=source_quad[[0,1,3]];dst=np.asarray(target_quad,float)[[0,1,3]];rows=[];right=[]
    for (x,y),(u,v) in zip(dst,src):
        rows.extend([[x,y,1,0,0,0],[0,0,0,x,y,1]]);right.extend([u,v])
    matrix=np.linalg.solve(np.asarray(rows),np.asarray(right))
    out=image.transform((512,512),Image.Transform.AFFINE,tuple(matrix),Image.Resampling.BICUBIC)
    return np.array(out,np.float32)/255

def render_138(u,layers,meta):
    """One full-sized rigid sheet swings to the side, never squashes away.

    The right paw holds one declared source-pixel point throughout. The left
    paw joins its actual cloth corner only near full cover, releases that
    corner as the sheet swings away, then waves. A full rectangle crop remains
    the same uniform scale through the complete loop; opacity is inherited
    solely from the actual source cloth matte.
    """
    cover=curve(u,[(0,0),(.23,1),(.36,1),(.64,0),(1,0)])
    theta=math.radians(-90*(1-cover));cs=math.cos(theta);sn=math.sin(theta)
    scale=310/layers['cloth'].width
    grip=np.array([593.,365.]);right_hand=np.array([396-cover,202+69*cover])
    dx=XX-right_hand[0];dy=YY-right_hand[1]
    sx=grip[0]+(dx*cs+dy*sn)/scale
    sy=grip[1]+(-dx*sn+dy*cs)/scale
    source=np.array(layers['cloth'],np.float32)/255
    cloth=support.straight(support.sample(support.premult(source),sy,sx)).astype(np.float32)/255
    source_delta=np.array([67.,365.])-grip
    left_grip=right_hand+scale*np.array([cs*source_delta[0]-sn*source_delta[1],sn*source_delta[0]+cs*source_delta[1]])
    wave=0.
    if .66<u<.94:
        q=(u-.66)/.28;wave=math.sin(math.pi*q)**2*math.sin(2*math.pi*q)
    free_hand=np.array([115+20*wave,216+3*abs(wave)])
    holding=smooth((cover-.60)/.25)
    left_hand=free_hand*(1-holding)+left_grip*holding
    lu,ll,lf,lp=arm_layer(layers['arm_left'],[252,286],[101,82],[177,335],left_hand,-1,layers['upper_arm'])
    ru,rl,rf,rp=arm_layer(layers['arm_right'],[46,235],[225,71],[337,335],right_hand,1,layers['upper_arm'])
    frame=body_layer(layers['body']);frame=over(frame,lu);frame=over(frame,ru);frame=over(frame,ll);frame=over(frame,rl)
    frame=over(frame,cloth);frame=over(frame,lf);frame=over(frame,rf)
    alpha=cloth[...,3];nonzero=alpha>1/255;yy,xx=np.nonzero(nonzero)
    return frame,{'cover':cover,'wave':wave,'left_arm':lp,'right_arm':rp,
        'cloth_rigid_angle_degrees':math.degrees(theta),'cloth_uniform_scale':scale,
        'cloth_source_size':[layers['cloth'].width,layers['cloth'].height],
        'cloth_source_grip':[593,365],'right_hand_holds_declared_cloth_grip':True,
        'left_hand_hold_amount':holding,'left_cloth_grip_target':left_grip.tolist(),
        'cloth_bbox':[int(xx.min()),int(yy.min()),int(xx.max()+1),int(yy.max()+1)] if len(xx) else None,
        'cloth_nonzero_alpha_pixels':int(nonzero.sum()),
        'cloth_nonuniform_scale':False,'cloth_opacity_fade':False,
        'cloth_motion':'rigid full-sheet side swing with held corner; face peeks around edge'}

def render_132(u,layers,meta):
    angle=curve(u,[(0,0),(.16,105),(.83,105),(.97,0),(1,0)])
    extension=curve(u,[(0,0),(.19,0),(.29,1.10),(.36,.92),(.43,1),(.56,1),(.70,0),(1,0)])
    wobble=8*math.sin(8*math.pi*(u-.29))*math.exp(-9*max(0,u-.29)) if .29<u<.56 else 0
    star_x=256+wobble;star_y=438-130*extension;spring_bottom=np.array([256.,479.]);spring_top=np.array([star_x,star_y+19])
    pop=curve(u,[(0,0),(.20,0),(.29,1),(.44,0),(1,0)]);dy=-7*pop;tilt=1.3*pop
    box=place(layers['box'],(173,387),(166,105));box_mask=Image.new('L',layers['box'].size)
    # Exact existing front/right faces occlude the spring below the opening.
    polygon=[(570-564,600-529),(848-564,641-529),(968-564,578-529),(968-564,756-529),(848-564,820-529),(570-564,774-529)]
    ImageDraw.Draw(box_mask).polygon(polygon,fill=255)
    front_img=layers['box'].copy();front_img.putalpha(Image.fromarray(np.minimum(np.array(front_img)[:,:,3],np.array(box_mask)).astype('uint8')))
    front_box=place(front_img,(173,387),(166,105))
    hinge=np.array([219.,388.]);H=np.array([119.,15.]);F=np.array([-45.,24.]);Z=np.array([0.,-60.]);theta=math.radians(angle);flap=F*math.cos(theta)+Z*math.sin(theta)
    area=float(np.cross(H,flap));quad=[hinge,hinge+H,hinge+H+flap,hinge+flap]
    if abs(area)<3:flap=flap+np.array([0.,.05]);quad=[hinge,hinge+H,hinge+H+flap,hinge+flap]
    if area>=0:
        lid=affine_plane_layer(layers['lid_outside'],[(614-23,161-157),(1208-23,292-157),(632-23,476-157),(27-23,305-157)],quad)
    else:
        lid=affine_plane_layer(layers['lid_inside'],[(562-558,940-858),(840-558,862-858),(981-558,1030-858),(696-558,1105-858)],quad)
    grip=np.array(quad[3])+np.array([0.,-9.]);release=smooth((angle-45)/20)
    left_target=grip*(1-release)+np.array([153.,365.])*release
    if .25<u<.55:
        q=curve(u,[(.25,0),(.32,1),(.48,1),(.55,0)]);left_target=left_target*(1-q)+np.array([139.,350.])*q
    right_rest=np.array([328.,407.]);celebrate=np.array([379.,350.]);push=np.array([star_x+18,star_y+8])
    if u<.42:
        q=curve(u,[(0,0),(.22,0),(.30,1),(.42,1)]);right_target=right_rest*(1-q)+celebrate*q
    elif u<.56:
        q=smooth((u-.42)/.14);right_target=celebrate*(1-q)+push*q
    elif u<.70:right_target=push
    else:
        q=smooth((u-.70)/.11);right_target=push*(1-q)+right_rest*q
    lu,ll,lf,lp=arm_layer(layers['arm_left'],[46,36],[203,187],[177,335+dy],left_target,-1,layers['upper_arm'],True)
    ru,rl,rf,rp=arm_layer(layers['arm_right'],[225,48],[64,197],[337,335+dy],right_target,1,layers['upper_arm'],True)
    frame=body_layer(layers['body'],dy,tilt);frame=over(frame,lu);frame=over(frame,ru);frame=over(frame,box)
    if angle>=60:frame=over(frame,lid)
    frame=over(frame,ll);frame=over(frame,rl)
    spring_image=np.array(layers['spring'],np.float32)/255
    spring=affine_part(spring_image,[layers['spring'].width/2,0],[layers['spring'].width/2,layers['spring'].height],spring_top,spring_bottom,30/layers['spring'].width,np.ones(spring_image.shape[:2],np.float32))
    star=place(layers['star'],(star_x-23,star_y-22),(46,44))
    frame=over(frame,spring);frame=over(frame,star)
    right_inside=.42<=u<.82
    if right_inside:frame=over(frame,rf)
    frame=over(frame,front_box)
    if angle<60:frame=over(frame,lid)
    if area>0:
        bow_height=32*min(1.,area/float(np.cross(H,F)));center=hinge+H*.52+flap*.43
        bow=place(layers['bow'],(center[0]-42,center[1]-bow_height),(84,max(1,bow_height)))
        frame=over(frame,bow)
    frame=over(frame,lf)
    if not right_inside:frame=over(frame,rf)
    return frame,{'lid_angle_degrees':angle,'lid_face':'outside' if area>=0 else 'inside','lid_plane_projected_area':area,'spring_extension':extension,'star_center':[star_x,star_y],'spring_bottom':spring_bottom.tolist(),'spring_top':spring_top.tolist(),'left_arm':lp,'right_arm':rp}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('recipe',type=Path);parser.add_argument('output',type=Path);parser.add_argument('--no-encode',action='store_true');a=parser.parse_args()
    recipe=json.loads(a.recipe.read_text());meta_path=REPO/recipe['extraction_path'];assert sha(meta_path)==recipe['extraction_sha256'];meta=json.loads(meta_path.read_text())
    assert recipe['generator_sha256']==sha(__file__)
    assert recipe['support_sha256']==sha(Path(support.__file__))
    assert sha(REPO/meta['generation_metadata_path'])==meta['generation_metadata_sha256']
    layers={}
    for item in meta['source_anchors']:
        path=REPO/item['path'];assert sha(path)==item['sha256'];layers[item['key']]=Image.open(path).convert('RGBA') if item['key'] not in ['arm_left','arm_right','upper_arm'] else rgba(path)
    assert not a.output.exists() or not any(a.output.iterdir());a.output.mkdir(parents=True,exist_ok=True);frames=a.output/'frames-rgba';frames.mkdir();states=[]
    for i in range(N):
        frame,state=(render_138 if recipe['id']=='lumen_138' else render_132)(i/N,layers,meta);support.atomic_save(Image.fromarray(support.straight(support.premult(frame)),'RGBA'),frames/f'{i:03d}.png');states.append(state)
    hashes=[sha(frames/f'{i:03d}.png') for i in range(N)];out=a.output/'candidate.webm'
    result={'schema_version':1,'id':recipe['id'],'actual_source_kind':'generated_layer_components','canonical_video_read':False,'frames_rgba_png_sha256':hashes,'scene_states':states,'generator_path':str(Path(__file__).relative_to(REPO)),'generator_sha256':sha(__file__),'extraction_sha256':sha(meta_path),'recipe_sha256':sha(a.recipe),'native_realtime_slow_device_playback':'not_observed'}
    if not a.no_encode:
        support.run(['ffmpeg','-nostdin','-v','error','-y','-framerate',FPS,'-i',frames/'%03d.png','-c:v','libvpx-vp9','-threads',2,'-pix_fmt','yuva420p','-auto-alt-ref',0,'-b:v',0,'-crf',recipe['crf'],'-deadline','good','-cpu-used',2,'-an','-frames:v',N,out])
        assert out.stat().st_size<=262144,(out.stat().st_size,'too large; reject and rerender newcandidate')
        decoded=a.output/'decoded';support.decode(out,decoded);result.update({'output_sha256':sha(out),'output_bytes':out.stat().st_size,'decoded_png_sha256':[sha(decoded/f'{i:03d}.png') for i in range(N)]})
    expected=recipe.get('expected',{})
    if expected.get('frames_rgba_png_sha256'):assert expected['frames_rgba_png_sha256']==hashes;result['raw_rgba_exact_match']=True
    if expected.get('decoded_png_sha256'):assert result['decoded_png_sha256']==expected['decoded_png_sha256'];result['encoded_frame_exact_match']=True
    (a.output/'render-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ['frames_rgba_png_sha256','decoded_png_sha256','scene_states']}))
if __name__=='__main__':main()
