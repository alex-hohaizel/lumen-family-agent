#!/usr/bin/env python3
"""Archive exact existing QA-bound review videos without changing their history.

Only snapshots associated with a staged exact candidate and its frozen package
or proof are copied. Independently closed replacement clips supersede invalid
historical clips. This creates no perceptual playback or human-review claim.
"""
import argparse,hashlib,json,shutil,subprocess
from datetime import datetime,timezone
from pathlib import Path
from repair import ROOT,REPO,sha


def read(p):return json.loads(Path(p).read_text())
def kind(path):
    name=Path(path).name.lower()
    return 'slow' if 'slow' in name else ('normal' if 'normal' in name else None)


def frozen_package(repair):
    path=repair.get('frozen_package_manifest_path')
    if path:
        assert sha(REPO/path)==repair['frozen_package_manifest_sha256']
        return path,read(REPO/path)
    qaref=repair['qa'];assert sha(REPO/qaref['artifact'])==qaref['artifact_sha256'];qa=read(REPO/qaref['artifact'])
    binding=qa.get('package_binding',qa.get('package',{}));manifest=binding.get('manifest')
    if isinstance(manifest,dict):path=manifest['artifact'];expected=manifest['sha256']
    elif binding.get('path'):
        path=binding['path'];expected=next(binding[key] for key in ['file_sha256','package_file_sha256','package_sha256','sha256'] if binding.get(key))
    else:return None,None
    source=REPO/path;assert sha(source)==expected
    target=ROOT/'approved-proofs'/f'portable-review-package-{expected[:16]}.json'
    if target.exists():assert sha(target)==expected
    else:shutil.copyfile(source,target)
    assert sha(target)==expected
    return str(target.relative_to(REPO)),read(target)


