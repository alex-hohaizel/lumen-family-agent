#!/usr/bin/env python3
"""Stage verified release bytes. Partial runs never publish a partial manifest."""
import argparse,hashlib,json,shutil,os
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parent
REPO=ROOT.parents[1]
ASSETS=REPO/'assets/stickers'
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def publish(source,target):
    if target.exists() and digest(source)==digest(target):return
    temporary=target.with_suffix(target.suffix+'.tmp');shutil.copyfile(source,temporary);os.replace(temporary,target)
def main(final=False):
    plan=json.loads((ROOT/'plan.json').read_text());archive={a['id']:a for a in json.loads((ASSETS/'archive-50-v18.json').read_text())}
    rows=[];qa=[];missing=[];upload=[]
    for row in plan['stickers']:
        name=row['id']
        if row['origin']=='approved_1_8':
            item=dict(archive[name],category=row['category'],origin=row['origin'],display_order=row['display_order'])
            assert digest(ASSETS/item['file'])==item['sha256']
            assert digest(ASSETS/item['preview'])==item['preview_sha256']
            rows.append(item);qa.append({'id':name,'sha256':item['sha256'],'preserved_approved_bytes':True});continue
        work=ROOT/'work'/name;qpath=work/'quality.json';source=ROOT/row['source']
        if not qpath.exists():missing.append(name);continue
        q=json.loads(qpath.read_text());webm=work/(name+'.webm');preview=work/'poster.png'
        if not webm.exists() or not preview.exists() or q.get('source_sha256')!=digest(source) or q.get('sha256')!=digest(webm):missing.append(name);continue
        assert q['technical_pass'] and q['alpha_decoded'] and q['unique_frames']==84 and q['trailing_repeated_frames']==0,name
        assert q['fps']==30 and q['frames']==84 and q['duration']==2.8 and q['bytes']==webm.stat().st_size<=262144,name
        if final:
            assert q.get('visual_review')=='approved',f'Visual review required: {name}'
            audit=json.loads((work/'native-audit.json').read_text())
            assert audit.get('passed') and audit.get('sha256')==q['sha256'] and audit.get('native_decoded_frames')==84,f'Native decode required: {name}'
        image=Image.open(preview);assert image.size==(512,512) and image.mode=='RGBA',name
        assert image.getchannel('A').getextrema()==(0,255),name
        publish(webm,ASSETS/(name+'.webm'));publish(preview,ASSETS/(name+'.png'))
        item={'id':name,'emoji':row['emoji'],'label':row['label'],'description':row['label']+'. '+row['scene_prompt'],'scene':row['label'],'file':name+'.webm','preview':name+'.png','bytes':q['bytes'],'sha256':q['sha256'],'preview_sha256':digest(preview),'motion_version':4,'fps':30,'frames':84,'duration':2.8,'source_keyposes_sha256':q['source_sha256'],'category':row['category'],'origin':row['origin'],'display_order':row['display_order']}
        rows.append(item);qa.append({'id':name,**q})
        for filename in [item['file'],item['preview']]:
            file=ASSETS/filename;data=file.read_bytes();upload.append({'path':'assets/stickers/'+filename,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'git_sha':hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()})
    (ROOT/'upload-index.json').write_text(json.dumps(upload,ensure_ascii=False,indent=2)+'\n')
    # Contact sheets use the exact staged previews, on both Telegram-like backgrounds.
    font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',16)
    for start in range(0,len(rows),30):
        group=rows[start:start+30];board=Image.new('RGB',(1200,1120),'#17232e');draw=ImageDraw.Draw(board)
        for i,item in enumerate(group):
            x=(i%6)*200;y=(i//6)*224;pic=Image.open(ASSETS/item['preview']).convert('RGBA');pic.thumbnail((190,190))
            board.paste(pic,(x+(200-pic.width)//2,y),pic);draw.text((x+7,y+194),f"{item['display_order']+1:03d} {item['id']}",font=font,fill='white')
        review=ROOT/'review';review.mkdir(exist_ok=True);board.save(review/f'palette-{start//30+1:02d}.jpg',quality=92)
    if final:
        assert not missing and len(rows)==120 and len(upload)==178
        assert len({r['id'] for r in rows})==len({r['emoji'] for r in rows})==len({r['sha256'] for r in rows})==120
        manifest=ASSETS/'manifest.json';temporary=manifest.with_suffix('.tmp');temporary.write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n');os.replace(temporary,manifest)
        (ROOT/'qa.json').write_text(json.dumps({'release':'1.10.0','count':120,'new':89,'retained_unchanged':31,'technical_pass':True,'visual_review':'approved','stickers':qa},ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'staged':len(rows),'new_ready':len(upload)//2,'missing':missing,'manifest_published':final},ensure_ascii=False))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--final',action='store_true');args=parser.parse_args();main(args.final)
