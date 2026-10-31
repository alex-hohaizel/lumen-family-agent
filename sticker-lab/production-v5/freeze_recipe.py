#!/usr/bin/env python3
"""Freeze an actually reviewed isolated recipe candidate, never approve/stage it."""
import argparse, hashlib, json, shutil, subprocess
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
from PIL import Image
import repair as core


def freeze(recipe_path, folder, frozen, coverage_path):
    recipe=json.loads(recipe_path.read_text());coverage=json.loads(coverage_path.read_text())
    assert coverage['reviewer']=='/root/specialist_animation'
    assert coverage['all_decoded_frames_viewed']==list(range(84))
    assert coverage['native512_frames_viewed']
    assert not (folder/'proof.json').exists(),'Do not mutate a frozen/reviewed proof'
    frozen.mkdir(parents=True,exist_ok=True)
    for name in ['recipe_engine.py','repair.py']:
        target=frozen/name;source=core.ROOT/name
        if target.exists():assert core.sha(target)==core.sha(source)
        else:shutil.copyfile(source,target)
    decoded=sorted((folder/'decoded').glob('*.png'));assert len(decoded)==84
    hashes=[core.sha(p) for p in decoded]
    recipe['generator']={'engine_path':str(frozen/'recipe_engine.py'),'engine_sha256':core.sha(frozen/'recipe_engine.py'),
                         'support_path':str(frozen/'repair.py'),'support_sha256':core.sha(frozen/'repair.py')}
    recipe['expected']={'frames_rgba_png_sha256':[core.sha(folder/'frames-rgba'/f'{i:03d}.png') for i in range(84)],
                        'decoded_png_sha256':hashes,'output_sha256':core.sha(folder/'candidate.webm'),
                        'output_bytes':(folder/'candidate.webm').stat().st_size}
    frozen_recipe=frozen/f'{recipe["candidate_id"]}.json'
    assert not frozen_recipe.exists();frozen_recipe.write_text(json.dumps(recipe,ensure_ascii=False,indent=2)+'\n')
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_streams','-show_format','-of','json',str(folder/'candidate.webm')]))
    pts=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',str(folder/'candidate.webm')]))['frames']
    times=[float(f['best_effort_timestamp_time']) for f in pts];assert len(times)==84 and all(a<b for a,b in zip(times,times[1:]))
    arrays=[np.asarray(Image.open(p).convert('RGBA'),dtype=np.float32) for p in decoded]
    comp=[a[...,:3]*a[...,3:4]/255+233*(1-a[...,3:4]/255) for a in arrays]
    diffs=[float(np.abs(comp[i]-comp[(i+1)%84]).mean()) for i in range(84)]
    bounds=[]
    for a in arrays:
        y,x=np.where(a[...,3]>16);assert len(x);bounds.append([int(x.min()),int(y.min()),int(x.max()+1),int(y.max()+1)])
    r=json.loads((folder/'rerender-result.json').read_text());s=recipe['source_provenance']
    generated=s['kind']=='generated_corrected_anchor'
    proof={'schema_version':1,'id':recipe['id'],'candidate':recipe['candidate_id'],'created_at':datetime.now(timezone.utc).isoformat(),
           'source_kind':s['kind'],'source_path':s['generation']['animation_anchor_path'] if generated else s['source_video_path'],'source_video_sha256':s.get('source_video_sha256'),
           'source_original_keyposes_status':'unresolved_original_not_recovered','ancestor_original_keyposes_sha256':s['ancestor_original_keyposes_sha256'],
           'derived_source_frames':[{'index':f['index'],'seconds':f['timestamp_seconds'],'decoded_png_sha256':f['sha256'],'path':f['path']} for f in recipe.get('source_frames',[])],
           'derived_keyframes_bundle_sha256':s.get('derived_source_bundle_sha256'),'source_frame_count':84,
           'source_action_frames':[f['index'] for f in recipe.get('source_frames',[])],
           'method':'Single clean exact derived RGBA frame; scene-specific named anatomical parts and object-contact anchors; explicit independent temporal waves; common premultiplied RGBA sampling',
           'character_semantics':recipe['semantics'],'semantic_tradeoff':recipe['semantics'].get('omitted_optional_action'),
           'not_recovered_original_art':True,'not_rigid_global_transform':True,'local_mesh':recipe['local_mesh'],
           'lineage':([{'output_frame':i,'source_anchors':[recipe['local_mesh']['source_anchor']],'original_video_timestamp':None,'kind':'generated_corrected_anchor_authored_shared_rgba_local_mesh','recipe_sha256':core.sha(frozen_recipe)} for i in range(84)] if generated else [{'output_frame':i,'source_frames':[recipe['local_mesh']['source_frame']],'source_seconds':[recipe['local_mesh']['source_frame']/30],'kind':'explicit_authored_shared_rgba_local_mesh','recipe_sha256':core.sha(frozen_recipe)} for i in range(84)]),
           'candidate_sha256':core.sha(folder/'candidate.webm'),'poster_sha256':core.sha(folder/'poster.png'),
           'bytes':(folder/'candidate.webm').stat().st_size,'crf':recipe['output']['crf'],'frames':84,'fps':30,'duration':2.8,
           'jacobian_min':r['statistics']['minimum_jacobian'],'maximum_displacement_px':r['statistics']['maximum_displacement_px'],
           'unique_decoded_frames':len({hashlib.sha256(a.tobytes()).hexdigest() for a in arrays}),
           'alpha_range':[int(min(a[...,3].min() for a in arrays)),int(max(a[...,3].max() for a in arrays))],
           'blank_frames':[],'bounding_boxes':bounds,'adjacent_composite_mae':diffs[:-1],'seam_composite_mae':diffs[-1],
           'decoded_png_sha256':hashes,'decoded_pts_seconds':times,'timestamps_monotonic':True,
           'native_streams':probe['streams'],'native_duration':float(probe['format']['duration']),
           'source_review':coverage['source_review'],'candidate_visual_review':coverage,
           'baseline_independent_triage':recipe.get('baseline_independent_triage'),
           'recipe_path':str(frozen_recipe),'recipe_sha256':core.sha(frozen_recipe),'generator_snapshot':str(frozen/'recipe_engine.py'),
           'generator_sha256':core.sha(frozen/'recipe_engine.py'),'support_sha256':core.sha(frozen/'repair.py'),
           'proposed_description_uk':recipe['description_uk'],'independent_review':'pending','native_playback':'pending','device_playback':'pending',
           'canonical_assets_changed':False,'frozen_at':datetime.now(timezone.utc).isoformat()}
    if generated:
        for key in ['source_video_sha256','derived_source_frames','derived_keyframes_bundle_sha256','source_frame_count','source_action_frames']:proof.pop(key)
        proof.update({'source_provenance':s,'source_anchors':recipe['source_anchors'],
                      'generated_source_bundle_sha256':s['generated_source_bundle_sha256'],
                      'baseline_video_sha256':s['baseline_video_sha256'],'source_anchor_count':len(recipe['source_anchors'])})
        proof['method']='Generated corrected anchor with explicit actual imagegen/input provenance; scene-specific anatomical parts/contact anchors; common premultiplied RGBA local animation'
    proof['review_artifacts']=[]
    for name,speed in [('normal',1),('slow',2)]:
        video=Path(coverage.get('review_artifact_paths',{}).get(name,str(folder/f'review-{name}.mp4')))
        vp=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_streams','-show_format','-of','json',str(video)]))
        assert len(vp['streams'])==1 and int(vp['streams'][0]['nb_read_frames'])==84
        assert abs(float(vp['format']['duration'])-2.8*speed)<.001
        core.run(['ffmpeg','-nostdin','-v','error','-xerror','-i',video,'-f','null','-'])
        proof['review_artifacts'].append({'path':str(video),'sha256':core.sha(video),'bytes':video.stat().st_size,'frames':84,'duration':2.8*speed,'actual_full_decode':True,'perceptually_watched':False})
    (folder/'proof.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
    return proof


def main():
    p=argparse.ArgumentParser();p.add_argument('recipe',type=Path);p.add_argument('candidate',type=Path);p.add_argument('frozen',type=Path);p.add_argument('coverage',type=Path);a=p.parse_args()
    proof=freeze(a.recipe,a.candidate,a.frozen,a.coverage)
    print(json.dumps({'candidate':proof['candidate'],'sha256':proof['candidate_sha256'],'proof_sha256':core.sha(a.candidate/'proof.json'),'bytes':proof['bytes']}))


if __name__=='__main__':main()
