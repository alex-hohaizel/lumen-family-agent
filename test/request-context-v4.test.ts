import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {TestDB} from './helpers.js';
import {one,state,reviseSource,forgetPhrase,eraseAll,type Database,type Row,type SQL} from '../src/db.js';
import {captureOriginalRequestContext,loadOriginalRequestContext,ORIGINAL_REQUEST_MAX_BYTES,ORIGINAL_REQUEST_MAX_ENTITIES,type OriginalRequestScope} from '../src/request-context.js';
import {StorageLifecycle} from '../src/storage-lifecycle.js';

let db:TestDB,sequence=40000;
beforeEach(async()=>{db=new TestDB();await db.init();await db.query("UPDATE app_state SET chat_id='-100',owner_id='11' WHERE id=1");});
afterEach(async()=>{await db.close();});
const scope=(sourceId:number,extra:Partial<OriginalRequestScope>={}):OriginalRequestScope=>({sourceId,actorId:'11',topicId:'7',namespaceChatId:'-100',revision:0,...extra});
// These fixtures call the server capture API explicitly. They are storage tests,
// not evidence that manually inserted legacy rows passed real Engine admission.
async function ingress(body='Покажи список покупок',patch:Record<string,any>={},database:SQL=db){
 const message:any={message_id:++sequence,date:946684800,from:{id:11,first_name:'Автор'},chat:{id:-100,type:'supergroup'},message_thread_id:7,text:body,...patch};
 const stored=typeof message.text==='string'&&message.text.length?message.text:message.caption||body;
 const row=await one(database,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id,created_at) VALUES($1,'11','Автор','user',$2,'7','2000-01-01T00:00:00Z') RETURNING id",[message.message_id,stored]);
 return {sourceId:Number(row!.id),message};
}
const capture=(sourceId:number,message:unknown,database:SQL=db)=>captureOriginalRequestContext(database,sourceId,message,{namespaceChatId:'-100',sourceTopicId:'7'});
const load=(sourceId:number,extra:Partial<OriginalRequestScope>={})=>loadOriginalRequestContext(db,scope(sourceId,extra));

test('capture binds exact live source and DB receive clock without a second body or permission',async()=>{
 const {sourceId,message}=await ingress('Поясни точний код помилки для мого запиту');
 const before=(await one(db,'SELECT clock_timestamp() AS at'))!.at;
 const descriptor=await db.tx(sql=>capture(sourceId,message,sql));assert.ok(descriptor);
 const after=(await one(db,'SELECT clock_timestamp() AS at'))!.at,original=await load(sourceId);assert.ok(original);
 assert.equal(original.body,message.text);assert.equal(original.field,'text');assert.deepEqual(original.entities,[]);
 assert.ok(original.receivedAt.getTime()>=new Date(before).getTime()&&original.receivedAt.getTime()<=new Date(after).getTime());
 assert.equal(original.createdAt.toISOString(),'2000-01-01T00:00:00.000Z');
 assert.notEqual(original.receivedAt.getTime(),message.date*1000);
 const persisted=JSON.stringify(descriptor);assert.ok(Buffer.byteLength(persisted)<=ORIGINAL_REQUEST_MAX_BYTES);
 assert.ok(!persisted.includes(message.text));assert.ok(!/permission|diagnostic_allowed|payload|requestText/.test(persisted));
});

test('caption UTF16 entities normalize quote/code only after all original spans validate',async()=>{
 const body='🙂 Додай кефір';
 const {sourceId,message}=await ingress(body,{text:undefined,caption:body,caption_entities:[{type:'bold',offset:0,length:2},{type:'code',offset:9,length:5,language:'uk'},{type:'blockquote',offset:3,length:5},{type:'code',offset:9,length:5}]});
 const descriptor=await db.tx(sql=>capture(sourceId,message,sql));assert.ok(descriptor);
 const original=await load(sourceId);assert.ok(original);assert.equal(original.field,'caption');assert.equal(descriptor.body_utf16_length,body.length);
 assert.deepEqual(original.entities,[{type:'blockquote',offset:3,length:5},{type:'code',offset:9,length:5}]);
 assert.ok(!JSON.stringify(descriptor).includes('language'));
});

test('invalid ordinary formatting entity makes the whole context unknown',async()=>{
 const {sourceId,message}=await ingress('Додай кефір',{entities:[{type:'blockquote',offset:0,length:5},{type:'bold',offset:500,length:1}]});
 assert.equal(await capture(sourceId,message),null);assert.equal(await load(sourceId),undefined);
 assert.equal((await one(db,'SELECT request_context FROM messages WHERE id=$1',[sourceId]))!.request_context,null);
});

