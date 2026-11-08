import {it} from 'node:test';
import assert from 'node:assert/strict';
import {Temporal} from '@js-temporal/polyfill';
import {TestDB,harness,paired,message} from './helpers.js';
import {Recurring,occurrences} from '../src/recurring.js';
import {Delivery} from '../src/delivery.js';
import {dispatchSchedules} from '../src/scheduling.js';
import type {Telegram} from '../src/telegram.js';
import {Lumen} from '../src/engine.js';
import type {Media} from '../src/media.js';

async function setup(){const db=new TestDB();await db.init();const h=harness(db);await paired(h);await db.query('UPDATE app_state SET open_group=true,mention_only=true,quiet_start=0,quiet_end=0');await h.lumen.receive(message('Я теж тут',22));return {db,h,delivery:new Delivery(db,h.tg as unknown as Telegram,h.config)};}
function rule(){return {title:'Картопля',instruction:'картоплю',mode:'reminder' as const,timezone:'Europe/Kyiv',start_date:Temporal.Now.plainDateISO('Europe/Kyiv').add({days:1}).toString(),time:'04:00',frequency:'daily' as const,interval:1,dst:'reject' as const};}
async function create(h:ReturnType<typeof harness>){
  const text='Люмен, нагадуй нам обом щодня о 04:00 про картоплю.',r=rule();
  h.brain.replies.push({reply:'',actions:[{kind:'schedule',title:r.title,instruction:r.instruction,mode:'reminder',timezone:r.timezone,due_at:occurrences(r,new Date().toISOString(),1)[0]!.due,authorization:'explicit',quote:text,recurrence:r,shared:true}]});
  const update=message(text);update.message!.chat.is_forum=true;await h.lumen.receive(update);await h.lumen.processNext();return update;
}
it('one daily04 shared series → one group delivery → named participant stops all future repetitions → replay is harmless',async()=>{
  const {db,h,delivery}=await setup();try{
    await create(h);let rows=(await db.query('SELECT * FROM recurring_series')).rows;assert.equal(rows.length,1);assert.equal(rows[0]!.status,'active');assert.equal(rows[0]!.shared,true);assert.deepEqual(rows[0]!.manager_ids,['22']);assert.equal((await db.query('SELECT id FROM interactions')).rows.length,0);
    await delivery.next();h.tg.sent.length=0;
    await new Recurring(db).tick();assert.equal((await db.query('SELECT id FROM scheduled_actions')).rows.length,1);
    await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 minute'");assert.equal(await dispatchSchedules(db),1);await delivery.next();assert.equal(h.tg.sent.length,1);assert.match(h.tg.sent[0]!.text,/Нагадування: картоплю/);assert.equal(h.tg.options.at(-1)!.threadId,undefined);
    const inspect=message('/reminders',22);await h.lumen.receive(inspect);const list=(await db.query("SELECT body FROM outbox WHERE dedup_key LIKE $1",['control:'+inspect.update_id+':%'])).rows;
    assert.equal(list.length,1);assert.equal(list[0]!.body.text.split('\n').filter((x:string)=>/Картопля|картоплю/.test(x)).length,1);
    const cancel=message('Люмен, видали ці нагадування про картоплю нарешті🙃 Для обох, і для мене і для Гравця А.',22);
    const calls=h.brain.calls.length;await h.lumen.receive(cancel);await h.lumen.receive(cancel);assert.equal(h.brain.calls.length,calls);
    rows=(await db.query('SELECT status,version FROM recurring_series')).rows;assert.equal(rows[0]!.status,'ended');assert.equal(rows[0]!.version,2);
    await new Recurring(db).tick();assert.equal(await dispatchSchedules(db),0);assert.equal((await db.query("SELECT id FROM scheduled_actions WHERE status IN ('pending','queued','needs_input')")).rows.length,0);
  }finally{await db.close();}
});
it('/cancel series UUID ends it; name clarification persists and unaddressed whole-series reply completes it',async()=>{
  for(const byId of [false,true]){const {db,h}=await setup();try{
    await create(h);const series=(await db.query('SELECT id FROM recurring_series')).rows[0]!;
    await h.lumen.receive(message('/cancel '+(byId?series.id:'Картопля')));
    if(!byId){assert.equal((await db.query('SELECT * FROM reminder_clarifications')).rows.length,1);await h.lumen.receive(message('всю серію'));}
    assert.equal((await db.query('SELECT status FROM recurring_series')).rows[0]!.status,'ended');assert.equal((await db.query('SELECT * FROM reminder_clarifications')).rows.length,0);
  }finally{await db.close();}}
});
it('redundant reminder activity offer becomes one explicit series, while quoted cancellation never claims success',async()=>{
  const {db,h}=await setup();try{
    const text='Люмен, нагадуй нам обом щодня о 04:00 про картоплю.',r=rule();
    h.brain.replies.push({reply:'',actions:[],offer:{title:'Нагадування',reason:'Час',value:'Не забути',scale:'Щодня',first_step:'Додамо нагадування',scope:'invited',participant_ids:['11','22'],action:{kind:'tool',name:'schedule.series',arguments:JSON.stringify({operation:'preview',rule:r})}}});
    // The second turn only reports the actual tool result.
    h.brain.replies.push({reply:'Серію створено.',actions:[]});await h.lumen.receive(message(text));await h.lumen.processNext();
    assert.equal((await db.query('SELECT * FROM recurring_series')).rows.length,1);assert.equal((await db.query('SELECT * FROM interactions')).rows.length,0);
    const quoted=message('Люмен, видали всі нагадування про картоплю',22);quoted.message!.entities=[{type:'blockquote',offset:0,length:quoted.message!.text!.length}];
    h.brain.replies.push({reply:'Готово, нагадування видалив.',actions:[{kind:'cancel_reminder',query:'картоплю',all:true}]});await h.lumen.receive(quoted);await h.lumen.processNext();
    assert.equal((await db.query('SELECT status FROM recurring_series')).rows[0]!.status,'active');
    const output=(await db.query("SELECT body FROM outbox WHERE dedup_key LIKE $1",['answer:'+quoted.update_id+':%'])).rows.map(x=>x.body.text).join('\n');assert.doesNotMatch(output,/Готово|видалив/);
  }finally{await db.close();}
});
it('an addressed voice request keeps the existing scheduling path with a grounded transcription receipt',async()=>{
  const {db,h}=await setup();try{
    const text='Люмен, нагадуй нам обом щодня о 04:00 про картоплю.';
    const media={transcribe:async()=>text} as unknown as Media;
    const lumen=new Lumen(db,{...h.config,apiKey:'synthetic-test-only',transcribeModel:'synthetic-transcriber'},h.tg as unknown as Telegram,h.brain,{id:999,username:'lumen_test_bot',can_read_all_group_messages:true},media);
    const r=rule();h.brain.replies.push({reply:'',actions:[{kind:'schedule',title:r.title,instruction:r.instruction,mode:'reminder',timezone:r.timezone,due_at:occurrences(r,new Date().toISOString(),1)[0]!.due,authorization:'explicit',quote:text,recurrence:r,shared:true}]});
    const update=message('');delete update.message!.text;update.message!.voice={file_id:'actual-synthetic-voice'};update.message!.reply_to_message={message_id:99001,from:{id:999,first_name:'Люмен',is_bot:true}};
    await lumen.receive(update);await lumen.processNext();
    const series=(await db.query('SELECT status,shared,manager_ids FROM recurring_series')).rows;assert.equal(series.length,1);assert.equal(series[0]!.status,'active');assert.equal(series[0]!.shared,true);assert.deepEqual(series[0]!.manager_ids,['22']);
    const attachment=(await db.query("SELECT metadata FROM attachments WHERE file_id='actual-synthetic-voice'")).rows[0]!;assert.equal(attachment.metadata.reminder_transcription.modality,'voice_transcription');assert.equal(attachment.metadata.reminder_transcription.authored,true);
  }finally{await db.close();}
});
