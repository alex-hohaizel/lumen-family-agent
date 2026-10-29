#!/usr/bin/env python3
"""Two original Lumen vector acting studies. No production sticker mutation.

Free toolchain: Python, rlottie-python (LGPL), FFmpeg. Shapes are authored here;
no raster character warping, downloaded character art, or paid generation.
"""
import argparse, copy, gzip, hashlib, json, math, os, re, subprocess, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parent
FR=60; END=168
PALETTE={'cream':'#fff4d7','shade':'#dfbd86','ink':'#695549','teal':'#8fd8dc','navy':'#152d60','blue':'#385a95','gold':'#ffbd2f'}

def rgba(c):return [int(c[i:i+2],16)/255 for i in (1,3,5)]+[1]
def fixed(v):return {'a':0,'k':v}
def val(v):return v if isinstance(v,list) else [v]
def keys(rows):
    a=[]
    for n,(t,v) in enumerate(rows):
        k={'t':t,'s':val(v)}
        if n+1<len(rows):k.update(e=val(rows[n+1][1]),o={'x':[.33],'y':[0]},i={'x':[.67],'y':[1]})
        a.append(k)
    return {'a':1,'k':a}

def path(d):
    """Absolute SVG M/L/C/Q/Z subset to a native cubic Lottie path."""
    ts=re.findall(r'[MLCQZ]|-?(?:\d*\.\d+|\d+)',d);i=0;vertices=[];ins=[];outs=[];closed=False
    while i<len(ts):
        cmd=ts[i];i+=1
        if cmd=='Z':closed=True;continue
        n={'M':2,'L':2,'C':6,'Q':4}[cmd];p=list(map(float,ts[i:i+n]));i+=n
        if cmd in ('M','L'):
            vertices.append(p);ins.append([0,0]);outs.append([0,0])
        else:
            prev=vertices[-1]
            if cmd=='Q':
                c1=[prev[j]+2/3*(p[j]-prev[j]) for j in range(2)]
                end=p[2:];c2=[end[j]+2/3*(p[j]-end[j]) for j in range(2)]
            else:c1=p[:2];c2=p[2:4];end=p[4:]
            outs[-1]=[c1[j]-prev[j] for j in range(2)]
            if closed and end==vertices[0]:pass
            vertices.append(end);ins.append([c2[j]-end[j] for j in range(2)]);outs.append([0,0])
    if closed and len(vertices)>1 and vertices[-1]==vertices[0]:ins[0]=ins.pop();vertices.pop();outs.pop()
    return {'i':ins,'o':outs,'v':vertices,'c':closed}

def tr(p=None,a=None,s=None,r=None,o=None):
    return {'ty':'tr','p':p or fixed([0,0]),'a':a or fixed([0,0]),'s':s or fixed([100,100]),'r':r or fixed(0),'o':o or fixed(100)}
def fill(c):return {'ty':'fl','c':fixed(rgba(c)),'o':fixed(100),'r':1}
def stroke(c,w):return {'ty':'st','c':fixed(rgba(c)),'o':fixed(100),'w':fixed(w),'lc':2,'lj':2}
def gradient(c1,c2,start,end,radial=False):
    return {'ty':'gf','o':fixed(100),'r':1,'t':2 if radial else 1,'s':fixed(start),'e':fixed(end),'g':{'p':2,'k':fixed([0]+rgba(c1)[:3]+[1]+rgba(c2)[:3])},'h':fixed(0),'a':fixed(0)}
def shape(d,c=None,w=0,line=None,grad=None,name='shape'):
    a=[{'ty':'sh','ks':fixed(path(d)),'nm':name}]
    if grad:a.append(grad)
    elif c:a.append(fill(c))
    if w:a.append(stroke(line or PALETTE['ink'],w))
    a.append(tr());return {'ty':'gr','it':a,'nm':name}
