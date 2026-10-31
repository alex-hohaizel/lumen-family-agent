#!/usr/bin/env python3
"""Stage only explicitly approved, frozen per-item records into local assets.

No blanket selection, upload, deployment or inference of approval is supported.
This deliberately checks the independent QA's exact output/proof hashes and
preserves every unlisted row/file bytewise, including retained originals.
"""
import argparse,hashlib,json,os,shutil,tempfile
from datetime import datetime,timezone
from pathlib import Path
from repair import ROOT,REPO,sha
from lineage import validated_source


def load(path):return json.loads(Path(path).read_text())


def accepted_review(qa,record):
    """Normalize known actual QA layouts; exact output/proof/scene stays bound."""
    if 'item' in qa:
        assert 'items' not in qa and qa['item']['id']==record['id']
        qa={**qa,'items':[qa['item']]}
    actual=qa.get('actual_agent_id')
    if actual is None:
        identity=record['qa']['identity_addendum']
        assert sha(REPO/identity['artifact'])==identity['artifact_sha256']
        attestation=load(REPO/identity['artifact'])
        assert attestation['actual_agent_id']==record['qa']['actual_agent_id']
        # The identity addendum must explicitly bind this exact review file.
        assert attestation['artifact_sha256']==record['qa']['artifact_sha256']
        assert attestation['confirms_artifact']==record['qa']['artifact']
        assert record['candidate_id'] in attestation['review_ids']
        actual=attestation['actual_agent_id']
    assert actual==record['qa']['actual_agent_id']
    if 'candidate_reviews' in qa:
        q=next(x for x in qa['candidate_reviews'] if x['candidate_id']==record['candidate_id'])
        result=(q['verdict'],q['candidate_sha256'],q['proof_sha256'],q['proposed_description_uk'])
    elif 'candidate_review' in qa:
        assert qa['version']['candidate_id']==record['candidate_id']
        q=qa['candidate_review'];binding=qa['review_scope']
        result=(q['verdict'],binding['candidate_sha256'],binding['proof_sha256'],q['proposed_description_uk'])
    elif 'items' in qa:
        q=next(x for x in qa['items'] if x.get('candidate_id',x.get('output',{}).get('candidate_id'))==record['candidate_id'])
        if 'output' in q:
            binding=q['output'];description=q.get('proposed_description_uk')
            if description is None:
                assert binding['recipe_sha256']==record['original_recipe_sha256']
                assert sha(REPO/record['original_recipe_path'])==binding['recipe_sha256']
                description=load(REPO/record['original_recipe_path'])['description_uk']
            result=(q['verdict'],binding['sha256'],binding['proof_sha256'],description)
        elif 'sha_bindings' in q:
            binding=q['sha_bindings']
            assert binding['recipe']['sha256']==record['original_recipe_sha256']
            assert sha(REPO/record['original_recipe_path'])==binding['recipe']['sha256']
            original_recipe=load(REPO/record['original_recipe_path'])
            result=(q['verdict'],binding['output']['sha256'],binding['proof']['sha256'],original_recipe['description_uk'])
        elif 'evidence_binding' in q:
            binding=q['evidence_binding']
            result=(q['verdict'],binding['candidate_sha256'],binding['proof_sha256'],q['proposed_actual_description_uk'])
        elif q.get('source_kind')=='generated_layer_components' and 'candidate_sha256' in q:
            assert q['recipe_sha256']==record['original_recipe_sha256']
            assert sha(REPO/record['original_recipe_path'])==q['recipe_sha256']
            assert q['source_contract_sha256']==record['original_source_contract_sha256']
            assert sha(REPO/record['original_source_contract_path'])==q['source_contract_sha256']
            contract=load(REPO/record['original_source_contract_path']);assert contract['id']==record['id']
            if q.get('description_uk'):assert q['description_uk']==contract['proposed_manifest_fields']['description']
            result=(q['verdict'],q['candidate_sha256'],q['proof_sha256'],contract['proposed_manifest_fields']['description'])
        elif 'candidate_sha256' in q:
            result=(q['verdict'],q['candidate_sha256'],q['proof_sha256'],q['proposed_actual_description_uk'])
        elif 'output_sha256' in q:
            result=(q['verdict'],q['output_sha256'],q['proof_sha256'],q['description_uk_reviewed'])
        else:raise ValueError('Unsupported item QA binding')
    elif 'binding' in qa and 'candidate_id' in qa:
        assert qa['candidate_id']==record['candidate_id']
        binding=qa['binding']
        # This actual80 QA binds the exact recipe/proof, rather than repeating
        # its full description. Retain that original recipe byte-for-byte.
        assert record['original_recipe_sha256']==binding['recipe_sha256']
        assert sha(REPO/record['original_recipe_path'])==binding['recipe_sha256']
        original_recipe=load(REPO/record['original_recipe_path'])
        result=(qa['verdict'],binding['candidate_sha256'],binding['proof_sha256'],original_recipe['description_uk'])
    else:raise ValueError('Unsupported actual QA schema; no inferred acceptance')
    assert result==('accept',record['output_sha256'],record['proof_sha256'],record['description_uk'])