def validate_final(path,ref):
    assert sha(path)==ref['sha256'] and path.stat().st_size==ref['bytes']
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_streams','-show_format','-of','json',str(path)]))
    assert len(probe['streams'])==1 and probe['streams'][0]['codec_type']=='video'
    stream=probe['streams'][0];count=int(stream['nb_read_frames']);duration=float(probe['format']['duration'])
    numerator,denominator=map(int,stream['r_frame_rate'].split('/'));fps=numerator/denominator
    assert count>0 and fps>0 and duration>0
    expected_frames=ref.get('frames',ref.get('actual_decoded_frames'))
    if expected_frames is not None:assert count==int(expected_frames)
    if ref.get('duration') is not None:assert abs(duration-float(ref['duration']))<.001
    frames=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',str(path)]))['frames']
    pts=[float(frame['best_effort_timestamp_time']) for frame in frames]
    assert len(pts)==count and all(abs(t-i/fps)<.0001 for i,t in enumerate(pts))
    subprocess.run(['ffmpeg','-nostdin','-v','error','-xerror','-err_detect','explode','-i',str(path),'-map','0:v:0','-f','null','-'],check=True)
    assert sha(path)==ref['sha256'] and path.stat().st_size==ref['bytes']
    return {'frames':count,'duration':duration,'fps':fps,'all_frame_pts_regular':True,'full_xerror_decode_pass':True,'width':stream['width'],'height':stream['height']}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('output',type=Path);parser.add_argument('--previous',type=Path);a=parser.parse_args();assert not a.output.exists()
    previous=read(a.previous) if a.previous else None
    prior={}
    if previous:
        assert previous['all_final_copy_sha_bytes_rechecked_after_all_decodes'] is True
        for item in previous['items']:
            for clip in item['review_clips']:
                assert sha(REPO/clip['path'])==clip['sha256'] and (REPO/clip['path']).stat().st_size==clip['bytes']
                prior[(item['candidate_sha256'],clip['path'],clip['sha256'])]=clip
    mp=REPO/'assets/stickers/manifest.json';manifest_hash=sha(mp);assets=read(mp);items=[];files=[]
    for asset in [row for row in assets if row.get('motion_version')==5]:
        sid=asset['id'];repair=asset['repair_provenance'];proof_path=REPO/repair['proof_path'];assert sha(proof_path)==repair['proof_sha256'];proof=read(proof_path)
        assert proof['candidate_sha256']==asset['sha256'];package_path,package=frozen_package(repair)
        package_files={r['path']:r for r in package['files']} if package else {}
        candidate_parents={str(Path(path).parent) for path,ref in package_files.items() if path.endswith('.webm') and ref['sha256']==asset['sha256']}
        candidates={};origins={};superseded=[]
        refs=proof.get('review_artifacts',proof.get('review_videos',[]));refs=list(refs.values()) if isinstance(refs,dict) else refs
        for ref in refs:
            label=kind(ref['path'])
            if label:candidates[label]=dict(ref);origins[label]={'binding':'exact_immutable_accepted_proof','proof_path':repair['proof_path'],'proof_sha256':repair['proof_sha256']}
        for path,ref in package_files.items():
            if not path.endswith('.mp4') or not (str(Path(path).parent) in candidate_parents or '/'+sid+'/' in path or Path(path).name.startswith(sid+'-') or Path(path).name.startswith(sid+'_')):continue
            label=kind(path)
            if label and label not in candidates:
                candidates[label]=dict(ref);origins[label]={'binding':'exact_accepted_frozen_package_file','package_path':package_path,'package_sha256':sha(REPO/package_path),'package_files_digest':repair['frozen_package_sha256']}
        for addendum in repair.get('review_artifact_addenda',[]):
            label=kind(addendum['replacement_path']);assert label
            if label in candidates:superseded.append({'kind':label,'historical_ref':candidates[label],'reason':'Independently closed review-artifact replacement; historical metadata remains unchanged.'})
            candidates[label]={'path':addendum['replacement_path'],'sha256':addendum['replacement_sha256'],'bytes':addendum['replacement_bytes'],'frames':84,'duration':2.8 if label=='normal' else 5.6}
            origins[label]={'binding':'independently_closed_review_replacement','addendum':addendum}
        reviewed=[]
        for label,ref in candidates.items():
            source=REPO/ref['path'];assert source.is_file(),f'Missing actual claimed QA review clip: {source}'
            assert sha(source)==ref['sha256'] and source.stat().st_size==ref['bytes'],f'Stale QA clip: {source}'
            target=ROOT/'approved-reviews'/f'{sid}-qa-{label}-{ref["sha256"][:12]}.mp4';target.parent.mkdir(exist_ok=True)
            if target.exists():assert sha(target)==ref['sha256']
            else:shutil.copyfile(source,target)
            prior_clip=prior.get((asset['sha256'],str(target.relative_to(REPO)),ref['sha256']))
            if prior_clip:
                assert prior_clip['bytes']==ref['bytes']
                checks=prior_clip['actual_final_copy_validation'];assert checks['all_frame_pts_regular'] and checks['full_xerror_decode_pass']
                if ref.get('frames',ref.get('actual_decoded_frames')) is not None:assert checks['frames']==int(ref.get('frames',ref.get('actual_decoded_frames')))
                if ref.get('duration') is not None:assert abs(checks['duration']-float(ref['duration']))<.001
                checks={**checks,'reused_exact_unchanged_prior_clip':True,'prior_index_path':str(a.previous),'prior_index_sha256':sha(a.previous)}
            else:checks=validate_final(target,ref)
            reviewed.append({'kind':label,'path':str(target.relative_to(REPO)),'sha256':sha(target),'bytes':target.stat().st_size,
                'original_qa_bound_path':ref['path'],'exact_original_bytes_preserved':True,'binding':origins[label],
                'actual_final_copy_validation':checks,'native_realtime_slow_device_playback':'not_observed'})
            files.append({'path':str(target.relative_to(REPO)),'sha256':sha(target),'bytes':target.stat().st_size})
        items.append({'id':sid,'candidate_id':repair['candidate_id'],'candidate_sha256':asset['sha256'],'independent_qa':repair['qa'],
            'review_clips':reviewed,'superseded_historical_reviews':superseded,'missing_clip_kinds':[label for label in ['normal','slow'] if label not in candidates],
            'scope':'Exact unchanged historical QA-bound review bytes and actual final-copy technical integrity only. Does not assert native perceptual review or completeness of temporal/device acceptance.'})
        print(f'{sid}: archived {len(reviewed)} exact QA-bound review clips',flush=True)
    assert sha(mp)==manifest_hash,'Canonical manifest changed during review snapshot; rerun on a stable point'
    for ref in files:assert sha(REPO/ref['path'])==ref['sha256'] and (REPO/ref['path']).stat().st_size==ref['bytes']
    report={'schema_version':1,'actual_integrator':'/root/animation_integrator_resume','at':datetime.now(timezone.utc).isoformat(),'manifest_sha256':manifest_hash,
        'scope':'Portable index of exact existing QA-bound normal/slowed review snapshots and independently closed replacements; no regenerated or newly watched clips are presented as original QA evidence.',
        'items':items,'files':files,'all_final_copy_sha_bytes_rechecked_after_all_decodes':True,'canonical_assets_or_qa_mutated':False,'external_publication':False,
        'native_realtime_slow_device_perceptual_acceptance':'unknown','helper_sha256':sha(__file__)}
    if previous:report['prior_exact_unchanged_validation']={'path':str(a.previous),'sha256':sha(a.previous),'meaning':'Only unchanged exact candidate/clip SHA and bytes reuse prior complete decode/PTS checks; newly discovered or changed clips are fully decoded.'}
    a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'index':str(a.output),'items':len(items),'copied_review_clips':len(files),'bytes':sum(f['bytes'] for f in files)}),flush=True)


if __name__=='__main__':main()