def ellipse(x,y,rx,ry,c,w=0,line=None,grad=None,name='ellipse'):
    a=[{'ty':'el','p':fixed([x,y]),'s':fixed([rx*2,ry*2])}]
    a.append(grad or fill(c))
    if w:a.append(stroke(line or PALETTE['ink'],w))
    a.append(tr());return {'ty':'gr','it':a,'nm':name}
def group(items,**kw):return {'ty':'gr','it':items+[tr(**kw)]}
def roundrect(x,y,w,h,r,c):
    return {'ty':'gr','it':[{'ty':'rc','p':fixed([x,y]),'s':fixed([w,h]),'r':fixed(r)},fill(c),tr()]}

class Scene:
    def __init__(self,name):self.name=name;self.layers=[];self.next=1
    def add(self,name,shapes=None,parent=None,p=None,a=None,s=None,r=None,o=None):
        n=self.next;self.next+=1;k=tr(p,a,s,r,o);k.pop('ty')
        l={'ddd':0,'ind':n,'ty':4 if shapes else 3,'nm':name,'sr':1,'ks':k,'ip':0,'op':END,'st':0,'bm':0,'ao':0}
        if shapes:l['shapes']=shapes[::-1]
        if parent:l['parent']=parent
        self.layers.append(l);return n
    def data(self):return {'tgs':1,'v':'5.7.4','fr':FR,'ip':0,'op':END,'w':512,'h':512,'nm':self.name,'ddd':0,'assets':[],'layers':self.layers[::-1]}

def body_motion(kind):
    if kind=='laugh':
        frames=[(0,0),(12,3),(22,-6),(30,3),(40,-7),(48,2),(58,-6),(66,2),(76,-7),(84,1),(96,-4),(108,0),(125,0),(146,0),(168,0)]
    else:frames=[(0,0),(15,4),(30,-4),(43,1),(62,0),(82,-2),(110,1),(138,0),(168,0)]
    return keys([(t,[256,435+d]) for t,d in frames])

def ear(s,head,side,kind):
    x=256+side*89;y=128
    outer=ellipse(x,y,45,55,'#fff5da',3,'#c7ac88',gradient('#fffbea','#e7cc98',[x-15,y-30],[x+30,y+40]),'ear-outer')
    inner=ellipse(x+side*2,y-2,32,42,'#91d9de',0,grad=gradient('#c6f4f1','#65aaba',[x-11,y-28],[x+27,y+35]),name='ear-inner')
    shine=ellipse(x-7,y-18,10,20,'#d9f6ef')
    fur=shape(f'M {x-side*18} {y+28} Q {x-side*29} {y+5} {x-side*11} {y+17} Q {x-side*22} {y-13} {x-side*4} {y+4} Q {x-side*11} {y-28} {x+side*4} {y+6} L {x+side*10} {y+34} Z','#fff4d4',name='inner-ear-fur')
    if kind=='laugh':rr=[(0,0),(18,side*-6),(29,side*7),(42,side*-5),(52,side*7),(65,side*-5),(77,side*6),(90,side*-4),(111,side*2),(145,0),(168,0)]
    else:rr=[(0,0),(18,side*-9),(38,side*6),(62,side*-4),(90,side*3),(128,0),(168,0)]
    s.add(('left' if side<0 else 'right')+' ear follow-through',[outer,inner,shine,fur],parent=head,a=fixed([x,y+35]),p=fixed([x,y+35]),r=keys(rr))

def heart_art():
    heart='M 0 43 C -21 25 -69 -3 -61 -35 C -54 -66 -16 -64 0 -37 C 16 -64 54 -66 61 -35 C 69 -3 21 25 0 43 Z'
    return [shape(heart,'#f36e85',3,'#bc3f66',gradient('#ffafbb','#ec456c',[-23,-48],[40,42]),'heart'),shape('M -45 -31 C -43 -47 -30 -51 -21 -44',None,5,'#ffe6ea',name='heart-gloss'),ellipse(-42,-21,3,4,'#fff4f0')]

