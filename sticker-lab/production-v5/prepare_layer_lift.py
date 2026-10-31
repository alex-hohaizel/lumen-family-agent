#!/usr/bin/env python3
"""Prepare only explicitly independently accepted generated-layer candidates.

Copies actual tool PNG containers, every operation input, immutable metadata,
exact crops and the actual renderer/support. Relocates operational paths in a
new recipe/extraction; original source contract/recipe/proof remain untouched.
An actual all84 raw/decoded rerender is required before stage.py can run.
"""
import argparse,copy,hashlib,json
from datetime import datetime,timezone
from pathlib import Path
from repair import ROOT,REPO,sha
from prepare_lift import copy_exact
from layer_source import validate_layer_source
from stage import accepted_review


def read(path):return json.loads(Path(path).read_text())
def stable_json(path,value):
    data=json.dumps(value,ensure_ascii=False,indent=2)+'\n';path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():assert path.read_text()==data,'Refuse modifying stable derived metadata'
    else:path.write_text(data)
    return str(path.relative_to(REPO))


def main():
    ap=argparse.ArgumentParser();ap.add_argument('request',type=Path);ap.add_argument('prepared',type=Path);args=ap.parse_args()
    assert not args.prepared.exists();req=read(args.request)
    assert req['authorization']['scope']=='local_canonical_staging_only'
    assert req['authorization']['approved_ids']==[r['id'] for r in req['items']]
    manifest={r['id']:r for r in read(REPO/'assets/stickers/manifest.json')}
    result={'schema_version':1,'batch_id':req['batch_id'],'created_at':datetime.now(timezone.utc).isoformat(),
        'actual_integrator':'/root/animation_integrator_resume','authorization':req['authorization'],
        'preparation_request':str(args.request),'items':[]}
    for selection in req['items']:
        sid=selection['id'];qa_path=REPO/selection['qa_artifact'];assert sha(qa_path)==selection['qa_artifact_sha256'];qa=read(qa_path)
        q=next(r for r in qa.get('items',[qa.get('item')]) if r and r['id']==sid);assert q['verdict']=='accept'
        binding=selection['binding'];candidate=REPO/binding['candidate_path'];proof_path=REPO/binding['proof_path'];recipe_path=REPO/binding['recipe_path']
        for path,key in [(candidate,'candidate_sha256'),(proof_path,'proof_sha256'),(recipe_path,'recipe_sha256')]:assert sha(path)==binding[key]
        proof=read(proof_path);recipe=read(recipe_path);assert proof['source_kind']=='generated_layer_components'
        assert proof['id']==recipe['id']==sid and proof['candidate_sha256']==binding['candidate_sha256']
        candidate_id=proof.get('candidate_id',proof.get('candidate'));assert candidate_id
        if recipe.get('candidate_id'):assert recipe['candidate_id']==candidate_id
        source_contract_path=REPO/proof['source_contract_path'];assert sha(source_contract_path)==proof['source_contract_sha256']
        source_contract=read(source_contract_path);assert source_contract['id']==sid
        assert source_contract['proposed_manifest_fields']['source_provenance']==proof['source_provenance']
        assert source_contract['proposed_manifest_fields']['description']==proof.get('proposed_description_uk',proof.get('description_uk'))
        original_source=proof['source_provenance'];source=copy.deepcopy(original_source)
        old=manifest[sid];assert old['origin']=='generated_1_10' and old['sha256']==source['baseline_video_sha256']
        assert old['source_keyposes_sha256']==source['ancestor_original_keyposes_sha256']
        base=ROOT/'approved-sources'/sid;base.mkdir(parents=True,exist_ok=True)
        def archive(ref,filename=None):
            output=base/(filename or (ref['sha256']+'.png'))
            return {**ref,'path':str(Path(copy_exact(REPO/ref['path'],output,ref['sha256'])).relative_to(REPO))}
        source['baseline_video_path']=archive({'path':source['baseline_video_path'],'sha256':source['baseline_video_sha256']},'baseline-source.webm')['path']
        source['baseline_frames']=[archive(ref,f'baseline-frame-{ref["frame_index"]:03d}.png') for ref in source['baseline_frames']]
        gen=source['generation'];metadata_path=REPO/gen['metadata_path'];assert sha(metadata_path)==gen['metadata_sha256'];metadata=read(metadata_path)
        gen['metadata_path']=archive({'path':gen['metadata_path'],'sha256':gen['metadata_sha256']},'generation-metadata.json')['path']
        gen['raw_outputs']=[archive(ref) for ref in gen['raw_outputs']]
        # Preserve all actual tool inputs; if the contract already has the
        # flattened map, require it to cover every operation input.
        refs=gen.get('input_references',[]);assert refs
        required={ref['sha256'] for op in metadata['operations'] for ref in op['inputs']}
        assert required<={ref['sha256'] for ref in refs}|{ref['sha256'] for ref in gen['raw_outputs']}
        gen['input_references']=[archive(ref) for ref in refs]
        source['anchors']=[archive(a,f'component-{a["key"]}.png') for a in source['anchors']]
        bundle=validate_layer_source(source,proof)
        # Keep author metadata-correction history as exact immutable evidence,
        # with explicit canonical path mapping. It is not vendor attestation.
        gen['history_artifacts']=[archive(ref,ref['sha256']+'-'+Path(ref['path']).name) for ref in selection.get('history_artifacts',[])]
        original_extraction=read(REPO/recipe['extraction_path']);assert sha(REPO/recipe['extraction_path'])==recipe['extraction_sha256']
        extraction=copy.deepcopy(original_extraction);extraction['source_anchors']=source['anchors'];extraction['raw_outputs']=gen['raw_outputs']
        extraction['actual_input_references']=gen['input_references'];extraction['baseline_video_path']=source['baseline_video_path']
        extraction['generation_metadata_path']=gen['metadata_path'];extraction['generation_metadata_sha256']=gen['metadata_sha256']
        extraction_path=ROOT/'approved-proofs'/f'{candidate_id}-extraction.json';stable_json(extraction_path,extraction)
        runtime=ROOT/'approved-generators'/req['batch_id']/sid;runtime.mkdir(parents=True,exist_ok=True)
        engine=REPO/recipe['generator_path'];support=REPO/recipe['support_path']
        assert sha(engine)==recipe['generator_sha256'];assert sha(support)==recipe['support_sha256']
        engine_target=runtime/engine.name;support_target=runtime/'support_snapshot.py'
        copy_exact(engine,engine_target,recipe['generator_sha256']);copy_exact(support,support_target,recipe['support_sha256'])
        original_engine=runtime/'originals'/(recipe['generator_sha256']+'-'+engine.name)
        original_support=runtime/'originals'/(recipe['support_sha256']+'-support_snapshot.py')
        copy_exact(engine,original_engine,recipe['generator_sha256']);copy_exact(support,original_support,recipe['support_sha256'])
        generator={'engine_path':str(engine_target.relative_to(REPO)),'engine_sha256':sha(engine_target),'support_path':str(support_target.relative_to(REPO)),
            'support_sha256':sha(support_target),'original_generator_snapshot':str(original_engine.relative_to(REPO)),
            'original_generator_sha256':sha(original_engine),'original_support_snapshot':str(original_support.relative_to(REPO)),
            'original_support_sha256':sha(original_support)}
        recipe.update({'candidate_id':candidate_id,'description_uk':proof.get('proposed_description_uk',proof.get('description_uk')),
            'source_provenance':source,'source_anchors':source['anchors'],'generator':generator,
            'generator_path':generator['engine_path'],'support_path':generator['support_path'],
            'extraction_path':str(extraction_path.relative_to(REPO)),'extraction_sha256':sha(extraction_path)})
        assert recipe['description_uk']
        expected=recipe['expected'];assert expected['frames_rgba_png_sha256']==proof['frames_rgba_png_sha256']
        assert expected['decoded_png_sha256']==proof['decoded_png_sha256'];assert len(expected['decoded_png_sha256'])==84
        expected.update({'output_sha256':binding['candidate_sha256'],'output_bytes':candidate.stat().st_size})
        stable_recipe=ROOT/'approved-recipes'/f'{candidate_id}.json';stable_json(stable_recipe,recipe)
        original_recipe=ROOT/'approved-recipes'/f'{candidate_id}-original-frozen.json';copy_exact(recipe_path,original_recipe,binding['recipe_sha256'])
        stable_proof=ROOT/'approved-proofs'/f'{candidate_id}.json';copy_exact(proof_path,stable_proof,binding['proof_sha256'])
        stable_source_contract=ROOT/'approved-proofs'/f'{candidate_id}-original-source-contract.json'
        copy_exact(source_contract_path,stable_source_contract,proof['source_contract_sha256'])
        package_path=REPO/selection['package_path'];package=read(package_path)
        stable_package=ROOT/'approved-proofs'/f'{package_path.parent.name}-package.json';copy_exact(package_path,stable_package)
        record={'id':sid,'approval_state':'approved_frame_sequence_prototype_local_staging','candidate_id':candidate_id,'source_kind':'generated_layer_components',
            'ancestor_original_keyposes_sha256':source['ancestor_original_keyposes_sha256'],'source_provenance':source,
            'output_path':str(candidate.relative_to(REPO)),'output_sha256':binding['candidate_sha256'],'output_bytes':candidate.stat().st_size,
            'poster_path':str((candidate.parent/'poster.png').relative_to(REPO)),'poster_sha256':proof['poster_sha256'],
            'proof_path':str(stable_proof.relative_to(REPO)),'proof_sha256':sha(stable_proof),
            'frozen_package_sha256':package['files_sha256'],'frozen_package_manifest_path':str(stable_package.relative_to(REPO)),
            'frozen_package_manifest_sha256':sha(stable_package),'description_uk':recipe['description_uk'],
            'recipe_path':str(stable_recipe.relative_to(REPO)),'recipe_sha256':sha(stable_recipe),'generator':generator,
            'original_recipe_path':str(original_recipe.relative_to(REPO)),'original_recipe_sha256':sha(original_recipe),
            'original_source_contract_path':str(stable_source_contract.relative_to(REPO)),'original_source_contract_sha256':sha(stable_source_contract),
            'recipe_relocation_note':'Only operational paths and explicit SHA-bound source/generator/expected metadata changed; actual authored scene renderer and parameters preserved; actual all84 RGBA+decoded rerender required.',
            'qa':{'artifact':selection['qa_artifact'],'artifact_sha256':selection['qa_artifact_sha256'],'review_id':qa.get('review_id',qa.get('report_id',qa.get('id'))),
                'actual_agent_id':qa['actual_agent_id'],'verdict':'accept','accepted_scope':q.get('accept_scope',q.get('accepted_scope',q.get('decision_scope',q.get('verdict_scope')))),
                'coverage':q.get('actual_coverage',q.get('coverage',q.get('actual_visual_coverage'))),
                'limitations':{'reported':q.get('limitations',qa.get('limitations',qa.get('unresolved_boundaries',qa.get('scope')))),
                    'native_realtime':'not_observed','native_slow':'not_observed','device':'not_observed','full_temporal_quality_acceptance':False}}}
        accepted_review(qa,record);result['items'].append(record)
        print(f'{sid}: exact generated components and full input graph archived; actual rerender required',flush=True)
    args.prepared.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
