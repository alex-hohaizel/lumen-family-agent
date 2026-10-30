import {writeFile} from 'node:fs/promises';
import {TestDB} from '../dist/test/helpers.js';
import {recall,RecallQuery} from '../dist/src/recall.js';
const db=new TestDB();await db.init();
const context={actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:'recall-controls',requested:true};
const expected=new Map();let queryCalls=0;const measured={query:async(sql,args)=>{queryCalls++;return db.query(sql,args);}};
try{
 for(let i=0;i<30;i++)for(const actor of ['11','22']){const key='маршрут'+String(i).padStart(3,'0'),body=actor==='11'?`Я купив квитки за ${100+i} грн, ${key}.`:`Я не купив квитки, ${key}. Це лише обговорення.`;const row=(await db.query("INSERT INTO messages(user_id,author,role,body,created_at) VALUES($1,$2,'user',$3,'2026-01-03T12:00:00Z') RETURNING id",[actor,actor==='11'?'А':'Б',body])).rows[0];expected.set(String(row.id),{actor,body});}
 let positives=0,negativeFilters=0,negationPreserved=0,wrongMetadata=0,totalItems=0;const started=performance.now();
 for(let i=0;i<30;i++){
  const key='маршрут'+String(i).padStart(3,'0'),q=await recall(measured,RecallQuery.parse({query:'Хто придбав білети '+key+'?',author_id:'11',limit:3}),context);if(q.items.some(x=>x.body.includes(key)))positives++;
  const denied=await recall(measured,RecallQuery.parse({query:'Хто придбав білети '+key+'?',author_id:'22',limit:3}),context);if(denied.items.every(x=>x.body.includes('не купив')&&x.status==='original_not_verified_fact'))negationPreserved++;
  const empty=await recall(measured,RecallQuery.parse({terms:[key],since:'2026-02-01T00:00:00Z',until:'2026-03-01T00:00:00Z'}),context);if(empty.items.length===0)negativeFilters++;
  for(const x of [...q.items,...denied.items]){totalItems++;const raw=expected.get(String(x.source_message_id));if(!raw||x.author_id!==raw.actor||x.body!==raw.body)wrongMetadata++;}
 }
 const result={scope:'Synthetic retrieval controls only; no model answers or human evaluation',positive_queries:30,recall_at_3:positives/30,negative_time_filter_queries:30,negative_time_filters_passed:negativeFilters,denial_author_queries:30,denial_markers_preserved:negationPreserved,candidate_metadata_checked:totalItems,false_author_or_source_metadata:wrongMetadata,retrieval_database_query_calls:queryCalls,query_calls_exclude_transaction_frames:true,retrieval_model_requests:0,elapsed_ms:Math.round((performance.now()-started)*100)/100,answer_false_attribution:'not_evaluated',production_cost:'not_measured'};
 await writeFile('docs/qa-1-12/recall-controls.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(positives!==30||negativeFilters!==30||negationPreserved!==30||wrongMetadata!==0)process.exitCode=1;
}finally{await db.close();}