def limb(s,root,side,kind):
    shoulder=[256+side*57,326]
    if kind=='love':
        angles=[(0,-side*29),(15,-side*41),(29,side*43),(42,side*36),(70,side*38),(108,side*37),(133,side*28),(155,-side*25),(168,-side*29)]
        elbow=[(0,side*16),(16,side*8),(32,-side*25),(54,-side*18),(103,-side*20),(141,side*8),(168,side*16)]
    elif side<0:
        angles=[(0,-30),(14,-48),(25,-53),(40,-47),(58,-51),(77,-45),(100,-48),(126,-37),(150,-30),(168,-30)]
        elbow=[(0,5),(20,20),(35,10),(55,19),(75,12),(99,14),(125,8),(168,5)]
    else:
        angles=[(0,30),(16,42),(28,47),(42,39),(60,46),(82,39),(101,29),(117,-112),(128,-143),(140,-133),(155,25),(168,30)]
        elbow=[(0,-5),(28,-20),(55,-11),(84,-16),(104,-7),(122,-13),(138,-16),(151,3),(168,-5)]
    upper=s.add(('left' if side<0 else 'right')+' shoulder',parent=root,p=fixed(shoulder),r=keys(angles))
    s.add('upper foreleg',[shape('M -13 1 C -18 13 -14 31 -6 37 C 2 43 14 36 15 26 C 17 14 15 2 8 -3 C 1 -8 -8 -6 -13 1 Z','#fff0cf',2.2,'#d2b78c',gradient('#fff7db','#d8bd8c',[-9,5],[14,34]),'upper-arm')],parent=upper)
    lower=s.add('elbow',parent=upper,p=fixed([0,30]),r=keys(elbow))
    s.add('forearm',[shape('M -12 -1 C -16 12 -11 27 -5 32 C 4 37 13 29 13 19 L 12 -2 Z','#fff3d4',2,'#d6ba8d',gradient('#fff7df','#ddc392',[-8,3],[11,31]),'forearm')],parent=lower)
    hand=s.add('wrist',parent=lower,p=fixed([0,25]),r=keys([(0,0),(34,side*7),(68,-side*3),(112,side*3),(143,0),(168,0)]))
    s.add('turquoise padded paw',[ellipse(0,11,18,19,'#9edce0',2.5,'#89b6bc',gradient('#ddfaf1','#7dbecb',[-8,0],[15,25]),'paw'),ellipse(-9,5,4.3,6,'#cfefdf'),ellipse(0,1.5,4.3,6,'#dbf5e4'),ellipse(9,5,4.3,6,'#c8eadc'),shape('M -6 19 Q 0 22 6 19',None,1.6,'#79aab5',name='paw-fold')],parent=hand)

