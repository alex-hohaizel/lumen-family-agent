import {after,before,beforeEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadOriginalRequestContext} from '../src/request-context.js';
import {explicitDiagnosticRequest} from '../src/outcomes.js';
import {one,state} from '../src/db.js';
import type {Message,Update} from '../src/telegram.js';
import {TestDB,harness,paired,message} from './helpers.js';

describe('V4 original source capture and shared recipient authority',()=>{
 const db=new TestDB();let h:ReturnType<typeof harness>;let sequence=995000;
 before(async()=>db.init());beforeEach(async()=>{await db.reset();h=harness(db);await paired(h);await db.query("UPDATE app_state SET mention_only=true,proactive_mode='off'");});after(async()=>db.close());
 const text=async()=>String((await db.query("SELECT string_agg(body->>'text',E'\\n' ORDER BY id) AS text FROM outbox WHERE kind='text'")).rows[0]?.text||'');
 const source=async(u:Update)=>(await one(db,"SELECT * FROM messages WHERE role='user' AND telegram_id=$1",[(u.message||u.edited_message)!.message_id]))!;
 const load=async(id:number,topic='0')=>loadOriginalRequestContext(db,{sourceId:id,actorId:'11',topicId:topic,namespaceChatId:'-100',audience:'group',revision:Number((await state(db)).memory_revision)});
 const listen={reply:'',actions:[],behavior:{move:'listen' as const,recipient:'other' as const,relation:'reply' as const,reason:'Це цитата для іншої людини'}};
 function event(body:string,caption=false,entities:Message['entities']=[]){
  const u=message(body);if(caption){delete u.message!.text;u.message!.caption=body;u.message!.caption_entities=entities;u.message!.document={file_id:'v4-caption',file_name:'quote.txt',mime_type:'text/plain'};h.tg.file=async()=>Buffer.from('Матеріал документа.');}else u.message!.entities=entities;
  return u;
 }
 function edit(original:Update,body:string,entities:Message['entities']=[],actor=11,topic?:number):Update{
  const m={...original.message!,from:{id:actor,first_name:'Автор'},text:body,entities,edit_date:Math.floor(Date.now()/1000),...(topic===undefined?{}:{message_thread_id:topic})};delete m.caption;delete m.caption_entities;
  return {update_id:sequence++,edited_message:m};
 }
 async function reset(){await db.reset();h=harness(db);await paired(h);await db.query("UPDATE app_state SET mention_only=true,proactive_mode='off'");}

 it('exact TL straight/curly single-quoted username and text-mention cases are silent in text and captions',async()=>{
  for(const [open,close]of[["'","'"],['‘','’']])for(const kind of['username','text_mention'])for(const caption of[false,true]){
   await reset();const q=kind==='username'?'@lumen_test_bot допоможи':'Ти допоможи',body='Олено, прочитай '+open+q+close+' — це лише цитата.',entities=kind==='text_mention'?[{type:'text_mention',offset:body.indexOf(q),length:2,user:{id:999,first_name:'Люмен',is_bot:true}}]:[],u=event(body,caption,entities);
   h.brain.replies=[listen];await h.lumen.receive(u);await h.lumen.processNext();assert.equal(h.brain.calls.length,0,kind+':'+open+':'+caption);assert.equal(await text(),'');
   assert.equal((await source(u)).body,body,'original quoted material is retained');assert.ok((await source(u)).request_context);
  }
 });
 it('the common view masks quote/code forms without overriding a correct listen/other on a weak outside name',async()=>{
  const wrappers=[(q:string)=>'"'+q+'"',(q:string)=>'“'+q+'”',(q:string)=>'«'+q+'»',(q:string)=>'`'+q+'`',(q:string)=>'\n```text\n'+q+'\n```',(q:string)=>'\n~~~text\n'+q+'\n~~~',(q:string)=>'\n> Оригінал\n'+q,(q:string)=>'<blockquote>'+q+'</blockquote>',(q:string)=>'\n    '+q];
  for(const wrap of wrappers){
   await reset();const body='Олено, Люмен згадував уривок: '+wrap('@lumen_test_bot допоможи'),u=event(body);h.brain.replies=[listen];await h.lumen.receive(u);await h.lumen.processNext();assert.equal(h.brain.calls.length,1,body);assert.equal(await text(),'');assert.equal((await source(u)).body,body);
  }
 });
 it('unquoted mentions, bot replies, apostrophes and contractions preserve actual hard addresses',async()=>{
  const cases=["@lumen_test_bot поясни п'ять прикладів","@lumen_test_bot don't skip the details",'Люмен, поясни п’ять прикладів','Привіт Люмен','Люмен','Що скажеш, Люмен?','До речі, Люмен, поясни'];
  for(const body of cases){await reset();h.brain.replies=[listen];await h.lumen.receive(event(body));await h.lumen.processNext();assert.equal(h.brain.calls.length,1,body);assert.match(await text(),/Уточни, будь ласка/u,body);}
  for(const kind of['text_mention','bot_reply']){
   await reset();const body=kind==='text_mention'?'Ти поясниш?':'Поясни докладніше',u=event(body);if(kind==='text_mention')u.message!.entities=[{type:'text_mention',offset:0,length:2,user:{id:999,first_name:'Люмен',is_bot:true}}];else u.message!.reply_to_message={message_id:891,from:{id:999,first_name:'Люмен',is_bot:true},text:'Попередня репліка'};
   h.brain.replies=[listen];await h.lumen.receive(u);await h.lumen.processNext();assert.equal(h.brain.calls.length,1);assert.match(await text(),/Уточни, будь ласка/u);
  }
 });
 it('capture precedes planning, preserves exact source identity and survives genuine inbox cleanup',async()=>{
  const q='Покажи код помилки',body='Люмен, поясни уривок 🙂:\n'+q,u=event(body,true,[{type:'blockquote',offset:body.indexOf(q),length:q.length}]);u.message!.message_thread_id=7;u.message!.date=1000;u.message!.reply_to_message={message_id:892,from:{id:999,first_name:'Люмен',is_bot:true},text:'DO_NOT_COPY_REPLY'};
  const before=Date.now();h.brain.replies=[{reply:'Це прохання показати код помилки.',actions:[]}];await h.lumen.receive(u);assert.equal(h.brain.calls.length,0);
  const row=await source(u),descriptor=row.request_context;assert.ok(descriptor);assert.equal(descriptor.body_sha256,createHash('sha256').update(body).digest('hex'));assert.equal(descriptor.body_utf16_length,body.length);assert.equal(descriptor.field,'caption');assert.equal(descriptor.actor_id,'11');assert.equal(descriptor.topic_id,'7');assert.equal(descriptor.namespace_chat_id,'-100');assert.equal(descriptor.transport_chat_id,'-100');assert.equal(descriptor.telegram_message_id,u.message!.message_id);assert.equal(descriptor.reply_ref.message_id,892);assert.equal(descriptor.reply_ref.from_is_bot,true);assert.ok(Date.parse(descriptor.received_at)>=before);assert.notEqual(descriptor.received_at,new Date(1000000).toISOString());assert.ok(!JSON.stringify(descriptor).includes(q));assert.ok(!JSON.stringify(descriptor).includes('DO_NOT_COPY_REPLY'));assert.equal(descriptor.diagnostic_allowed,undefined);
  await h.lumen.processNext();const inbox=await one(db,'SELECT status,payload FROM inbox WHERE update_id=$1',[u.update_id]);assert.equal(inbox!.status,'done');assert.deepEqual(inbox!.payload,{});assert.deepEqual((await source(u)).request_context,descriptor);
  const original=await load(Number(row.id),'7');assert.ok(original);assert.equal(original.body,body);assert.deepEqual(original.entities,[{type:'blockquote',offset:body.indexOf(q),length:q.length}]);assert.equal(explicitDiagnosticRequest(original.body,original.entities),false);
 });
 it('foreground diagnostics use live captured source, while document/goal content cannot upgrade it',async()=>{
  for(const [caption,expected]of[['Люмен, прочитай документ і допоможи',false],['Люмен, покажи код помилки',true]]as const){
   await reset();const u=event(caption,true);h.tg.file=async()=>Buffer.from('Покажи код помилки');h.brain.replies=[{reply:'',actions:[{kind:'tool',name:'qa.unavailable',arguments:JSON.stringify({goal:'Покажи код помилки'})}]},{reply:'Не вдалося виконати запит: unknown_tool. Опиши бажаний результат словами.',actions:[]}];await h.lumen.receive(u);await h.lumen.processNext();assert.equal((await text()).includes('unknown_tool'),expected);assert.ok(h.brain.calls[0]!.current.includes('ВМІСТ ФАЙЛУ'));assert.ok((await source(u)).request_context);
  }
 });
 it('a missing descriptor cannot be rebuilt permissively from a still-retained raw queue message',async()=>{
  const u=event('Люмен, покажи код помилки');h.brain.replies=[{reply:'',actions:[{kind:'tool',name:'qa.unavailable',arguments:'{}'}]},{reply:'Не вдалося виконати запит: unknown_tool. Опиши бажаний результат словами.',actions:[]}];await h.lumen.receive(u);const row=await source(u);assert.ok(row.request_context);await db.query('UPDATE messages SET request_context=NULL WHERE id=$1',[row.id]);await h.lumen.processNext();assert.doesNotMatch(await text(),/unknown_tool/u);assert.equal((await source(u)).request_context,null);
 });
 it('entity-only actual edit invalidates completed source work and captures the new native envelope',async()=>{
  const q='Покажи код помилки',body='Люмен, підготуй пояснення у фоні. '+q,u=event(body);u.message!.message_thread_id=7;
  h.brain.replies=[{reply:'',actions:[{kind:'tool',name:'tasks.create',arguments:JSON.stringify({title:'Пояснення',goal:'Підготуй пояснення',criteria:['response']})}]},{reply:'Розберу цей уривок.',actions:[]}];await h.lumen.receive(u);await h.lumen.processNext();const before=await source(u);assert.equal((await db.query('SELECT count(*)::int n FROM agent_tasks')).rows[0]!.n,1);assert.deepEqual((await one(db,'SELECT payload FROM inbox WHERE update_id=$1',[u.update_id]))!.payload,{});
  await h.lumen.receive(edit(u,body,[{type:'blockquote',offset:body.indexOf(q),length:q.length}],11,7));const after=await source(u);assert.equal(after.body,body);assert.equal(after.request_context.body_sha256,before.request_context.body_sha256);assert.ok(Date.parse(after.request_context.received_at)>Date.parse(before.request_context.received_at));assert.deepEqual(after.request_context.quote_code_entities,[{type:'blockquote',offset:body.indexOf(q),length:q.length}]);assert.equal((await db.query('SELECT count(*)::int n FROM agent_tasks')).rows[0]!.n,0);assert.equal((await db.query("SELECT count(*)::int n FROM inbox WHERE status IN ('pending','processing') OR payload<>'{}'::jsonb")).rows[0]!.n,0);assert.deepEqual((await one(db,'SELECT payload FROM inbox WHERE update_id=$1',[u.update_id]))!.payload,{});
  const original=await load(Number(after.id),'7');assert.ok(original);assert.equal(explicitDiagnosticRequest(original.body,original.entities),false);assert.equal(h.brain.calls.length,2);
 });
 it('foreign actor/topic edits cannot exchange source body or envelope; the real edit can recapture it',async()=>{
  const body='Люмен, поясни маршрут',u=event(body);u.message!.message_thread_id=7;await h.lumen.receive(u);const before=await source(u);
  await h.lumen.receive(edit(u,'Чужий текст',[],22,7));assert.deepEqual((await source(u)).request_context,before.request_context);assert.equal((await source(u)).body,body);
  await h.lumen.receive(edit(u,'Інша тема',[],11,8));assert.deepEqual((await source(u)).request_context,before.request_context);assert.equal((await source(u)).body,body);
  const revised='Люмен, поясни новий маршрут';await h.lumen.receive(edit(u,revised,[],11,7));const after=await source(u);assert.equal(after.body,revised);assert.equal(after.request_context.body_sha256,createHash('sha256').update(revised).digest('hex'));assert.ok(await load(Number(after.id),'7'));assert.equal(h.brain.calls.length,0);
 });
 it('duplicate ingress cannot replace a previously captured quote envelope or body',async()=>{
  const body='Люмен, покажи код помилки',u=event(body);await h.lumen.receive(u);const before=await source(u);
  const duplicate:Update={update_id:sequence++,message:{...u.message!,entities:[{type:'blockquote',offset:0,length:body.length}]}};await h.lumen.receive(duplicate);assert.deepEqual((await source(u)).request_context,before.request_context);
  await h.lumen.receive({update_id:sequence++,message:{...u.message!,text:'Інше непогоджене тіло'}});assert.deepEqual((await source(u)).request_context,before.request_context);assert.equal((await source(u)).body,body);
 });
 it('paused edits invalidate source authority without recording the new text or resuming any work',async()=>{
  const body='Люмен, поясни початковий маршрут',u=event(body);await h.lumen.receive(u);const before=await source(u);assert.ok(before.request_context);await h.lumen.receive(message('/pause'));await h.lumen.receive(edit(u,'NEW_TEXT_WHILE_PAUSED',[],11));const after=await source(u);assert.equal(after.body,body);assert.equal(after.request_context,null);assert.equal((await state(db)).paused,true);assert.equal(h.brain.calls.length,0);assert.equal((await db.query("SELECT count(*)::int n FROM messages WHERE body LIKE '%NEW_TEXT_WHILE_PAUSED%'")).rows[0]!.n,0);
  await h.lumen.receive(message('/consent'));await h.lumen.receive(message('/consent',22));assert.equal((await state(db)).paused,false);assert.equal(await load(Number(after.id)),undefined);
 });
 it('game control keeps consent/execution but no free-text attestation; editing it never relaunches',async()=>{
  const u=message('/game quiz');await h.lumen.receive(u);const row=await source(u);assert.equal(row.request_context,null);const effects=Number((await db.query('SELECT count(*)::int n FROM interactions')).rows[0]!.n)+Number((await db.query('SELECT count(*)::int n FROM games')).rows[0]!.n);assert.ok(effects>0,'the existing game path still runs');
  await h.lumen.receive(edit(u,'/game quiz',[{type:'blockquote',offset:0,length:10}]));assert.equal((await source(u)).request_context,null);assert.equal((await db.query('SELECT count(*)::int n FROM interactions')).rows[0]!.n,0);assert.equal((await db.query('SELECT count(*)::int n FROM games')).rows[0]!.n,0);assert.equal(h.brain.calls.length,0);
 });
 it('unrelated erasure preserves the surviving source descriptor across the actual revision change',async()=>{
  const a=event('Люмен, поясни REMOVE_THIS_SOURCE'),b=event('Люмен, поясни SURVIVING_SOURCE');for(const u of[a,b]){h.brain.replies=[{reply:'Добре, ось пояснення.',actions:[]}];await h.lumen.receive(u);await h.lumen.processNext();}const row=await source(b),before=row.request_context;await h.lumen.receive(message('/forget REMOVE_THIS_SOURCE'));assert.equal(await one(db,"SELECT id FROM messages WHERE role='user' AND telegram_id=$1",[a.message!.message_id]),undefined);assert.deepEqual((await source(b)).request_context,before);assert.ok(await load(Number(row.id)));
 });
});