def main():
    parser=argparse.ArgumentParser();parser.add_argument('approved_records',type=Path)
    args=parser.parse_args();approval=load(args.approved_records)
    records=approval['items'];assert records and len({r['id'] for r in records})==len(records)
    assert approval['authorization']['scope']=='local_canonical_staging_only'
    assert approval['authorization']['approved_ids']==[r['id'] for r in records]
    mp=REPO/'assets/stickers/manifest.json';original_bytes=mp.read_bytes();manifest=json.loads(original_bytes)
    assert len(manifest)==120 and len({x['id'] for x in manifest})==120
    assert len({x['scene'] for x in manifest})==120
    old_by_id={x['id']:x for x in manifest};changed={r['id'] for r in records}
    baseline={x['id']:{'row':json.dumps(x,ensure_ascii=False,sort_keys=True),
                         'video':sha(REPO/'assets/stickers'/x['file']),
                         'preview':sha(REPO/'assets/stickers'/x['preview'])} for x in manifest}
    # All checks finish before any mutation.
    ready=[]
    for r in records:
        assert r['approval_state']=='approved_frame_sequence_prototype_local_staging'
        assert r['id'] in old_by_id
        old=old_by_id[r['id']]
        assert old['origin']=='generated_1_10','Retained originals cannot be staged here'
        expected_source_sha=r.get('source_video_sha256',r.get('source_provenance',{}).get('baseline_video_sha256'))
        assert baseline[r['id']]['video']==expected_source_sha
        assert old['source_keyposes_sha256']==r['ancestor_original_keyposes_sha256']
        qa_path=REPO/r['qa']['artifact'];assert sha(qa_path)==r['qa']['artifact_sha256']
        qa=load(qa_path);accepted_review(qa,r)
        assert r['qa']['actual_agent_id'] and r['qa']['review_id'] and r['qa']['accepted_scope'] and r['qa']['limitations']
        candidate=REPO/r['output_path'];poster=REPO/r['poster_path'];proof=REPO/r['proof_path']
        assert sha(candidate)==r['output_sha256'] and candidate.stat().st_size==r['output_bytes']
        assert sha(poster)==r['poster_sha256'] and sha(proof)==r['proof_sha256']
        p=load(proof)
        recipe=load(REPO/r['recipe_path'])
        assert sha(REPO/r['recipe_path'])==r['recipe_sha256']
        assert recipe['id']==r['id'] and recipe['candidate_id']==r['candidate_id']
        assert recipe['description_uk']==r['description_uk']
        assert p.get('proposed_description_uk',p.get('description_uk'))==r['description_uk']
        source_provenance,source_bundle=validated_source(r,old,p,recipe)
        if recipe.get('base_sequence'):
            base=recipe['base_sequence']
            assert base['video_path']==r['source_video_path']
            assert base['video_sha256']==r['source_video_sha256']
            assert len(base['decoded_png_sha256'])==84
        for addendum in r.get('review_artifact_addenda',[]):
            assert sha(REPO/addendum['artifact'])==addendum['artifact_sha256']
            assert sha(REPO/addendum['replacement_path'])==addendum['replacement_sha256']
            assert (REPO/addendum['replacement_path']).stat().st_size==addendum['replacement_bytes']
            closure=addendum['independent_closure']
            assert sha(REPO/closure['artifact'])==closure['artifact_sha256']
            cq=next(x for x in load(REPO/closure['artifact'])['items'] if x['id']==r['id'])
            assert cq['verdict']=='accept' and cq['candidate_sha256_unchanged']==r['output_sha256']
            assert cq['old_proof_sha256_unchanged']==r['proof_sha256']
            assert cq['addendum_sha256']==addendum['artifact_sha256']
            assert cq['replacement_sha256']==addendum['replacement_sha256']
        for file_key,hash_key in [('engine_path','engine_sha256'),('support_path','support_sha256'),
                                  ('original_generator_snapshot','original_generator_sha256'),
                                  ('original_support_snapshot','original_support_sha256')]:
            assert sha(REPO/r['generator'][file_key])==r['generator'][hash_key]
        assert recipe['generator']==r['generator']
        rr=r['reproducibility'];assert sha(REPO/rr['artifact'])==rr['artifact_sha256']
        reproduction=load(REPO/rr['artifact'])
        assert reproduction['recipe_sha256']==r['recipe_sha256']
        assert reproduction['raw_rgba_exact_match'] is True
        assert reproduction['encoded_frame_exact_match'] is True
        assert reproduction['canonical_video_read'] is False
        assert reproduction['decoded_png_sha256']==p['decoded_png_sha256']
        row=dict(old)
        row.update({'bytes':r['output_bytes'],'sha256':r['output_sha256'],
                    'preview_sha256':r['poster_sha256'],'motion_version':5,
                    'fps':p['fps'],'frames':p['frames'],'duration':p['duration'],
                    'description':r['description_uk'],
                    'source_keyposes_sha256':source_bundle,
                    'previous_source_keyposes_sha256':old['source_keyposes_sha256'],
                    'source_provenance':source_provenance,
                    'repair_provenance':{
                        'approved_record':str(args.approved_records.relative_to(REPO)) if args.approved_records.is_absolute() else str(args.approved_records),
                        'candidate_id':r['candidate_id'],
                        'previous_output_sha256':old['sha256'],
                        'previous_preview_sha256':old['preview_sha256'],
                        'frozen_package_sha256':r['frozen_package_sha256'],
                        'frozen_package_manifest_path':r.get('frozen_package_manifest_path'),
                        'frozen_package_manifest_sha256':r.get('frozen_package_manifest_sha256'),
                        'proof_path':r['proof_path'],'proof_sha256':r['proof_sha256'],
                        'recipe_path':r['recipe_path'],'recipe_sha256':r['recipe_sha256'],
                        'original_recipe_path':r.get('original_recipe_path'),
                        'original_recipe_sha256':r.get('original_recipe_sha256'),
                        'source_contract_override':r.get('source_contract_override'),
                        'generator':r['generator'],'reproducibility':r['reproducibility'],
                        'review_artifact_addenda':r.get('review_artifact_addenda',[]),
                        'method':p['method'],'qa':r['qa'],
                        'verified_scope':'independently_reviewed_frame_sequence_prototype',
                        'native_realtime_playback':'pending',
                        'native_slow_playback':'pending','device_playback':'pending',
                        'external_publication':False,
                    }})
        if r.get('original_source_contract_path'):
            row['repair_provenance']['original_source_contract']={'path':r['original_source_contract_path'],'sha256':r['original_source_contract_sha256']}
        ready.append((r,row,candidate,poster))
    backups=ROOT/'staging-backup';backups.mkdir(exist_ok=True)
    backup_manifest=backups/'manifest-before-first-stage.json'
    if not backup_manifest.exists():backup_manifest.write_bytes(original_bytes)
    for r,row,candidate,poster in ready:
        old=old_by_id[r['id']]
        for key,path in [('file',candidate),('preview',poster)]:
            destination=REPO/'assets/stickers'/old[key]
            back=backups/old[key]
            if not back.exists():shutil.copyfile(destination,back)
            temporary=destination.with_name(destination.name+'.stage-temporary')
            shutil.copyfile(path,temporary);os.replace(temporary,destination)
        old.clear();old.update(row)
    # Local atomic manifest replacement; existing IDs/order/emoji are untouched.
    temporary=mp.with_name('manifest.stage-temporary.json')
    temporary.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n');os.replace(temporary,mp)
    after=load(mp);assert [x['id'] for x in after]==list(baseline)
    assert len(after)==120 and len({x['scene'] for x in after})==120
    for row in after:
        bid=row['id']
        if bid not in changed:
            assert json.dumps(row,ensure_ascii=False,sort_keys=True)==baseline[bid]['row']
            assert sha(REPO/'assets/stickers'/row['file'])==baseline[bid]['video']
            assert sha(REPO/'assets/stickers'/row['preview'])==baseline[bid]['preview']
    report={'schema_version':1,'staged_at':datetime.now(timezone.utc).isoformat(),
            'approved_records':str(args.approved_records),'staged_ids':[r['id'] for r in records],
            'manifest_count':120,'manifest_order_preserved':True,'unique_scenes':120,
            'manifest_before_sha256':hashlib.sha256(original_bytes).hexdigest(),
            'manifest_after_sha256':sha(mp),'unlisted_rows_bytes_semantically_unchanged':120-len(records),
            'unlisted_media_bytewise_unchanged':120-len(records),
            'retained31_bytewise_unchanged':sum(r['origin']=='approved_1_8' for r in after)==31,
            'external_publication':False,'native_realtime_slow_device_playback':'pending'}
    target=ROOT/f'stage-{approval["batch_id"]}-result.json';target.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False))


if __name__=='__main__':main()