def face(s,head,kind):
    for side in [-1,1]:
        x=256+side*43
        eye_shapes=[ellipse(x,207,16,23,'#233958',2.7,'#26334d',gradient('#35497b','#101e3a',[x,y:=193],[x,228]),'eye'),ellipse(x+side*2,211,10,17,'#101d34'),ellipse(x-5,197,5.5,7,'#ffffff'),ellipse(x+6,218,2.6,3,'#8ed9e9')]
        reopen=112 if kind=='laugh' else 125
        eye_o=keys([(0,100),(19,100),(21,0),(reopen+10,0),(reopen+12,100),(168,100)])
        eye_scale=keys([(0,[100,100]),(12,[100,100]),(21,[100,2]),(reopen,[100,2]),(147,[100,100]),(168,[100,100])])
        s.add('open blue eye',eye_shapes,parent=head,o=eye_o,a=fixed([x,207]),p=fixed([x,207]),s=eye_scale)
        if kind=='laugh':d=f'M {x-18} 213 C {x-8} 197 {x+8} 197 {x+18} 212';rows=[(0,0),(18,0),(22,100),(114,100),(143,0),(168,0)]
        else:d=f'M {x-18} 208 C {x-9} 219 {x+9} 219 {x+18} 207';rows=[(0,0),(18,0),(22,100),(125,100),(143,0),(168,0)]
        s.add('expressive closed eyelid',[shape(d,None,5.5,'#3d4662',name='closed-eye')],parent=head,o=keys(rows))
        brow_y=177
        s.add('eyebrow',[shape(f'M {x-13} {brow_y+3} Q {x} {brow_y-8} {x+13} {brow_y+1}',None,5.2,'#374567',name='brow')],parent=head,p=keys([(0,[0,0]),(12,[0,-3]),(26,[0,-1]),(103,[0,-1]),(140,[0,0]),(168,[0,0])]))
        s.add('warm rosy cheek',[ellipse(256+side*66,235,20,11,'#efb4b0')],parent=head,o=keys([(0,35),(24,63),(106,68),(142,35),(168,35)]))
    muzzle=[ellipse(239,240,25,22,'#fff5d9',0,grad=gradient('#fffbe8','#ecd9b5',[239,227],[244,261]),name='muzzle-left'),ellipse(273,240,25,22,'#fff5d9',0,grad=gradient('#fffbe8','#ecd9b5',[273,227],[278,261]),name='muzzle-right')]
    s.add('soft muzzle',muzzle,parent=head)
    if kind=='laugh':
        # Identical four-point topology; actual mouth outline changes through the laugh.
        def mouth(w,h):return {'v':[[256-w,249],[256,249-h*.12],[256+w,249],[256,249+h]],'i':[[0,0],[-w*.5,0],[0,-h*.2],[w*.72,0]],'o':[[0,h*.6],[w*.5,0],[0,h*.6],[-w*.72,0]],'c':True}
        shape_keys=keys([(0,mouth(17,7)),(12,mouth(15,4)),(22,mouth(25,29)),(31,mouth(23,24)),(41,mouth(25,31)),(50,mouth(23,23)),(60,mouth(25,29)),(69,mouth(22,23)),(79,mouth(25,28)),(90,mouth(22,20)),(108,mouth(18,11)),(121,mouth(17,7)),(168,mouth(17,7))])
        s.add('animated laughing mouth',[{'ty':'gr','it':[{'ty':'sh','ks':shape_keys},fill('#5a344c'),stroke('#8c6e60',1.7),tr()]}],parent=head)
        s.add('tongue laugh',[ellipse(256,269,13,6,'#ee91a4')],parent=head,o=keys([(0,0),(15,0),(24,100),(91,100),(113,0),(168,0)]))
    else:s.add('contented smile',[shape('M 239 250 Q 247 263 256 251 Q 265 263 273 250',None,2.6,'#8e7159',name='smile')],parent=head)
    s.add('two tiny teeth',[roundrect(251,259,8,10,2.2,'#fffdf4'),roundrect(261,259,8,10,2.2,'#fffdf4')],parent=head)
    s.add('nose',[shape('M 244 229 C 242 218 271 218 269 229 C 267 234 259 235 256 239 C 253 235 246 234 244 229 Z','#394a70',1.7,'#243c5c',gradient('#8196bc','#293c64',[251,220],[260,237]),'nose'),ellipse(251,224,5,1.5,'#b7c7d9'),shape('M 256 237 L 256 247',None,1.7,'#9e805f',name='nose-line')],parent=head)

