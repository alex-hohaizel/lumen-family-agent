"""Exact generated component provenance, distinct from recovered original art.

The immutable tool metadata retains its historical paths. Operational reads use
the approved canonical path map, keyed by exact SHA256, including every input to
every generation/edit operation. This validator never repaints raster content.
"""
import hashlib,json
from pathlib import PurePosixPath
from PIL import Image
from repair import REPO,sha


PREFIX='sticker-lab/production-v5/approved-sources/'


def pinned(ref):
    path=ref['path'];assert isinstance(path,str) and path.startswith(PREFIX)
    assert not PurePosixPath(path).is_absolute() and '..' not in PurePosixPath(path).parts
    assert sha(REPO/path)==ref['sha256']
    return REPO/path


def validate_layer_source(source,proof=None):
    assert source['kind']=='generated_layer_components'
    assert source['not_recovered_original_art'] is True and source['not_original_keyposes'] is True
    assert source['ancestor_original_status']=='unresolved_original_not_recovered'
    baseline={'path':source['baseline_video_path'],'sha256':source['baseline_video_sha256']};pinned(baseline)
    frames=source['baseline_frames'];assert frames and len({f['frame_index'] for f in frames})==len(frames)
    for f in frames:
        assert f['kind']=='decoded_baseline_video_frame'
        assert type(f['frame_index']) is int and 0<=f['frame_index']<84
        assert abs(f['timestamp_seconds']-f['frame_index']/30)<1e-8
        im=Image.open(pinned(f));assert im.size==(512,512) and im.mode=='RGBA'
    gen=source['generation'];assert gen['tool']=='built-in image_gen.imagegen' and gen['actual_agent_id']
    assert gen['operation']=='layer_component_generation_and_targeted_source_edits'
    assert gen['literal_prompts_preserved'] is True
    metadata=json.loads(pinned({'path':gen['metadata_path'],'sha256':gen['metadata_sha256']}).read_text())
    for ref in gen.get('history_artifacts',[]):pinned(ref)
    assert metadata['kind']=='generated_layer_components'
    assert metadata['actual_agent_id']==gen['actual_agent_id']
    raws=gen['raw_outputs'];assert raws and len({r['sha256'] for r in raws})==len(raws)
    rawmap={r['sha256']:r for r in raws};rawimages={}
    for raw in raws:
        im=Image.open(pinned(raw));assert list(im.size)==raw['size'] and im.mode=='RGBA'
        assert im.getchannel('A').getextrema()[0]==0 and im.getchannel('A').getextrema()[1]>0
        rawimages[raw['sha256']]=im
    # Additional entries include cross-scene/intermediate references, not only
    # initial baseline and identity images. Historical paths are never read.
    refs=gen['input_references'];assert refs
    for ref in refs:pinned(ref)
    mapping={r['sha256']:r for r in raws+refs+frames}
    assert {r['sha256'] for r in metadata['raw_outputs']}==set(rawmap)
    for raw in metadata['raw_outputs']:
        exact=rawmap[raw['sha256']];assert raw['size']==exact['size']
        assert raw['actual_tool_returned_path']==exact['actual_tool_returned_path']
    operations=metadata['operations'];assert len(operations)==gen['operation_chain_count']
    assert len({op['id'] for op in operations})==len(operations)
    assert {op['output_sha256'] for op in operations}==set(rawmap)
    for op in operations:
        assert op['tool']==gen['tool'] and op['actual_agent_id']==gen['actual_agent_id']
        assert isinstance(op['prompt'],str) and op['prompt'].strip()
        assert op['transparent_background'] is True
        raw=rawmap[op['output_sha256']]
        assert op['actual_tool_output']==raw['actual_tool_returned_path']
        assert op['output_size']==raw['size'] and op['output_mode']=='RGBA'
        assert list(rawimages[op['output_sha256']].getchannel('A').getextrema())==op['actual_alpha_extrema']
        assert op['inputs']
        for ref in op['inputs']:
            assert ref['role'] and ref['sha256'] in mapping
            pinned(mapping[ref['sha256']])
    for ref in metadata['actual_input_references']:
        assert ref['sha256'] in mapping;pinned(mapping[ref['sha256']])
    anchors=sorted(source['anchors'],key=lambda a:a['key'])
    assert anchors and len({a['key'] for a in anchors})==len(anchors)
    historical={a['key']:a for a in metadata['source_anchors']};assert set(historical)=={a['key'] for a in anchors}
    for anchor in anchors:
        assert anchor['origin']=='generated_layer_components' and anchor['original_video_timestamp'] is None
        assert 'index' not in anchor and 'timestamp_seconds' not in anchor
        deriv=anchor['derivation'];assert deriv['resize'] is None and deriv['padding'] is None
        assert deriv['operation'].startswith('Pillow exact rectangular crop only;')
        raw=rawimages[deriv['raw_output_sha256']]
        box=deriv['crop_box_xyxy'];assert len(box)==4 and all(type(n) is int for n in box)
        x0,y0,x1,y1=box;assert 0<=x0<x1<=raw.width and 0<=y0<y1<=raw.height
        assert [x1-x0,y1-y0]==[anchor['width'],anchor['height']]
        crop=Image.open(pinned(anchor));assert crop.mode=='RGBA' and crop.size==(anchor['width'],anchor['height'])
        assert crop.tobytes()==raw.crop(box).tobytes(),anchor['key']+' is not the declared exact crop'
        h=historical[anchor['key']]
        for key in ['sha256','width','height','origin','original_video_timestamp','derivation']:assert anchor[key]==h[key]
    bundle=hashlib.sha256(''.join(a['sha256'] for a in anchors).encode('ascii')).hexdigest()
    assert bundle==source['generated_source_bundle_sha256']
    if proof is not None:
        original=proof['source_provenance'];assert original['kind']==source['kind']==proof['source_kind']
        for key in ['baseline_video_sha256','ancestor_original_keyposes_sha256','generated_source_bundle_sha256']:
            assert source[key]==original[key]
        assert proof['generated_source_bundle_sha256']==bundle
        assert [(f['frame_index'],f['timestamp_seconds'],f['sha256']) for f in frames]==[(f['frame_index'],f['timestamp_seconds'],f['sha256']) for f in original['baseline_frames']]
        assert [(a['key'],a['sha256'],a['derivation']) for a in anchors]==[(a['key'],a['sha256'],a['derivation']) for a in sorted(original['anchors'],key=lambda a:a['key'])]
        for key in ['tool','actual_agent_id','operation','metadata_sha256','literal_prompts_preserved','operation_chain_count']:
            assert gen[key]==original['generation'][key]
        assert [(r['sha256'],r['size'],r['actual_tool_returned_path']) for r in raws]==[(r['sha256'],r['size'],r['actual_tool_returned_path']) for r in original['generation']['raw_outputs']]
    return bundle
