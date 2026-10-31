#!/usr/bin/env python3
"""Read-only final canonical integration audit with one full decode per video.

Verifies the final manifest, all original/changed files, exact source and QA
contracts and actual media constraints. Frame/time/device perception is outside
this technical audit; no external pack publication or deployment is attempted.
"""
import argparse,hashlib,json,subprocess
from datetime import datetime,timezone
from pathlib import Path
from repair import REPO,ROOT,sha
from lineage import validated_source
from stage import accepted_review


def read(p):return json.loads(Path(p).read_text())
def main():
    ap=argparse.ArgumentParser();ap.add_argument('output',type=Path);ap.add_argument('--expected-repaired',type=int,default=71);a=ap.parse_args();assert not a.output.exists()
    binding_path=ROOT/'approved-proofs/baseline-manifest-binding.json';binding=read(binding_path);baseline_path=REPO/binding['manifest_path'];assert sha(baseline_path)==binding['manifest_sha256']
    baseline=read(baseline_path);old={r['id']:r for r in baseline};mp=REPO/'assets/stickers/manifest.json';manifest_sha=sha(mp);assets=read(mp)
    assert len(assets)==len({r['id'] for r in assets})==len({r['scene'] for r in assets})==120
    assert [r['id'] for r in assets]==[r['id'] for r in baseline]
    repaired=[r['id'] for r in assets if r.get('motion_version')==5];assert len(repaired)==a.expected_repaired
    retained=[r['id'] for r in assets if r['origin']=='approved_1_8'];assert len(retained)==31 and not set(retained)&set(repaired)
    file_baseline_path=ROOT/'approved-proofs/baseline-sticker-files-4a1b5b4ee9.json';file_baseline=read(file_baseline_path)
    assert file_baseline['upstream_commit']==binding['upstream_commit'] and file_baseline['upstream_tree']==binding['upstream_tree']
    assert len(file_baseline['files'])==278 and file_baseline['video_files']==file_baseline['png_files']==139
    changed_files={'assets/stickers/'+row[key] for row in assets if row['id'] in repaired for key in ['file','preview']}
    unchanged_asset_files=[];legacy50=[]
    for ref in file_baseline['files']:
        path=REPO/ref['path'];assert path.is_file()
        if ref['path'] not in changed_files:
            assert sha(path)==ref['sha256'] and path.stat().st_size==ref['bytes'];unchanged_asset_files.append(ref['path'])
        numeric_id=int(path.stem.split('_')[-1])
        if numeric_id<=50:
            assert ref['path'] not in changed_files and sha(path)==ref['sha256'];legacy50.append(ref['path'])
    assert len(legacy50)==100
    items=[]
    for asset in assets:
        sid=asset['id'];video=REPO/'assets/stickers'/asset['file'];preview=REPO/'assets/stickers'/asset['preview']
        assert sha(video)==asset['sha256'] and video.stat().st_size==asset['bytes'] and video.stat().st_size<=262144
        assert sha(preview)==asset['preview_sha256']
        if sid not in repaired:assert asset==old[sid]
        else:
            repair=asset['repair_provenance'];document=read(REPO/repair['approved_record']);record=next(r for r in document['items'] if r['id']==sid)
            assert record['output_sha256']==asset['sha256'] and record['poster_sha256']==asset['preview_sha256']
            for key,hashkey in [('proof_path','proof_sha256'),('recipe_path','recipe_sha256')]:assert sha(REPO/repair[key])==repair[hashkey]==record[hashkey]
            proof=read(REPO/repair['proof_path']);recipe=read(REPO/repair['recipe_path']);source,bundle=validated_source(record,old[sid],proof,recipe)
            assert source==asset['source_provenance'] and bundle==asset['source_keyposes_sha256']
            qa=record['qa'];assert sha(REPO/qa['artifact'])==qa['artifact_sha256'];accepted_review(read(REPO/qa['artifact']),record)
            assert qa['actual_agent_id'] and qa['review_id'] and qa['accepted_scope'] and qa['limitations'] and qa['verdict']=='accept'
            repro=record['reproducibility'];assert sha(REPO/repro['artifact'])==repro['artifact_sha256'];rr=read(REPO/repro['artifact'])
            assert rr['recipe_sha256']==record['recipe_sha256']
            assert rr['raw_rgba_exact_match'] and rr['encoded_frame_exact_match'] and rr['canonical_video_read'] is False
            assert rr['decoded_png_sha256']==proof['decoded_png_sha256'] and len(rr['decoded_png_sha256'])==84
            for key,hashkey in [('engine_path','engine_sha256'),('support_path','support_sha256'),('original_generator_snapshot','original_generator_sha256'),('original_support_snapshot','original_support_sha256')]:
                assert sha(REPO/record['generator'][key])==record['generator'][hashkey]
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_streams','-show_format','-of','json',str(video)]))
        assert len(probe['streams'])==1;stream=probe['streams'][0]
        assert stream['codec_type']=='video' and stream['codec_name']=='vp9' and stream['width']==512 and stream['height']==512
        numerator,denominator=map(int,stream['r_frame_rate'].split('/'));fps=numerator/denominator
        duration=float(probe['format']['duration']);frames=int(stream['nb_read_frames'])
        assert 0<fps<=30 and 0<duration<=3.0 and frames>1
        tags={k.lower():v for k,v in stream.get('tags',{}).items()};assert tags.get('alpha_mode')=='1'
        subprocess.run(['ffmpeg','-nostdin','-v','error','-xerror','-err_detect','explode','-c:v','libvpx-vp9','-i',str(video),'-map','0:v:0','-f','null','-'],check=True)
        assert sha(video)==asset['sha256'] and sha(preview)==asset['preview_sha256']
        items.append({'id':sid,'changed':sid in repaired,'sha256':asset['sha256'],'bytes':asset['bytes'],'preview_sha256':asset['preview_sha256'],
            'actual_media':{'codec':'vp9','width':512,'height':512,'fps':fps,'frames':frames,'duration':duration,'alpha_mode':tags['alpha_mode'],'audio_streams':0,'full_xerror_libvpx_decode':True},
            'source_and_exact_independent_qa_binding':'pass' if sid in repaired else 'exact_unchanged_baseline','native_realtime_slow_device_perception':'unknown'})
        print(f'{sid}: canonical bytes/source/QA + actual VP9 alpha full decode PASS',flush=True)
    assert sha(mp)==manifest_sha
    for asset in assets:assert sha(REPO/'assets/stickers'/asset['file'])==asset['sha256'] and sha(REPO/'assets/stickers'/asset['preview'])==asset['preview_sha256']
    report={'schema_version':1,'actual_integrator':'/root/animation_integrator_resume','at':datetime.now(timezone.utc).isoformat(),'manifest_sha256':manifest_sha,
        'baseline_binding_path':str(binding_path.relative_to(REPO)),'baseline_binding_sha256':sha(binding_path),'manifest_ids_order_scenes_preserved':True,
        'all139_sticker_ids_retain_webm_and_png_paths':True,'baseline_all139_file_index_path':str(file_baseline_path.relative_to(REPO)),
        'baseline_all139_file_index_sha256':sha(file_baseline_path),'unchanged_asset_file_count':len(unchanged_asset_files),
        'all50_legacy_webm_and_png_files_bytewise_unchanged':True,
        'manifest_count':120,'repaired_count':len(repaired),'unchanged_count':120-len(repaired),'retained31_exact_baseline':True,
        'all_source_original_recipe_proof_generator_rerender_exact_qa_contracts_pass':True,'all120_vp9_alpha_full_xerror_decode_pass':True,
        'all120_media_preview_sha_rechecked_at_finish':True,'items':items,'native_realtime_slow_human_device_perception':'unknown',
        'external_publication':False,'helper_sha256':sha(__file__)}
    a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'output':str(a.output),'repaired':len(repaired),'actual_media_full_decode':120}))


if __name__=='__main__':main()
