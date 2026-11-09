import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {TestDB,harness,paired,message} from './helpers.js';
import {one,forgetPhrase} from '../src/db.js';
import {Recurring,SeriesCommand,SeriesRule,occurrences} from '../src/recurring.js';
import {ScheduleSchema,saveSchedule,dispatchSchedules} from '../src/scheduling.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {Delivery} from '../src/delivery.js';
import {allowRecurringTaskClaim} from '../src/recurrence-policy.js';
import {recordProvenance} from '../src/provenance.js';
import {captureOriginalRequestContext} from '../src/request-context.js';
import type {ToolContext} from '../src/agent-tools.js';

let db:TestDB,h:ReturnType<typeof harness>,n=880000;
before(async()=>{db=new TestDB();await db.init();});
after(async()=>db.close());
beforeEach(async()=>{await db.reset();await db.query('DELETE FROM recurring_series');await db.query('DELETE FROM domain_commands');h=harness(db);await paired(h);});
const c=(sourceId:number,audience:'group'|'private'='group'):ToolContext=>({actorId:'11',chatId:'-100',topicId:'7',revision:0,sourceId,updateId:String(++n),requested:true,audience});
async function source(body='Перевіряй наш звіт щодня'){
 const telegramId=++n,id=Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,topic_id,body) VALUES($1,'11','А','user','7',$2) RETURNING id",[telegramId,body])).rows[0]!.id);
 assert.ok(await db.tx(sql=>captureOriginalRequestContext(sql,id,{message_id:telegramId,date:Math.floor(Date.now()/1000),from:{id:11,first_name:'А'},chat:{id:-100,type:'supergroup'},message_thread_id:7,text:body},{namespaceChatId:'-100',sourceTopicId:'7'})));
 return id;
}
async function actualSource(body:string,review?:any){
 const update=message(body);update.message!.message_thread_id=7;
 if(review)update.message!.reply_to_message={message_id:Number(review.telegram_id),from:{id:999,is_bot:true,first_name:'Люмен'},date:0,chat:{id:-100,type:'supergroup'},text:review.body.text};
 await h.lumen.receive(update);return Number((await one(db,"SELECT id FROM messages WHERE role='user' AND telegram_id=$1",[update.message!.message_id]))!.id);
}
async function fixture(mode:'task'|'reminder'='task',catch_up?:'ask'|'skip'|'latest',audience:'group'|'private'='group'){
 const sourceId=await source(),series=new Recurring(db);
 const draft=await series.run(SeriesCommand.parse({operation:'preview',rule:{title:'Щоденне привітання',instruction:'Скажи привіт учасникам',mode,timezone:'UTC',start_date:new Date(Date.now()+86400000).toISOString().slice(0,10),time:'00:00',frequency:'daily',catch_up}}),c(sourceId,audience));
 await series.run(SeriesCommand.parse({operation:'confirm',id:draft.id,version:1}),c(sourceId,audience));await series.tick();
 const occurrence=(await db.query('SELECT * FROM recurring_occurrences WHERE series_id=$1 AND schedule_id IS NOT NULL ORDER BY due_at',[draft.id])).rows[0]!;
 assert.ok(occurrence?.schedule_id,'the real series worker materialized an action');
 return {id:draft.id,sourceId,occurrence,scheduleId:occurrence.schedule_id as string,audience};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function shift(id:string,interval='2 hours'){
 await db.query('UPDATE scheduled_actions SET due_at=now()-$2::interval WHERE id=$1',[id,interval]);
 await db.query('UPDATE recurring_occurrences SET due_at=now()-$2::interval WHERE schedule_id=$1',[id,interval]);
}
async function notices(){return (await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'series-review:%'")).rows;}
async function assertReview(f:Fixture){
 const action=await one(db,'SELECT * FROM scheduled_actions WHERE id=$1',[f.scheduleId]);
 assert.equal(action!.status,'needs_input');assert.equal(action!.task_id,null);
 assert.equal((await one(db,'SELECT status FROM recurring_occurrences WHERE schedule_id=$1',[f.scheduleId]))!.status,'needs_input');
 assert.equal((await db.query('SELECT id FROM agent_tasks')).rows.length,0);
 const rows=await notices();assert.equal(rows.length,1);
 assert.equal(rows[0]!.actor_id,'11');assert.equal(rows[0]!.audience,f.audience);assert.equal(rows[0]!.revision,0);
 assert.equal(Number(rows[0]!.source_message_id),f.sourceId);assert.equal(rows[0]!.body.threadId,7);
 assert.deepEqual((await db.query("SELECT source_message_id FROM provenance_edges WHERE derived_kind='outbox' AND derived_key=$1",[String(rows[0]!.id)])).rows.map(x=>Number(x.source_message_id)),[f.sourceId]);
}

for(const order of ['delivery-first','series-first','concurrent'] as const)test(`overdue ask task requires one scoped review in ${order} lane order`,async()=>{
 const f=await fixture('task','ask');await shift(f.scheduleId);const restarted=new Recurring(db);
 if(order==='delivery-first'){await h.lumen.scheduleDue();assert.equal(await dispatchSchedules(db),0);await restarted.tick();}
 else if(order==='series-first'){await restarted.tick();await h.lumen.scheduleDue();assert.equal(await dispatchSchedules(db),0);}
 else await Promise.all([h.lumen.scheduleDue(),restarted.tick()]);
 await assertReview(f);assert.equal(await dispatchSchedules(db),0);await new Recurring(db).tick();await assertReview(f);
 const delivery=new Delivery(db,h.tg as any,h.config);assert.equal(await delivery.next(),true);assert.equal(await delivery.next(),false);
 assert.equal(h.tg.sent.length,1);assert.equal(h.tg.sent[0]!.chatId,'-100');assert.equal(h.tg.options[0]!.threadId,7);
 assert.equal((await notices())[0]!.status,'sent');assert.ok((await notices())[0]!.telegram_id);
});

for(const mode of ['task','reminder'] as const)for(const order of ['delivery-first','series-first'] as const)test(`explicit skip cancels ${mode} catch-up in ${order}`,async()=>{
 const f=await fixture(mode,'skip');await shift(f.scheduleId);
 if(order==='series-first')await new Recurring(db).tick();
 assert.equal(await dispatchSchedules(db),0);if(order==='delivery-first')await new Recurring(db).tick();
 assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[f.scheduleId]))!.status,'cancelled');
 assert.equal((await one(db,'SELECT status FROM recurring_occurrences WHERE schedule_id=$1',[f.scheduleId]))!.status,'missed');
 assert.equal((await notices()).length,0);assert.equal((await db.query('SELECT id FROM agent_tasks')).rows.length,0);
});

