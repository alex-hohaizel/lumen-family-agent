#!/usr/bin/env python3
"""Make a contact sheet and a video index from the actual shipped VP9 files."""
import argparse,json,subprocess
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parent
REPO=ROOT.parents[1]
FONT='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

def run(args):subprocess.run([str(a) for a in args],check=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('output',type=Path);args=parser.parse_args()
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=True)
    assets=json.loads((REPO/'assets/stickers/manifest.json').read_text())
    title=ImageFont.truetype(FONT,36);small=ImageFont.truetype(FONT,18)
    sheet=Image.new('RGB',(1500,3440),'#eef2f7');draw=ImageDraw.Draw(sheet)
    draw.text((30,16),'ЛЮМЕН · 50 ЕМОЦІЙ',font=title,fill='#19304b')
    for n,a in enumerate(assets):
        x=n%5*300;y=n//5*336+72
        im=Image.open(REPO/'assets/stickers'/a['preview']).convert('RGBA').resize((288,288),Image.Resampling.LANCZOS)
        sheet.paste(im,(x+6,y),im);draw.text((x+10,y+292),f'{n+1:02d} · '+a['label'],font=small,fill='#19304b')
    sheet.save(out/'Lumen_50_Preview.jpg',quality=96)
    pages=[]
    for start in range(0,50,9):
        group=assets[start:start+9];page=Image.new('RGB',(960,1120),'#eef2f7');d=ImageDraw.Draw(page)
        d.text((26,18),f'ЛЮМЕН · {start+1:02d}–{min(50,start+9):02d} / 50',font=title,fill='#19304b')
        for i,a in enumerate(group):
            x=i%3*320;y=i//3*340+78
            d.rounded_rectangle((x+8,y,x+312,y+330),18,fill='#e2eaf4')
            d.text((x+18,y+300),f'{start+i+1:02d} · '+a['label'],font=small,fill='#19304b')
        bg=out/f'page-{start//9+1}.png';page.save(bg)
        cmd=['ffmpeg','-v','error','-y','-threads','1','-loop','1','-framerate','30','-i',bg]
        for a in group:cmd+=['-threads','1','-stream_loop','1','-c:v','libvpx-vp9','-i',REPO/'assets/stickers'/a['file']]
        filters=[];current='0:v'
        for i,a in enumerate(group):
            x=i%3*320+16;y=i//3*340+78
            filters.append(f'[{i+1}:v]scale=288:288:flags=lanczos,format=rgba[st{i}]')
            filters.append(f'[{current}][st{i}]overlay=x={x}:y={y}:shortest=1:format=auto[pg{i}]');current=f'pg{i}'
        filters.append(f'[{current}]format=yuv420p[final]')
        dest=out/f'page-{start//9+1}.mp4';pages.append(dest)
        cmd+=['-filter_complex_threads','1','-filter_complex',';'.join(filters),'-map','[final]','-t','5.6','-r','30','-an','-c:v','libx264','-threads','2','-crf','18','-preset','fast','-movflags','+faststart',dest];run(cmd)
    listing=out/'pages.txt';listing.write_text(''.join("file '"+str(p)+"'\n" for p in pages))
    run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',listing,'-c','copy','-movflags','+faststart',out/'Lumen_50_Showcase.mp4'])
    for p in pages:p.unlink()
    for p in out.glob('page-*.png'):p.unlink()
    listing.unlink()

if __name__=='__main__':main()
