import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TestDB,harness,paired,message} from './helpers.js';
import {one,forgetPhrase,queueText} from '../src/db.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {Recurring,SeriesCommand} from '../src/recurring.js';
import {Delivery} from '../src/delivery.js';
import {recordProvenance} from '../src/provenance.js';
import {loadOriginalRequestContext} from '../src/request-context.js';
import type {Plan,Action} from '../src/model.js';
import type {Message,Update} from '../src/telegram.js';
let db:TestDB,h:ReturnType<typeof harness>,runner:AgentTasks,seq=999000;
const plan=(reply:string,actions:Action[]=[]):Plan=>({reply,actions,behavior:{move:'answer',recipient:'bot',relation:'new_request',reason:'Явне авторське доручення'}});
const tool=(name:string,args:unknown):Action=>({kind:'tool',name,arguments:JSON.stringify(args)});
const context=(sourceId:number,revision=0)=>({actorId:'11',chatId:'-100',topicId:'7',revision,sourceId,updateId:String(++seq),requested:true,audience:'group' as const});
before(async()=>{db=new TestDB();await db.init();});after(async()=>db.close());
beforeEach(async()=>{await db.reset();await db.query('DELETE FROM recurring_series');await db.query('DELETE FROM domain_commands');h=harness(db);await paired(h);await db.query('DELETE FROM inbox');await db.query("UPDATE app_state SET mention_only=true,proactive_mode='off'");h.brain.calls.length=0;runner=new AgentTasks(db,h.config,h.brain);});
function incoming(body:string,fields:Partial<Message>={},actor=11,topic=7):Update{const update=message(body,actor);Object.assign(update.message!,{message_thread_id:topic},fields);return update;}
async function finishForeground(update:Update,actions:Action[]=[],reply='Добре, розберу це у фоні.'){
 h.brain.replies=[plan('',actions),plan(reply)];
 await h.lumen.receive(update);
 const source=(await one(db,"SELECT * FROM messages WHERE role='user' AND telegram_id=$1",[update.message!.message_id]))!;assert.ok(source);
 return processReceived(update,Number(source.id));
}
async function processReceived(update:Update,sourceId:number){
 for(let turn=0;turn<6;turn++){const row=await one(db,'SELECT status FROM inbox WHERE update_id=$1',[update.update_id]);if(row?.status==='done')break;assert.equal(await h.lumen.processNext(),true);}
 const inbox=(await one(db,'SELECT status,payload FROM inbox WHERE update_id=$1',[update.update_id]))!;assert.equal(inbox.status,'done');assert.deepEqual(inbox.payload,{});
 return {sourceId,update,inbox,source:(await one(db,'SELECT * FROM messages WHERE id=$1',[sourceId]))!};
}
async function createTask(body:string,fields:Partial<Message>={},goal='Підготуй коротке пояснення цього уривка'){
 const fg=await finishForeground(incoming(body,fields),[tool('tasks.create',{title:'Пояснення уривка',goal,criteria:['response']})]);
 const task=(await one(db,'SELECT * FROM agent_tasks ORDER BY created_at DESC LIMIT 1'))!;assert.ok(task);assert.equal(Number(task.source_message_id),fg.sourceId);return {...fg,task};
}
async function failWorker(taskId:string){
 h.brain.replies=[plan('',[tool('v4.unavailable_tool',{})])];assert.equal(await runner.next(),true);await db.query('UPDATE agent_tasks SET available_at=now() WHERE id=$1',[taskId]);
 h.brain.replies=[plan('Сталася помилка unknown_tool.')];assert.equal(await runner.next(),true);
 const task=(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[taskId]))!;assert.equal(task.status,'needs_input');
 const out=(await one(db,"SELECT * FROM outbox WHERE dedup_key LIKE 'task-result:%' AND body->>'taskId'=$1 ORDER BY id DESC LIMIT 1",[taskId]))!;assert.ok(out);
 assert.equal(out.body.text.includes('unknown_tool'),task.result.includes('unknown_tool'));
 return {task,out,technical:task.result.includes('unknown_tool')};
}
async function resumeTask(taskId:string,body:string,fields:Partial<Message>={},clarification?:string,actor=11,topic=7){
 const fg=await finishForeground(incoming(body,fields,actor,topic),[tool('tasks.resume',{id:taskId,...(clarification?{clarification}:{})})],'Повернуся до цієї задачі.');
 const run=(await one(db,"SELECT * FROM tool_runs WHERE tool='tasks.resume' AND source_message_id=$1 ORDER BY id DESC LIMIT 1",[fg.sourceId]))!;
 return {...fg,run};
}
async function reviewedTask(audience:'group'|'private'='group',beforeReview?:(f:{taskId:string;sourceId:number;scheduleId:string})=>Promise<void>,deliverReview=true){
 const origin=await finishForeground(incoming('Люмен, щодня привітай учасників'),[],'Домовились.');
 const series=new Recurring(db),draft=await series.run(SeriesCommand.parse({operation:'preview',rule:{title:'Щоденне привітання',instruction:'Коротко привітай учасників',mode:'task',timezone:'UTC',start_date:new Date(Date.now()+86400000).toISOString().slice(0,10),time:'00:00',frequency:'daily',catch_up:'ask'}}),{...context(origin.sourceId),audience});
 await series.run(SeriesCommand.parse({operation:'confirm',id:draft.id,version:1}),{...context(origin.sourceId),audience});await series.tick();
 const occurrence=(await one(db,'SELECT * FROM recurring_occurrences WHERE series_id=$1 AND schedule_id IS NOT NULL ORDER BY due_at LIMIT 1',[draft.id]))!;
 await db.query("UPDATE scheduled_actions SET due_at=now()-interval '2 hours' WHERE id=$1",[occurrence.schedule_id]);await db.query("UPDATE recurring_occurrences SET due_at=now()-interval '2 hours' WHERE schedule_id=$1",[occurrence.schedule_id]);
 const taskId=randomUUID();await db.query("INSERT INTO agent_tasks(id,dedup_key,actor_id,topic_id,title,goal,revision,source_message_id,audience) VALUES($1,$2,'11','7','V2 queued greeting','Коротко привітай учасників',0,$3,$4)",[taskId,'scheduled-task:'+occurrence.schedule_id,origin.sourceId,audience]);await db.query("UPDATE scheduled_actions SET status='dispatched',task_id=$2 WHERE id=$1",[occurrence.schedule_id,taskId]);await db.tx(sql=>recordProvenance(sql,'task',taskId,[origin.sourceId]));
 if(beforeReview)await beforeReview({taskId,sourceId:origin.sourceId,scheduleId:occurrence.schedule_id});
 const count=h.brain.calls.length;assert.equal(await runner.next(),false);assert.equal(h.brain.calls.length,count);
 if(deliverReview){const delivery=new Delivery(db,h.tg as any,h.config);for(let turn=0;turn<12;turn++){const row=await one(db,"SELECT status FROM outbox WHERE dedup_key LIKE 'series-review:%'");if(row?.status==='sent')break;await delivery.next();}}
 const review=(await one(db,"SELECT * FROM outbox WHERE dedup_key LIKE 'series-review:%'"))!;assert.equal(review.status,deliverReview?'sent':'pending');if(deliverReview)assert.ok(review.body.deliveryReceipt);
 return {origin,taskId,review,seriesId:draft.id,scheduleId:occurrence.schedule_id,occurrence};
}
const reply=(review:any):Message['reply_to_message']=>({message_id:Number(review.telegram_id),from:{id:999,is_bot:true,first_name:'Люмен'},date:0,chat:{id:-100,type:'supergroup'},text:review.body.text});
async function claim(f:Awaited<ReturnType<typeof reviewedTask>>,permit:boolean){
 const calls=h.brain.calls.length;h.brain.replies=[plan('Привіт усім учасникам.')];assert.equal(await runner.next(),permit);assert.equal(h.brain.calls.length-calls,permit?1:0);
 assert.equal((await db.query("SELECT id FROM task_events WHERE task_id=$1 AND kind='recurring_catch_up_resumed'",[f.taskId])).rows.length,permit?1:0);
 if(permit){assert.equal(await runner.next(),false);assert.equal(h.brain.calls.length-calls,1);}else assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[f.taskId]))?.status,'needs_input');
}