def build(kind):
    s=Scene('Lumen — '+('laughing to tears' if kind=='laugh' else 'a heart worth hugging'))
    # A contact shadow stays fixed. All character detail remains transparent vector shapes.
    s.add('grounding shadow',[ellipse(256,454,85,9,'#314667')],o=fixed(12))
    root=s.add('body acting rig',p=body_motion(kind),a=fixed([256,435]))
    s.add('cloak silhouette',[shape('M 207 291 C 192 307 176 349 155 409 Q 187 429 223 407 L 290 407 Q 328 428 359 409 C 335 350 322 306 306 291 Z','#213f76',3.1,'#162b54',gradient('#5472a5','#172953',[196,302],[313,424]),'cloak')],parent=root,r=keys([(0,0),(22,-2),(42,2),(65,-1),(89,1),(119,-1),(143,0),(168,0)]),a=fixed([256,306]),p=fixed([256,306]))
    for side in [-1,1]:
        x=256+side*36
        s.add('steady foot',[ellipse(x,443,28,17,'#9fd4d9',2.2,'#8ab4bc',gradient('#ddf6e7','#8bbcc7',[x-8,434],[x+20,457]),'foot'),shape(f'M {x-7} 445 L {x-8} 453',None,1.7,'#80abb8',name='toe-line-1'),shape(f'M {x+4} 445 L {x+5} 454',None,1.7,'#80abb8',name='toe-line-2')])
    s.add('cream belly',[shape('M 209 319 C 188 337 179 395 194 424 C 206 453 243 448 256 434 C 275 451 305 449 318 424 C 333 393 323 339 303 318 Q 257 298 209 319 Z','#fff0ce',3,'#d6bd91',gradient('#fff9e0','#dfc397',[234,328],[297,442]),'body'),ellipse(255,381,45,49,'#fff4db'),shape('M 235 408 Q 256 427 277 408',None,1.6,'#edd9b4',name='belly-contour')],parent=root)
    s.add('hood collar',[shape('M 203 292 Q 185 305 210 325 Q 237 339 256 315 Q 278 339 302 325 Q 326 307 309 293 Q 281 281 256 297 Q 230 281 203 292 Z','#304c86',2.8,'#182b52',gradient('#5f79ad','#203970',[220,289],[289,331]),'collar'),shape('M 205 302 Q 229 296 249 309 M 264 309 Q 286 296 309 302',None,3,'#7891bc',name='collar-highlight')],parent=root)
    head=s.add('head acting rig',parent=root,a=fixed([256,286]),p=keys([(0,[256,286]),(14,[256,289]),(27,[256,281]),(48,[256,283]),(78,[256,281]),(104,[256,284]),(132,[256,287]),(153,[256,286]),(168,[256,286])]),r=keys([(0,0),(15,-3 if kind=='laugh' else -7),(30,4 if kind=='laugh' else -9),(55,-3 if kind=='laugh' else -6),(80,3 if kind=='laugh' else 5),(108,0),(130,-4 if kind=='laugh' else 2),(153,0),(168,0)]))
    ear(s,head,-1,kind);ear(s,head,1,kind)
    head_outline='M 152 174 C 154 146 172 132 196 128 Q 199 112 207 109 L 218 125 Q 233 111 246 112 Q 252 99 266 94 L 262 116 Q 282 113 300 127 C 325 131 350 149 358 175 Q 365 192 367 204 L 377 222 L 367 225 L 377 241 L 365 241 Q 367 267 339 280 C 316 299 280 300 256 297 C 227 301 189 293 172 280 Q 146 264 146 243 L 135 242 L 145 226 L 134 222 L 146 204 Q 147 184 152 174 Z'
    s.add('original Lumen face design',[shape(head_outline,'#fff0cf',3.2,'#cdb28b',gradient('#fffbe9','#e5c892',[220,131],[286,302]),'fluffy-head'),shape('M 246 117 Q 251 103 266 94 L 262 120 Q 267 122 270 125 Q 262 141 257 168 Q 250 140 240 128 Z','#9bdce0',name='aqua-forelock'),shape('M 170 218 Q 162 239 173 253 Q 190 275 218 276',None,2,'#fff9e8',name='cheek-rim-left'),shape('M 342 218 Q 351 239 339 253 Q 326 272 303 276',None,2,'#fff9e8',name='cheek-rim-right')],parent=head)
    face(s,head,kind)
    medallion=[shape('M 236 315 L 224 303 L 227 326 L 240 332 Z','#e5a72d',2,'#b17924',name='clasp-wing-left'),shape('M 276 315 L 288 303 L 285 326 L 272 332 Z','#e5a72d',2,'#b17924',name='clasp-wing-right'),ellipse(256,319,24,24,'#f8bd35',2.3,'#9d6c28',gradient('#fff4a3','#d88e15',[246,303],[276,341]),'gold-rim'),ellipse(256,319,18,18,'#ffc22e',1.5,'#fff1ab',gradient('#fff6b6','#f5a405',[249,311],[268,333],True),'warm-gem'),ellipse(251,312,6,5,'#fff8cd')]
    s.add('golden Lumen amulet',medallion,parent=root)
    if kind=='love':
        s.add('the hug heart',heart_art(),parent=root,p=keys([(0,[256,380]),(15,[256,370]),(29,[256,369]),(47,[256,370]),(77,[256,368]),(108,[256,370]),(137,[256,376]),(168,[256,380])]),s=keys([(0,[65,65]),(14,[74,74]),(27,[107,107]),(40,[100,100]),(70,[105,105]),(84,[100,100]),(115,[101,101]),(145,[76,76]),(168,[65,65])]))
    limb(s,root,-1,kind);limb(s,root,1,kind)
    if kind=='laugh':
        for side in [-1,1]:
            for n,(start,life) in enumerate([(24,27),(55,30),(82,28)]):
                x=256+side*(66+n*3);y=223+n*2
                droplet=shape('M 0 -10 C 3 -5 8 0 7 5 C 6 13 -6 13 -7 5 C -8 0 -3 -5 0 -10 Z','#7dd6ed',1.7,'#51a7cb',gradient('#d6faff','#54b9df',[-3,-4],[5,12]),'joy-tear')
                s.add('arched joy tear',[droplet,ellipse(-2,1,1.7,3,'#e9fdff')],parent=head,p=keys([(0,[x,y]),(start,[x,y]),(start+life*.3,[x+side*18,y-3]),(start+life,[x+side*35,y+42]),(168,[x+side*35,y+42])]),r=keys([(0,-side*22),(start,-side*22),(start+life,side*18),(168,side*18)]),s=keys([(0,[0,0]),(start,[0,0]),(start+5,[100,100]),(start+life-5,[90,90]),(start+life,[0,0]),(168,[0,0])]),o=keys([(0,0),(start,0),(start+3,100),(start+life-4,100),(start+life,0),(168,0)]))
    else:
        for n,(x,y,start) in enumerate([(144,203,26),(365,181,40),(334,104,63)]):
            end=start+65
            s.add('rising affection heart',heart_art(),p=keys([(0,[x,y]),(start,[x,y]),(end,[x+(n-1)*10,y-42]),(168,[x+(n-1)*10,y-42])]),s=keys([(0,[0,0]),(start,[0,0]),(start+12,[27,27]),(end-12,[23,23]),(end,[0,0]),(168,[0,0])]),r=keys([(0,-12+n*12),(start,-12+n*12),(end,8-n*5),(168,8-n*5)]),o=keys([(0,0),(start,0),(start+10,100),(end-14,100),(end,0),(168,0)]))
    return s.data()

