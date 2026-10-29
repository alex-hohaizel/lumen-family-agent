#!/usr/bin/env python3
"""Independently decode final WEBM bytes, never infer motion from source PNGs."""
import argparse,concurrent.futures,hashlib,json,subprocess
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parent
def audit(name):
    work=ROOT/'work'/name;native=work/(name+'.webm');qpath=work/'quality.json'
    if not qpath.exists() or not native.exists():return None
    q=json.loads(qpath.read_text());sha=hashlib.sha256(native.read_bytes()).hexdigest()
    if sha!=q['sha256']:return None
    target=work/'native-audit.json'
    if target.exists():
        previous=json.loads(target.read_text())
        if previous.get('sha256')==sha and previous.get('passed'):return previous
    info=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_streams','-show_format','-of','json',str(native)]));s=info['streams']
    assert len(s)==1 and s[0]['codec_name']=='vp9' and s[0]['width']==s[0]['height']==512 and s[0]['avg_frame_rate']=='30/1',name
    assert int(s[0]['nb_read_frames'])==84 and abs(float(info['format']['duration'])-2.8)<.01,name
    raw=subprocess.check_output(['ffmpeg','-v','error','-threads','1','-c:v','libvpx-vp9','-i',str(native),'-pix_fmt','rgba','-f','rawvideo','-'])
    decoded=np.frombuffer(raw,dtype=np.uint8).reshape((-1,512,512,4));assert decoded.shape[0]==84,name
    hashes=[hashlib.sha256(frame.tobytes()).hexdigest() for frame in decoded]
    unique=len(set(hashes));assert unique>=72,f'{name}: insufficient native movement {unique}'
    alpha=decoded[:,:,:,3];assert int(alpha.min())==0 and int(alpha.max())==255,name
    trailing=0
    for i in range(83,0,-1):
        if hashes[i]!=hashes[i-1]:break
        trailing+=1
    assert trailing<=1,f'{name}: frozen native tail'
    bounds=[]
    for a in alpha:
        yy,xx=np.where(a>24);assert len(xx),name;bounds.append([int(xx.min()),int(yy.min()),int(xx.max()),int(yy.max())])
    assert all(min(b[:2])>0 and max(b[2:])<511 for b in bounds),f'{name}: clipped decoded silhouette'
    result={'id':name,'sha256':sha,'bytes':len(native.read_bytes()),'codec':'vp9','width':512,'height':512,'fps':30,'duration':2.8,'native_decoded_frames':84,'native_unique_frames':unique,'native_trailing_repeated_frames':trailing,'native_alpha_range':[int(alpha.min()),int(alpha.max())],'native_loop_rgba_mae':float(np.abs(decoded[0].astype(float)-decoded[-1].astype(float)).mean()),'passed':True}
    target.write_text(json.dumps(result,indent=2)+'\n');return result
def main():
    parser=argparse.ArgumentParser();parser.add_argument('ids',nargs='*');args=parser.parse_args()
    names=args.ids or [r['id'] for r in json.loads((ROOT/'new.json').read_text())]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(audit,names))
    ready=[x for x in results if x];(ROOT/'native-audit.json').write_text(json.dumps({'count':len(ready),'passed':all(x['passed'] for x in ready),'stickers':ready},indent=2)+'\n')
    print(json.dumps({'decoded_native':len(ready),'waiting':len(names)-len(ready),'min_unique_frames':min((x['native_unique_frames'] for x in ready),default=0)}))
if __name__=='__main__':main()
