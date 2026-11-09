import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TestDB,harness,paired,message} from './helpers.js';
import {one,forgetPhrase} from '../src/db.js';
import {Recurring,SeriesCommand} from '../src/recurring.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {Delivery} from '../src/delivery.js';
import {recordProvenance} from '../src/provenance.js';
import type {ToolContext} from '../src/agent-tools.js';

let db:TestDB,h:ReturnType<typeof harness>,runner:AgentTasks,n=995000;
type Entity={type:string;offset:number;length:number};
before(async()=>{db=new TestDB();await db.init();});after(async()=>db.close());
beforeEach(async()=>{await db.reset();await db.query('DELETE FROM recurring_series');await db.query('DELETE FROM domain_commands');h=harness(db);await paired(h);runner=new AgentTasks(db,h.config,h.brain);});
const c=(sourceId:number):ToolContext=>({actorId:'11',chatId:'-100',topicId:'7',revision:0,sourceId,updateId:String(++n),requested:true,audience:'group'});
async function source(body:string,entities:Entity[]=[],extra:{caption?:boolean;review?:any;forward?:boolean}={}){
 const update=message(body),m=update.message!;m.message_thread_id=7;
 if(extra.caption){delete m.text;m.caption=body;m.caption_entities=entities;m.document={file_id:'known-caption-file',mime_type:'text/plain'};}
 else m.entities=entities;
 if(extra.review)m.reply_to_message={message_id:Number(extra.review.telegram_id),from:{id:999,is_bot:true,first_name:'Люмен'},date:0,chat:{id:-100,type:'supergroup'},text:extra.review.body.text};
 if(extra.forward)(m as any).forward_origin={type:'hidden_user',sender_user_name:'Приклад',date:0};
 await h.lumen.receive(update);
 const row=(await one(db,"SELECT id FROM messages WHERE role='user' AND telegram_id=$1",[m.message_id]))!;
 return {id:Number(row.id),message:m,updateId:update.update_id};
}
function span(body:string,quoted:string,type='blockquote'):Entity{return {type,offset:body.indexOf(quoted),length:quoted.length};}
async function reviewedLegacyTask(){
 const origin=await source('Щодня привітай учасників'),series=new Recurring(db);
 const draft=await series.run(SeriesCommand.parse({operation:'preview',rule:{title:'Щоденне привітання',instruction:'Коротко привітай учасників',mode:'task',timezone:'UTC',start_date:new Date(Date.now()+86400000).toISOString().slice(0,10),time:'00:00',frequency:'daily',catch_up:'ask'}}),c(origin.id));
 await series.run(SeriesCommand.parse({operation:'confirm',id:draft.id,version:1}),c(origin.id));await series.tick();
 const occurrence=(await one(db,'SELECT * FROM recurring_occurrences WHERE series_id=$1 AND schedule_id IS NOT NULL ORDER BY due_at LIMIT 1',[draft.id]))!;
 await db.query("UPDATE scheduled_actions SET due_at=now()-interval '2 hours' WHERE id=$1",[occurrence.schedule_id]);await db.query("UPDATE recurring_occurrences SET due_at=now()-interval '2 hours' WHERE schedule_id=$1",[occurrence.schedule_id]);
 const id=randomUUID();await db.query("INSERT INTO agent_tasks(id,dedup_key,actor_id,topic_id,title,goal,revision,source_message_id,audience) VALUES($1,$2,'11','7','V2 queued greeting','Коротко привітай учасників',0,$3,'group')",[id,'scheduled-task:'+occurrence.schedule_id,origin.id]);await db.query("UPDATE scheduled_actions SET status='dispatched',task_id=$2 WHERE id=$1",[occurrence.schedule_id,id]);await db.tx(sql=>recordProvenance(sql,'task',id,[origin.id]));
 assert.equal(await runner.next(),false);assert.equal(h.brain.calls.length,0);
 const delivery=new Delivery(db,h.tg as any,h.config);assert.equal(await delivery.next(),true);
 const review=(await one(db,"SELECT * FROM outbox WHERE dedup_key LIKE 'series-review:%'"))!;assert.equal(review.status,'sent');assert.ok(review.telegram_id);
 return {id,origin,review};
}

