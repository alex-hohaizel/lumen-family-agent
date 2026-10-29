#!/usr/bin/env python3
"""Bounded local render queue, independent of the live Telegram service."""
import concurrent.futures,json,os,subprocess,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent

def build(rank):
    started=time.time();d=ROOT/'work'/f'lumen_{rank:02d}';d.mkdir(parents=True,exist_ok=True)
    with (d/'build.log').open('w') as log:
        p=subprocess.run(['python3',str(ROOT/'build.py'),str(rank),'--threads','4'],stdout=log,stderr=log,env={**os.environ,'OPENBLAS_NUM_THREADS':'2'})
    print(json.dumps({'rank':rank,'exit':p.returncode,'seconds':round(time.time()-started,1)},ensure_ascii=False),flush=True)
    if p.returncode:(d/'failed.json').write_text(json.dumps({'exit':p.returncode,'time':time.time()})+'\n')
    return p.returncode

def main():
    pending={};seen=set();started=time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        while time.time()-started<4*3600:
            for f,rank in list(pending.items()):
                if f.done():f.result();del pending[f]
            for p in sorted((ROOT/'sources').glob('lumen_*.png')):
                rank=int(p.stem.split('_')[1]);d=ROOT/'work'/p.stem
                if rank in seen or (d/'quality.json').exists() or (d/'failed.json').exists():continue
                if len(pending)>=2:break
                seen.add(rank);pending[pool.submit(build,rank)]=rank;print(f'RENDER {rank:02d}',flush=True)
            complete=[i for i in range(1,51) if (ROOT/'work'/f'lumen_{i:02d}'/'quality.json').exists()]
            state={'completed':complete,'rendering':list(pending.values()),'sources':len(list((ROOT/'sources').glob('lumen_*.png'))),'failures':[p.parent.name for p in (ROOT/'work').glob('*/failed.json')]}
            (ROOT/'progress.json').write_text(json.dumps(state,indent=2)+'\n')
            if len(complete)==50 and not pending:break
            time.sleep(2)
if __name__=='__main__':main()
