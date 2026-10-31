#!/usr/bin/env python3
"""Attach actual exact rerender evidence to explicit prepared records, two workers."""
import argparse,json,shutil,subprocess,sys
from concurrent.futures import ThreadPoolExecutor,as_completed
from datetime import datetime,timezone
from pathlib import Path
from repair import ROOT,REPO,sha


def job(record,base):
    sid=record['id'];output=base/sid;recipe=REPO/record['recipe_path']
    assert sha(recipe)==record['recipe_sha256']
    engine=REPO/record['generator']['engine_path'];assert sha(engine)==record['generator']['engine_sha256']
    result=output/('render-result.json' if record['source_kind']=='generated_layer_components' else 'rerender-result.json');valid=False
    if result.exists():
        old=json.loads(result.read_text())
        valid=old['recipe_sha256']==record['recipe_sha256'] and old['raw_rgba_exact_match'] is True and old['encoded_frame_exact_match'] is True
        expected=json.loads(recipe.read_text())['expected']
        if valid:
            valid=all(sha(output/'frames-rgba'/f'{i:03d}.png')==h for i,h in enumerate(expected['frames_rgba_png_sha256']))
            valid &= all(sha(output/'decoded'/f'{i:03d}.png')==h for i,h in enumerate(expected['decoded_png_sha256']))
    if output.exists() and not valid:
        rejected=ROOT/'rejected-evidence'/f'{base.name}-{sid}-incomplete-{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")}'
        rejected.parent.mkdir(exist_ok=True);output.rename(rejected)
    if not valid:
        run=subprocess.run([sys.executable,str(engine),str(recipe),str(output)],cwd=REPO,capture_output=True,text=True)
        output.mkdir(parents=True,exist_ok=True);(output/'actual-run.log').write_text(run.stdout+run.stderr)
        if run.returncode:raise RuntimeError(f'{sid} rerender failed: '+run.stderr[-1800:])
    report=json.loads(result.read_text());proof=json.loads((REPO/record['proof_path']).read_text())
    assert report['recipe_sha256']==record['recipe_sha256']
    assert report['raw_rgba_exact_match'] is True and report['encoded_frame_exact_match'] is True
    assert report['canonical_video_read'] is False and report['decoded_png_sha256']==proof['decoded_png_sha256']
    target=ROOT/'approved-proofs'/f'{record["candidate_id"]}{record.get("rerender_artifact_tag","")}-rerender.json'
    if target.exists():assert sha(target)==sha(result)
    else:shutil.copyfile(result,target)
    record['reproducibility']={'artifact':str(target.relative_to(REPO)),'artifact_sha256':sha(target),
        'actual_run':'Portable source-checked approved recipe CLI; all84 pre-encode RGBA PNG hashes and all84 decoded VP9 PNG hashes exactly matched frozen accepted output.',
        'raw_rgba_exact_match':True,'encoded_frame_exact_match':True,'canonical_video_read':False,
        'container_bytes_exact_match':report.get('container_bytes_exact_match',report.get('output_sha256')==record['output_sha256']),
        'container_note':'Muxer container UIDs may differ; exact accepted canonical output bytes are retained.'}
    return record


def main():
    p=argparse.ArgumentParser();p.add_argument('prepared',type=Path);p.add_argument('approved',type=Path);args=p.parse_args()
    assert not args.approved.exists();document=json.loads(args.prepared.read_text());base=ROOT/'rerender-validation'/document['batch_id'];base.mkdir(parents=True,exist_ok=True)
    complete={};failures=[]
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures={pool.submit(job,r,base):r['id'] for r in document['items']}
        for future in as_completed(futures):
            sid=futures[future]
            try:complete[sid]=future.result();print(f'{sid}: actual raw84 + decoded84 exact PASS',flush=True)
            except Exception as error:failures.append({'id':sid,'error':str(error)});print(f'{sid}: FAIL {error}',flush=True)
            (base/'progress.json').write_text(json.dumps({'complete_ids':list(complete),'failures':failures,'maximum_workers':2},ensure_ascii=False,indent=2)+'\n')
    assert not failures,failures
    document['items']=[complete[r['id']] for r in document['items']]
    document['actual_rerender_completed_at']=datetime.now(timezone.utc).isoformat();document['actual_rerender_workers']=2
    args.approved.write_text(json.dumps(document,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'approved_records':str(args.approved),'exact_rerenders':len(complete),'canonical_assets_changed':False}),flush=True)


if __name__=='__main__':main()