const diagnostic='Покажи код помилки',body='Люмен, підготуй коротке пояснення цього уривка у фоні.\n'+diagnostic;
for(const quoted of [true,false])test(`V4 full Engine diagnostic after empty inbox: ${quoted?'native quote stays human':'explicit request retains known code'}`,async t=>{
 const fields=quoted?{entities:[{type:'blockquote',offset:body.indexOf(diagnostic),length:diagnostic.length}]}:{};
 const f=await createTask(body,fields);assert.ok(f.source.request_context);const result=await failWorker(f.task.id);assert.equal(result.technical,!quoted);assert.equal(result.out.body.text.includes('unknown_tool'),!quoted);
 t.diagnostic(JSON.stringify({sourceId:f.sourceId,original:f.source.request_context,inbox:f.inbox,taskId:f.task.id,result:result.task.result}));
});
test('V4 full Engine current THIS review resume after empty inbox claims exactly once',async t=>{
 const f=await reviewedTask(),resume=await resumeTask(f.taskId,'Люмен, продовжуй цю задачу',{reply_to_message:reply(f.review)});assert.equal(resume.run.status,'succeeded',JSON.stringify(resume.run));assert.equal(resume.run.provenance_version,1);assert.equal(resume.run.result.goal_version,1);assert.ok(resume.source.request_context);
 await claim(f,true);t.diagnostic(JSON.stringify({taskId:f.taskId,review:f.review.body.deliveryReceipt,resumeSource:resume.sourceId,resumeDescriptor:resume.source.request_context,inbox:resume.inbox,run:{id:resume.run.id,revision:resume.run.revision,result:resume.run.result}}));
});