test('surrogate-splitting, malformed, nonintegral and out-of-range native ranges never become empty proof',async()=>{
 for(const entity of [null,{type:'code',offset:1,length:1},{type:'pre',offset:0,length:1},{type:'blockquote',offset:-1,length:2},{type:'bold',offset:2.5,length:1},{type:'code',offset:0,length:0},{type:'code',offset:0,length:100},{type:4,offset:2,length:1}]){
  const {sourceId,message}=await ingress('🙂 Додай кефір',{entities:[entity]});
  assert.equal(await capture(sourceId,message),null);assert.equal(await load(sourceId),undefined);
 }
});

test('entity count and byte bounds reject excess metadata and permit the exact engineering count',async()=>{
 const body='x'.repeat(ORIGINAL_REQUEST_MAX_ENTITIES+1);
 const exact=await ingress(body,{entities:Array.from({length:ORIGINAL_REQUEST_MAX_ENTITIES},(_,offset)=>({type:'code',offset,length:1}))});
 assert.equal((await capture(exact.sourceId,exact.message))!.quote_code_entities.length,ORIGINAL_REQUEST_MAX_ENTITIES);
 for(const entities of [Array.from({length:ORIGINAL_REQUEST_MAX_ENTITIES+1},(_,offset)=>({type:'bold',offset,length:1})),[{type:'pre',offset:0,length:1,language:'x'.repeat(ORIGINAL_REQUEST_MAX_BYTES)}],{}]){
  const {sourceId,message}=await ingress(body,{entities});assert.equal(await capture(sourceId,message),null);
 }
});

test('truncated source, transcripts, synthetic events and missing original text are unknown',async()=>{
 for(const change of [
  (message:any)=>{message.text+='unretained original tail';},
  (message:any)=>{delete message.text;message.voice={file_id:'voice'};},
  (message:any)=>{message.lumen_event={kind:'reaction'};},
  (message:any)=>{message.lumen_choice={};},
  (message:any)=>{message.lumen_interaction={};},
  (message:any)=>{message.lumen_interaction_event={};},
  (message:any)=>{message.message_id=-message.message_id;},
  (message:any)=>{message.caption='second nonempty original field';}
 ]){
  const {sourceId,message}=await ingress('Оригінальний запит');change(message);assert.equal(await capture(sourceId,message),null);assert.equal(await load(sourceId),undefined);
 }
});

test('source identity, logical topic and actual transport must agree at capture',async()=>{
 for(const patch of [{from:{id:22}},{from:{id:11,is_bot:true}},{chat:{id:-200,type:'supergroup'}},{chat:{id:11,type:'private'}},{chat:{id:-100,type:'channel'}},{message_thread_id:8},{message_thread_id:0},{message_id:1.5}]){
  const {sourceId,message}=await ingress();Object.assign(message,patch);assert.equal(await capture(sourceId,message),null);
 }
 const {sourceId,message}=await ingress();
 assert.equal(await captureOriginalRequestContext(db,sourceId,message,{namespaceChatId:'-200',sourceTopicId:'7'}),null);
 assert.equal(await captureOriginalRequestContext(db,sourceId,message,{namespaceChatId:'-100',sourceTopicId:'8'}),null);
});

test('all forwarding aliases and via_bot survive as source facts without derived permission',async()=>{
 for(const key of ['forward_origin','forward_from','forward_from_chat','forward_from_message_id','forward_signature','forward_sender_name','forward_date','is_automatic_forward','forward_future_alias']){
  const {sourceId,message}=await ingress('Факт пересилання',{[key]:key==='is_automatic_forward'?true:{id:9}});
  assert.ok(await capture(sourceId,message));assert.equal((await load(sourceId))!.forwarded,true,key);
 }
 const {sourceId,message}=await ingress('Через бота',{via_bot:{id:999}});await capture(sourceId,message);
 const original=await load(sourceId);assert.equal(original!.viaBot,true);assert.equal(original!.forwarded,false);
});

test('minimal reply reference excludes text and accepts only same-transport reply metadata',async()=>{
 const {sourceId,message}=await ingress('Продовжуй цю задачу',{reply_to_message:{message_id:10002,from:{id:999,is_bot:true},text:'PRIVATE REPLY TEXT'}});
 const descriptor=await capture(sourceId,message);assert.ok(descriptor);
 assert.deepEqual((await load(sourceId))!.replyRef,{chat_id:'-100',message_id:10002,from_id:'999',from_is_bot:true});
 assert.ok(!JSON.stringify(descriptor).includes('PRIVATE REPLY TEXT'));
 for(const reply of [{message_id:10002,chat:{id:-200}},{message_id:'10002'},{message_id:10002,from:{id:0}},{message_id:10002,from:{id:999,is_bot:'true'}}]){
  const current=await ingress('Продовжуй',{reply_to_message:reply});assert.equal(await capture(current.sourceId,current.message),null);
 }
});

