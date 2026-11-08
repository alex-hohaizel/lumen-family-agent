import {afterEach,beforeEach,describe,it,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TestDB,harness,paired,message} from './helpers.js';
import {one} from '../src/db.js';
import {dispatchSchedules,saveSchedule,scheduleDecision} from '../src/scheduling.js';
import {Delivery} from '../src/delivery.js';
import type {Telegram,Message} from '../src/telegram.js';
import {captureOriginalRequestContext} from '../src/request-context.js';

describe('Scheduled text and deferred-task resource boundaries',()=>{
  let db:TestDB,h:ReturnType<typeof harness>;
  beforeEach(async()=>{db=new TestDB();await db.init();h=harness(db);await paired(h);});
  afterEach(async()=>{mock.restoreAll();await db.close();});

  async function nativeSource(request:Message){
    const source=await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,$2,'Synthetic','user',$3,$4) RETURNING id",[request.message_id,String(request.from!.id),request.text,String(request.message_thread_id||0)]);
    await captureOriginalRequestContext(db,Number(source!.id),request,{namespaceChatId:'-100',sourceTopicId:String(request.message_thread_id||0)});
    return Number(source!.id);
  }
  async function schedule(mode:'reminder'|'task',authorization:'explicit'|'ask'='explicit',topic=7){
    const text='Нагадай browser.open, document.preview_pdf, FFmpeg — це лише назви інструментів у тексті.';
    const request=message(text).message!;request.message_thread_id=topic;
    const sourceId=await nativeSource(request);
    await db.tx(sql=>saveSchedule(sql,{kind:'schedule',title:'Synthetic reminder title',instruction:text,mode,due_at:new Date(Date.now()+3600000).toISOString(),timezone:'Europe/Kyiv',authorization,quote:text},request,sourceId,request.message_id,0));
    return {row:(await one(db,'SELECT * FROM scheduled_actions WHERE source_message_id=$1',[sourceId]))!,request,text};
  }
  async function due(id:string){await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 second' WHERE id=$1",[id]);}
  async function expectNoToolWork(){
    for(const table of ['agent_tasks','tool_runs','media_jobs'])assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n,0,table);
    assert.equal(h.brain.calls.length,0);
  }

  it('keeps a committed reminder successful when the telemetry sink fails',async()=>{
    const {row}=await schedule('reminder');await due(row.id);
    mock.method(console,'log',()=>{throw Error('synthetic_sink_unavailable');});
    assert.equal(await dispatchSchedules(db),1);
    assert.equal(await dispatchSchedules(db),0);
    assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[row.id]))!.status,'queued');
    assert.equal((await db.query('SELECT id FROM outbox')).rows.length,1);
  });

  it('delivers tool-like reminder text once without planning or creating resource work',async()=>{
    const {row,text}=await schedule('reminder');
    assert.equal(await dispatchSchedules(db),0);await due(row.id);
    const logs=mock.method(console,'log',()=>{});
    assert.equal(await dispatchSchedules(db),1);assert.equal(await dispatchSchedules(db),0);
    await expectNoToolWork();
    const queued=(await one(db,"SELECT * FROM outbox WHERE dedup_key LIKE 'scheduled:%'"))!;
    assert.equal(queued.kind,'text');assert.equal(queued.body.text,'Нагадування: '+text);assert.equal(queued.body.threadId,7);assert.equal(queued.actor_id,'11');
    const delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);
    assert.equal(await delivery.next('text'),true);assert.equal(await delivery.next('text'),false);
    assert.equal(h.tg.sent.filter(item=>item.text==='Нагадування: '+text).length,1);
    assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[row.id]))!.status,'completed');
    await expectNoToolWork();
    assert.equal(logs.mock.calls.length,1);
    const event=JSON.parse(String(logs.mock.calls[0]!.arguments[0]));
    assert.deepEqual(Object.keys(event).sort(),['duration_ms','event','max_lateness_ms','reminders','tasks']);
    assert.equal(event.event,'scheduled_dispatch');assert.equal(event.reminders,1);assert.equal(event.tasks,0);assert.ok(event.max_lateness_ms>=0);assert.ok(event.duration_ms>=0);
    assert.ok(!JSON.stringify(event).includes(text));assert.ok(!JSON.stringify(event).includes(row.id));
  });

  it('creates one deferred task only when due and records its mode without executing tools',async()=>{
    const {row}=await schedule('task');
    assert.equal(await dispatchSchedules(db),0);assert.equal((await db.query('SELECT * FROM agent_tasks')).rows.length,0);
    await due(row.id);const logs=mock.method(console,'log',()=>{});
    assert.equal(await dispatchSchedules(db),1);assert.equal(await dispatchSchedules(db),0);
    const tasks=(await db.query('SELECT * FROM agent_tasks')).rows;
    assert.equal(tasks.length,1);assert.equal(tasks[0]!.topic_id,'7');assert.equal(tasks[0]!.actor_id,'11');
    assert.ok(new Date(tasks[0]!.deadline).getTime()>Date.now()+25*60000);
    assert.equal((await db.query('SELECT * FROM tool_runs')).rows.length,0);assert.equal(h.brain.calls.length,0);
    const event=JSON.parse(String(logs.mock.calls[0]!.arguments[0]));assert.equal(event.reminders,0);assert.equal(event.tasks,1);
  });

  it('does not dispatch cancelled, expired-unconfirmed, paused or stale-revision schedules',async()=>{
    const cancelled=await schedule('reminder');await due(cancelled.row.id);
    const cancel=message(`Скасуй нагадування ${cancelled.row.id}`).message!;cancel.message_thread_id=7;const cancelSource=await nativeSource(cancel);
    await db.tx(sql=>scheduleDecision(sql,{kind:'schedule_decision',id:cancelled.row.id,decision:'cancel',quote:cancel.text!},cancel,0,{sourceId:cancelSource}));
    const expired=await schedule('reminder','ask');await due(expired.row.id);
    await db.query("UPDATE scheduled_actions SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.row.id]);
    const stale=await schedule('reminder');await due(stale.row.id);await db.query('UPDATE scheduled_actions SET revision=1 WHERE id=$1',[stale.row.id]);
    const paused=await schedule('reminder');await due(paused.row.id);await db.query('UPDATE app_state SET paused=true');
    const logs=mock.method(console,'log',()=>{});
    assert.equal(await dispatchSchedules(db),0);await db.query('UPDATE app_state SET paused=false');
    await db.query("UPDATE scheduled_actions SET status='cancelled' WHERE id=$1",[paused.row.id]);
    assert.equal(await dispatchSchedules(db),0);await expectNoToolWork();
    assert.equal((await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'scheduled:%'")).rows.length,0);assert.equal(logs.mock.calls.length,0);
    assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[expired.row.id]))!.status,'expired');
  });

  it('keeps a recurring private reminder private and rejects a changed series actor',async()=>{
    async function recurringPrivate(actor:string){
      const scheduled=await schedule('reminder'),series=randomUUID();await due(scheduled.row.id);
      await db.query("INSERT INTO recurring_series(id,actor_id,topic_id,rule,status,revision,audience) VALUES($1,$2,'7',$3,'active',0,'private')",[series,actor,JSON.stringify({mode:'reminder'})]);
      await db.query("INSERT INTO recurring_occurrences(series_id,occurrence_key,due_at,status,schedule_id) VALUES($1,'synthetic',now()-interval '1 second','scheduled',$2)",[series,scheduled.row.id]);
      return scheduled;
    }
    const own=await recurringPrivate('11'),changed=await recurringPrivate('22');mock.method(console,'log',()=>{});
    assert.equal(await dispatchSchedules(db),1);
    const outbound=(await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'scheduled:%'")).rows;
    assert.equal(outbound.length,1);assert.equal(outbound[0]!.audience,'private');assert.equal(outbound[0]!.actor_id,'11');
    assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[changed.row.id]))!.status,'cancelled');
    const delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);assert.equal(await delivery.next('text'),true);
    assert.equal(h.tg.sent.at(-1)!.chatId,'11');assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[own.row.id]))!.status,'completed');
    await expectNoToolWork();
  });

  it('rolls back dispatch without logging committed work when the transaction fails',async()=>{
    const {row}=await schedule('reminder');await due(row.id);const logs=mock.method(console,'log',()=>{});
    const failing={...db,query:db.query.bind(db),close:db.close.bind(db),tx:async<T>(run:Parameters<TestDB['tx']>[0]):Promise<T>=>db.tx(async sql=>{await run(sql);throw Error('synthetic_rollback');})};
    await assert.rejects(()=>dispatchSchedules(failing),/synthetic_rollback/);
    assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[row.id]))!.status,'pending');
    assert.equal((await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'scheduled:%'")).rows.length,0);assert.equal(logs.mock.calls.length,0);
  });
});