for(const order of ['delivery-first','series-first'] as const)test(`latest reminders coalesce two materialized missed occurrences and deliver once in ${order}`,async()=>{
 const f=await fixture('reminder');
 const other=(await db.query("SELECT * FROM recurring_occurrences WHERE series_id=$1 AND schedule_id IS NULL AND status='pending' ORDER BY due_at LIMIT 1",[f.id])).rows[0]!;
 await db.query("UPDATE recurring_occurrences SET due_at=now()+interval '1 hour' WHERE series_id=$1 AND occurrence_key=$2",[f.id,other.occurrence_key]);
 await new Recurring(db).tick();
 const second=(await one(db,'SELECT schedule_id FROM recurring_occurrences WHERE series_id=$1 AND occurrence_key=$2',[f.id,other.occurrence_key]))!.schedule_id;
 assert.ok(second);await shift(f.scheduleId,'3 hours');await shift(second,'2 hours');if(order==='series-first')await new Recurring(db).tick();
 assert.equal(await dispatchSchedules(db),1);assert.equal(await dispatchSchedules(db),0);
 assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[f.scheduleId]))!.status,'cancelled');
 const queued=(await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'scheduled:%'")).rows;assert.equal(queued.length,1);
 assert.match(queued[0]!.body.text,/2 повторів об’єднано/);assert.equal(queued[0]!.actor_id,'11');assert.equal(queued[0]!.body.threadId,7);assert.equal(Number(queued[0]!.source_message_id),f.sourceId);
 const delivery=new Delivery(db,h.tg as any,h.config);assert.equal(await delivery.next(),true);assert.equal(await delivery.next(),false);
 assert.equal(h.tg.sent.length,1);assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[second]))!.status,'completed');
});

test('task latest keeps the established ask policy after the one-hour grace',async()=>{
 const f=await fixture('task','latest');await shift(f.scheduleId);assert.equal(await dispatchSchedules(db),0);await assertReview(f);
});
test('a normal recurring task inside grace dispatches and reaches the actual worker',async()=>{
 const f=await fixture('task','ask');assert.equal(await dispatchSchedules(db),0);await shift(f.scheduleId,'45 minutes');
 assert.equal(await dispatchSchedules(db),1);assert.equal(await dispatchSchedules(db),0);
 const task=await one(db,'SELECT * FROM agent_tasks');assert.equal(task!.actor_id,'11');assert.equal(task!.topic_id,'7');assert.equal(task!.revision,0);assert.equal(Number(task!.source_message_id),f.sourceId);
 assert.deepEqual((await db.query("SELECT source_message_id FROM provenance_edges WHERE derived_kind='task' AND derived_key=$1",[task!.id])).rows.map(x=>Number(x.source_message_id)),[f.sourceId]);
 assert.equal(await new AgentTasks(db,h.config,h.brain).next(),true);assert.equal(h.brain.calls.length,1);assert.equal((await notices()).length,0);
});