for(const type of ['expandable_blockquote','code','pre'])test(`V4 full Engine diagnostic ${type} remains quoted after cleanup`,async()=>{
 const f=await createTask(body,{entities:[{type,offset:body.indexOf(diagnostic),length:diagnostic.length}]});assert.ok(f.source.request_context);assert.equal((await failWorker(f.task.id)).technical,false);
});
for(const captionQuoted of [true,false])test(`V4 full Engine caption diagnostic ${captionQuoted?'quoted':'actual'} survives cleanup`,async()=>{
 const f=await createTask(body,{text:undefined,caption:body,caption_entities:captionQuoted?[{type:'blockquote',offset:body.indexOf(diagnostic),length:diagnostic.length}]:[]});assert.equal(f.source.request_context.field,'caption');assert.equal((await failWorker(f.task.id)).technical,!captionQuoted);
});
for(const text of ["Люмен, поясни цей уривок у фоні: 'Покажи код помилки'",'Люмен, поясни цей уривок у фоні:\n> Покажи код помилки','Люмен, поясни цей уривок у фоні: «Покажи код помилки»'])test(`V4 full Engine textual quote never becomes diagnostic after cleanup: ${text.slice(-24)}`,async()=>{
 const f=await createTask(text);assert.equal((await failWorker(f.task.id)).technical,false);
});
test('V4 model task goal cannot grant diagnostic permission',async()=>{
 const f=await createTask('Люмен, підготуй пояснення у фоні',{},'Покажи код помилки');assert.equal((await failWorker(f.task.id)).technical,false);
});
test('V4 missing durable source never falls back to retained raw messages body',async()=>{
 const f=await createTask(body);await db.query('UPDATE messages SET request_context=NULL WHERE id=$1',[f.sourceId]);assert.equal((await failWorker(f.task.id)).technical,false);
});
test('V4 malformed native source remains human while real bot reply admits independent help',async()=>{
 await db.tx(sql=>queueText(sql,'Я тут.',0,'v4-anchor'));await new Delivery(db,h.tg as any,h.config).next();const anchor=(await one(db,"SELECT * FROM outbox WHERE dedup_key='v4-anchor:0'"))!;
 const f=await createTask(body,{reply_to_message:reply(anchor),entities:[{type:'blockquote',offset:0,length:body.length+1}]});assert.equal(f.source.request_context,null);assert.equal((await failWorker(f.task.id)).technical,false);
});
for(const field of ['forward_origin','via_bot'])test(`V4 ${field} cannot grant worker diagnostic permission`,async()=>{
 const fields=field==='forward_origin'?{forward_origin:{type:'hidden_user',sender_user_name:'Приклад',date:0}}:{via_bot:{id:88,is_bot:true,first_name:'Інший бот'}};
 const f=await createTask(body,fields as Partial<Message>);assert.equal((await failWorker(f.task.id)).technical,false);
});