test('identical redelivery preserves original receive clock after JSONB normalization',async()=>{
 const {sourceId,message}=await ingress('Цитований запит',{entities:[{type:'code',offset:0,length:3}],reply_to_message:{message_id:10002,from:{id:999,is_bot:true}}});
 const first=await db.tx(sql=>capture(sourceId,message,sql));assert.ok(first);
 const repeated=await db.tx(sql=>capture(sourceId,message,sql));assert.deepEqual(repeated,first);
 assert.equal((await load(sourceId))!.receivedAt.toISOString(),first.received_at);
});

test('duplicate ingress cannot exchange quote, forward or reply envelopes',async()=>{
 const {sourceId,message}=await ingress('Додай кефір');const first=await capture(sourceId,message);assert.ok(first);
 for(const patch of [{entities:[{type:'blockquote',offset:0,length:message.text.length}]},{forward_sender_name:'Another person'},{via_bot:{id:999}},{reply_to_message:{message_id:10002}}]){
  assert.equal(await capture(sourceId,{...message,...patch}),null);
  assert.deepEqual((await one(db,'SELECT request_context FROM messages WHERE id=$1',[sourceId]))!.request_context,first);
 }
});

test('loader requires exact current actor, namespace, topic, revision and live user row',async()=>{
 const {sourceId,message}=await ingress();await capture(sourceId,message);
 for(const mismatch of [{actorId:'22'},{namespaceChatId:'-200'},{topicId:'8'},{revision:1},{revision:-1}])assert.equal(await load(sourceId,mismatch),undefined);
 await db.query("UPDATE messages SET role='assistant' WHERE id=$1",[sourceId]);assert.equal(await load(sourceId),undefined);
});

test('body hash, UTF16 length, malformed descriptor and excess stored metadata fail closed',async()=>{
 const {sourceId,message}=await ingress('🙂 Поточний запит');const descriptor=await capture(sourceId,message);assert.ok(descriptor);
 for(const patch of [{body_sha256:'0'.repeat(64)},{body_utf16_length:1},{quote_code_entities:[{type:'code',offset:1,length:1}]},{quote_code_entities:[{type:'bold',offset:0,length:2}]},{received_at:'2099-01-01T00:00:00.000Z'},{body:'forbidden duplicate body'},{unexpected:'x'.repeat(ORIGINAL_REQUEST_MAX_BYTES)},{actor_id:'22'},{transport_chat_id:'-200'},{received_at:undefined}]){
  await db.query('UPDATE messages SET request_context=$2::jsonb WHERE id=$1',[sourceId,JSON.stringify({...descriptor,...patch})]);assert.equal(await load(sourceId),undefined);
 }
 await db.query('UPDATE messages SET request_context=$2::jsonb,body=$3 WHERE id=$1',[sourceId,JSON.stringify(descriptor),'Інший текст']);assert.equal(await load(sourceId),undefined);
});

test('legacy NULL stays unknown even when a retained inbox or plain source body looks actionable',async()=>{
 const {sourceId,message}=await ingress('Покажи точний код помилки');
 await db.query("INSERT INTO inbox(update_id,payload,revision) VALUES($1,$2,0)",[message.message_id,JSON.stringify({sourceId,message})]);
 assert.equal(await load(sourceId),undefined);assert.equal((await one(db,'SELECT request_context FROM messages WHERE id=$1',[sourceId]))!.request_context,null);
});

test('actual private namespace stays actor-owned and cannot become another group or audience',async()=>{
 await db.query("UPDATE app_state SET chat_id='11' WHERE id=1");
 const {sourceId,message}=await ingress('Особистий список',{chat:{id:11,type:'private'},message_thread_id:undefined});
 await db.query("UPDATE messages SET topic_id='0' WHERE id=$1",[sourceId]);
 assert.ok(await captureOriginalRequestContext(db,sourceId,message,{namespaceChatId:'11',sourceTopicId:'0'}));
 assert.ok(await load(sourceId,{namespaceChatId:'11',topicId:'0',audience:'private'}));
 assert.equal(await load(sourceId,{namespaceChatId:'11',topicId:'0',audience:'group'}),undefined);
 assert.equal(await load(sourceId,{namespaceChatId:'-100',topicId:'0',audience:'private'}),undefined);
});

test('public source may support narrower private output while keeping its actual group transport',async()=>{
 const {sourceId,message}=await ingress();await capture(sourceId,message);
 const original=await load(sourceId,{audience:'private'});assert.ok(original);assert.equal(original.transportChatId,'-100');
});