for(const mode of ['reminder','task'] as const)test(`private recurring ${mode} preserves its audience through dispatch`,async()=>{
 const f=await fixture(mode,'ask','private');await shift(f.scheduleId,'10 minutes');assert.equal(await dispatchSchedules(db),1);
 if(mode==='task')assert.equal((await one(db,'SELECT audience FROM agent_tasks'))!.audience,'private');
 else{
  const out=await one(db,"SELECT * FROM outbox WHERE dedup_key LIKE 'scheduled:%'");assert.equal(out!.audience,'private');
  await new Delivery(db,h.tg as any,h.config).next();assert.equal(h.tg.sent.length,1);assert.equal(h.tg.sent[0]!.chatId,'11');assert.equal(h.tg.options[0]!.threadId,undefined);
 }
});
test('private catch-up review is delivered only to its author',async()=>{
 const f=await fixture('task','ask','private');await shift(f.scheduleId);await dispatchSchedules(db);await assertReview(f);
 await new Delivery(db,h.tg as any,h.config).next();assert.equal(h.tg.sent.length,1);assert.equal(h.tg.sent[0]!.chatId,'11');assert.equal(h.tg.options[0]!.threadId,undefined);
});

// This fixture reproduces V2's exact queued state without importing an archive.
// The before-repair probe separately executed the frozen V2 dispatcher itself.
async function legacyQueue(f:Fixture){
 const id=randomUUID();await db.query("INSERT INTO agent_tasks(id,dedup_key,actor_id,topic_id,title,goal,revision,source_message_id,audience) VALUES($1,$2,'11','7','Щоденне привітання','Скажи привіт учасникам',0,$3,'group')",[id,'scheduled-task:'+f.scheduleId,f.sourceId]);
 await db.query("UPDATE scheduled_actions SET status='dispatched',task_id=$2 WHERE id=$1",[f.scheduleId,id]);
 await db.tx(sql=>recordProvenance(sql,'task',id,[f.sourceId]));return id;
}
for(const policy of ['ask','skip'] as const)test(`legacy unstarted ${policy} task cannot bypass policy at execution claim`,async()=>{
 const f=await fixture('task',policy);await shift(f.scheduleId);const taskId=await legacyQueue(f);
 assert.equal(await new AgentTasks(db,h.config,h.brain).next(),false);assert.equal(h.brain.calls.length,0);
 const task=await one(db,'SELECT status,error_code FROM agent_tasks WHERE id=$1',[taskId]);assert.equal(task!.status,policy==='ask'?'needs_input':'cancelled');
 assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[f.scheduleId]))!.status,policy==='ask'?'needs_input':'cancelled');
 assert.equal((await notices()).length,policy==='ask'?1:0);await dispatchSchedules(db);await new Recurring(db).tick();assert.equal((await notices()).length,policy==='ask'?1:0);
});
test('legacy queued task inside grace still starts and inherits private audience',async()=>{
 const f=await fixture('task','ask','private');await shift(f.scheduleId,'20 minutes');const taskId=await legacyQueue(f);
 assert.equal(await new AgentTasks(db,h.config,h.brain).next(),true);assert.equal(h.brain.calls.length,1);assert.equal((await one(db,'SELECT audience FROM agent_tasks WHERE id=$1',[taskId]))!.audience,'private');
});
for(const started of ['step','running-event','tool-run','approval'] as const)test(`catch-up fence leaves already begun ${started} execution semantics intact`,async()=>{
 const f=await fixture('task','ask');await shift(f.scheduleId);const taskId=await legacyQueue(f);
 if(started==='step')await db.query('UPDATE agent_tasks SET step=1 WHERE id=$1',[taskId]);
 if(started==='running-event')await db.query("INSERT INTO task_events(task_id,goal_version,kind) VALUES($1,1,'running')",[taskId]);
 if(started==='tool-run')await db.query("INSERT INTO tool_runs(dedup_key,task_id,actor_id,tool,arguments,result,status,revision) VALUES($1,$2,'11','external.test','{}','{\"provider_receipt\":\"existing-proof\"}','succeeded',0)",[String(++n),taskId]);
 if(started==='approval')await db.query("INSERT INTO tool_approvals(id,task_id,actor_id,topic_id,tool,arguments,argument_hash,summary,status,revision) VALUES($1,$2,'11','7','external.test','{}','existing-hash','Погоджена дія','approved',0)",[randomUUID(),taskId]);
 const allowed=await db.tx(async sql=>{await sql.query('SELECT id FROM app_state WHERE id=1 FOR UPDATE');const task=await one(sql,'SELECT * FROM agent_tasks WHERE id=$1 FOR UPDATE',[taskId]);return allowRecurringTaskClaim(sql,task,0);});
 assert.equal(allowed,true);assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[taskId]))!.status,'pending');assert.equal((await notices()).length,0);
 if(started==='tool-run')assert.equal((await one(db,'SELECT status,result FROM tool_runs WHERE task_id=$1',[taskId]))!.result.provider_receipt,'existing-proof');
 if(started==='approval')assert.equal((await one(db,'SELECT status FROM tool_approvals WHERE task_id=$1',[taskId]))!.status,'approved');
});
test('moving a legacy reviewed occurrence creates a fresh future run without a review loop',async()=>{
 const f=await fixture('task','ask');await shift(f.scheduleId);await legacyQueue(f);await new AgentTasks(db,h.config,h.brain).next();
 const moveTo=new Date(Date.now()+7200000).toISOString();await new Recurring(db).run(SeriesCommand.parse({operation:'move',id:f.id,version:2,occurrence_key:f.occurrence.occurrence_key,move_to:moveTo}),c(f.sourceId));
 await new Recurring(db).tick();const moved=await one(db,'SELECT * FROM recurring_occurrences WHERE series_id=$1 AND occurrence_key=$2',[f.id,f.occurrence.occurrence_key]);
 assert.equal(moved!.status,'scheduled');assert.notEqual(moved!.schedule_id,f.scheduleId);assert.equal(new Date(moved!.due_at).toISOString(),moveTo);
 await shift(moved!.schedule_id,'5 minutes');assert.equal(await dispatchSchedules(db),1);
 assert.equal(await new AgentTasks(db,h.config,h.brain).next(),true);assert.equal(h.brain.calls.length,1);assert.equal((await notices()).length,1);
});
test('a new source-bound resume with an explicit task ID authorizes the reviewed legacy run once',async()=>{
 const f=await fixture('task','ask','private');await shift(f.scheduleId);const taskId=await legacyQueue(f),runner=new AgentTasks(db,h.config,h.brain);
 assert.equal(await runner.next(),false);assert.equal(h.brain.calls.length,0);
 const resumeSource=await actualSource(`Виконай пропущену задачу ${taskId} зараз`);
 const resumed=await runner.tools.execute('tasks.resume',{id:taskId},c(resumeSource,'private'));assert.equal(resumed.status,'pending');
 // The other lane may wake between the new instruction and the task claim.
 await dispatchSchedules(db);await new Recurring(db).tick();assert.equal(await runner.next(),true);assert.equal(h.brain.calls.length,1);
 await dispatchSchedules(db);await new Recurring(db).tick();assert.equal((await notices()).length,1);
 assert.equal((await db.query("SELECT id FROM task_events WHERE task_id=$1 AND kind='recurring_catch_up_resumed'",[taskId])).rows.length,1);
 const edges=(await db.query("SELECT source_message_id FROM provenance_edges WHERE derived_kind='task' AND derived_key=$1 ORDER BY source_message_id",[taskId])).rows.map(x=>Number(x.source_message_id));assert.deepEqual(edges,[f.sourceId,resumeSource]);
 assert.equal((await one(db,'SELECT audience FROM agent_tasks WHERE id=$1',[taskId]))!.audience,'private');
});
test('a natural continue reply on the current delivered review authorizes only that run',async()=>{
 const f=await fixture();await shift(f.scheduleId);const taskId=await legacyQueue(f),runner=new AgentTasks(db,h.config,h.brain);await runner.next();
 await new Delivery(db,h.tg as any,h.config).next();const review=(await notices())[0]!;
 const resumeSource=await actualSource('Продовжуй цю задачу',review);await runner.tools.execute('tasks.resume',{id:taskId},c(resumeSource));
 assert.equal(await runner.next(),true);assert.equal(h.brain.calls.length,1);assert.equal((await notices()).length,1);
});
test('a model-selected resume during an unrelated new user turn cannot authorize a missed run',async()=>{
 const f=await fixture();await shift(f.scheduleId);const taskId=await legacyQueue(f),runner=new AgentTasks(db,h.config,h.brain);await runner.next();
 const resumeSource=await actualSource('Сьогодні гарна погода');await runner.tools.execute('tasks.resume',{id:taskId},c(resumeSource));
 assert.equal(await runner.next(),false);assert.equal(h.brain.calls.length,0);assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[taskId]))!.status,'needs_input');
});
test('a reply to an old occurrence version review cannot approve the moved overdue run',async()=>{
 const f=await fixture();await shift(f.scheduleId);await legacyQueue(f);const runner=new AgentTasks(db,h.config,h.brain);await runner.next();
 const delivery=new Delivery(db,h.tg as any,h.config);await delivery.next();const oldReview=(await notices())[0]!;
 await new Recurring(db).run(SeriesCommand.parse({operation:'move',id:f.id,version:2,occurrence_key:f.occurrence.occurrence_key,move_to:new Date(Date.now()+7200000).toISOString()}),c(f.sourceId));await new Recurring(db).tick();
 const occurrence=(await one(db,'SELECT * FROM recurring_occurrences WHERE series_id=$1 AND occurrence_key=$2',[f.id,f.occurrence.occurrence_key]))!;
 const moved={...f,occurrence,scheduleId:occurrence.schedule_id};await shift(moved.scheduleId);const taskId=await legacyQueue(moved);await runner.next();await delivery.next();
 const reviews=await notices();assert.equal(reviews.length,2);assert.notEqual(reviews[0]!.dedup_key,reviews[1]!.dedup_key);
 const resumeSource=await actualSource('Продовжуй цю задачу',oldReview);await runner.tools.execute('tasks.resume',{id:taskId},c(resumeSource));
 assert.equal(await runner.next(),false);assert.equal(h.brain.calls.length,0);assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[taskId]))!.status,'needs_input');
});
test('forgetting the new resume source revokes its authority before execution',async()=>{
 const f=await fixture();await shift(f.scheduleId);const taskId=await legacyQueue(f),runner=new AgentTasks(db,h.config,h.brain);await runner.next();
 const text=`Виконай задачу ${taskId} зараз — поновлення автором`;const resumeSource=await actualSource(text);await runner.tools.execute('tasks.resume',{id:taskId},c(resumeSource));
 await db.tx(sql=>forgetPhrase(sql,'поновлення автором'));
 assert.equal(await runner.next(),false);assert.equal(h.brain.calls.length,0);const task=await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[taskId]);assert.ok(!task||task.status==='cancelled');
});
test('re-queued legacy work without a fresh successful author instruction is not consent',async()=>{
 const f=await fixture();await shift(f.scheduleId);const taskId=await legacyQueue(f),runner=new AgentTasks(db,h.config,h.brain);await runner.next();
 await db.query("UPDATE agent_tasks SET status='pending' WHERE id=$1",[taskId]);assert.equal(await runner.next(),false);assert.equal(h.brain.calls.length,0);
 assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[taskId]))!.status,'needs_input');assert.equal((await notices()).length,1);
});
test('a resumed old task detached by moving its occurrence cannot become a one-off task',async()=>{
 const f=await fixture();await shift(f.scheduleId);const taskId=await legacyQueue(f),runner=new AgentTasks(db,h.config,h.brain);await runner.next();
 await new Recurring(db).run(SeriesCommand.parse({operation:'move',id:f.id,version:2,occurrence_key:f.occurrence.occurrence_key,move_to:new Date(Date.now()+7200000).toISOString()}),c(f.sourceId));await new Recurring(db).tick();
 const resumeSource=await actualSource(`Продовжуй задачу ${taskId}`);await runner.tools.execute('tasks.resume',{id:taskId},c(resumeSource));assert.equal(await runner.next(),false);assert.equal(h.brain.calls.length,0);
 assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[taskId]))!.status,'cancelled');
});
test('an ordinary unrelated tool approval is not a catch-up instruction',async()=>{
 const f=await fixture();await shift(f.scheduleId);const taskId=await legacyQueue(f),approvalId=randomUUID();
 await db.query("INSERT INTO tool_approvals(id,actor_id,topic_id,tool,arguments,argument_hash,summary,status,revision) VALUES($1,'11','7','external.test','{}','unrelated-hash','Окремий погоджений крок','approved',0)",[approvalId]);
 const allowed=await db.tx(async sql=>{await sql.query('SELECT id FROM app_state WHERE id=1 FOR UPDATE');return allowRecurringTaskClaim(sql,await one(sql,'SELECT * FROM agent_tasks WHERE id=$1 FOR UPDATE',[taskId]),0);});
 assert.equal(allowed,false);assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[taskId]))!.status,'needs_input');assert.equal((await one(db,'SELECT status FROM tool_approvals WHERE id=$1',[approvalId]))!.status,'approved');
});
for(const minutes of [59,61])test(`the existing one-hour task grace remains effective at ${minutes} minutes`,async()=>{
 const f=await fixture('task','ask');await shift(f.scheduleId,`${minutes} minutes`);assert.equal(await dispatchSchedules(db),minutes<60?1:0);
 assert.equal((await notices()).length,minutes<60?0:1);assert.equal((await db.query('SELECT id FROM agent_tasks')).rows.length,minutes<60?1:0);
});
for(const scope of ['author_id','topic_id'] as const)test(`a materialized action with a mismatched ${scope} cannot use series authorization`,async()=>{
 const f=await fixture();await shift(f.scheduleId,'10 minutes');await db.query(`UPDATE scheduled_actions SET ${scope}=$2 WHERE id=$1`,[f.scheduleId,scope==='author_id'?'22':'8']);
 assert.equal(await dispatchSchedules(db),0);assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[f.scheduleId]))!.status,'cancelled');assert.equal((await db.query('SELECT id FROM agent_tasks')).rows.length,0);
});