const otherId='00000000-0000-4000-8000-000000000077',execute=(id:string)=>`Люмен, виконай задачу ${id} зараз`;
for(const type of ['blockquote','expandable_blockquote','code','pre'])test(`V4 full Engine quoted ${type} resume cannot execute after cleanup`,async()=>{
 const f=await reviewedTask(),text=execute(f.taskId),resumed=await resumeTask(f.taskId,text,{reply_to_message:reply(f.review),entities:[{type,offset:0,length:text.length}]});assert.equal(resumed.run.status,'succeeded');await claim(f,false);
});
for(const kind of ['different-id','conversation','another-task','stale-reply','old-message','forward','malformed','unknown-context'])test(`V4 full Engine resume ${kind} stays reviewable without effects`,async()=>{
 const f=await reviewedTask();let text='Люмен, продовжуй цю задачу',fields:Partial<Message>={reply_to_message:reply(f.review)};
 if(kind==='different-id')text=execute(otherId)+'. Для довідки старий ідентифікатор '+f.taskId+'.';
 if(kind==='conversation')text='Люмен, продовжуй розмову.';
 if(kind==='another-task')text='Люмен, виконай іншу задачу.';
 if(kind==='stale-reply')fields.reply_to_message={...reply(f.review)!,message_id:Number(f.review.telegram_id)+5};
 if(kind==='old-message')fields.date=Math.floor((Date.now()-7200000)/1000);
 if(kind==='forward')(fields as any).is_automatic_forward=true;
 if(kind==='malformed')fields.entities=[{type:'blockquote',offset:0,length:text.length+1}];
 const resumed=await resumeTask(f.taskId,text,fields);assert.equal(resumed.run.status,'succeeded');if(kind==='unknown-context')await db.query('UPDATE messages SET request_context=NULL WHERE id=$1',[resumed.sourceId]);
 await claim(f,false);
});
for(const actor of [11,22])test(`V4 actual Engine resume scope actor ${actor} on ${actor===11?'other topic':'same topic'} does not select another task`,async()=>{
 const f=await reviewedTask();await resumeTask(f.taskId,execute(f.taskId),{reply_to_message:reply(f.review)},undefined,actor,actor===11?8:7);await claim(f,false);
});
test('V4 full Engine standalone code UUID is data after an actual outside command',async()=>{
 const f=await reviewedTask(),text=execute(f.taskId);await resumeTask(f.taskId,text,{entities:[{type:'code',offset:text.indexOf(f.taskId),length:f.taskId.length}]});await claim(f,true);
});
test('V4 private recurring task keeps its private audience after actual group UUID resume',async()=>{
 const f=await reviewedTask('private');assert.equal(f.review.body.deliveryReceipt.destination_chat_id,'11');await resumeTask(f.taskId,execute(f.taskId));await claim(f,true);assert.equal((await one(db,'SELECT audience FROM agent_tasks WHERE id=$1',[f.taskId]))!.audience,'private');
});
test('V4 wrong quoted resume remains recoverable by a later full Engine current-review reply',async()=>{
 const f=await reviewedTask(),text=execute(f.taskId);await resumeTask(f.taskId,text,{reply_to_message:reply(f.review),entities:[{type:'blockquote',offset:0,length:text.length}]});await claim(f,false);
 await resumeTask(f.taskId,'Люмен, продовжуй цю задачу',{reply_to_message:reply(f.review)});await claim(f,true);
});
test('V4 original DB receipt time rejects a message admitted before the review, despite later processing',async()=>{
 let pending:{update:Update;sourceId:number}|undefined;
 const f=await reviewedTask('group',async task=>{const update=incoming(execute(task.taskId));await h.lumen.receive(update);pending={update,sourceId:Number((await one(db,"SELECT id FROM messages WHERE telegram_id=$1 AND role='user'",[update.message!.message_id]))!.id)};});
 h.brain.replies=[plan('',[tool('tasks.resume',{id:f.taskId})]),plan('Продовжу.')];await processReceived(pending!.update,pending!.sourceId);await claim(f,false);
});
test('V4 full Engine resume receipt and original context survive unrelated forget revision',async t=>{
 const f=await reviewedTask(),resumed=await resumeTask(f.taskId,'Люмен, продовжуй цю задачу',{reply_to_message:reply(f.review)});assert.equal(resumed.run.provenance_version,1);
 await finishForeground(incoming('Люмен, забудемо потім маркер НезалежнийV4'),[],'Почув.');await db.tx(sql=>forgetPhrase(sql,'НезалежнийV4'));
 const task=(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[f.taskId]))!,run=(await one(db,'SELECT * FROM tool_runs WHERE id=$1',[resumed.run.id]))!;assert.equal(task.revision,1);assert.equal(run.status,'succeeded');assert.equal(run.revision,0);assert.equal(run.result.goal_version,task.goal_version);
 const source=await loadOriginalRequestContext(db,{sourceId:resumed.sourceId,actorId:'11',topicId:'7',namespaceChatId:'-100',audience:'group',revision:1});assert.equal(source!.receivedAt.toISOString(),resumed.source.request_context.received_at);await claim(f,true);
 t.diagnostic(JSON.stringify({taskId:f.taskId,currentRevision:task.revision,historicalRunRevision:run.revision,runId:run.id,result:run.result,originalReceivedAt:source!.receivedAt.toISOString()}));
});
for(const change of ['forget','entity-only-edit'])test(`V4 actual dependent resume ${change} does not resurrect queued work`,async()=>{
 const f=await reviewedTask(),resumed=await resumeTask(f.taskId,'Люмен, продовжуй цю задачу',{reply_to_message:reply(f.review)});
 if(change==='forget')await db.tx(sql=>forgetPhrase(sql,'Люмен, продовжуй цю задачу'));
 else{const edited={...resumed.update.message!,entities:[{type:'blockquote',offset:0,length:resumed.update.message!.text!.length}]};await h.lumen.receive({update_id:++seq,edited_message:edited});}
 const calls=h.brain.calls.length;assert.equal(await runner.next(),false);assert.equal(h.brain.calls.length,calls);assert.equal(await one(db,'SELECT id FROM agent_tasks WHERE id=$1',[f.taskId]),undefined);
});