type DiagnosticSpec={id:string;body:string;entities?:Entity[];permit:boolean;caption?:boolean;forward?:boolean;mismatch?:boolean};
const quoted='Покажи код помилки',intro='Люмен, прочитай цей уривок:\n';
const diagnosticSpecs:DiagnosticSpec[]=[
 ...['blockquote','expandable_blockquote','pre','code'].map(type=>({id:`native-${type}`,body:intro+quoted,entities:[span(intro+quoted,quoted,type)],permit:false})),
 {id:'markdown-lazy-quote',body:'Люмен, прочитай уривок:\n> Приклад прохання:\nПокажи код помилки',permit:false},
 {id:'literal-quote',body:'Люмен, поясни фразу «Покажи код помилки».',permit:false},
 {id:'unquoted-explicit',body:'Люмен, покажи код помилки.',permit:true},
 {id:'mixed-unquoted-explicit',body:intro+quoted+'\n\nА тепер назви код помилки.',entities:[span(intro+quoted,quoted)],permit:true},
 {id:'utf16-quoted-span',body:'🧪 Люмен, прочитай цей уривок:\n'+quoted,entities:[span('🧪 Люмен, прочитай цей уривок:\n'+quoted,quoted)],permit:false},
 {id:'malformed-quote-range',body:quoted,entities:[{type:'blockquote',offset:0,length:quoted.length+1}],permit:false},
 {id:'malformed-negative-offset',body:quoted,entities:[{type:'pre',offset:-1,length:quoted.length}],permit:false},
 {id:'caption-native-quote',body:quoted,entities:[span(quoted,quoted)],permit:false,caption:true},
 {id:'caption-unquoted-explicit',body:quoted,permit:true,caption:true},
 {id:'nonquote-formatting',body:quoted,entities:[span(quoted,quoted,'bold')],permit:true},
 {id:'forwarded-explicit',body:quoted,permit:false,forward:true},
 {id:'stored-body-does-not-match-inbox',body:'Прочитай уривок',permit:false,mismatch:true}
];
for(const spec of diagnosticSpecs)test(`R2 diagnostic actual authored source: ${spec.id}`,async t=>{
 const s=await source(spec.body,spec.entities,{caption:spec.caption,forward:spec.forward});
 if(spec.mismatch)await db.query('UPDATE messages SET body=$2 WHERE id=$1',[s.id,quoted]);
 const task=await runner.tools.execute('tasks.create',{title:'Діагностика',goal:'Покажи код помилки'},c(s.id));
 try{await runner.tools.execute('r2.invalid_tool',{}, {...c(s.id),taskId:task.id,goalVersion:1});assert.fail('an unknown tool must not execute');}catch(e){assert.equal((e as any).code,'unknown_tool');}
 h.brain.replies.push({reply:'Не вдалося виконати: unknown_tool. Опиши бажаний результат словами.',actions:[]});assert.equal(await runner.next(),true);assert.equal(h.brain.calls.length,1);
 const result=(await one(db,'SELECT status,result FROM agent_tasks WHERE id=$1',[task.id]))!;assert.equal(result.result.includes('unknown_tool'),spec.permit);
 const reply=(await one(db,"SELECT body FROM outbox WHERE body->>'taskId'=$1 AND dedup_key LIKE 'task-result:%'",[task.id]))!;assert.equal(reply.body.text.includes('unknown_tool'),spec.permit);
 if(spec.id==='native-blockquote'||spec.id==='mixed-unquoted-explicit')t.diagnostic(JSON.stringify({source_id:s.id,body:spec.body,entities:spec.entities,task_id:task.id,model_calls:1,technical_details_permitted:spec.permit,result:result.result}));
});

