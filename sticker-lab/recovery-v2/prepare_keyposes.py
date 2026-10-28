#!/usr/bin/env python3
"""Extract complete generated actors by connected component, keeping one scale.

The source sheet must contain the eight Lumen poses made from assets/lumen.png.
No individual limbs, eyelids or mouth are extracted or separately transformed.
"""
import argparse,json,subprocess
from pathlib import Path
from PIL import Image
import numpy as np
from scipy import ndimage

ROOT=Path(__file__).resolve().parent

def main():
    p=argparse.ArgumentParser();p.add_argument('--rife-binary');p.add_argument('--model');args=p.parse_args()
    image=Image.open(ROOT/'keyframes-source.png').convert('RGBA');arr=np.asarray(image);labels,n=ndimage.label(arr[:,:,3]>32);sizes=np.bincount(labels.ravel());ids=[int(x) for x in np.flatnonzero(sizes>50000) if x]
    assert len(ids)==8,'Expected eight complete character poses'
    rows=[]
    for i in ids:
        yy,xx=np.where(labels==i);rows.append((int(yy.min())//512,float(xx.mean()),i))
    rows.sort()
    for d in ['keyframes-rgba','keyframes-rgb','input-black','input-white','interpolated-black','interpolated-white']:(ROOT/d).mkdir(exist_ok=True)
    for k,(_,_,i) in enumerate(rows):
        mask=labels==i;yy,xx=np.where(mask);x0=max(0,int(xx.min())-5);x1=min(image.width,int(xx.max())+6);y0=max(0,int(yy.min())-5);y1=min(image.height,int(yy.max())+6)
        piece=arr[y0:y1,x0:x1].copy();piece[:,:,3]*=ndimage.binary_dilation(mask,iterations=5)[y0:y1,x0:x1]
        cut=Image.fromarray(piece).resize((round((x1-x0)*.94),round((y1-y0)*.94)),Image.Resampling.LANCZOS)
        bottom=yy.max();feet=mask&(np.indices(mask.shape)[0]>bottom-24);footx=float(np.where(feet)[1].mean());canvas=Image.new('RGBA',(512,512));canvas.alpha_composite(cut,(round(256-(footx-x0)*.94),round(479-(bottom-y0)*.94)));canvas.save(ROOT/'keyframes-rgba'/f'{k:02}.png')
        bg=Image.new('RGBA',canvas.size,'#e9edf4');bg.alpha_composite(canvas);bg.convert('RGB').save(ROOT/'keyframes-rgb'/f'{k:02}.png')
    sequence=[0,1,2,3,4,3,2,1,0]
    for mode,color in [('black','#000000'),('white','#ffffff')]:
        for n,k in enumerate(sequence):
            frame=Image.open(ROOT/'keyframes-rgba'/f'{k:02}.png').convert('RGBA');bg=Image.new('RGBA',frame.size,color);bg.alpha_composite(frame);bg.convert('RGB').save(ROOT/('input-'+mode)/f'{n:03}.png')
    (ROOT/'sequence.json').write_text(json.dumps({'poses':sequence,'frames':84,'fps':30,'duration':2.8,'interpolator':'rife-ncnn-vulkan 20221029 / rife-v4.6','gpu_id':-1,'previous_vector_design':'rejected','new_sample':'unapproved'})+'\n')
    if args.rife_binary:
        assert args.model,'--model is required with --rife-binary'
        for mode in ['black','white']:
            subprocess.run([args.rife_binary,'-i',str(ROOT/('input-'+mode)),'-o',str(ROOT/('interpolated-'+mode)),'-n','84','-m',args.model,'-g','-1','-j','1:4:1','-f','%03d.png'],check=True)

if __name__=='__main__':main()
