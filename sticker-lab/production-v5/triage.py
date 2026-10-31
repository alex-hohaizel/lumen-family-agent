#!/usr/bin/env python3
"""Addressed all-new source triage; image boards do NOT confer motion acceptance."""
import hashlib,json,subprocess,time
from pathlib import Path
from PIL import Image,ImageDraw
import numpy as np
from repair import ROOT,REPO,sha

def main():
    started=time.monotonic()
    out=ROOT/'audit';out.mkdir(exist_ok=True)
    raw=json.loads((REPO.parent/'media-audit/decode-scan.json').read_text())
    rawitems={x['id']:x for x in raw['items']}
    ledger=[]
    for item in json.loads((REPO/'assets/stickers/manifest.json').read_text()):
        if item['origin']!='generated_1_10':continue
        source=REPO/'assets/stickers'/item['file']
        blob=subprocess.check_output(['ffmpeg','-v','error','-threads','2','-c:v','libvpx-vp9','-i',str(source),'-vsync','0','-f','rawvideo','-pix_fmt','rgba','-'])
        frames=np.frombuffer(blob,dtype=np.uint8).reshape(-1,512,512,4)
        assert len(frames)==84
        assert sha(source)==item['sha256']==rawitems[item['id']]['sha256']
        # An overview for each source; native frames are inspected on demand.
        board=Image.new('RGB',(1792,936),'#e9edf4');draw=ImageDraw.Draw(board)
        for i,arr in enumerate(frames):
            im=Image.fromarray(arr,'RGBA').resize((128,128),Image.Resampling.LANCZOS)
            x,y=(i%14)*128,(i//14)*156
            board.paste(im,(x,y+20),im);draw.text((x+3,y+3),f'{i:02d} {i/30:.2f}s',fill='#13213a')
        board.save(out/(item['id']+'-all84.jpg'),quality=94)
        risk=rawitems[item['id']]['max_adjacent_pair']
        selected=sorted(set([0,10,21,31,42,52,63,73,83]+[max(0,min(83,risk[0]+d)) for d in [-1,0,1]]))
        detail=Image.new('RGB',(1024,840),'#e9edf4');d=ImageDraw.Draw(detail)
        for j,i in enumerate(selected):
            im=Image.fromarray(frames[i],'RGBA').resize((256,256),Image.Resampling.LANCZOS)
            x,y=(j%4)*256,(j//4)*280
            detail.paste(im,(x,y+23),im);d.text((x+5,y+4),f'{item["id"]} f{i:02d}',fill='#13213a')
        detail.save(out/(item['id']+'-risk12.jpg'),quality=95)
        ledger.append({'id':item['id'],'scene':item['scene'],'label':item['label'],
                       'before_sha256':sha(source),'source_kind':'existing_encoded_video',
                       'ancestor_original_keyposes_sha256':item['source_keyposes_sha256'],
                       'original_sources_status':'unresolved',
                       'native_frames_decoded':84,
                       'decoded_rgba_frame_sha256':[hashlib.sha256(a.tobytes()).hexdigest() for a in frames],
                       'timestamps':'baseline full ffprobe timestamps in ../../../../media-audit/decode-scan.json',
                       'overview':str(out/(item['id']+'-all84.jpg')),
                       'risk_detail':str(out/(item['id']+'-risk12.jpg')),
                       'risk_detail_frames':selected,
                       'visual_triage_status':'pending','full_native_frame_review':'pending',
                       'native_playback':'pending','device_playback':'pending',
                       'repair_status':'unmodified','anatomy_and_emotion_verdict':'pending'})
    (out/'new89-ledger.json').write_text(json.dumps({'schema_version':1,'count':len(ledger),'method':'Every native frame decoded; all84 overview+selected256px risk detail; contact sheets are triage, not full temporal acceptance.','elapsed_seconds':time.monotonic()-started,'items':ledger},ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'count':len(ledger),'elapsed_seconds':time.monotonic()-started,'output':str(out)},ensure_ascii=False))

if __name__=='__main__':main()