type ResumeInput={body:string;entities?:Entity[];review?:boolean;caption?:boolean;mismatch?:boolean};
type ResumeSpec={id:string;permit:boolean;input:(id:string)=>ResumeInput};
const different='00000000-0000-4000-8000-000000000099';
const command=(id:string)=>`Виконай задачу ${id} зараз`;
const resumeSpecs:ResumeSpec[]=[
 ...['blockquote','expandable_blockquote','pre','code'].map(type=>({id:`native-${type}`,permit:false,input:(id:string)=>({body:command(id),entities:[span(command(id),command(id),type)]})})),
 {id:'native-quoted-review-reply',permit:false,input:()=>({body:'Продовжуй цю задачу',entities:[span('Продовжуй цю задачу','Продовжуй цю задачу')],review:true})},
 {id:'markdown-lazy-quote',permit:false,input:id=>({body:`> Приклад:\n${command(id)}`})},
 {id:'indented-code',permit:false,input:id=>({body:`    ${command(id)}`})},
 {id:'literal-quote',permit:false,input:id=>({body:`«${command(id)}»`})},
 {id:'plain-explicit-id',permit:true,input:id=>({body:command(id)})},
 {id:'current-unquoted-review-reply',permit:true,input:()=>({body:'Продовжуй цю задачу',review:true})},
 {id:'current-review-standalone-continue',permit:true,input:()=>({body:'Продовжуй',review:true})},
 {id:'review-reply-conversation-object',permit:false,input:()=>({body:'Продовжуй розмову.',review:true})},
 {id:'review-reply-other-task-object',permit:false,input:()=>({body:'Виконай іншу задачу.',review:true})},
 {id:'utf16-quote-before-actual-command',permit:true,input:id=>{const prefix='🧪 Приклад: '+command(different);return {body:prefix+'\n\n'+command(id),entities:[span(prefix,prefix)]};}},
 {id:'inline-native-quote-before-actual-command',permit:true,input:id=>{const prefix='🧪 Приклад ';return {body:prefix+command(id),entities:[span(prefix,prefix)]};}},
 {id:'caption-native-quote',permit:false,input:id=>({body:command(id),entities:[span(command(id),command(id))],caption:true})},
 {id:'caption-plain-command',permit:true,input:id=>({body:command(id),caption:true})},
 {id:'different-operative-id-later-reference',permit:false,input:id=>({body:`${command(different)}. Для довідки старий ідентифікатор ${id}.`})},
 {id:'different-id-same-clause-reference',permit:false,input:id=>({body:`${command(different)}, для довідки старий ідентифікатор ${id}`})},
 // V4 separates command authority from target data: only the UUID is quoted,
 // while the real author still supplies the outside imperative.
 {id:'standalone-quoted-uuid-is-data-after-outside-command',permit:true,input:id=>{const body=`Виконай задачу ${id} зараз`;return {body,entities:[span(body,id)]};}},
 {id:'review-reply-with-conflicting-id',permit:false,input:id=>({body:`${command(different)}. Для довідки ${id}`,review:true})},
 {id:'review-reply-conflicting-id-alone',permit:false,input:()=>({body:command(different),review:true})},
 {id:'review-reply-conflicting-native-code-id',permit:false,input:()=>({body:command(different),entities:[span(command(different),different,'code')],review:true})},
 {id:'review-reply-conflicting-native-pre-id',permit:false,input:()=>({body:command(different),entities:[span(command(different),different,'pre')],review:true})},
 {id:'native-code-current-id-data',permit:true,input:id=>({body:command(id),entities:[span(command(id),id,'code')]})},
 {id:'inline-code-current-id-data',permit:true,input:id=>({body:`Виконай задачу \`${id}\` зараз`})},
 {id:'correct-operative-id-later-other-reference',permit:true,input:id=>({body:`${command(id)}. Для довідки інший ідентифікатор ${different}.`})},
 {id:'target-only-in-later-reference',permit:false,input:id=>({body:`Виконай задачу зараз. Для довідки старий ідентифікатор ${id}.`})},
 {id:'malformed-quote-range',permit:false,input:id=>({body:command(id),entities:[{type:'blockquote',offset:0,length:command(id).length+1}]})},
 // Queue copies are not original-source proof. The captured live source, its
 // body hash, actor, topic and current task/review remain the V4 authority.
 {id:'durable-original-survives-altered-inbox-copy',permit:true,input:id=>({body:'Люмен, '+command(id),mismatch:true})}
];
for(const spec of resumeSpecs)test(`R2 resume actual authored target: ${spec.id}`,async t=>{
 const f=await reviewedLegacyTask(),input=spec.input(f.id),s=await source(input.body,input.entities,{caption:input.caption,review:input.review?f.review:undefined});
 if(input.mismatch){
  const original=(await one(db,'SELECT body,request_context FROM messages WHERE id=$1',[s.id]))!;
  assert.equal(original.body,input.body);assert.ok(original.request_context,'actual received original must retain its validated descriptor');
  await db.query("UPDATE inbox SET payload=jsonb_set(payload,'{message,text}',$2::jsonb) WHERE update_id=$1",[s.updateId,JSON.stringify('Прочитай уривок')]);
  assert.equal((await one(db,"SELECT payload->'message'->>'text' AS text FROM inbox WHERE update_id=$1",[s.updateId]))!.text,'Прочитай уривок');
  assert.deepEqual((await one(db,'SELECT body,request_context FROM messages WHERE id=$1',[s.id]))!,original,'changing a queue copy cannot replace or invalidate the captured original');
 }
 const resumed=await runner.tools.execute('tasks.resume',{id:f.id},c(s.id));assert.equal(resumed.status,'pending');
 const ran=await runner.next();assert.equal(ran,spec.permit);assert.equal(h.brain.calls.length,spec.permit?1:0);
 const task=(await one(db,'SELECT status,step FROM agent_tasks WHERE id=$1',[f.id]))!;if(!spec.permit)assert.equal(task.status,'needs_input');
 const events=(await db.query("SELECT id FROM task_events WHERE task_id=$1 AND kind='recurring_catch_up_resumed'",[f.id])).rows;assert.equal(events.length,spec.permit?1:0);
 if(['native-blockquote','different-operative-id-later-reference','plain-explicit-id','utf16-quote-before-actual-command'].includes(spec.id))t.diagnostic(JSON.stringify({task_id:f.id,original_source_id:f.origin.id,resume_source_id:s.id,body:input.body,entities:input.entities,review_id:f.review.telegram_id,ran,model_calls:h.brain.calls.length,status:task.status}));
});