test('ending and revising a series prevent its materialized action from dispatching',async()=>{
 for(const operation of ['end','revise'] as const){
  const f=await fixture();await shift(f.scheduleId,'20 minutes');
  const rule=(await one(db,'SELECT rule FROM recurring_series WHERE id=$1',[f.id]))!.rule;
  const endText=`Скасуй усю серію ${f.id}.`,endSource=operation==='end'?await source(endText):undefined;
  const context=endSource?{...c(endSource),requestText:endText}:c(f.sourceId);
  await new Recurring(db).run(SeriesCommand.parse({operation,id:f.id,version:2,...(operation==='revise'?{rule:{...rule,title:'Нова редакція'}}:{quote:endText})}),context);
  assert.equal(await dispatchSchedules(db),0);assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[f.scheduleId]))!.status,'cancelled');
 }
 assert.equal((await db.query('SELECT id FROM agent_tasks')).rows.length,0);
});
test('a stale series cannot authorize a current-revision pending action',async()=>{
 const f=await fixture();await shift(f.scheduleId,'10 minutes');await db.query('UPDATE recurring_series SET revision=1 WHERE id=$1',[f.id]);
 assert.equal(await dispatchSchedules(db),0);assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[f.scheduleId]))!.status,'cancelled');assert.equal((await db.query('SELECT id FROM agent_tasks')).rows.length,0);
});
test('forget of another source carries a surviving recurring action and its provenance into the new revision',async()=>{
 const f=await fixture();await shift(f.scheduleId,'10 minutes');await source('Забудь окремий тимчасовий маркер');
 await db.tx(sql=>forgetPhrase(sql,'окремий тимчасовий маркер'));
 assert.equal((await one(db,'SELECT revision FROM recurring_series WHERE id=$1',[f.id]))!.revision,1);
 assert.equal(await dispatchSchedules(db),1);const task=await one(db,'SELECT * FROM agent_tasks');assert.equal(task!.revision,1);assert.equal(Number(task!.source_message_id),f.sourceId);assert.equal(task!.topic_id,'7');
});
test('forget of the series source removes materialized actions and legacy queued work',async()=>{
 const f=await fixture();await shift(f.scheduleId);await legacyQueue(f);await db.tx(sql=>forgetPhrase(sql,'Перевіряй наш звіт щодня'));
 assert.equal((await db.query('SELECT id FROM recurring_series')).rows.length,0);assert.equal((await db.query('SELECT id FROM scheduled_actions')).rows.length,0);assert.equal((await db.query('SELECT id FROM agent_tasks')).rows.length,0);assert.equal(await dispatchSchedules(db),0);
});
for(const gate of ['paused','revoked-consent'] as const)test(`${gate} blocks dispatch before catch-up decisions`,async()=>{
 const f=await fixture();await shift(f.scheduleId);await db.query(gate==='paused'?"UPDATE app_state SET paused=true":"UPDATE app_state SET consent='[]'");
 assert.equal(await dispatchSchedules(db),0);assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[f.scheduleId]))!.status,'pending');assert.equal((await notices()).length,0);assert.equal((await db.query('SELECT id FROM agent_tasks')).rows.length,0);
});
test('confirmed one-off tasks preserve their existing overdue behavior',async()=>{
 const text='Нагадай мені сказати привіт',sourceId=await source(text),m=message(text).message!;m.message_thread_id=7;
 await db.tx(sql=>saveSchedule(sql,ScheduleSchema.parse({kind:'schedule',title:'Привітання',instruction:'Скажи привіт учасникам',mode:'task',due_at:new Date(Date.now()+7200000).toISOString(),timezone:'UTC',authorization:'explicit',quote:text}),m,sourceId,++n,0));
 const action=await one(db,'SELECT id FROM scheduled_actions');await shift(action!.id);assert.equal(await dispatchSchedules(db),1);assert.equal((await db.query('SELECT id FROM agent_tasks')).rows.length,1);assert.equal((await notices()).length,0);
});
test('civil recurrence and explicit DST disambiguation are unchanged by the dispatch policy',()=>{
 const base=SeriesRule.parse({title:'Місцеві дев’ята',instruction:'Скажи привіт',timezone:'Europe/Kyiv',start_date:'2030-03-30',time:'09:00',frequency:'daily'});
 assert.deepEqual(occurrences(base,'2030-03-29T00:00:00Z',2).map(x=>x.due),['2030-03-30T07:00:00Z','2030-03-31T06:00:00Z']);
 const fold={...base,start_date:'2030-10-27',time:'03:30'};
 const early=occurrences({...fold,dst:'earlier'},'2030-10-26T00:00:00Z',1)[0]!,late=occurrences({...fold,dst:'later'},'2030-10-26T00:00:00Z',1)[0]!;
 assert.equal(Date.parse(late.due)-Date.parse(early.due),3600000);assert.throws(()=>occurrences({...fold,dst:'reject'},'2030-10-26T00:00:00Z',1),/series_dst_choice_required/);assert.equal(occurrences({...fold,dst:'skip'},'2030-10-26T00:00:00Z',1)[0]!.skipped,true);
});
for(const scope of ['explicit','ordinary-with-diagnostic-goal','other-author','other-topic','missing'] as const)test(`worker diagnostic detail uses the actual bound source: ${scope}`,async()=>{
 const f=await fixture();await shift(f.scheduleId,'10 minutes');const taskId=await legacyQueue(f),runner=new AgentTasks(db,h.config,h.brain);
 const diagnostic='Покажи код помилки',body=scope==='ordinary-with-diagnostic-goal'?'Допоможи з цим завданням':diagnostic;
 const telegramId=++n,sourceId=Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,topic_id,body) VALUES($1,$2,'А','user',$3,$4) RETURNING id",[telegramId,scope==='other-author'?'22':'11',scope==='other-topic'?'8':'7',body])).rows[0]!.id);
 if(scope==='explicit'||scope==='ordinary-with-diagnostic-goal')assert.ok(await db.tx(sql=>captureOriginalRequestContext(sql,sourceId,{message_id:telegramId,date:Math.floor(Date.now()/1000),from:{id:11,first_name:'А'},chat:{id:-100,type:'supergroup'},message_thread_id:7,text:body},{namespaceChatId:'-100',sourceTopicId:'7'})));
 await db.query('UPDATE agent_tasks SET source_message_id=$2,goal=$3 WHERE id=$1',[taskId,scope==='missing'?null:sourceId,diagnostic]);
 await db.query("INSERT INTO tool_runs(dedup_key,task_id,actor_id,tool,arguments,status,error_code,revision) VALUES($1,$2,'11','connector.call','{}','failed','network_unavailable',0)",[String(++n),taskId]);
 h.brain.replies.push({reply:'Не вдалося: network_unavailable.',actions:[]});assert.equal(await runner.next(),true);assert.equal(h.brain.calls.length,1);
 const task=await one(db,'SELECT result FROM agent_tasks WHERE id=$1',[taskId]);assert.equal(task!.result.includes('network_unavailable'),scope==='explicit');
});

