#!/usr/bin/env python3
"""Continuously deform the original Lumen artwork on a periodic 8 s timeline.

The original texture stays registered: no pose swapping or optical-flow blends.
An imagegen closed-eyelid texture, when supplied, is used only inside eye masks.
"""
import argparse
import json
import math
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL = ROOT / 'assets/lumen.png'
SIZE = 1000
DURATION = 8
FPS = 60
MODE = "avatar"
OUTPUT_SIZE = 800
BBOX = (240, 141, 962, 1181)
SCALE = 890 / (BBOX[3] - BBOX[1])
OFFSET = ((SIZE - round((BBOX[2] - BBOX[0]) * SCALE)) // 2, 55)


def ease(x):
    x = min(1., max(0., x))
    return x * x * x * (x * (x * 6 - 15) + 10)


def blink_at(t):
    # 170 ms close, 70 ms hold, 280 ms reopen; exactly one blink per loop.
    u = t - 3.17
    if u < 0 or u >= .52:
        return 0.
    if u < .17:
        return ease(u / .17)
    if u < .24:
        return 1.
    return 1 - ease((u - .24) / .28)


def registered(im):
    cut = im.crop(BBOX)
    cut = cut.resize((round(cut.width * SCALE), round(cut.height * SCALE)), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (SIZE, SIZE))
    canvas.alpha_composite(cut, OFFSET)
    return canvas


def source_to_canvas(x, y):
    return (round((x - BBOX[0]) * SCALE + OFFSET[0]), round((y - BBOX[1]) * SCALE + OFFSET[1]))


def prepare_blink(original, closed_path):
    if closed_path is None:
        return None
    closed = Image.open(closed_path).convert('RGBA')
    # Canvas registration preserves the source coordinates; stray alpha pixels are ignored.
    closed = closed.resize(Image.open(ORIGINAL).size, Image.Resampling.LANCZOS)
    aligned = registered(closed)
    eyes = []
    for cx, cy in [(461, 435), (743, 435)]:
        x0, y0 = source_to_canvas(cx - 68, cy - 82)
        x1, y1 = source_to_canvas(cx + 68, cy + 82)
        box = (x0, y0, x1, y1)
        patch = original.crop(box)
        lid = aligned.crop(box)
        # A broad fur feather avoids a visible boundary around the blink texture.
        mask = Image.new('L', patch.size)
        ImageDraw.Draw(mask).ellipse((3, 3, patch.width - 4, patch.height - 4), fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(4.5))
        eyes.append((box, patch, lid, mask))
    return eyes


def with_blink(base, eyes, amount):
    if not eyes or amount <= .00001:
        return base
    result = base.copy()
    for box, opened, closed, mask in eyes:
        if amount >= .99999:
            lid = closed
        else:
            from scipy.ndimage import map_coordinates
            w, h = opened.size
            xx, yy = np.meshgrid(np.arange(w,dtype=float),np.arange(h,dtype=float))
            xn = (xx - (w - 1) / 2) / (w * .40)
            arc = np.minimum(xn*xn,1.5)
            closed_curve = h * (.59 + .11 * arc)
            upper = (h * (.13 + .42 * arc)) * (1-amount) + closed_curve * amount
            lower = (h * (.85 - .22 * arc)) * (1-amount) + closed_curve * amount
            # Translate the generated lid texture onto the current upper lid.
            sample_y = yy + closed_curve - upper
            source = np.asarray(closed)
            top_texture = np.stack([map_coordinates(source[:,:,c],[sample_y,xx],order=1,mode='nearest') for c in range(4)],axis=2).astype('uint8')
            above = np.clip((upper - yy + 1.2)/2.4,0,1)
            below = np.clip((yy - lower + 1.2)/2.4,0,1)
            top_mask = Image.fromarray((above*255).astype('uint8'))
            lower_mask = Image.fromarray((below*255).astype('uint8'))
            lid = Image.composite(Image.fromarray(top_texture),opened,top_mask)
            lid = Image.composite(closed,lid,lower_mask)
        result.paste(lid, box, mask)
    return result


def mesh_at(t):
    phase = 2 * math.pi * t / DURATION
    angle = math.radians(2.6 if MODE == "thinking" else 1.65) * math.sin(phase)
    inhale = math.sin(phase * 2)
    c, s = math.cos(angle), math.sin(angle)
    grid = np.linspace(0, SIZE, 33)
    xx, yy = np.meshgrid(grid, grid)
    head = np.clip((545 - yy) / 100, 0, 1)
    head = head * head * (3 - 2 * head)
    anchor = np.clip((945 - yy) / 270, 0, 1)
    # Inverse rotation around the neck gives a rigid head with a soft neck joint.
    rx = (xx - 500) * c + (yy - 495) * s + 500
    ry = -(xx - 500) * s + (yy - 495) * c + 495
    sx = xx + (rx - xx) * head
    sy = yy + (ry - yy) * head + 5.0 * inhale * anchor
    sx += 1.4 * math.sin(phase) * anchor
    torso = np.exp(-((yy - 735) / 145) ** 2) * (1 - head)
    sx -= (xx - 500) * .0055 * inhale * torso
    # Tiny ear and cloak motion are periodic and remain attached to the body.
    ear_left = np.exp(-((xx - 305) / 90) ** 2 - ((yy - 165) / 120) ** 2)
    ear_right = np.exp(-((xx - 695) / 90) ** 2 - ((yy - 165) / 120) ** 2)
    sy += 1.7 * math.sin(phase * 2 + .5) * (ear_left - ear_right)
    cloak = np.exp(-((yy - 680) / 125) ** 2) * np.exp(-((np.abs(xx - 500) - 200) / 55) ** 2)
    sx += 2.5 * math.sin(phase + .4) * cloak
    if MODE == "waving":
        # A raised-paw source is deformed around the elbow on a four-second arc.
        px, py = source_to_canvas(435, 805)
        theta = math.radians(5.5) * math.sin(phase * 2)
        ca, sa = math.cos(theta), math.sin(theta)
        hand = np.exp(-((xx - 330) / 95) ** 2 - ((yy - 545) / 140) ** 2)
        hand *= np.clip((yy - 435) / 65, 0, 1)
        ax = (xx-px)*ca + (yy-py)*sa + px
        ay = -(xx-px)*sa + (yy-py)*ca + py
        sx += (ax-xx)*hand
        sy += (ay-yy)*hand
    mesh = []
    for y in range(32):
        for x in range(32):
            rect = (round(grid[x]), round(grid[y]), round(grid[x+1]), round(grid[y+1]))
            quad = tuple(float(v) for p in [(y,x),(y+1,x),(y+1,x+1),(y,x+1)] for v in (sx[p],sy[p]))
            mesh.append((rect,quad))
    return mesh


def render_frame(base, eyes, t):
    source = with_blink(base, eyes, 1.0 if MODE == "happy" else (0.0 if MODE == "waving" else blink_at(t)))
    frame = source.transform((SIZE,SIZE), Image.Transform.MESH, mesh_at(t), Image.Resampling.BICUBIC)
    background = Image.new('RGBA',(SIZE,SIZE),(245,247,250,255))
    # The stationary contact shadow anchors the feet while the body breathes.
    shadow = Image.new('RGBA',(SIZE,SIZE))
    ImageDraw.Draw(shadow).ellipse((348,923,652,958), fill=(54,73,91,29))
    background.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(10)))
    background.alpha_composite(frame)
    return background.convert('RGB').resize((OUTPUT_SIZE,OUTPUT_SIZE),Image.Resampling.LANCZOS)