test('entity-only revision invalidates old proof until a server captures the actual authorized edit',async()=>{
 const {sourceId,message}=await ingress('Покажи точний код помилки');const old=await capture(sourceId,message);assert.ok(old);
 await db.tx(sql=>reviseSource(sql,sourceId,message.text));assert.equal(await load(sourceId,{revision:1}),undefined);
 const edited={...message,entities:[{type:'blockquote',offset:0,length:message.text.length}]};
 assert.ok(await db.tx(sql=>capture(sourceId,edited,sql)));
 const original=await load(sourceId,{revision:1});assert.equal(original!.entities.length,1);assert.equal(original!.descriptor.body_sha256,old.body_sha256);
 assert.equal(await load(sourceId,{revision:0}),undefined);
});

test('source deletion, phrase forget and erase remove metadata; unrelated revision retains independent source',async()=>{
 const kept=await ingress('Незалежна корисна допомога'),erased=await ingress('Секретна фраза для стирання');
 await capture(kept.sourceId,kept.message);await capture(erased.sourceId,erased.message);
 const received=(await load(kept.sourceId))!.receivedAt.toISOString();
 await db.tx(sql=>forgetPhrase(sql,'Секретна фраза'));
 assert.equal(await load(erased.sourceId,{revision:1}),undefined);assert.equal(await one(db,'SELECT id FROM messages WHERE id=$1',[erased.sourceId]),undefined);
 assert.equal((await load(kept.sourceId,{revision:1}))!.receivedAt.toISOString(),received);
 await db.query('DELETE FROM messages WHERE id=$1',[kept.sourceId]);assert.equal(await load(kept.sourceId,{revision:1}),undefined);
 const all=await ingress('Ще джерело');await capture(all.sourceId,all.message);await db.tx(eraseAll);
 assert.equal(await one(db,'SELECT request_context FROM messages WHERE id=$1',[all.sourceId]),undefined);
 assert.equal(Number((await state(db)).memory_revision),2);
});

test('terminal inbox compaction and empty payloads leave source metadata and original DB receive time intact',async()=>{
 const {sourceId,message}=await ingress('Жива допомога після очищення',{entities:[{type:'code',offset:0,length:4}]});
 await capture(sourceId,message);const received=(await load(sourceId))!.receivedAt.toISOString();
 await db.query("INSERT INTO inbox(update_id,payload,revision,status,created_at) VALUES($1,$2,0,'done',now()-interval '2 days')",[message.message_id,JSON.stringify({sourceId,message})]);
 const result=await new StorageLifecycle(db).cleanup();assert.equal(result.terminal_inbox_compacted,1);
 assert.deepEqual((await one(db,'SELECT payload FROM inbox WHERE update_id=$1',[message.message_id]))!.payload,{sourceId});
 assert.equal((await load(sourceId))!.receivedAt.toISOString(),received);
 await db.query("UPDATE inbox SET payload='{}',plan=NULL WHERE update_id=$1",[message.message_id]);
 assert.equal((await load(sourceId))!.entities.length,1);assert.equal((await load(sourceId))!.receivedAt.toISOString(),received);
});

test('descriptor survives a real local database close and reopen independently of queue payload',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lumen-source-context-v4-'));
 class PersistentDB implements Database {
  pg:PGlite;constructor(){this.pg=new PGlite(directory);}
  query<T extends Row=Row>(query:string,args:any[]=[]){return this.pg.query<T>(query,args);}
  tx<T>(fn:(sql:SQL)=>Promise<T>){return this.pg.transaction(async tx=>fn({query:<R extends Row=Row>(query:string,args:any[]=[])=>tx.query<R>(query,args),script:async query=>{await tx.exec(query);}}));}
  close(){return this.pg.close();}
 }
 let persistent=new PersistentDB();
 try{
  await persistent.pg.exec(await readFile(new URL('../../src/schema.sql',import.meta.url),'utf8'));
  await persistent.query("UPDATE app_state SET chat_id='-100' WHERE id=1");
  const {sourceId,message}=await ingress('Переживає перезапуск',{entities:[{type:'pre',offset:0,length:5}]},persistent);
  await persistent.tx(sql=>capture(sourceId,message,sql));const original=await loadOriginalRequestContext(persistent,scope(sourceId));assert.ok(original);
  await persistent.close();persistent=new PersistentDB();
  const reopened=await loadOriginalRequestContext(persistent,scope(sourceId));assert.ok(reopened);
  assert.equal(reopened.receivedAt.toISOString(),original.receivedAt.toISOString());assert.deepEqual(reopened.entities,original.entities);
 }finally{await persistent.close();await rm(directory,{recursive:true,force:true});}
});
