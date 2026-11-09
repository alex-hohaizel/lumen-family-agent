import {describe,it,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TestDB,harness,paired,message} from './helpers.js';
import {one} from '../src/db.js';
import {Recurring,SeriesRule} from '../src/recurring.js';
import {captureOriginalRequestContext} from '../src/request-context.js';
import {dispatchSchedules} from '../src/scheduling.js';
import {TaskJournal} from '../src/task-journal.js';
import {Delivery} from '../src/delivery.js';
import {Telegram} from '../src/telegram.js';
import {openInteraction,answerInteraction,interactionView,enqueueInteraction,toggleInteraction} from '../src/interactions.js';
import {claimActionWork} from '../src/commitments.js';
import {AgentTools,type ToolContext} from '../src/agent-tools.js';
import {visibleConsentReminderCandidates,requestReminderStopApproval,finishReminderStopApproval} from '../src/reminder-consent.js';
import {cancelApprovedReminderRoots} from '../src/reminder-control.js';

describe('owner approval for a visible recurring group task',()=>{
 let db:TestDB,h:ReturnType<typeof harness>;
 before(async()=>{db=new TestDB();await db.init();});after(async()=>{await db.close();});
 beforeEach(async()=>{await db.reset();await db.query('TRUNCATE recurring_series CASCADE');h=harness(db);await paired(h);await db.query("INSERT INTO members(user_id,name) VALUES('11','Власник роботи'),('22','Співрозмовник'),('33','Інший учасник') ON CONFLICT(user_id) DO UPDATE SET active=true,name=excluded.name");});
 async function source(text:string,actor=22,topic='0',extra:{replyTo?:number;entities?:Array<{type:string;offset:number;length:number}>}={}):Promise<ToolContext>{
  const update=message(text,actor),m=update.message!;if(topic!=='0')m.message_thread_id=Number(topic);
  if(extra.replyTo)m.reply_to_message={message_id:extra.replyTo,from:{id:999,is_bot:true,first_name:'Люмен'},date:Math.floor(Date.now()/1000),chat:{id:-100,type:'supergroup'}};
  if(extra.entities)m.entities=extra.entities;
  const row=(await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id,created_at) VALUES($1,$2,$2,'user',$3,$4,$5) RETURNING id",[m.message_id,String(actor),text,topic,new Date(m.date*1000)]))!;
  assert.ok(await captureOriginalRequestContext(db,Number(row.id),m,{namespaceChatId:'-100',sourceTopicId:topic}));
  return {actorId:String(actor),chatId:'-100',topicId:topic,revision:0,sourceId:Number(row.id),requestText:text,updateId:String(update.update_id),requested:true,audience:'group'};
 }
 const rule=()=>SeriesRule.parse({title:'Ранкова перевірка рослин',instruction:'Надішли спільному чату коротке повідомлення про догляд за рослинами.',mode:'task',timezone:'Europe/Kyiv',start_date:new Date(Date.now()+86400000).toISOString().slice(0,10),time:'04:00',frequency:'daily',catch_up:'skip'});
 async function create(deliver=true){
  const c=await source('Щодня о04:00 надішли в чат перевірку рослин.',11),r=rule(),rec=new Recurring(db);
  const created=await rec.run({operation:'preview',rule:r},c);await rec.run({operation:'confirm',id:created.id,version:1},{...c,updateId:c.updateId+':confirm'});
  if(!deliver)return {id:created.id,c};
  await rec.tick();const first=(await one(db,'SELECT * FROM recurring_occurrences WHERE series_id=$1 ORDER BY due_at LIMIT 1',[created.id]))!;
  await db.query("UPDATE recurring_occurrences SET due_at=now()-interval '1 second' WHERE series_id=$1 AND occurrence_key=$2",[created.id,first.occurrence_key]);
  if(first.schedule_id)await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 second' WHERE id=$1",[first.schedule_id]);
  await new Recurring(db).tick();assert.equal(await dispatchSchedules(db),1);
  const task=(await one(db,'SELECT t.* FROM agent_tasks t JOIN scheduled_actions a ON a.task_id=t.id JOIN recurring_occurrences r ON r.schedule_id=a.id WHERE r.series_id=$1 ORDER BY t.created_at DESC LIMIT 1',[created.id]))!;
  await new TaskJournal(db).publish(task.id,true);assert.equal(await new Delivery(db,h.tg as unknown as Telegram,h.config).next('text'),true);
  assert.ok(h.tg.sent.some(x=>x.chatId==='-100'&&x.text.includes(r.title)));
  return {id:created.id,c,task};
 }
 async function proposal(id:string,c?:ToolContext,scope:'series'|'occurrence'='series'){
  c??=await source(scope==='series'?'Я хочу, щоб ти перестав надсилати «Ранкова перевірка рослин».':'Скасуй лише найближчий повтор «Ранкова перевірка рослин».');
  const roots=await visibleConsentReminderCandidates(db,c,{id});assert.equal(roots.length,1);
  const result=await db.tx(sql=>requestReminderStopApproval(sql,roots,c!,scope));
  assert.equal(result.status,'needs_participant_approval');assert.match(result.message,/Власник роботи/u);
  const view=(await one(db,"SELECT id FROM interactions WHERE spec->>'reminder_cancel'='true' ORDER BY created_at DESC LIMIT 1"))!;
  return {c,result,view:await interactionView(db,view.id)};
 }
 async function ownerAnswer(id:string,decision:'agree'|'decline'='agree'){
  const c=await source(decision==='agree'?'Підтверджую зупинку серії.':'Залишити серію як є.',11);
  const before=await interactionView(db,id);
  await db.tx(async sql=>{const v=await answerInteraction(sql,{id,version:before.version,decision},c);await enqueueInteraction(sql,v,c);});
  return c;
 }
 async function sentApprovalCard(id:string){
  const delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);
  for(let attempt=0;attempt<12;attempt++){
   const row=(await one(db,'SELECT card_message_id FROM interactions WHERE id=$1',[id]))!;
   if(Number(row.card_message_id)>0)return Number(row.card_message_id);
   await delivery.next('text');
  }
  assert.fail('approval card was not actually delivered');
 }
 it('finds a publicly delivered canonical parent but never grants the requester direct stop authority',async()=>{
  const {id}=await create(),c=await source('Перестань це надсилати.');
  const roots=await visibleConsentReminderCandidates(db,c,{query:'рослин'});
  assert.equal(roots.length,1);assert.equal(roots[0]!.ref,'series:'+id);assert.equal(roots[0]!.approval_visibility,'sent_group');
  assert.equal(roots[0]!.actor_id,'11');assert.equal(roots[0]!.shared,false);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
 });
 it('shows one owner/requester card, records only the requester automatically, and stops the parent after the owner button',async()=>{
  const {id,task}=await create(),p=await proposal(id);
  assert.deepEqual(p.view.participants.map((x:any)=>x.id).sort(),['11','22']);assert.deepEqual(p.view.pending,['11']);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
  const roots=await visibleConsentReminderCandidates(db,p.c,{id});await db.tx(sql=>requestReminderStopApproval(sql,roots,p.c,'series'));
  assert.equal((await one(db,"SELECT count(*) AS n FROM interactions WHERE spec->>'reminder_cancel'='true'"))!.n,1);
  await ownerAnswer(p.view.id);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'ended');
  assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[task!.id]))!.status,'cancelled');
  assert.equal((await interactionView(db,p.view.id)).phase,'resolved');
  assert.equal((await one(db,'SELECT count(*) AS n FROM action_work WHERE action_id=$1',[p.view.id]))!.n,0);
  assert.equal(await new Recurring(db).tick(),false);
 });
 it('owner decline closes only the proposal and keeps the existing series active',async()=>{
  const {id}=await create(),p=await proposal(id);await ownerAnswer(p.view.id,'decline');
  const view=await interactionView(db,p.view.id);assert.equal(view.phase,'cancelled');assert.match(view.result,/не погоджено/u);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
 });
 it('an active outsider cannot approve a card addressed to the actual owner and requester',async()=>{
  const {id}=await create(),p=await proposal(id),outsider=await source('Підтверджую.',33);
  await assert.rejects(()=>answerInteraction(db,{id:p.view.id,version:p.view.version,decision:'agree'},outsider),/interaction_not_participant/u);
  await assert.rejects(()=>db.tx(sql=>finishReminderStopApproval(sql,p.view,outsider,cancelApprovedReminderRoots)),/reminder_approval_unavailable/u);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
 });
 it('changed root version invalidates approval without changing the root',async()=>{
  const {id}=await create(),p=await proposal(id);await db.query('UPDATE recurring_series SET version=version+1 WHERE id=$1',[id]);await ownerAnswer(p.view.id);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');assert.equal((await interactionView(db,p.view.id)).phase,'cancelled');
 });
 it('changing the request body or immutable proposal target cannot become a cancellation grant',async()=>{
  const {id}=await create(),p=await proposal(id);
  await db.query("UPDATE messages SET body='Залиш як є',request_context=NULL WHERE id=$1",[p.c.sourceId]);
  await ownerAnswer(p.view.id);assert.equal((await interactionView(db,p.view.id)).phase,'cancelled');assert.match((await interactionView(db,p.view.id)).result,/прохання змінилося/u);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
 });
 it('mutable proposal launch tampering is rejected against the immutable commitment hash',async()=>{
  const {id}=await create(),p=await proposal(id);await db.query("UPDATE interactions SET launch=jsonb_set(launch,'{scope}',to_jsonb('occurrence'::text)) WHERE id=$1",[p.view.id]);
  await assert.rejects(()=>ownerAnswer(p.view.id),/reminder_vote_unbound/u);assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
  assert.equal((await one(db,"SELECT count(*) AS n FROM consent_grants WHERE action_id=$1 AND actor_id='11'",[p.view.id]))!.n,0);
 });
 it('a different topic and stale source revision cannot approve the same card',async()=>{
  const {id}=await create(),p=await proposal(id),other=await source('Підтверджую.',11,'7');
  await assert.rejects(()=>db.tx(sql=>finishReminderStopApproval(sql,p.view,other,cancelApprovedReminderRoots)),/reminder_approval_unavailable/u);
  await db.query('UPDATE app_state SET memory_revision=memory_revision+1');
  await assert.rejects(()=>db.tx(sql=>finishReminderStopApproval(sql,p.view,{...other,topicId:'0'},cancelApprovedReminderRoots)),/task_cancelled/u);
 });
 it('private or unpublished roots remain hidden even if their title exactly matches',async()=>{
  const {id}=await create(false),c=await source('Перестань надсилати перевірку рослин.');assert.deepEqual(await visibleConsentReminderCandidates(db,c,{id}),[]);
  const shown=await create();await db.query("UPDATE recurring_series SET audience='private' WHERE id=$1",[shown.id]);assert.deepEqual(await visibleConsentReminderCandidates(db,c,{id:shown.id}),[]);
 });
 it('a formerly visible task with private output evidence is not exposed through the group approval route',async()=>{
  const {id,task}=await create(),c=await source('Зупини повтори.');
  await db.query("INSERT INTO outbox(dedup_key,kind,body,revision,actor_id,audience,status) VALUES($1,'text',$2,0,'11','private','sent')",['private-fence:'+task!.id,JSON.stringify({taskId:task!.id,scopeTopicId:'0',text:'private result'})]);
  assert.deepEqual(await visibleConsentReminderCandidates(db,c,{id}),[]);
 });
 it('a sent row with a different destination receipt is not proof of public visibility in this group',async()=>{
  const {id,task}=await create(),c=await source('Зупини повтори.');
  await db.query("UPDATE outbox SET body=jsonb_set(body,'{deliveryReceipt,destination_chat_id}',to_jsonb('22'::text)) WHERE body->>'taskId'=$1",[task!.id]);
  assert.deepEqual(await visibleConsentReminderCandidates(db,c,{id}),[]);
 });
 it('expiry between the owner response and execution preserves the existing series',async()=>{
  const {id}=await create(),p=await proposal(id),c=await source('Підтверджую зупинку серії.',11);
  const v=await answerInteraction(db,{id:p.view.id,version:p.view.version,decision:'agree'},c);
  await db.query("UPDATE interactions SET expires_at=now()-interval '1 second' WHERE id=$1",[p.view.id]);
  await db.tx(sql=>finishReminderStopApproval(sql,v,c,cancelApprovedReminderRoots));
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');assert.match((await interactionView(db,p.view.id)).result,/Час погодження минув/u);
 });
 it('revoked fresh owner grant cannot be replaced by an old ready flag',async()=>{
  const {id}=await create(),p=await proposal(id),c=await source('Підтверджую зупинку серії.',11);
  const v=await answerInteraction(db,{id:p.view.id,version:p.view.version,decision:'agree'},c);
  await db.query("UPDATE consent_grants SET decision='decline' WHERE action_id=$1 AND actor_id='11'",[p.view.id]);
  await assert.rejects(()=>db.tx(sql=>finishReminderStopApproval(sql,v,c,cancelApprovedReminderRoots)),/reminder_approval_unbound/u);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
 });
 it('a clone with the same title and source has no visibility merely because the real root was delivered',async()=>{
  const {id}=await create(),clone=randomUUID(),c=await source('Зупини повтори.');
  await db.query('INSERT INTO recurring_series(id,actor_id,topic_id,rule,revision,status,source_message_id,audience) SELECT $1,actor_id,topic_id,rule,revision,status,source_message_id,audience FROM recurring_series WHERE id=$2',[clone,id]);
  assert.deepEqual(await visibleConsentReminderCandidates(db,c,{id:clone}),[]);
 });
 it('public task cards do not turn internal instructions into another participant search oracle',async()=>{
  const {id}=await create(),c=await source('Припини повтори.');
  await db.query("UPDATE recurring_series SET rule=jsonb_set(rule,'{instruction}',to_jsonb('Внутрішній код сапфіровийкомпас'::text)) WHERE id=$1",[id]);
  assert.deepEqual(await visibleConsentReminderCandidates(db,c,{query:'сапфіровийкомпас'}),[]);
  assert.equal((await visibleConsentReminderCandidates(db,c,{query:'рослин'})).length,1);
 });
 it('already claimed work is reported separately while future repetitions end; replay does not execute twice',async()=>{
  const {id,task}=await create(),p=await proposal(id);
  await db.query("UPDATE agent_tasks SET status='running',step=1 WHERE id=$1",[task!.id]);
  await db.query("INSERT INTO task_events(task_id,goal_version,kind) VALUES($1,1,'running')",[task!.id]);
  await ownerAnswer(p.view.id);const view=await interactionView(db,p.view.id);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'ended');
  assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[task!.id]))!.status,'running');assert.match(view.result,/розпочато/u);
  let calls=0;const c=await source('Підтверджую.',11);await db.tx(sql=>finishReminderStopApproval(sql,view,c,async()=>{calls++;throw Error('must not replay');}));assert.equal(calls,0);
 });
 it('two real original consents provide historical visibility, but a fresh owner approval is still required',async()=>{
  const c=await source('Щодня о04:00 надішли перевірку рослин для нас.',11),r=rule();
  const launch={kind:'tool',name:'schedule.series',arguments:JSON.stringify({operation:'preview',rule:r})};
  let v=await openInteraction(db,{title:r.title,kind:'activity',scope:'invited',participant_ids:['11','22'],policy:'all',question:'Погоджуємо цю спільну роботу?',options:[]},c,{launch,autoAccept:false});
  v=await answerInteraction(db,{id:v.id,version:1,decision:'agree'},c);const other=await source('Погоджуюсь.',22);v=await answerInteraction(db,{id:v.id,version:1,decision:'agree'},other);
  await enqueueInteraction(db,v,other);const work=(await one(db,'SELECT id FROM action_work WHERE action_id=$1',[v.id]))!;await claimActionWork(db,work.id,0);
  const tools=new AgentTools(db,h.config,h.brain),created:any=await tools.execute('schedule.series',{operation:'preview',rule:r},{...c,actionId:v.id,interactionId:v.id,interactionVersion:1});
  await tools.execute('schedule.series',{operation:'confirm',id:created.id,version:1},{...c,updateId:c.updateId+':confirm',actionId:v.id});
  const stop=await source('Я хочу, щоб ти перестав це надсилати.',22),roots=await visibleConsentReminderCandidates(db,stop,{id:created.id});
  assert.equal(roots.length,1);assert.equal(roots[0]!.approval_visibility,'consented_launch');assert.equal(roots[0]!.shared,false);
  const result=await db.tx(sql=>requestReminderStopApproval(sql,roots,stop));assert.equal(result.status,'needs_participant_approval');
  const p=(await one(db,"SELECT id FROM interactions WHERE spec->>'reminder_cancel'='true'"))!;await ownerAnswer(p.id);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[created.id]))!.status,'ended');
 });
 for(const kind of ['native-blockquote','native-code','legacy-forward','via-bot'] as const)it(`a ${kind} yes cannot become the owner's stop approval through native ingress`,async()=>{
  const {id}=await create(),p=await proposal(id),update=message('так',11);
  if(kind==='native-blockquote')update.message!.entities=[{type:'blockquote',offset:0,length:3}];
  if(kind==='native-code')update.message!.entities=[{type:'code',offset:0,length:3}];
  if(kind==='legacy-forward')(update.message as any).forward_sender_name='Synthetic forwarded sender';
  if(kind==='via-bot')(update.message as any).via_bot={id:777,is_bot:true,first_name:'Synthetic bot'};
  await h.lumen.receive(update);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
  assert.equal((await one(db,"SELECT count(*) AS n FROM consent_grants WHERE action_id=$1 AND actor_id='11' AND decision='agree'",[p.view.id]))!.n,0);
  assert.deepEqual((await interactionView(db,p.view.id)).pending,['11']);
 });
 it('a model interaction_response cannot manufacture the owner agreement from an unrelated question',async()=>{
  const {id}=await create(),p=await proposal(id);
  const response={id:p.view.id,version:p.view.version,decision:'agree' as const,choices:[],content:'',submit:true,callback:{id:p.view.id,version:p.view.version,action:'yes'}};
  h.brain.replies.push({reply:'',actions:[],interaction_response:response});
  await h.lumen.receive(message('Люмен, що ти думаєш про погоду?',11));await h.lumen.processNext();
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');assert.deepEqual((await interactionView(db,p.view.id)).pending,['11']);
 });
 it('an actual own native yes records a source-bound vote and ends the agreed parent',async()=>{
  const {id}=await create(),p=await proposal(id),cardId=await sentApprovalCard(p.view.id),update=message('так',11);
  update.message!.reply_to_message={message_id:cardId,from:{id:999,is_bot:true,first_name:'Люмен'},date:Math.floor(Date.now()/1000),chat:{id:-100,type:'supergroup'}};
  await h.lumen.receive(update);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'ended');
  const votes=(await db.query("SELECT actor_id,result FROM domain_commands WHERE domain='reminder_stop_vote' ORDER BY actor_id")).rows;
  assert.deepEqual(votes.map(v=>[v.actor_id,v.result.modality]),[['11','native_text'],['22','initial_requester']]);
 });
 for(const text of ['так','Так сталося, що в мене немає часу.','Погоджуюся зі статтею','так?','так, не скасовуй'])it(`nonreply unrelated or negated agreement is not owner authority: ${text}`,async()=>{
  const {id}=await create(),p=await proposal(id),c=await source(text,11);
  await assert.rejects(()=>answerInteraction(db,{id:p.view.id,version:p.view.version,decision:'agree'},c),/reminder_vote_explicit_required/u);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');assert.deepEqual((await interactionView(db,p.view.id)).pending,['11']);
 });
 for(const {scope,text,masked} of [
  {scope:'series',text:'Люмен, підтверджую скасування лише найближчого повтору'},
  {scope:'series',text:'Підтверджую зупинку серії пізніше'},
  {scope:'series',text:'Підтверджую зупинку серії завтра о 18:00'},
  {scope:'series',text:'Підтверджую зупинку серії після завершення роботи'},
  {scope:'series',text:'Підтверджую зупинку серії, якщо інші погодяться'},
  {scope:'series',text:'Підтверджую зупинку серії, але найближчий повтор залиш'},
  {scope:'series',text:'Підтверджую зупинку серії “ІНША СПРАВА”'},
  {scope:'series',text:'Підтверджую зупинку серії іншої справи'},
  {scope:'series',text:'Підтверджую зупинку серії `пізніше`'},
  {scope:'series',text:'Підтверджую зупинку серії\n> пізніше'},
  {scope:'series',text:'Підтверджую зупинку серії ІНША СПРАВА',masked:'blockquote'},
  {scope:'series',text:'Підтверджую зупинку серії пізніше',masked:'code'},
  {scope:'series',text:'Так, зупиняй серію, але не зараз'},
  {scope:'series',text:'Так сталося, що серію вже обговорювали'},
  {scope:'series',text:'Так, не скасовуй серію'},
  {scope:'occurrence',text:'Підтверджую скасування всієї серії'},
  {scope:'occurrence',text:'Так, скасовуй усі майбутні повтори'},
  {scope:'occurrence',text:'Підтверджую скасування найближчого повтору пізніше'},
  {scope:'occurrence',text:'Підтверджую скасування другого повтору'},
  {scope:'occurrence',text:'Підтверджую скасування найближчого повтору, якщо буде дощ'},
 ] as ReadonlyArray<{scope:'series'|'occurrence';text:string;masked?:'blockquote'|'code'}>)it(`an actual card reply cannot accept changed scope, timing, target, or condition (${scope}): ${text}${masked?' ['+masked+']':''}`,async()=>{
  const {id}=await create(),p=await proposal(id,undefined,scope),cardId=await sentApprovalCard(p.view.id);
  const extra=masked?{entities:[{type:masked,offset:text.indexOf(masked==='code'?'пізніше':'ІНША СПРАВА'),length:masked==='code'?'пізніше'.length:'ІНША СПРАВА'.length}]}:{};
  const c=await source(text,11,'0',{replyTo:cardId,...extra});
  const before=(await one(db,'SELECT status,version FROM recurring_series WHERE id=$1',[id]))!;
  await assert.rejects(()=>answerInteraction(db,{id:p.view.id,version:p.view.version,decision:'agree'},c),/reminder_vote_explicit_required/u);
  assert.deepEqual(await one(db,'SELECT status,version FROM recurring_series WHERE id=$1',[id]),before);
  assert.deepEqual((await interactionView(db,p.view.id)).pending,['11']);
  assert.equal((await one(db,"SELECT count(*) AS n FROM consent_grants WHERE action_id=$1 AND actor_id='11'",[p.view.id]))!.n,0);
  assert.equal((await one(db,"SELECT count(*) AS n FROM domain_commands WHERE domain='reminder_stop_vote' AND actor_id='11'"))!.n,0);
 });
 for(const {scope,text} of [
  {scope:'series',text:'Люмен, підтверджую скасування всієї серії.'},
  {scope:'occurrence',text:'Підтверджую скасування лише найближчого повтору.'},
 ] as const)it(`an unconditional native confirmation accepts exactly the frozen ${scope} scope`,async()=>{
  const {id}=await create(),p=await proposal(id,undefined,scope),c=await source(text,11);
  const before=(await one(db,'SELECT version FROM recurring_series WHERE id=$1',[id]))!;
  const skipped=(await one(db,"SELECT count(*) AS n FROM recurring_occurrences WHERE series_id=$1 AND status='skipped'",[id]))!.n;
  await db.tx(async sql=>{const v=await answerInteraction(sql,{id:p.view.id,version:p.view.version,decision:'agree'},c);await enqueueInteraction(sql,v,c);});
  const after=(await one(db,'SELECT status,version FROM recurring_series WHERE id=$1',[id]))!;
  assert.equal(after.status,scope==='series'?'ended':'active');assert.equal(after.version,before.version+1);
  if(scope==='occurrence')assert.equal((await one(db,"SELECT count(*) AS n FROM recurring_occurrences WHERE series_id=$1 AND status='skipped'",[id]))!.n,skipped+1);
  assert.equal((await interactionView(db,p.view.id)).phase,'resolved');
 });
 it('an exact own reply agreeing to this card preserves the frozen occurrence scope',async()=>{
  const {id}=await create(),p=await proposal(id,undefined,'occurrence'),cardId=await sentApprovalCard(p.view.id),c=await source('Я підтверджую цю дію.',11,'0',{replyTo:cardId});
  await db.tx(async sql=>{const v=await answerInteraction(sql,{id:p.view.id,version:p.view.version,decision:'agree'},c);await enqueueInteraction(sql,v,c);});
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
  assert.equal((await interactionView(db,p.view.id)).phase,'resolved');
  assert.equal((await one(db,"SELECT count(*) AS n FROM recurring_occurrences WHERE series_id=$1 AND status='skipped'",[id]))!.n,1);
 });
 for(const scope of ['series','occurrence'] as const)it(`a real internal owner callback records a callback proof for ${scope} without inventing an original text descriptor`,async()=>{
  const {id}=await create(),p=await proposal(id,undefined,scope),update=message('[Вибір у поточному кроці]',11);
  const row=(await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,'11','Власник роботи','user',$2,'0') RETURNING id",[-update.update_id,update.message!.text]))!;
  const c:ToolContext={actorId:'11',chatId:'-100',topicId:'0',revision:0,sourceId:Number(row.id),updateId:String(update.update_id),requested:true,audience:'group'};
  await db.tx(async sql=>{const v=await toggleInteraction(sql,p.view.id,p.view.version,'yes',c);await enqueueInteraction(sql,v,c);});
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,scope==='series'?'ended':'active');
  if(scope==='occurrence')assert.equal((await one(db,"SELECT count(*) AS n FROM recurring_occurrences WHERE series_id=$1 AND status='skipped'",[id]))!.n,1);
  const proof=(await one(db,"SELECT result FROM domain_commands WHERE domain='reminder_stop_vote' AND actor_id='11'"))!.result;
  assert.equal(proof.modality,'callback');assert.equal(proof.callbackAction,'yes');assert.equal((await one(db,'SELECT request_context FROM messages WHERE id=$1',[row.id]))!.request_context,null);
 });
 it('a model cannot turn a native row that imitates callback text into a callback proof',async()=>{
  const {id}=await create(),p=await proposal(id),c=await source('[Вибір у поточному кроці]',11);
  await assert.rejects(()=>answerInteraction(db,{id:p.view.id,version:p.view.version,decision:'agree'},c),/reminder_vote_explicit_required/u);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');
 });
 it('editing an owner vote after recording it invalidates execution even when the text is restored',async()=>{
  const {id}=await create(),p=await proposal(id),c=await source('Підтверджую зупинку серії.',11),v=await answerInteraction(db,{id:p.view.id,version:p.view.version,decision:'agree'},c);
  await db.query("UPDATE messages SET edited_at=now()+interval '1 second' WHERE id=$1",[c.sourceId]);
  await db.tx(sql=>finishReminderStopApproval(sql,v,c,cancelApprovedReminderRoots));
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');assert.equal((await interactionView(db,p.view.id)).phase,'cancelled');
 });
 it('deleting the owner vote proof cannot be replaced by a ready flag and surviving consent_grant',async()=>{
  const {id}=await create(),p=await proposal(id),c=await source('Підтверджую зупинку серії.',11),v=await answerInteraction(db,{id:p.view.id,version:p.view.version,decision:'agree'},c);
  await db.query("DELETE FROM domain_commands WHERE domain='reminder_stop_vote' AND actor_id='11'");
  await db.tx(sql=>finishReminderStopApproval(sql,v,c,cancelApprovedReminderRoots));
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'active');assert.equal((await interactionView(db,p.view.id)).phase,'cancelled');
 });
});
