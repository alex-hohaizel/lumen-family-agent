"""Explicit independently accepted metadata corrections; no pixel substitution."""
import copy,json
from repair import REPO,sha


def without_paths(value):
    if isinstance(value,list):return [without_paths(x) for x in value]
    if not isinstance(value,dict):return value
    return {k:without_paths(v) for k,v in value.items() if k!='path' and not k.endswith('_path')}


def corrected_source(selection,proof):
    override=selection['source_contract_override'];contract_path=REPO/override['contract_path']
    assert sha(contract_path)==override['contract_sha256']
    contract=json.loads(contract_path.read_text());assert contract['id']==selection['id']
    review=override['independent_acceptance'];assert sha(REPO/review['artifact'])==review['artifact_sha256']
    qa=json.loads((REPO/review['artifact']).read_text());assert qa['actual_agent_id']
    item=next(x for x in qa['items'] if x['id']==selection['id']) if 'items' in qa else qa
    acceptance=item['source']['provenance_acceptance'];assert acceptance['verdict']=='accept'
    assert acceptance['corrected_contract_path']==override.get('reviewed_contract_path',override['contract_path'])
    assert acceptance['corrected_contract_sha256']==override['contract_sha256']
    source=copy.deepcopy(contract['proposed_manifest_fields']['source_provenance']);old=proof['source_provenance']
    assert source['kind']==old['kind']=='generated_corrected_anchor'
    for field in ['baseline_video_sha256','ancestor_original_keyposes_sha256','generated_source_bundle_sha256']:
        assert source[field]==old[field]
    for field in ['baseline_target','identity_reference']:assert source[field]['sha256']==old[field]['sha256']
    gen,prior=source['generation'],old['generation']
    for field in ['tool','actual_agent','operation','original_image_sha256','animation_anchor_sha256']:
        assert gen[field]==prior[field]
    assert gen['original_metadata_sha256']==prior['metadata_sha256']
    assert [(a['key'],a['sha256']) for a in source['anchors']]==[(a['key'],a['sha256']) for a in old['anchors']]
    return source