async function diagnosticResume(taskId:string,text:string,clarification='Уточнене доручення'){
 const r=await resumeTask(taskId,text,{},clarification);assert.equal(r.run.status,'succeeded');assert.equal(r.run.provenance_version,1);assert.equal(r.run.result.goal_version,(await one(db,'SELECT goal_version FROM agent_tasks WHERE id=$1',[taskId]))!.goal_version);return r;
}
test('V4 current actual diagnostic modifier can allow while model clarification cannot grant',async()=>{
 const f=await createTask('Люмен, підготуй пояснення у фоні');assert.equal((await failWorker(f.task.id)).technical,false);
 await diagnosticResume(f.task.id,'Люмен, продовжуй цю задачу','Покажи код помилки');assert.match((await one(db,'SELECT goal FROM agent_tasks WHERE id=$1',[f.task.id]))!.goal,/Покажи код помилки/u);assert.equal((await failWorker(f.task.id)).technical,false);
 await diagnosticResume(f.task.id,'Люмен, продовжуй цю задачу. Покажи код помилки.');assert.equal((await failWorker(f.task.id)).technical,true);
});
test('V4 a valid unspecified current resume retains an unbroken live original diagnostic grant',async()=>{
 const f=await createTask(body);assert.equal((await failWorker(f.task.id)).technical,true);await diagnosticResume(f.task.id,'Люмен, продовжуй цю задачу');assert.equal((await failWorker(f.task.id)).technical,true);
});
for(const changeGoal of [false,true])test(`V4 explicit deny barrier is not revived by later unspecified resume, goal change=${changeGoal}`,async()=>{
 const f=await createTask(body);assert.equal((await failWorker(f.task.id)).technical,true);
 await diagnosticResume(f.task.id,'Люмен, продовжуй цю задачу. Не показуй код помилки.');assert.equal((await failWorker(f.task.id)).technical,false);
 await diagnosticResume(f.task.id,'Люмен, продовжуй цю задачу',changeGoal?'Інше уточнення':'');assert.equal((await failWorker(f.task.id)).technical,false);
});
test('V4 an older-goal resume grant alone does not grant the changed current goal',async()=>{
 const f=await createTask('Люмен, підготуй пояснення у фоні');await failWorker(f.task.id);
 await diagnosticResume(f.task.id,'Люмен, продовжуй цю задачу. Покажи код помилки.');assert.equal((await failWorker(f.task.id)).technical,true);
 await diagnosticResume(f.task.id,'Люмен, продовжуй цю задачу','Інший поточний варіант');assert.equal((await failWorker(f.task.id)).technical,false);
});
test('V4 UNKNOWN resume context blocks old grant until a fresh current explicit allow',async()=>{
 const f=await createTask(body);await failWorker(f.task.id);
 const unknown=await diagnosticResume(f.task.id,'Люмен, продовжуй цю задачу');await db.query('UPDATE messages SET request_context=NULL WHERE id=$1',[unknown.sourceId]);assert.equal((await failWorker(f.task.id)).technical,false);
 await diagnosticResume(f.task.id,'Люмен, продовжуй цю задачу','Ще одне уточнення');assert.equal((await failWorker(f.task.id)).technical,false);
 await diagnosticResume(f.task.id,'Люмен, продовжуй цю задачу. Покажи код помилки.');assert.equal((await failWorker(f.task.id)).technical,true);
});
test('V4 a wrong returned resume goal version cannot claim the reviewed instance',async()=>{
 const f=await reviewedTask(),r=await resumeTask(f.taskId,'Люмен, продовжуй цю задачу',{reply_to_message:reply(f.review)});await db.query("UPDATE tool_runs SET result=jsonb_set(result,'{goal_version}','2'::jsonb) WHERE id=$1",[r.run.id]);await claim(f,false);
 await resumeTask(f.taskId,'Люмен, продовжуй цю задачу',{reply_to_message:reply(f.review)});await claim(f,true);
});
test('V4 a truncated verified receipt history blocks original grant until a fresh current allow',async()=>{
 const f=await createTask(body);await failWorker(f.task.id);const r=await diagnosticResume(f.task.id,'Люмен, продовжуй цю задачу');
 // Bounded storage fault/control: copy one real Engine receipt, not invented
 // permission or synthetic ingress. Every clone retains its actual live source.
 const copies=(await db.query("INSERT INTO tool_runs(dedup_key,actor_id,tool,arguments,result,status,revision,source_message_id,created_at,finished_at,provenance_version,goal_version,effectful) SELECT 'v4-history:'||g.n,$2,'tasks.resume',arguments,result,status,revision,source_message_id,created_at,finished_at,provenance_version,goal_version,effectful FROM tool_runs CROSS JOIN generate_series(1,65) g(n) WHERE id=$1 RETURNING id",[r.run.id,'11'])).rows;
 for(const copy of copies)await db.tx(sql=>recordProvenance(sql,'tool_run',copy.id,[r.sourceId]));
 assert.equal((await failWorker(f.task.id)).technical,false);await diagnosticResume(f.task.id,'Люмен, продовжуй цю задачу. Покажи код помилки.');assert.equal((await failWorker(f.task.id)).technical,true);
});
for(const mode of ['explicit','quoted','wrong-target','old-message'])test(`V4 full Engine ${mode} exact-UUID request before notice delivery`,async()=>{
 const f=await reviewedTask('group',undefined,false),text=execute(mode==='wrong-target'?otherId:f.taskId),fields:Partial<Message>={};
 if(mode==='quoted')fields.entities=[{type:'blockquote',offset:7,length:text.length-7}];
 if(mode==='old-message')fields.date=Math.floor((Date.now()-7200000)/1000);
 await resumeTask(f.taskId,text,fields);await claim(f,mode==='explicit');assert.equal((await one(db,'SELECT status FROM outbox WHERE id=$1',[f.review.id]))!.status,'pending');
});