async function deliveredArtifact(kind:'pdf'|'image'='pdf'){
 const sourceId=await source('Підготуй наш файл для розмови'),runner=new AgentTasks(db,h.config,h.brain),context=c(sourceId);
 const task=await runner.tools.execute('tasks.create',{title:'Файл до розмови',goal:'Підготуй наш файл'},context);
 const tc={...c(sourceId),taskId:task.id,goalVersion:1};
 const artifact=kind==='pdf'?await runner.tools.execute('document.create',{name:'План',format:'pdf',title:'Наш план',paragraphs:['Прогулянка. Чай. Спільний вечір.']},tc):await runner.tools.execute('artifact.create',{name:'Наш_малюнок.txt',content:'Заготовка'},tc);
 if(kind==='image'){
  // A binary output fixture uses the actual returned ID. Delivery and its fresh
  // read decode PNG bytes; the .txt filename deliberately cannot prove image.
  const bytes=await sharp({create:{width:12,height:12,channels:3,background:'#456'}}).png().toBuffer();
  await db.query("UPDATE agent_artifacts SET mime='image/png',encoding='base64',content=$2 WHERE id=$1",[artifact.id,bytes.toString('base64')]);
 }
 const delivery=new Delivery(db,h.tg as any,h.config);assert.equal(await delivery.next('media'),true);
 const out=(await one(db,"SELECT * FROM outbox WHERE kind='artifact' AND body->>'id'=$1",[artifact.id]))!;assert.equal(out.status,'sent');assert.ok(out.body.deliveryReceipt?.output?.sha256);
 return {sourceId,taskId:task.id,artifactId:artifact.id,runner,out,delivery};
}
for(const kind of ['pdf','image'] as const)test(`worker typed acknowledgement follows actual delivered ${kind} bytes`,async()=>{
 const f=await deliveredArtifact(kind),reply=kind==='pdf'?'PDF надіслано.':'Зображення надіслано.';
 h.brain.replies.push({reply,actions:[]});assert.equal(await f.runner.next(),true);
 const task=(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[f.taskId]))!;assert.equal(task.status,'delivering');assert.equal(task.result,reply);
 const read=(await one(db,"SELECT result FROM tool_runs WHERE tool='artifact.delivery' AND task_id=$1 AND status='succeeded'",[f.taskId]))!;assert.deepEqual(read.result.outputProof.kinds,[kind]);assert.equal(read.result.outputProof.sha256,f.out.body.deliveryReceipt.output.sha256);
 assert.equal(read.result.outputProof.receipt_message_id,f.out.telegram_id);
 for(let i=0;i<6;i++){if(!(await one(db,"SELECT id FROM outbox WHERE status='pending' AND kind='text' AND body->>'taskId'=$1",[f.taskId])))break;await f.delivery.next('text');}
 assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[f.taskId]))!.status,'completed');assert.ok(h.tg.sent.some(x=>x.text.includes(reply)));
});
for(const invalid of ['legacy-receipt','changed-bytes','invalid-task-source'] as const)test(`worker refuses typed file claim with ${invalid} while preserving the actual sent receipt`,async()=>{
 const f=await deliveredArtifact();
 if(invalid==='legacy-receipt')await db.query("UPDATE outbox SET body=body #- '{deliveryReceipt,output}' WHERE id=$1",[f.out.id]);
 if(invalid==='changed-bytes'){
  const stored=(await one(db,'SELECT content,encoding FROM agent_artifacts WHERE id=$1',[f.artifactId]))!;
  const before=Buffer.from(stored.content,stored.encoding==='base64'?'base64':'utf8');
  assert.equal(createHash('sha256').update(before).digest('hex'),f.out.body.deliveryReceipt.output.sha256);
  // Appending to a padded base64 string can leave decoded bytes unchanged.
  // Alter the actual delivered bytes, then re-encode and verify the fixture.
  const changed=Buffer.concat([before,Buffer.from('AAAA','ascii')]);
  await db.query("UPDATE agent_artifacts SET encoding='base64',content=$2 WHERE id=$1",[f.artifactId,changed.toString('base64')]);
  const reread=(await one(db,'SELECT content FROM agent_artifacts WHERE id=$1',[f.artifactId]))!;
  const actual=Buffer.from(reread.content,'base64');
  assert.equal(actual.length,before.length+4);
  assert.notEqual(createHash('sha256').update(actual).digest('hex'),f.out.body.deliveryReceipt.output.sha256);
 }
 if(invalid==='invalid-task-source'){
  const wrong=Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,topic_id,body) VALUES($1,'22','Б','user','7','Інше прохання') RETURNING id",[++n])).rows[0]!.id);await db.query('UPDATE agent_tasks SET source_message_id=$2 WHERE id=$1',[f.taskId,wrong]);
 }
 h.brain.replies.push({reply:'PDF надіслано.',actions:[]});assert.equal(await f.runner.next(),true);
 const task=(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[f.taskId]))!;assert.equal(task.status,'needs_input');assert.doesNotMatch(task.result,/PDF надіслано/);
 const out=(await one(db,'SELECT * FROM outbox WHERE id=$1',[f.out.id]))!;assert.equal(out.status,'sent');assert.equal(out.telegram_id,f.out.telegram_id);assert.equal(out.body.deliveryReceipt.message_id,f.out.body.deliveryReceipt.message_id);
 if(invalid==='changed-bytes')assert.deepEqual(out.body.deliveryReceipt,f.out.body.deliveryReceipt,'changing current artifact bytes cannot rewrite the historical sent receipt');
 const reads=(await db.query("SELECT result FROM tool_runs WHERE task_id=$1 AND tool='artifact.delivery' AND status='succeeded'",[f.taskId])).rows;
 assert.equal(reads.some(r=>r.result.outputProof?.kinds?.includes('pdf')),false);
});
test('legacy generic file acknowledgement remains truthful without a typed proof',async()=>{
 const f=await deliveredArtifact();await db.query("UPDATE outbox SET body=body #- '{deliveryReceipt,output}' WHERE id=$1",[f.out.id]);h.brain.replies.push({reply:'Файл надіслано.',actions:[]});
 assert.equal(await f.runner.next(),true);const task=(await one(db,'SELECT status,result FROM agent_tasks WHERE id=$1',[f.taskId]))!;assert.equal(task.status,'delivering');assert.equal(task.result,'Файл надіслано.');
});