for(const denial of ['native-quote','wrong-target'] as const)test(`R2 denied ${denial} resume remains available for a later actual current-review instruction`,async()=>{
 const f=await reviewedLegacyTask(),body=command(denial==='wrong-target'?different:f.id),bad=await source(body,denial==='native-quote'?[span(body,body)]:[]);
 await runner.tools.execute('tasks.resume',{id:f.id},c(bad.id));assert.equal(await runner.next(),false);assert.equal(h.brain.calls.length,0);
 assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[f.id]))!.status,'needs_input');
 const good=await source('Продовжуй цю задачу',[],{review:f.review});await runner.tools.execute('tasks.resume',{id:f.id},c(good.id));assert.equal(await runner.next(),true);assert.equal(h.brain.calls.length,1);
 assert.equal((await db.query("SELECT id FROM task_events WHERE task_id=$1 AND kind='recurring_catch_up_resumed'",[f.id])).rows.length,1);
});
for(const closure of ['cancelled','ended','forgotten'] as const)test(`R2 denial recovery does not reopen a truly ${closure} instance`,async()=>{
 const f=await reviewedLegacyTask(),body=command(f.id),bad=await source(body,[span(body,body)]);await runner.tools.execute('tasks.resume',{id:f.id},c(bad.id));await runner.next();
 if(closure==='cancelled')await runner.tools.execute('tasks.cancel',{id:f.id},c(bad.id));
 if(closure==='ended'){
  const series=(await one(db,'SELECT id,version FROM recurring_series'))!,endText=`Скасуй усю серію ${series.id}.`,endSource=await source(endText);
  await new Recurring(db).run(SeriesCommand.parse({operation:'end',id:series.id,version:series.version,quote:endText}),{...c(endSource.id),requestText:endText});
 }
 if(closure==='forgotten')await db.tx(sql=>forgetPhrase(sql,'Щодня привітай учасників'));
 const good=await source('Продовжуй цю задачу',[],{review:f.review}),revision=Number((await one(db,'SELECT memory_revision FROM app_state WHERE id=1'))!.memory_revision);await runner.tools.execute('tasks.resume',{id:f.id},{...c(good.id),revision});assert.equal(await runner.next(),false);assert.equal(h.brain.calls.length,0);
 const task=await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[f.id]);assert.ok(!task||task.status==='cancelled');
});
