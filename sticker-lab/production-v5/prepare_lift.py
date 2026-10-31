#!/usr/bin/env python3
"""Prepare durable records from an explicit authorized per-item QA selection.

This copies only selected actual inputs/proofs/code, preserves original recipe
bytes, and writes a prepared record. No canonical media or approval is inferred.
Actual rerender evidence must be attached before stage.py can accept a record.
"""
import argparse,copy,hashlib,json,shutil
from datetime import datetime,timezone
from pathlib import Path
from repair import ROOT,REPO,sha
from stage import accepted_review
from source_override import corrected_source
from lineage import generated_baseline_sha


def read(path):return json.loads(Path(path).read_text())
def copy_exact(source,target,expected=None):
    source=Path(source);target=Path(target);target.parent.mkdir(parents=True,exist_ok=True)
    expected=expected or sha(source);assert sha(source)==expected
    if target.exists():assert sha(target)==expected,'Refuse changing a stable snapshot'
    else:shutil.copyfile(source,target)
    assert sha(target)==expected
    return str(target)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('request',type=Path);parser.add_argument('prepared',type=Path);args=parser.parse_args()
    request=read(args.request);assert request['authorization']['scope']=='local_canonical_staging_only'
    assert request['authorization']['approved_ids']==[s['id'] for s in request['items']]
    assert not args.prepared.exists();manifest=read(REPO/'assets/stickers/manifest.json')
    runtime=ROOT/'approved-generators'/request['batch_id'];runtime.mkdir(parents=True,exist_ok=True)
    for name in ['recipe_engine.py','repair.py']:copy_exact(ROOT/name,runtime/name)
    result={'schema_version':1,'batch_id':request['batch_id'],'created_at':datetime.now(timezone.utc).isoformat(),
            'authorization':request['authorization'],'preparation_request':str(args.request),'items':[]}
    for sel in request['items']:
        sid=sel['id'];qa_path=Path(sel['qa_artifact']);assert sha(qa_path)==sel['qa_artifact_sha256'];qa=read(qa_path)
        if 'items' in qa:
            q=next(q for q in qa['items'] if q['id']==sid);assert q['verdict']=='accept'
            if 'output' in q:
                output=q['output'];binding={'candidate_path':output['path'],'candidate_sha256':output['sha256'],
                    'proof_path':output['proof_path'],'proof_sha256':output['proof_sha256'],
                    'recipe_path':output['recipe_path'],'recipe_sha256':output['recipe_sha256']}
                candidate_id=output.get('candidate_id',q.get('candidate_id'));assert candidate_id
                if q.get('candidate_id'):assert q['candidate_id']==candidate_id
            elif 'sha_bindings' in q:
                exact=q['sha_bindings'];binding={'candidate_path':exact['output']['path'],'candidate_sha256':exact['output']['sha256'],
                    'proof_path':exact['proof']['path'],'proof_sha256':exact['proof']['sha256'],
                    'recipe_path':exact['recipe']['path'],'recipe_sha256':exact['recipe']['sha256']}
                candidate_id=q['candidate_id']
            else:binding=q.get('evidence_binding',q);candidate_id=q['candidate_id']
            candidate=Path(binding['candidate_path']);proof_path=Path(binding['proof_path'])
            output_sha=binding.get('candidate_sha256',binding.get('output_sha256'))
            description=q.get('proposed_actual_description_uk',q.get('description_uk_reviewed',q.get('proposed_description_uk')))
        else:
            assert qa['id_reviewed']==sid and qa['verdict']=='accept'
            q=qa;binding=qa['binding'];candidate_id=qa['candidate_id'];candidate=Path(binding['candidate_path']);proof_path=Path(binding['proof_path'])
            output_sha=binding['candidate_sha256'];description=None
        assert sha(candidate)==output_sha and sha(proof_path)==binding['proof_sha256']
        p=read(proof_path);kind=p['source_kind'];assert kind in ['derived_decoded_video','generated_corrected_anchor']
        original_recipe_path=Path(binding.get('recipe_path',p['recipe_path']))
        expected_recipe_sha=binding.get('recipe_sha256',p['recipe_sha256']);assert sha(original_recipe_path)==expected_recipe_sha
        recipe=read(original_recipe_path);assert recipe['id']==sid and recipe['candidate_id']==candidate_id
        if sel.get('source_contract_override'):
            corrected=corrected_source(sel,p);recipe['source_provenance']=corrected;recipe['source_anchors']=copy.deepcopy(corrected['anchors'])
        description=description or recipe['description_uk'];assert recipe['description_uk']==description
        assert p.get('proposed_description_uk',p.get('description_uk'))==description
        old=next(x for x in manifest if x['id']==sid)
        baseline_sha=p['source_video_sha256'] if kind=='derived_decoded_video' else generated_baseline_sha(p)
        assert old['sha256']==baseline_sha
        assert old['source_keyposes_sha256']==p['ancestor_original_keyposes_sha256']
        sources=ROOT/'approved-sources'/sid;sources.mkdir(exist_ok=True)
        archive=Path(copy_exact(REPO/'assets/stickers'/old['file'],sources/('source.webm' if kind=='derived_decoded_video' else 'baseline-source.webm'),baseline_sha))
        frames=[]
        for f in recipe.get('source_frames',[]):
            target=sources/f'{f["index"]:03d}.png';copy_exact(f['path'],target,f['sha256']);frames.append({**f,'path':str(target.relative_to(REPO))})
        if kind=='derived_decoded_video':
            recipe['source_frames']=frames;recipe['source_provenance']['source_video_path']=str(archive.relative_to(REPO))
            if recipe.get('base_sequence'):recipe['base_sequence']['video_path']=str(archive.relative_to(REPO))
            bundle=hashlib.sha256(''.join(f['sha256'] for f in sorted(frames,key=lambda f:f['index'])).encode('ascii')).hexdigest()
            assert bundle==p['derived_keyframes_bundle_sha256']==recipe['source_provenance']['derived_source_bundle_sha256']
        else:
            source=recipe['source_provenance'];source['baseline_video_path']=str(archive.relative_to(REPO))
            for name,filename in [('baseline_target','baseline-target.png'),('identity_reference','identity-reference.png')]:
                ref=source[name];ref['path']=str(Path(copy_exact(ref['path'],sources/filename,ref['sha256'])).relative_to(REPO))
            gen=source['generation']
            for path_key,hash_key,filename in [('metadata_path','metadata_sha256','generation-metadata.json'),
                    ('original_image_path','original_image_sha256','generated-original.png'),('animation_anchor_path','animation_anchor_sha256','anchor.png')]:
                if path_key=='metadata_path' and sel.get('source_contract_override'):filename=f'generation-metadata-{gen[hash_key][:12]}.json'
                gen[path_key]=str(Path(copy_exact(gen[path_key],sources/filename,gen[hash_key])).relative_to(REPO))
            if gen.get('original_metadata_path'):
                gen['original_metadata_path']=str(Path(copy_exact(gen['original_metadata_path'],sources/f'original-metadata-{gen["original_metadata_sha256"][:12]}.json',gen['original_metadata_sha256'])).relative_to(REPO))
            if gen.get('metadata_repair_attestation'):
                att=gen['metadata_repair_attestation'];att['path']=str(Path(copy_exact(att['path'],sources/f'metadata-repair-attestation-{att["sha256"][:12]}.json',att['sha256'])).relative_to(REPO))
            if gen.get('intermediate_image_path'):
                gen['intermediate_image_path']=str(Path(copy_exact(gen['intermediate_image_path'],sources/'intermediate-image.png',gen['intermediate_image_sha256'])).relative_to(REPO))
            anchors=[]
            for a in recipe['source_anchors']:
                a=dict(a);a['path']=str(Path(copy_exact(a['path'],sources/f'{a["key"]}.png',a['sha256'])).relative_to(REPO));anchors.append(a)
            recipe['source_anchors']=anchors;source['anchors']=anchors
            bundle=hashlib.sha256(''.join(a['sha256'] for a in sorted(anchors,key=lambda a:a['key'])).encode('ascii')).hexdigest()
            assert bundle==p['generated_source_bundle_sha256']==source['generated_source_bundle_sha256']
        package_path=Path(sel['package_path']);package=read(package_path)
        original_gen=read(original_recipe_path)['generator'];generator={}
        for prefix,suffix in [('engine','recipe_engine.py'),('support','repair.py')]:
            expected=original_gen[prefix+'_sha256'];source=original_gen.get(prefix+'_path')
            if source is None:source=next(e['path'] for e in package['files'] if e['sha256']==expected and e['path'].endswith('/'+suffix))
            target=runtime/'originals'/f'{expected}-{suffix}';copy_exact(source,target,expected)
            if prefix=='engine':generator.update({'original_generator_snapshot':str(target.relative_to(REPO)),'original_generator_sha256':expected})
            else:generator.update({'original_support_snapshot':str(target.relative_to(REPO)),'original_support_sha256':expected})
        generator.update({'engine_path':str((runtime/'recipe_engine.py').relative_to(REPO)),'engine_sha256':sha(runtime/'recipe_engine.py'),
                          'support_path':str((runtime/'repair.py').relative_to(REPO)),'support_sha256':sha(runtime/'repair.py')})
        recipe['generator']=generator;recipe.setdefault('expected',{})
        if 'frames_rgba_png_sha256' not in recipe['expected']:
            recipe['expected']['frames_rgba_png_sha256']=p['frames_rgba_png_sha256']
        assert len(recipe['expected']['frames_rgba_png_sha256'])==84
        recipe['expected'].update({'decoded_png_sha256':p['decoded_png_sha256'],'output_sha256':output_sha,'output_bytes':candidate.stat().st_size})
        recipe_suffix=sel.get('stable_recipe_suffix','')
        stable_recipe=ROOT/'approved-recipes'/f'{candidate_id}{recipe_suffix}.json';recipe_text=json.dumps(recipe,ensure_ascii=False,indent=2)+'\n'
        if stable_recipe.exists():assert stable_recipe.read_text()==recipe_text
        else:stable_recipe.write_text(recipe_text)
        frozen_recipe=ROOT/'approved-recipes'/f'{candidate_id}-original-frozen.json';copy_exact(original_recipe_path,frozen_recipe,expected_recipe_sha)
        stable_proof=ROOT/'approved-proofs'/f'{candidate_id}.json';copy_exact(proof_path,stable_proof,binding['proof_sha256'])
        stable_package=ROOT/'approved-proofs'/f'{package_path.parent.name}-package.json';copy_exact(package_path,stable_package)
        qa_record={'artifact':str(qa_path),'artifact_sha256':sha(qa_path),'review_id':qa.get('review_id',qa.get('report_id',qa.get('id'))),
                   'actual_agent_id':qa['actual_agent_id'],'verdict':'accept','accepted_scope':q.get('accept_scope',q.get('accepted_scope',q.get('decision_scope',q.get('verdict_scope')))),
                   'coverage':q.get('actual_visual_coverage',q.get('visual_coverage',q.get('actual_visual_review',q.get('actual_coverage',q.get('coverage'))))),
                   'limitations':{'reported':q.get('limitations',q.get('unresolved',qa.get('limitations',qa.get('unresolved_boundaries',qa.get('scope'))))),
                       'native_realtime':'not_observed','native_slow':'not_observed','device':'not_observed','full_temporal_quality_acceptance':False}}
        record={'id':sid,'approval_state':'approved_frame_sequence_prototype_local_staging','candidate_id':candidate_id,
                'source_kind':kind,'source_video_path':str(archive.relative_to(REPO)),'source_video_sha256':baseline_sha,
                'ancestor_original_keyposes_sha256':p['ancestor_original_keyposes_sha256'],'derived_source_bundle_sha256':bundle,
                'derived_source_bundle_algorithm':'sha256 of ASCII concatenation of exact decoded PNG SHA256 hex strings sorted by source frame index',
                'derived_source_frames':frames,'output_path':str(candidate),'output_sha256':output_sha,'output_bytes':candidate.stat().st_size,
                'poster_path':str(candidate.parent/'poster.png'),'poster_sha256':p['poster_sha256'],
                'proof_path':str(stable_proof.relative_to(REPO)),'proof_sha256':sha(stable_proof),
                'frozen_package_sha256':package['files_sha256'],'frozen_package_manifest_path':str(stable_package.relative_to(REPO)),
                'frozen_package_manifest_sha256':sha(stable_package),'description_uk':description,'qa':qa_record,
                'recipe_path':str(stable_recipe.relative_to(REPO)),'recipe_sha256':sha(stable_recipe),'generator':generator,
                'original_recipe_path':str(frozen_recipe.relative_to(REPO)),'original_recipe_sha256':sha(frozen_recipe),
                'recipe_relocation_note':'Only durable source/code paths and explicit expected decode metadata changed; numeric scene recipe is preserved. All84 raw/decoded frames must match before staging.'}
        if kind=='generated_corrected_anchor':
            for key in ['source_video_path','source_video_sha256','derived_source_bundle_sha256','derived_source_bundle_algorithm','derived_source_frames']:record.pop(key)
            record['source_provenance']=copy.deepcopy(recipe['source_provenance'])
            record['qa']['source_semantic_tradeoffs']={'authored':recipe['semantics'],'independent_observations':q.get('observations')}
        if sel.get('source_contract_override'):
            override=copy.deepcopy(sel['source_contract_override']);original_path=override['contract_path'];target=ROOT/'approved-proofs'/f'{sid}{recipe_suffix}-corrected-source-contract.json'
            copy_exact(original_path,target,override['contract_sha256']);override['reviewed_contract_path']=original_path;override['contract_path']=str(target.relative_to(REPO));record['source_contract_override']=override
            record['rerender_artifact_tag']=recipe_suffix
            record['qa']['source_metadata_correction']=override['independent_acceptance']
        if sel.get('handoff_closure'):
            closure=sel['handoff_closure'];closure_path=Path(closure['artifact']);assert sha(closure_path)==closure['artifact_sha256'];cq=next(x for x in read(closure_path)['items'] if x['id']==sid)
            assert cq['verdict']=='accept' and cq['candidate_sha256_unchanged']==output_sha and cq['old_proof_sha256_unchanged']==record['proof_sha256']
            addendum=ROOT/'approved-proofs'/f'{sid}-review-addendum.json';copy_exact(cq['addendum_path'],addendum,cq['addendum_sha256'])
            replacement=ROOT/'approved-reviews'/f'{sid}-{cq["review_type"]}.mp4';copy_exact(cq['replacement_path'],replacement,cq['replacement_sha256'])
            record['review_artifact_addenda']=[{'artifact':str(addendum.relative_to(REPO)),'artifact_sha256':sha(addendum),'replacement_path':str(replacement.relative_to(REPO)),
                   'replacement_sha256':sha(replacement),'replacement_bytes':replacement.stat().st_size,'independent_closure':closure,
                   'original_frozen_review_metadata_superseded_only':True,'native_playback':'not_observed'}]
            record['qa']['handoff_closure']=closure
        accepted_review(qa,record);result['items'].append(record)
        print(f'Prepared durable exact record {sid}; actual rerender required',flush=True)
    args.prepared.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
