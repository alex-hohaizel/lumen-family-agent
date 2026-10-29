#!/usr/bin/env python3
"""Run after both source render queues have finished, before release staging."""
import json,subprocess,os,sys
from pathlib import Path
from finalize import CURATED
ROOT=Path(__file__).resolve().parent
for rank in range(1,51):
    d=ROOT/'work'/f'lumen_{rank:02d}';q=json.loads((d/'quality.json').read_text())
    sequence=json.loads((d/'extraction.json').read_text())['sequence'] if (d/'extraction.json').exists() else None
    rebuild=q.get('cadence_version')!=2 or rank in CURATED and sequence!=CURATED[rank]
    wanted={1:42,27:42,44:42}.get(rank,0)
    if not rebuild and q.get('encoding_version')==2 and q.get('preview_phase')==wanted:continue
    args=['python3',str(ROOT/'build.py'),str(rank),'--threads','4']+([] if rebuild else ['--encode-only'])
    with (d/'final-encoding.log').open('w') as f:p=subprocess.run(args,stdout=f,stderr=f,env={**os.environ,'OPENBLAS_NUM_THREADS':'2'})
    print(json.dumps({'final_encoding':rank,'rebuild':rebuild,'exit':p.returncode}),flush=True)
    if p.returncode:sys.exit(p.returncode)
