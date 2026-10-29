#!/usr/bin/env python3
"""Bounded independent final encodes while the early assets finish sequentially."""
import concurrent.futures,json,subprocess,os
from pathlib import Path
from finalize import CURATED
ROOT=Path(__file__).resolve().parent
def finish(rank):
    d=ROOT/'work'/f'lumen_{rank:02d}';q=json.loads((d/'quality.json').read_text());sequence=json.loads((d/'extraction.json').read_text())['sequence'] if (d/'extraction.json').exists() else None
    rebuild=q.get('cadence_version')!=2 or rank in CURATED and sequence!=CURATED[rank];wanted={1:42,27:42,44:42}.get(rank,0)
    if not rebuild and q.get('encoding_version')==2 and q.get('preview_phase')==wanted:return
    with (d/'parallel-finish.log').open('w') as log:p=subprocess.run(['python3',str(ROOT/'build.py'),str(rank),'--threads','4']+([] if rebuild else ['--encode-only']),stdout=log,stderr=log,env={**os.environ,'OPENBLAS_NUM_THREADS':'2'})
    print(json.dumps({'finish':rank,'rebuild':rebuild,'exit':p.returncode}),flush=True)
    assert p.returncode==0
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(finish,range(30,51)))
