import {describe,it,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {ModelError} from '../src/auth.js';
import {ToolError} from '../src/safe-http.js';
import {TelegramError} from '../src/telegram.js';
import {TestDB} from './helpers.js';
import {one,migrate,queueText,forgetPhrase,reviseSource,pauseMemory,eraseAll} from '../src/db.js';
import {RELEASE} from '../src/release.js';
import {recordIncident,describeFailure,safeErrorCode,validIncidentCode,lookupIncident,logIncident,attachIncident,incidentForError,attachResultIncident,incidentForResult,cleanupIncidents,INCIDENT_ROW_LIMIT,type IncidentContext} from '../src/incidents.js';

it('typed error causes survive without publishing arbitrary exception messages or untrusted properties',()=>{
 assert.equal(safeErrorCode(new ModelError('model_stream_interrupted')),'model_stream_interrupted');
 assert.equal(safeErrorCode(new ToolError('reminder_request_unbound')),'reminder_request_unbound');
 assert.equal(safeErrorCode(new TelegramError('telegram_topic_closed')),'telegram_topic_closed');
 assert.equal(safeErrorCode(Object.assign(Error('password=secret'),{code:'23505'})),'duplicate_operation');
 assert.equal(safeErrorCode(Object.assign(Error('password=secret'),{code:'ECONNRESET'})),'network_connection_reset');
 assert.equal(safeErrorCode(Object.assign(Error('token=secret'),{code:'secret_token_value'})),'operation_failed');
 assert.equal(safeErrorCode(Object.assign(Error('token=secret'),{code:'constructor'})),'operation_failed');
 assert.equal(safeErrorCode(new ToolError('https://secret.example/token')),'operation_failed');
 assert.equal(safeErrorCode(new SyntaxError('private request contents')),'response_contract_invalid');
 assert.equal(incidentForError({incidentReceipt:{code:'forged',message:'secret'}}),undefined);
});
it('failure explanations state the actual known check and effects, never guess unknown causes or suggest blind retries',()=>{
 const actual=describeFailure('reminder_request_unbound',{operation:'cancel_reminder',stage:'source_binding',detail:'source_id_invalid',effectState:'unchanged'});
 assert.match(actual,/Ідентифікатор.*формат/u);assert.match(actual,/Запис не змінено/u);assert.doesNotMatch(actual,/повтор|можливо|бракує прав/iu);
 const unknown=describeFailure('never_seen_internal_reason',{stage:'delivery',effectState:'uncertain'});
 assert.match(unknown,/точну причину ще не встановлено/u);assert.match(unknown,/перед повтором потрібно звірити/u);
 assert.doesNotMatch(unknown,/never_seen_internal_reason|завершено|не змінено/u);
 assert.doesNotMatch(describeFailure('operation_failed',{detail:'password=secret',operation:'my secret task'}),/password|my secret/u);
 assert.match(describeFailure('constructor',{operation:'constructor',stage:'constructor',detail:'constructor'}),/точну причину ще не встановлено/u);
 assert.doesNotMatch(describeFailure('constructor',{operation:'__proto__'}),/function|native code|object Object/u);
 assert.match(describeFailure('http_404'),/HTTP 404/);
 for(const code of ['chatgpt_reauth_required','chatgpt_plan_permission_missing','api_key_missing','oauth_refresh_network','reminder_not_found','reminder_clarification_expired'])assert.doesNotMatch(describeFailure(code),/точну причину ще не встановлено/u);
 for(const code of ['reminder_time_invalid','schedule_time_invalid']){
  const message=describeFailure(code,{operation:'schedule.series',effectState:'unchanged'});assert.match(message,/час минув|коректною датою/u);assert.equal((message.match(/На яку дату й годину запланувати дію\?/gu)||[]).length,1);assert.equal((message.match(/\?/g)||[]).length,1);
 }
 for(const code of ['view_stale','view_membership_required','view_scope_required','resource_unavailable','asset_unavailable','linked_material_unavailable','owner_required','context_changed']){
  const message=describeFailure(code,{operation:'library.browse'});assert.doesNotMatch(message,/точну причину ще не встановлено/u);assert.doesNotMatch(message,/назва приватного|owner_id|audience|resource_unavailable/u);
 }
 for(const [operation,label] of [['studio.render','відеоісторією'],['archive.manage','альбомом'],['lists.manage','списком'],['tasks.status','доручення'],['connector.call','підключеним сервісом'],['library.browse','збереженим матеріалом'],['calendar.write','календарем'],['stock.manage','запасів']]){
  const message=describeFailure('operation_failed',{operation,stage:'tool'});assert.ok(message.includes(label!));assert.ok(!message.includes(operation!));
 }
});
it('operational fallback codes are unique and sanitized when durable recording is unavailable',()=>{
 const logs:string[]=[],previous=console.error;console.error=(line:string)=>logs.push(line);
 try{
  const receipts=Array.from({length:100},()=>logIncident({operation:'delivery',stage:'delivery',attemptKey:'private_request',actorId:'11',sourceId:123,facts:{http_status:503,password:'secret',native_code:'unsafe token',resource_id:'d07cb03d-0733-4d44-b0a3-228bfc8ce5e7',target_refs:['legacy:12']}},new TelegramError('telegram_500')));
  assert.equal(new Set(receipts.map(r=>r.code)).size,100);assert.ok(receipts.every(r=>validIncidentCode(r.code)&&!r.persisted));
  assert.ok(logs.every(line=>!line.includes('private_request')&&!line.includes('secret')&&!line.includes('actor_id')&&!line.includes('source_id')));
  assert.equal(JSON.parse(logs[0]!).facts.http_status,503);
  assert.equal(JSON.parse(logs[0]!).app_version,RELEASE);
  assert.equal(JSON.parse(logs[0]!).facts.resource_id,undefined);assert.equal(JSON.parse(logs[0]!).facts.target_refs,undefined);
 }finally{console.error=previous;}
});

describe('durable scoped diagnostic incidents',()=>{
 let db:TestDB,sourceId:number;
 const base:IncidentContext={operation:'cancel_reminder',stage:'source_binding',attemptKey:'telegram-update:111',requestId:'111',chatId:'-100',actorId:'11',topicId:'0',audience:'group',revision:0,effectState:'unchanged'};
 before(async()=>{db=new TestDB();await db.init();});after(async()=>{await db.close();});
 beforeEach(async()=>{
  await db.reset();await db.query('DELETE FROM diagnostic_incidents');
  await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',paused=false WHERE id=1");
  sourceId=Number((await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES(111,'11','Автор','user','Приватний зміст оригіналу','0') RETURNING id"))!.id);
 });
 const fail=()=>Object.assign(new ToolError('reminder_request_unbound'),{failureDetail:'source_id_invalid'});
 const save=(context:Partial<IncidentContext>={})=>db.tx(sql=>recordIncident(sql,{...base,sourceId,...context},fail()));
 it('saves a PG string source ID, exact release, allowlisted structural facts and no payload',async()=>{
  const receipt=await save({sourceId:String(sourceId),facts:{source_context_present:true,source_body_sha256:'a'.repeat(64),password:'secret',original_text:'Приватний зміст',native_code:'token=secret'}});
  assert.equal(receipt.persisted,true);assert.ok(validIncidentCode(receipt.code));assert.match(receipt.message,/Ідентифікатор.*формат/u);assert.match(receipt.message,new RegExp(receipt.code));
  const row=(await one(db,'SELECT * FROM diagnostic_incidents WHERE code=$1',[receipt.code]))!;
  assert.equal(Number(row.source_message_id),sourceId);assert.equal(row.app_version,RELEASE);assert.equal(row.reason_detail,'source_id_invalid');
  assert.deepEqual(row.facts,{source_context_present:true,source_body_sha256:'a'.repeat(64)});
  assert.doesNotMatch(JSON.stringify(row),/Приватний зміст|password|secret|token=/u);
  assert.doesNotMatch(receipt.message,/actor|source_message|Приватний зміст/u);
 });
 it('reuses the same logical failed attempt across calls and issues another code for a new attempt',async()=>{
  const first=await save(),same=await save(),next=await save({attemptKey:'telegram-update:112'});
  assert.equal(first.code,same.code);assert.notEqual(first.code,next.code);
  assert.equal((await one(db,'SELECT occurrences FROM diagnostic_incidents WHERE code=$1',[first.code]))!.occurrences,2);
 });
 it('keeps bounded typed target references and hashed authorization facts only in private diagnostic evidence',async()=>{
  const id='d07cb03d-0733-4d44-b0a3-228bfc8ce5e7',hash='f'.repeat(64);
  const facts={target_refs:['series:'+id,'schedule:'+id,'occurrence:'+id,'reminder:12','legacy:13'],target_id:id,requested_scope:'series',authorization_proof_sha256:hash,authorization_proof_utf16_length:75,target_count:5,targets_sha256:'a'.repeat(64),observed_version:hash,expected_version:'2',resource_id:id,resource_kind:'media'};
  const r=await save({facts}),row=(await one(db,'SELECT facts FROM diagnostic_incidents WHERE code=$1',[r.code]))!;
  assert.deepEqual(row.facts,facts);assert.doesNotMatch(r.message,new RegExp(id));assert.doesNotMatch(r.message,new RegExp(hash));
  const numeric=await save({attemptKey:'numeric-resource',facts:{resource_id:'12',resource_kind:'reminder'}});
  assert.deepEqual((await one(db,'SELECT facts FROM diagnostic_incidents WHERE code=$1',[numeric.code]))!.facts,{resource_id:'12',resource_kind:'reminder'});
 });
 it('discards malformed references, secret-like strings and excessive arrays or authorization lengths',async()=>{
  const invalid=[
   {target_refs:['secret-token'],target_id:'token',resource_id:'password',resource_kind:'private-secret',requested_scope:'DROP TABLE messages',authorization_proof_sha256:'raw quote with secret',authorization_proof_utf16_length:-1,target_count:Infinity,targets_sha256:'raw targets'},
   {target_refs:['legacy:01'],resource_id:'0012',authorization_proof_utf16_length:12001,target_count:1000001},
   {target_refs:['series:12']},
   {target_refs:Array.from({length:21},()=> 'legacy:12')},
   {target_refs:['legacy:12','https://secret.example/token']},
   {target_id:12,requested_scope:true,resource_kind:1,resource_id:true,observed_version:false,authorization_proof_sha256:true,targets_sha256:12},
  ];
  for(const [index,facts] of invalid.entries()){
   const r=await save({attemptKey:'invalid-facts:'+index,facts});assert.deepEqual((await one(db,'SELECT facts FROM diagnostic_incidents WHERE code=$1',[r.code]))!.facts,{});
  }
 });
 it('records incident and final notice atomically; rollback leaves neither and attaches no phantom receipt',async()=>{
  const error=fail();let code='';
  await assert.rejects(db.tx(async sql=>{const r=await recordIncident(sql,{...base,sourceId},error);code=r.code;await queueText(sql,r.message,0,'atomic-error',false,{sourceMessageId:sourceId,actorId:'11'});throw Error('rollback');}));
  assert.equal(await one(db,'SELECT code FROM diagnostic_incidents WHERE code=$1',[code]),undefined);
  assert.equal(await one(db,"SELECT id FROM outbox WHERE dedup_key='atomic-error:0'"),undefined);assert.equal(incidentForError(error),undefined);
  const r=await save();attachIncident(error,r);assert.equal(incidentForError(error,{...base,sourceId})?.code,r.code);
  const result={error:'reminder_request_unbound'};assert.equal(incidentForResult(result),undefined);attachResultIncident(result,r);assert.equal(incidentForResult(result)?.code,r.code);assert.equal(incidentForError(result,{...base,sourceId}),undefined);assert.equal(incidentForResult({incidentCode:r.code,incidentMessage:r.message}),undefined);
 });
 it('a reused singleton exception cannot carry another request or audience incident code',async()=>{
  const error=fail(),firstContext={...base,sourceId},r=await db.tx(sql=>recordIncident(sql,firstContext,error));attachIncident(error,r);
  assert.equal(incidentForError(error),undefined);assert.equal(incidentForError(error,firstContext)?.code,r.code);
  assert.equal(incidentForError(error,{...firstContext,stage:'tool',attemptKey:'outer-stage-same-source'})?.code,r.code);
  for(const altered of [{actorId:'22'},{topicId:'7'},{chatId:'-101'},{audience:'private' as const},{revision:1},{sourceId:sourceId+1},{requestId:'112'}])assert.equal(incidentForError(error,{...firstContext,...altered}),undefined);
  const nextContext={...base,requestId:'112',sourceId:undefined,attemptKey:'other-request'};
  const next=await db.tx(sql=>recordIncident(sql,nextContext,error));attachIncident(error,next);assert.notEqual(next.code,r.code);
  assert.equal(incidentForError(error,firstContext),undefined);assert.equal(incidentForError(error,nextContext)?.code,next.code);
  const taskContext={...base,sourceId,taskId:'d07cb03d-0733-4d44-b0a3-228bfc8ce5e7',attemptKey:'task:one:1'};
  const task=await db.tx(sql=>recordIncident(sql,taskContext,error));attachIncident(error,task);
  assert.equal(incidentForError(error,taskContext)?.code,task.code);assert.equal(incidentForError(error,{...taskContext,attemptKey:'task:one:2'}),undefined);
 });
 it('distinct actions in the same request have distinct incident codes while an exact logical action is stable',async()=>{
  const error=fail(),first={...base,sourceId,operation:'lists.manage',operationKey:'a'.repeat(64)};
  const r=await db.tx(sql=>recordIncident(sql,first,error));attachIncident(error,r);
  assert.equal(incidentForError(error,first)?.code,r.code);
  assert.equal(incidentForError(error,{...first,operationKey:'b'.repeat(64)}),undefined);
  assert.equal(incidentForError(error,{...first,operation:'studio.manage'}),undefined);
  assert.equal(incidentForError(error,{...first,operationKey:undefined}),undefined);
  const same=await db.tx(sql=>recordIncident(sql,first,error));assert.equal(same.code,r.code);
  const changedArgs=await db.tx(sql=>recordIncident(sql,{...first,operationKey:'b'.repeat(64)},error));assert.notEqual(changedArgs.code,r.code);
  const changedTool=await db.tx(sql=>recordIncident(sql,{...first,operation:'studio.manage'},error));assert.notEqual(changedTool.code,r.code);
  await assert.rejects(db.tx(sql=>recordIncident(sql,{...first,operationKey:'raw secret arguments'},error)),/incident_operation_key_invalid/);
 });
 it('opaque code does not authorize another actor, topic, audience or revision',async()=>{
  const r=await save({audience:'private'}),scope={actorId:'11',topicId:'0',audience:'private' as const,revision:0};
  assert.ok(await lookupIncident(db,r.code,scope));
  for(const altered of [{actorId:'22'},{topicId:'9'},{audience:'group' as const},{revision:1}])assert.equal(await lookupIncident(db,r.code,{...scope,...altered}),null);
  assert.equal(await lookupIncident(db,"' OR true--",scope),null);
  const publicView=await lookupIncident(db,r.code,scope);assert.equal(publicView?.source_message_id,undefined);assert.equal(publicView?.actor_id,undefined);assert.equal(publicView?.facts,undefined);
 });
 it('wrong-owner or wrong-topic source IDs never retain a foreign source link',async()=>{
  const other=(await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES(112,'22','Інша людина','user','Чужий приватний зміст','7') RETURNING id"))!;
  const r=await save({sourceId:String(other.id)}),row=(await one(db,'SELECT source_message_id,facts FROM diagnostic_incidents WHERE code=$1',[r.code]))!;
  assert.equal(row.source_message_id,null);assert.equal(row.facts.source_bound,false);
 });
 it('source edit/forget/full erase remove corresponding diagnostic evidence',async()=>{
  const edited=await save();await db.tx(sql=>reviseSource(sql,sourceId,'Виправлений текст'));
  assert.equal(await one(db,'SELECT code FROM diagnostic_incidents WHERE code=$1',[edited.code]),undefined);
  await db.query('UPDATE app_state SET memory_revision=0 WHERE id=1');
  const forgotten=await save();await db.tx(sql=>forgetPhrase(sql,'Виправлений текст'));
  assert.equal(await one(db,'SELECT code FROM diagnostic_incidents WHERE code=$1',[forgotten.code]),undefined);
  await db.query('UPDATE app_state SET memory_revision=0 WHERE id=1');
  const anonymous=await save({sourceId:undefined});await db.tx(eraseAll);
  assert.equal(await one(db,'SELECT code FROM diagnostic_incidents WHERE code=$1',[anonymous.code]),undefined);
 });
 it('pause clears incidents and stale or paused contexts cannot recreate them',async()=>{
  const r=await save();await db.tx(pauseMemory);assert.equal(await one(db,'SELECT code FROM diagnostic_incidents WHERE code=$1',[r.code]),undefined);
  await assert.rejects(save(),/incident_context_stale/);
  await db.query('UPDATE app_state SET paused=false,memory_revision=1 WHERE id=1');await assert.rejects(save(),/incident_context_stale/);
  assert.equal(Number((await one(db,'SELECT count(*) AS n FROM diagnostic_incidents'))!.n),0);
 });
 it('retention expires old records and enforces the bounded row cap',async()=>{
  const old=await save();await db.query("UPDATE diagnostic_incidents SET created_at=now()-interval '31 days' WHERE code=$1",[old.code]);
  assert.equal(await cleanupIncidents(db),1);assert.equal(await lookupIncident(db,old.code,{actorId:'11',topicId:'0',audience:'group',revision:0}),null);
  await db.query(`INSERT INTO diagnostic_incidents(code,dedup_key,operation,stage,reason_code,topic_id,audience,revision,app_version)
   SELECT 'LM-'||lpad(i::text,26,'0'),lpad(i::text,64,'0'),'conversation','planning','operation_failed','0','private',0,'test' FROM generate_series(1,$1::integer) i`,[INCIDENT_ROW_LIMIT]);
  await save({attemptKey:'new-bounded-attempt'});
  assert.equal(Number((await one(db,'SELECT count(*) AS n FROM diagnostic_incidents'))!.n),INCIDENT_ROW_LIMIT);
 });
 it('migrates an existing version21 database additively and detects a missing diagnostics table',async()=>{
  await db.query("INSERT INTO reminders(title,due_at,author_id) VALUES('Збережене нагадування',now()+interval '1 day','11')");
  await db.pg.exec('DROP TABLE diagnostic_incidents; DELETE FROM schema_version WHERE version=22;');
  await migrate(db);assert.equal((await one(db,'SELECT max(version) AS n FROM schema_version'))!.n,22);
  assert.equal(Number((await one(db,'SELECT count(*) AS n FROM reminders'))!.n),1);
  await migrate(db);assert.equal(Number((await one(db,'SELECT count(*) AS n FROM reminders'))!.n),1);
  await db.pg.exec('DROP TABLE diagnostic_incidents;');await migrate(db);assert.equal((await one(db,"SELECT to_regclass('diagnostic_incidents') AS name"))!.name,'diagnostic_incidents');
 });
});
