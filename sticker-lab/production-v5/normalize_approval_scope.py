#!/usr/bin/env python3
"""Derive a new approval document by copying exact existing QA scope fields.

Never changes QA reports, candidate/proof/recipe/rerender hashes or acceptance.
Some actual reviewers used decision_scope/verdict_scope instead of accepted_scope.
"""
import argparse,copy,json
from datetime import datetime,timezone
from pathlib import Path
from repair import REPO,sha
from stage import accepted_review


def main():
    p=argparse.ArgumentParser();p.add_argument('source',type=Path);p.add_argument('target',type=Path);args=p.parse_args()
    assert not args.target.exists();original=json.loads(args.source.read_text());result=copy.deepcopy(original);changes=[]
    for record in result['items']:
        qaref=record['qa'];qa_path=REPO/qaref['artifact'];assert sha(qa_path)==qaref['artifact_sha256'];qa=json.loads(qa_path.read_text())
        item=next(q for q in qa['items'] if q['id']==record['id']);assert item['verdict']=='accept'
        accepted_review(qa,record)
        if not qaref.get('review_id'):
            name=next(k for k in ['review_id','report_id','id'] if qa.get(k))
            qaref['review_id']=qa[name];qaref['exact_review_id_source_field']=name
            changes.append({'id':record['id'],'review_id_copied_from_field':name,'review_id':qa[name]})
        if not qaref.get('accepted_scope'):
            name=next(k for k in ['accept_scope','accepted_scope','decision_scope','verdict_scope'] if item.get(k))
            qaref['accepted_scope']=item[name];qaref['exact_scope_source_field']=name
            changes.append({'id':record['id'],'scope_copied_from_field':name,'scope_text':item[name]})
        assert qaref['accepted_scope'] and qaref['review_id'] and qaref['actual_agent_id'] and qaref['limitations']
    result['scope_field_normalization']={'source_path':str(args.source),'source_sha256':sha(args.source),'actual_integrator':'/root/animation_integrator_resume',
        'at':datetime.now(timezone.utc).isoformat(),'changes':changes,'candidate_proof_recipe_rerender_bindings_unchanged':True,
        'meaning':'Only exact existing accepted QA scope text was copied into the operational schema; no broadened acceptance and no new verdict.'}
    args.target.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'target':str(args.target),'scopes_normalized':len(changes),'records':len(result['items'])}))


if __name__=='__main__':main()
