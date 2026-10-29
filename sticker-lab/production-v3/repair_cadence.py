#!/usr/bin/env python3
"""Rebuild early drafts with the final moving-frame cadence and coherent poses."""
from pathlib import Path
import subprocess,json,os
ROOT=Path(__file__).resolve().parent
for rank in [1,3,4,5,6,7,8,9,10,11,12,14,18]:
    d=ROOT/'work'/f'lumen_{rank:02d}';d.mkdir(exist_ok=True)
    with (d/'cadence-rebuild.log').open('w') as log:r=subprocess.run(['python3',str(ROOT/'build.py'),str(rank),'--threads','2'],stdout=log,stderr=log,env={**os.environ,'OPENBLAS_NUM_THREADS':'2'})
    if r.returncode==0:(d/'failed.json').unlink(missing_ok=True)
    else:(d/'failed.json').write_text(json.dumps({'repair_exit':r.returncode})+'\n')
    print(json.dumps({'cadence_rebuild':rank,'exit':r.returncode}),flush=True)
