#!/usr/bin/env python3
"""Small batches of temporal contact sheets, preserving the eight review phases."""
import json,math
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parent
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',18)
rows=json.loads((ROOT/'new.json').read_text());ready=[]
for row in rows:
    work=ROOT/'work'/row['id'];q=work/'quality.json';contact=ROOT/'review'/(row['id']+'_motion.jpg')
    if not q.exists() or not contact.exists():continue
    proof=json.loads(q.read_text())
    ready.append((row,proof,contact))
pages=[]
for start in range(0,len(ready),8):
    batch=ready[start:start+8];board=Image.new('RGB',(1536,len(batch)*218),'#17232e');draw=ImageDraw.Draw(board)
    for n,(row,proof,contact) in enumerate(batch):
        source=Image.open(contact)
        draw.text((8,n*218+2),row['id']+'   '+row['label']+'   '+proof['sha256'][:12],font=font,fill='white')
        for cell in range(8):
            x=(cell%4)*256;y=(cell//4)*256;tile=source.crop((x,y,x+256,y+256)).resize((192,192),Image.Resampling.LANCZOS);board.paste(tile,(cell*192,n*218+25))
    filename=f'temporal-{start//8+1:02d}.jpg';board.save(ROOT/'review'/filename,quality=93);pages.append({'file':filename,'items':[{'id':row['id'],'sha256':proof['sha256']} for row,proof,_ in batch]})
(ROOT/'review'/'temporal-index.json').write_text(json.dumps(pages,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'ready':len(ready),'pages':len(pages)}))
