import {before,after,beforeEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {Temporal} from '@js-temporal/polyfill';
import {TestDB,harness,paired,message} from './helpers.js';
import {one} from '../src/db.js';
import {captureOriginalRequestContext} from '../src/request-context.js';
import {Recurring,SeriesRule} from '../src/recurring.js';
import {dispatchSchedules} from '../src/scheduling.js';
import {TaskJournal} from '../src/task-journal.js';
import {Delivery} from '../src/delivery.js';
import type {Telegram} from '../src/telegram.js';
import type {ToolContext} from '../src/agent-tools.js';
import {openInteraction,answerInteraction,interactionView} from '../src/interactions.js';

describe('natural stop of an older public task through the real owner approval route',()=>{
 let db:TestDB,h:ReturnType<typeof harness>,delivery:Delivery,id:string,completedTask:string;
 const title='Ранкова перевірка рослин',quote='Я хочу, щоб ти перестав це надсилати';
 const secret='OWNER_INTERNAL_GOAL_CANARY';
 before(async()=>{db=new TestDB();await db.init();});after(async()=>{await db.close();});
 async function source(text:string,actor:number):Promise<ToolContext>{
  const u=message(text,actor),m=u.message!;
  const row=(await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id,created_at) VALUES($1,$2,$2,'user',$3,'0',$4) RETURNING id",[m.message_id,String(actor),text,new Date(m.date*1000)]))!;
  assert.ok(await captureOriginalRequestContext(db,Number(row.id),m,{namespaceChatId:'-100',sourceTopicId:'0'}));
  return {actorId:String(actor),chatId:'-100',topicId:'0',revision:0,sourceId:Number(row.id),requestText:text,updateId:String(u.update_id),requested:true,audience:'group'};
 }
 async function createTask(){
  const c=await source('Щоночі о04:00 надсилай перевірку рослин.',11),rule=SeriesRule.parse({title,instruction:'Надішли публічне привітання. Внутрішня примітка: '+secret,mode:'task',timezone:'Europe/Kyiv',start_date:Temporal.Now.plainDateISO('Europe/Kyiv').add({days:1}).toString(),time:'04:00',frequency:'daily',catch_up:'skip'});
  const created=await new Recurring(db).run({operation:'preview',rule},c);
  await new Recurring(db).run({operation:'confirm',id:created.id,version:1},{...c,updateId:c.updateId+':confirm'});
  await new Recurring(db).tick();const first=(await one(db,'SELECT * FROM recurring_occurrences WHERE series_id=$1 ORDER BY due_at LIMIT 1',[created.id]))!;
  await db.query("UPDATE recurring_occurrences SET due_at=now()-interval '1 second' WHERE series_id=$1 AND occurrence_key=$2",[created.id,first.occurrence_key]);
  if(first.schedule_id)await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 second' WHERE id=$1",[first.schedule_id]);
  await new Recurring(db).tick();assert.equal(await dispatchSchedules(db),1);
  const task=(await one(db,'SELECT t.id FROM agent_tasks t JOIN scheduled_actions a ON a.task_id=t.id JOIN recurring_occurrences r ON r.schedule_id=a.id WHERE r.series_id=$1 ORDER BY t.created_at DESC LIMIT 1',[created.id]))!;
  await db.query("UPDATE agent_tasks SET status='completed',result='Публічне привітання готове.' WHERE id=$1",[task.id]);
  await new TaskJournal(db).publish(task.id,true);assert.equal(await delivery.next('text'),true);
  return {id:String(created.id),task:String(task.id)};
 }
 beforeEach(async()=>{
  await db.reset();await db.query('TRUNCATE recurring_series CASCADE');h=harness(db);await paired(h);
  await db.query('UPDATE app_state SET open_group=true,mention_only=true,quiet_start=0,quiet_end=0');
  delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);const created=await createTask();id=created.id;completedTask=created.task;
 });
 async function stop(byId=true){
  const text=`@lumen_test_bot\nВ тебе є таке, як\n"${title}\nЗавершено"\n${quote}`;
  h.brain.replies.push({reply:'Готово.',authorization:{quote,actions:['cancel_reminder']},actions:[{kind:'cancel_reminder',...(byId?{id}:{query:title}),scope:'series'}]});
  await h.lumen.receive(message(text,22));await h.lumen.processNext();
 }
 async function ownerButton(proposal:string){
  const v=await interactionView(db,proposal),u=message('[Вибір у поточному кроці]',11);
  u.message!.message_id=-u.update_id;
  u.message!.lumen_interaction_event={id:proposal,version:v.version,action:'yes'};
  const calls=h.brain.calls.length;await h.lumen.receive(u);assert.equal(h.brain.calls.length,calls);
 }
 it('keeps the unlinked two-person planning card separate, explains actual ownership, then ends the parent through its owner button',async()=>{
  const a=await source('Погоджуюсь, якщо погодиться й інший учасник.',22);
  const old=await openInteraction(db,{title:'Згода на нічні повідомлення',kind:'planning',scope:'invited',participant_ids:['11','22'],policy:'all',question:'Погоджуємо нічні повідомлення?',options:['Так','Ні']},a);
  for(const actor of [11,22])await answerInteraction(db,{id:old.id,version:old.version,decision:'answer',choices:[0]},await source('Так',actor));
  await db.query("UPDATE interactions SET phase='resolved' WHERE id=$1",[old.id]);
  assert.equal((await interactionView(db,old.id)).launch,null);
  await stop();const context=JSON.parse(h.brain.calls.at(-1)!.context),visible=context.reminder_roots.approval_required;
  assert.equal(visible.length,1);assert.equal(visible[0].id,id);assert.equal(visible[0].requires_approval,true);
  assert.doesNotMatch(JSON.stringify(visible),new RegExp(secret));assert.equal(visible[0].instruction,undefined);
  const proposal=(await one(db,"SELECT id FROM interactions WHERE spec->>'reminder_cancel'='true'"))!;
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
  assert.deepEqual((await interactionView(db,proposal.id)).pending,['11']);
  const answer=(await db.query("SELECT body->>'text' AS text FROM outbox WHERE dedup_key LIKE 'answer:%' ORDER BY id DESC LIMIT 1")).rows[0]!.text;
  assert.match(answer,/Власник|підтвердження/u);assert.doesNotMatch(answer,/цитата|не є дорученням|Готово/u);
  while(await delivery.next('text')){}
  assert.ok(h.tg.options.some(option=>JSON.stringify(option.replyMarkup||{}).includes('Зупинити серію')));
  await ownerButton(proposal.id);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'ended');
  assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[completedTask]))!.status,'completed');
  await new Recurring(db).tick();assert.equal(await dispatchSchedules(db),0);
  assert.equal((await interactionView(db,old.id)).phase,'resolved');
  assert.equal((await one(db,'SELECT count(*)::int AS n FROM action_work WHERE action_id=$1',[proposal.id]))!.n,0);
 });
 it('title-based natural cancellation enters the same proposal route without asking for a command word',async()=>{
  await stop(false);assert.equal((await one(db,"SELECT count(*)::int AS n FROM interactions WHERE spec->>'reminder_cancel'='true'"))!.n,1);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
 });
 for(const response of ['Люмен, підтверджую скасування лише найближчого повтору','Люмен, підтверджую зупинку серії пізніше','так'])it(`an owner vote changing the proposed scope or time keeps the series and explains the actual card: ${response}`,async()=>{
  await stop();const proposal=(await one(db,"SELECT id,version FROM interactions WHERE spec->>'reminder_cancel'='true'"))!;
  while(await delivery.next('text')){}
  const card=(await one(db,"SELECT telegram_id,body FROM outbox WHERE kind='interaction' AND body->>'id'=$1 AND status='sent' ORDER BY id DESC LIMIT 1",[proposal.id]))!;
  const update=message(response,11);update.message!.reply_to_message={message_id:Number(card.telegram_id),from:{id:999,is_bot:true,first_name:'Люмен'},date:0,chat:{id:-100,type:'supergroup'},text:card.body.text};
  if(response==='так')update.message!.entities=[{type:'blockquote',offset:0,length:3}];
  h.brain.replies.push({reply:'Скасував.',actions:[],interaction_response:{id:proposal.id,version:proposal.version,decision:'agree',submit:true,choices:[],content:''}});
  await h.lumen.receive(update);await h.lumen.processNext();
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
  const view=await interactionView(db,proposal.id);assert.notEqual(view.responses.find((r:any)=>r.user_id==='11')?.submitted,true);assert.deepEqual(view.pending,['11']);
  const result=(await one(db,"SELECT body->>'text' AS text FROM outbox WHERE dedup_key LIKE $1",[response==='так'?'interaction-input:'+update.update_id+':%':'error:'+update.update_id+':%']))!;
  assert.ok(result,JSON.stringify({outbox:(await db.query('SELECT dedup_key,body FROM outbox ORDER BY id DESC LIMIT 3')).rows,inbox:(await db.query('SELECT update_id,status,error_code FROM inbox')).rows,calls:h.brain.calls.length}));
  assert.match(result.text,/немає явного погодження саме дії з поточної картки/u);assert.match(result.text,/LM-[0-9A-Z]{26}/u);assert.doesNotMatch(result.text,/Скасував|цитата/u);
 });
 it('a quoted instruction cannot create an owner-approval proposal even when the public target is visible',async()=>{
  const text=`@lumen_test_bot\n${quote}`,u=message(text,22);
  u.message!.entities=[{type:'blockquote',offset:text.indexOf(quote),length:quote.length}];
  h.brain.replies.push({reply:'',authorization:{quote,actions:['cancel_reminder']},actions:[{kind:'cancel_reminder',id,scope:'series'}]});
  await h.lumen.receive(u);await h.lumen.processNext();
  assert.equal((await one(db,"SELECT count(*)::int AS n FROM interactions WHERE spec->>'reminder_cancel'='true'"))!.n,0);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
 });
 it('two visible matches ask which root, preserve whole-series intent, and never stop the other root',async()=>{
  const other=await createTask();await stop(false);
  const pending=await one(db,'SELECT purpose,candidates FROM reminder_clarifications WHERE actor_id=$1',['22']);
  assert.ok(pending,JSON.stringify({roots:(await db.query('SELECT id,status FROM recurring_series')).rows,outbox:(await db.query('SELECT body FROM outbox ORDER BY id DESC LIMIT 2')).rows}));
  assert.equal(pending.purpose,'which_root');assert.equal(pending.candidates[0].requested_scope,'series');
  assert.equal((await one(db,"SELECT count(*)::int AS n FROM interactions WHERE spec->>'reminder_cancel'='true'"))!.n,0);
  await h.lumen.receive(message('1',22));
  const proposal=(await one(db,"SELECT id,launch FROM interactions WHERE spec->>'reminder_cancel'='true'"))!;
  assert.equal(proposal.launch.bindings.length,1);await ownerButton(proposal.id);
  const rows=(await db.query('SELECT status FROM recurring_series WHERE id=ANY($1::uuid[])',[[id,other.id]])).rows;
  assert.deepEqual(rows.map(row=>row.status).sort(),['active','ended']);
 });
});
