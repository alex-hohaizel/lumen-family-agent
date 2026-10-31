"""Strict, distinct source contracts used by local-only staging."""
import copy,hashlib,json
from PIL import Image
from repair import REPO,sha
from source_override import corrected_source,without_paths
from layer_source import validate_layer_source


def generated_baseline_sha(proof):
    """Bind both historical top-level spellings to the explicit generated source."""
    value=proof['source_provenance']['baseline_video_sha256']
    assert any(key in proof for key in ['baseline_video_sha256','source_video_sha256'])
    for key in ['baseline_video_sha256','source_video_sha256']:
        if key in proof:assert proof[key]==value
    return value


def validated_source(record,old,proof,recipe):
    kind=record.get('source_kind','derived_decoded_video')
    assert kind==proof['source_kind']==recipe['source_provenance']['kind']
    assert record['ancestor_original_keyposes_sha256']==old['source_keyposes_sha256']
    assert proof['ancestor_original_keyposes_sha256']==record['ancestor_original_keyposes_sha256']
    if kind=='derived_decoded_video':
        assert record['source_video_path'].startswith('sticker-lab/production-v5/approved-sources/')
        assert old['sha256']==record['source_video_sha256']==proof['source_video_sha256']
        assert sha(REPO/record['source_video_path'])==record['source_video_sha256']
        assert recipe['source_frames']==record['derived_source_frames']
        hashes=[];assert len({f['index'] for f in record['derived_source_frames']})==len(record['derived_source_frames'])
        for f in sorted(record['derived_source_frames'],key=lambda f:f['index']):
            assert type(f['index']) is int and 0<=f['index']<84
            assert f['path'].startswith('sticker-lab/production-v5/approved-sources/')
            assert abs(f['timestamp_seconds']-f['index']/30)<1e-8
            assert sha(REPO/f['path'])==f['sha256'];hashes.append(f['sha256'])
        bundle=hashlib.sha256(''.join(hashes).encode('ascii')).hexdigest()
        assert bundle==record['derived_source_bundle_sha256']==proof['derived_keyframes_bundle_sha256']
        assert recipe['source_provenance']['derived_source_bundle_sha256']==bundle
        source={'kind':kind,'source_video_path':record['source_video_path'],'source_video_sha256':record['source_video_sha256'],
                'ancestor_original_keyposes_sha256':record['ancestor_original_keyposes_sha256'],
                'ancestor_original_status':'unresolved_original_not_recovered','derived_source_bundle_sha256':bundle,
                'derived_source_bundle_algorithm':record['derived_source_bundle_algorithm'],'frames':record['derived_source_frames']}
    elif kind=='generated_corrected_anchor':
        source=copy.deepcopy(record['source_provenance']);original=proof['source_provenance']
        assert source==recipe['source_provenance']
        assert source['not_recovered_original_art'] is True
        assert source['baseline_video_sha256']==old['sha256']==generated_baseline_sha(proof)
        assert sha(REPO/source['baseline_video_path'])==source['baseline_video_sha256']
        assert source['ancestor_original_keyposes_sha256']==record['ancestor_original_keyposes_sha256']
        for name in ['baseline_target','identity_reference']:
            ref=source[name];assert sha(REPO/ref['path'])==ref['sha256']==original[name]['sha256']
        target=source['baseline_target'];assert target['source_kind']=='decoded_baseline_video_frame'
        assert type(target['frame_index']) is int and 0<=target['frame_index']<84
        assert abs(target['timestamp_seconds']-target['frame_index']/30)<1e-8
        gen=source['generation'];oldgen=original['generation']
        assert gen['tool']=='built-in image_gen.imagegen' and gen['actual_agent']
        assert gen['operation']=='precise-object-edit' and gen['generated_anchor_has_no_original_video_timestamp'] is True
        correction=gen['metadata_sha256']!=oldgen['metadata_sha256'] or gen['original_image_size']!=oldgen['original_image_size']
        if correction:
            accepted=corrected_source(record,proof)
            assert without_paths(source)==without_paths(accepted)
            assert sha(REPO/gen['original_metadata_path'])==gen['original_metadata_sha256']==oldgen['metadata_sha256']
            attestation=gen['metadata_repair_attestation'];assert sha(REPO/attestation['path'])==attestation['sha256']
        for path_key,hash_key in [('metadata_path','metadata_sha256'),('original_image_path','original_image_sha256'),('animation_anchor_path','animation_anchor_sha256')]:
            assert sha(REPO/gen[path_key])==gen[hash_key]
            if hash_key!='metadata_sha256':assert gen[hash_key]==oldgen[hash_key]
            elif not correction:assert gen[hash_key]==oldgen[hash_key]
        metadata=json.loads((REPO/gen['metadata_path']).read_text())
        assert metadata['prompt'] and metadata['transparent_background'] is True
        assert metadata['generated_sha256']==gen['original_image_sha256']
        assert metadata['anchor_sha256']==gen['animation_anchor_sha256']
        if metadata.get('steps'):
            assert len(metadata['steps'])==gen['tool_calls']
            attestation=json.loads((REPO/gen['metadata_repair_attestation']['path']).read_text())
            assert [s['prompt'] for s in metadata['steps']]==[s['prompt'] for s in attestation['calls']]
            assert sha(REPO/gen['intermediate_image_path'])==gen['intermediate_image_sha256']
        for role,expected in [('edit_target',target['sha256']),('identity_reference',source['identity_reference']['sha256'])]:
            assert next(r for r in metadata['actual_input_references'] if r['role']==role)['sha256']==expected
        raw=Image.open(REPO/gen['original_image_path']);anchor=Image.open(REPO/gen['animation_anchor_path'])
        assert list(raw.size)==gen['original_image_size'] and raw.mode=='RGBA'
        assert anchor.size==(512,512) and anchor.mode=='RGBA' and anchor.getchannel('A').getextrema()==(0,255)
        anchors=sorted(source['anchors'],key=lambda a:a['key']);assert anchors==sorted(recipe['source_anchors'],key=lambda a:a['key'])
        original_anchors={a['key']:a for a in proof['source_anchors']};assert len(original_anchors)==len(anchors)
        for a in anchors:
            assert a['origin']==kind and a['original_video_timestamp'] is None
            assert 'index' not in a and 'timestamp_seconds' not in a
            assert sha(REPO/a['path'])==a['sha256']==original_anchors[a['key']]['sha256']
        bundle=hashlib.sha256(''.join(a['sha256'] for a in anchors).encode('ascii')).hexdigest()
        assert bundle==source['generated_source_bundle_sha256']==proof['generated_source_bundle_sha256']
    elif kind=='generated_layer_components':
        source=copy.deepcopy(record['source_provenance'])
        assert source==recipe['source_provenance']
        assert source['baseline_video_sha256']==old['sha256']==generated_baseline_sha(proof)
        assert source['ancestor_original_keyposes_sha256']==record['ancestor_original_keyposes_sha256']
        assert source['anchors']==recipe['source_anchors']
        bundle=validate_layer_source(source,proof)
    else:raise ValueError('No stage contract for this source kind; explicit reviewed schema required')
    assert bundle!=record['ancestor_original_keyposes_sha256']
    source['original_scene_prompt_english']=old['description']
    return source,bundle
