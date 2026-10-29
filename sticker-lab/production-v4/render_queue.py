"""Watch completed generated sheets and render independent whole-pose loops."""
import concurrent.futures,hashlib,json,os,subprocess,time,fcntl
from pathlib import Path
ROOT=Path(__file__).resolve().parent
rows=json.loads((ROOT/'new.json').read_text())
status={};attempted={};running={}
driver_lock=(ROOT/'render-queue.lock').open('w');fcntl.flock(driver_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
# Resume only hash-matched, fully completed outputs after an interrupted session.
for row in rows:
    source=ROOT/row['source'];work=ROOT/'work'/row['id'];qpath=work/'quality.json';native=work/(row['id']+'.webm')
    if not source.exists() or not qpath.exists() or not native.exists():continue
    try:
        fingerprint=hashlib.sha256(source.read_bytes()).hexdigest();q=json.loads(qpath.read_text())
        if q.get('technical_pass') and q.get('source_sha256')==fingerprint and q.get('sha256')==hashlib.sha256(native.read_bytes()).hexdigest() and native.stat().st_size==q['bytes']:
            attempted[row['id']]=fingerprint;status[row['id']]={'status':'rendered','source_sha256':fingerprint,'sha256':q['sha256'],'bytes':q['bytes'],'unique_frames':q['unique_frames'],'loop_rgba_mae':q['loop_rgba_mae']}
    except (ValueError,OSError,KeyError):pass
print(json.dumps({'resumed_verified':len(status),'remaining':len(rows)-len(status)}),flush=True)
def render(row,fingerprint):
    name=row['id'];rank=int(name.split('_')[1]);work=ROOT/'work'/name;work.mkdir(parents=True,exist_ok=True)
    with (work/'render.log').open('w') as log:
        result=subprocess.run(['python3',str(ROOT/'build.py'),str(rank),'--threads','3'],stdout=log,stderr=log,cwd=ROOT.parents[1])
    qpath=work/'quality.json'
    if result.returncode or not qpath.exists():return {'status':'failed','exit_code':result.returncode,'source_sha256':fingerprint}
    q=json.loads(qpath.read_text());q['source_sha256']=fingerprint;qpath.write_text(json.dumps(q,indent=2)+'\n')
    return {'status':'rendered','source_sha256':fingerprint,'sha256':q['sha256'],'bytes':q['bytes'],'unique_frames':q['unique_frames'],'loop_rgba_mae':q['loop_rgba_mae']}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    while True:
        for f,(row,fingerprint) in list(running.items()):
            if not f.done():continue
            try:status[row['id']]=f.result()
            except Exception as e:status[row['id']]={'status':'failed','error':str(e),'source_sha256':fingerprint}
            print(json.dumps({'id':row['id'],**status[row['id']]},ensure_ascii=False),flush=True);del running[f]
        for row in rows:
            source=ROOT/row['source'];metadata=source.with_suffix('.json')
            if not source.exists() or not metadata.exists():continue
            fingerprint=hashlib.sha256(source.read_bytes()).hexdigest()
            if attempted.get(row['id'])==fingerprint:continue
            if len(running)>=3:break
            attempted[row['id']]=fingerprint;status[row['id']]={'status':'rendering','source_sha256':fingerprint};running[pool.submit(render,row,fingerprint)]=(row,fingerprint)
        snapshot={'total':len(rows),'source_ready':sum((ROOT/r['source']).exists() for r in rows),'rendered':sum(x['status']=='rendered' for x in status.values()),'failed':sum(x['status']=='failed' for x in status.values()),'items':status,'updated_at':time.time()}
        temporary=ROOT/'render-progress.tmp';temporary.write_text(json.dumps(snapshot,indent=2)+'\n');os.replace(temporary,ROOT/'render-progress.json')
        if len(attempted)==len(rows) and not running:break
        time.sleep(3)