def main():
    global ORIGINAL, MODE, OUTPUT_SIZE
    ap=argparse.ArgumentParser()
    ap.add_argument('--closed',type=Path,default=ROOT/'assets/lumen-blink-closed-v3.png')
    ap.add_argument('--original',type=Path)
    ap.add_argument('--mode',choices=['avatar','idle','happy','thinking','waving'],default='avatar')
    ap.add_argument('--size',type=int)
    ap.add_argument('--output',type=Path)
    ap.add_argument('--stills',action='store_true')
    args=ap.parse_args()
    MODE=args.mode
    ORIGINAL=args.original or ROOT/'assets'/('lumen-wave-pose-v3.png' if MODE=='waving' else 'lumen.png')
    OUTPUT_SIZE=args.size or (800 if MODE=='avatar' else 512)
    args.output=args.output or ROOT/'assets'/f'lumen-{MODE}.mp4'
    args.output.parent.mkdir(parents=True,exist_ok=True)
    original=Image.open(ORIGINAL).convert('RGBA')
    if MODE == 'waving':
        from scipy.ndimage import label
        alpha=np.asarray(original.getchannel('A'))
        labels,count=label(alpha>128)
        counts=np.bincount(labels.ravel());counts[0]=0
        component=labels==counts.argmax()
        ys,xs=np.where(component)
        bounds=(int(xs.min()),int(ys.min()),int(xs.max()+1),int(ys.max()+1))
        original.putalpha(Image.fromarray(np.where(component,alpha,0).astype('uint8')))
        cut=original.crop(bounds).resize((BBOX[2]-BBOX[0],BBOX[3]-BBOX[1]),Image.Resampling.LANCZOS)
        original=Image.new('RGBA',(1205,1305))
        original.alpha_composite(cut,(BBOX[0],BBOX[1]))
    # The supplied cutout contains a 1–2 px magenta matte; keep it outside the animated alpha.
    original.putalpha(original.getchannel('A').filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(.45)))
    base=registered(original)
    eyes=prepare_blink(base,None if MODE=='waving' else args.closed)
    if args.stills:
        for t in [0,1,2,3.17,3.25,3.34,3.45,3.62,4,5,6,7.983333,8]:
            render_frame(base,eyes,t).save(args.output.parent/f'frame-{t:05.2f}.png')
        print('QA stills ready',flush=True)
        return
    cmd=['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{OUTPUT_SIZE}x{OUTPUT_SIZE}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','medium','-crf','16','-pix_fmt','yuv420p','-movflags','+faststart',str(args.output)]
    proc=subprocess.Popen(cmd,stdin=subprocess.PIPE)
    try:
        for n in range(DURATION*FPS):
            proc.stdin.write(render_frame(base,eyes,n/FPS).tobytes())
            if n%60==0:print(json.dumps({'rendered_seconds':n/FPS,'total_seconds':DURATION}),flush=True)
        proc.stdin.close()
        if proc.wait():raise RuntimeError('FFmpeg failed')
    except BaseException:
        proc.kill();proc.wait();raise
    first=np.asarray(render_frame(base,eyes,0),dtype=float)
    last=np.asarray(render_frame(base,eyes,DURATION),dtype=float)
    assert np.array_equal(first,last),'Rig period must be exact'
    print(json.dumps({'output':str(args.output),'duration':DURATION,'fps':FPS,'bytes':args.output.stat().st_size,'periodic_geometry':True,'eye_texture':args.closed is not None}),flush=True)


if __name__=='__main__':main()