def render(data,out):
    from rlottie_python import LottieAnimation
    from PIL import Image,ImageDraw,ImageFont
    import numpy as np
    a=LottieAnimation.from_data(json.dumps(data));frames=[];bounds=[];deltas=[];prior=None;unique=set()
    pngdir=out/'frames';pngdir.mkdir(parents=True,exist_ok=True)
    for i in range(END):
        frame=a.render_pillow_frame(frame_num=i,width=512,height=512).convert('RGBA');frames.append(frame)
        frame.save(pngdir/f'{i:03}.png');bounds.append(frame.getchannel('A').getbbox());arr=np.asarray(frame).astype(float);unique.add(hashlib.sha256(arr.tobytes()).hexdigest())
        if prior is not None:deltas.append(float(np.mean(abs(arr-prior))))
        prior=arr
    poster=frames[58];poster.save(out/'poster.png')
    # GIF is a 30 FPS compatibility preview. MP4 and native TGS keep all 60 FPS.
    review=[]
    for f in frames:
        bg=Image.new('RGBA',f.size,'#f1f3fa');bg.alpha_composite(f);review.append(bg.convert('RGB'))
    review=review[::2]
    durations=[30 if i%3!=2 else 40 for i in range(len(review))]
    palette_sheet=Image.new('RGB',(512*7,512),'#f1f3fa')
    for n,i in enumerate([0,10,20,35,55,65,75]):palette_sheet.paste(review[i],(n*512,0))
    palette=palette_sheet.quantize(colors=192)
    indexed=[f.quantize(palette=palette,dither=Image.Dither.NONE) for f in review]
    indexed[0].save(out/'preview.gif',save_all=True,append_images=indexed[1:],duration=durations,loop=0,optimize=False,disposal=2)
    subprocess.run(['ffmpeg','-v','error','-y','-framerate','60','-i',str(pngdir/'%03d.png'),'-f','lavfi','-i','color=c=0xf1f3fa:s=512x512:r=60','-filter_complex','[1:v][0:v]overlay=shortest=1:format=auto,format=yuv420p','-c:v','libx264','-crf','18','-preset','fast','-an','-t','2.8','-movflags','+faststart',str(out/'preview.mp4')],check=True)
    subprocess.run(['ffmpeg','-v','error','-y','-framerate','30','-i',str(pngdir/'%03d.png'),'-vf','select=not(mod(n\\,2)),setpts=N/(30*TB)','-c:v','libvpx-vp9','-b:v','0','-crf','28','-pix_fmt','yuva420p','-an','-auto-alt-ref','0','-t','2.8',str(out/'telegram-video.webm')],check=True)
    # Six acting beats at a readable size, not a substitute for watching the loop.
    board=Image.new('RGB',(1024,768),'#f1f3fa')
    for n,i in enumerate([0,18,40,70,115,143]):
        f=frames[i].resize((341,341),Image.Resampling.LANCZOS);board.paste(f,((n%3)*341,(n//3)*384),f)
        ImageDraw.Draw(board).text(((n%3)*341+14,(n//3)*384+350),f'{i/FR:.2f}s',fill='#293e66')
    board.save(out/'acting-sheet.jpg',quality=94)
    clean=[b for b in bounds if b]
    return {'rendered_frames':END,'unique_frames':len(unique),'fps':FR,'duration':END/FR,'all_within_canvas':all(b[0]>0 and b[1]>0 and b[2]<512 and b[3]<512 for b in clean),'alpha_bounds':[min(b[0] for b in clean),min(b[1] for b in clean),max(b[2] for b in clean),max(b[3] for b in clean)],'mean_adjacent_delta':round(sum(deltas)/len(deltas),5),'maximum_adjacent_delta':round(max(deltas),5),'loop_delta':round(float(np.mean(abs(np.asarray(frames[0]).astype(float)-np.asarray(frames[-1]).astype(float)))),5),'gif_preview_fps':30,'mp4_preview_fps':60,'gif_preview_uses_centisecond_rounding':True,'renderer':'rlottie-python 1.3.8'}

def main():
    p=argparse.ArgumentParser();p.add_argument('--only',choices=['laugh','love','both'],default='both');p.add_argument('--render',action='store_true');args=p.parse_args()
    for kind in ['laugh','love'] if args.only=='both' else [args.only]:
        out=ROOT/'prototypes'/kind;out.mkdir(parents=True,exist_ok=True);data=build(kind)
        text=json.dumps(data,separators=(',',':'),ensure_ascii=False);(out/'source.lottie.json').write_text(text)
        tgs=gzip.compress(text.encode(),compresslevel=9,mtime=0);(out/'lumen.tgs').write_bytes(tgs)
        assert len(tgs)<=64*1024 and data['fr']==60 and data['op']/data['fr']<=3
        proof={'emoji':'😂' if kind=='laugh' else '🥰','kind':kind,'status':'awaiting_user_review','tgs_bytes':len(tgs),'sha256':hashlib.sha256(tgs).hexdigest(),'no_embedded_images':True,'no_expressions':True,'original_lumen_vector_art':True,'layers':len(data['layers']),'production_pack_changed':False}
        if args.render:proof.update(render(data,out))
        (out/'validation.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n');print(json.dumps(proof,ensure_ascii=False),flush=True)

if __name__=='__main__':main()
