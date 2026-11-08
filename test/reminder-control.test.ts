import {describe,it,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TestDB,harness,paired,message} from './helpers.js';
import {one,queueText} from '../src/db.js';
import {createReminderSeries,Recurring,SeriesRule,occurrences} from '../src/recurring.js';
import {cancelReminderRequest,listReminders,resolveReminders,reminderMetadata,recordReminderTranscription,reminderRequestSource,privateReminderCue} from '../src/reminder-control.js';
import {captureOriginalRequestContext} from '../src/request-context.js';
import {dispatchSchedules} from '../src/scheduling.js';
import {Delivery} from '../src/delivery.js';
import {Telegram,type Message} from '../src/telegram.js';
import type {ToolContext} from '../src/agent-tools.js';

describe('shared reminder logical roots and cancellation authority',()=>{
 let db:TestDB,h:ReturnType<typeof harness>;
 before(async()=>{db=new TestDB();await db.init();});after(async()=>{await db.close();});
 beforeEach(async()=>{
  await db.reset();await db.query('TRUNCATE recurring_series CASCADE');h=harness(db);await paired(h);
  await db.query("INSERT INTO members(user_id,name) VALUES('11','Гравець А'),('22','Пані Калина') ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,active=true");
 });
 async function source(text:string,uid=11,topic='0',extra:Partial<Message>={}):Promise<ToolContext>{
  const u=message(text,uid);Object.assign(u.message!,{...extra,...(topic!=='0'?{message_thread_id:Number(topic)}:{})});
  const m=u.message!,row=(await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id,created_at) VALUES($1,$2,$3,'user',$4,$5,$6) RETURNING id",[m.message_id,String(uid),m.from!.first_name,text,topic,new Date(m.date*1000)]))!;
  assert.ok(await captureOriginalRequestContext(db,Number(row.id),m,{namespaceChatId:'-100',sourceTopicId:topic}));
  return {actorId:String(uid),chatId:'-100',topicId:topic,revision:0,sourceId:Number(row.id),updateId:String(u.update_id),requested:true,requestText:text,audience:'group'};
 }
 function rule(title='Картопля'){
  return SeriesRule.parse({title,instruction:'З’їсти картоплю',mode:'reminder',timezone:'Europe/Kyiv',start_date:new Date(Date.now()+86400000).toISOString().slice(0,10),time:'04:00',frequency:'daily'});
 }
 async function create(text='Люмен, щодня о 04:00 нагадуй нам про картоплю для обох.',input=rule(),uid=11){
  const c=await source(text,uid);return {c,row:await db.tx(sql=>createReminderSeries(sql,input,c,{quote:text}))};
 }
 async function cancel(text:string,c:ToolContext,other:Partial<Parameters<typeof cancelReminderRequest>[1]>={}){
  return db.tx(sql=>cancelReminderRequest(sql,{text,...other},c));
 }
 async function voiceSource(transcript:string,extra:Partial<Message>={}){
  const u=message('[голосове]');delete u.message!.text;
  Object.assign(u.message!,{voice:{file_id:'actual-received-voice:'+u.update_id,mime_type:'audio/ogg'},...extra});
  const m=u.message!,row=(await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,'11','Гравець А','user','[голосове]','0') RETURNING id",[m.message_id]))!;
  const c:ToolContext={actorId:'11',chatId:'-100',topicId:'0',revision:0,sourceId:Number(row.id),updateId:String(u.update_id),requested:true,requestText:transcript,audience:'group'};
  await db.tx(sql=>recordReminderTranscription(sql,m,Number(row.id),transcript,0,'-100'));
  return {c,m};
 }
 async function manualSeries(actor='11',extra:Record<string,unknown>={}){
  const id=randomUUID();await db.query("INSERT INTO recurring_series(id,actor_id,topic_id,rule,revision,status,audience,shared,manager_ids) VALUES($1,$2,'0',$3,0,'active',$4,$5,$6)",[id,actor,JSON.stringify(rule()),extra.audience||'group',extra.shared||false,JSON.stringify(extra.manager_ids||[])]);return id;
 }
 it('creates one daily04 root and one actual group delivery; per-step retry does not create another root',async()=>{
  const {c,row}=await create();
  const retry=await db.tx(sql=>createReminderSeries(sql,rule(),{...c,operationKey:'a-different-model-tool-step'},{quote:c.requestText!}));
  assert.equal(retry.id,row.id);assert.equal(row.shared,true);assert.deepEqual(row.manager_ids,['22']);
  const narrowerQuote=await db.tx(sql=>createReminderSeries(sql,rule(),{...c,operationKey:'another-step'},{quote:'нагадуй нам про картоплю'}));
  assert.equal(narrowerQuote.id,row.id);assert.deepEqual(narrowerQuote.manager_ids,['22']);
  assert.equal((await one(db,'SELECT count(*) AS n FROM recurring_series'))!.n,1);
  const rec=new Recurring(db);await rec.tick();
  const first=(await one(db,'SELECT * FROM recurring_occurrences WHERE series_id=$1 ORDER BY due_at LIMIT 1',[row.id]))!;
  await db.query("UPDATE recurring_occurrences SET due_at=now()-interval '1 second' WHERE series_id=$1 AND occurrence_key=$2",[row.id,first.occurrence_key]);
  if(first.schedule_id)await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 second' WHERE id=$1",[first.schedule_id]);
  await new Recurring(db).tick();
  assert.equal(await dispatchSchedules(db),1);
  const delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);await delivery.next();
  assert.equal(h.tg.sent.filter(x=>x.text==='Нагадування: З’їсти картоплю').length,1);
  assert.equal(h.tg.sent.at(-1)!.chatId,'-100');
  assert.equal((await db.query("SELECT id FROM outbox WHERE status='sent' AND dedup_key LIKE 'scheduled:%'")).rows.length,1);
  assert.equal((await listReminders(db,c)).filter(x=>x.ref==='series:'+row.id).length,1);
  assert.equal((await listReminders(db,c)).filter(x=>x.kind==='occurrence').length,0);
 });
 it('a plain new group request is shared without requiring the word both or polling participants',async()=>{
  const {row}=await create('Люмен, нагадуй щодня о 04:00 про картоплю.');
  assert.equal(row.shared,true);assert.deepEqual(row.manager_ids,[]);
  assert.equal((await one(db,'SELECT count(*) AS n FROM interactions'))!.n,0);
 });
 it('an authored private cue narrows delivery to the author; shared=false alone does not silently move it to DM',async()=>{
  const text='Люмен, щодня нагадуй мені приватно про воду.',c=await source(text);
  assert.deepEqual(await reminderMetadata(db,c,{quote:text}),{shared:false,manager_ids:[],audience:'private'});
  const ordinary=await source('Люмен, щодня нагадуй про воду.');
  assert.deepEqual(await reminderMetadata(db,ordinary,{shared:false,quote:ordinary.requestText!}),{shared:false,manager_ids:[],audience:'group'});
 });
 it('negative/private-group cues do not silently authorize DM and contradictory cues require clarification',async()=>{
  const text='Люмен, щодня нагадуй у чаті, не приватно, про воду.',c=await source(text);
  assert.deepEqual(await reminderMetadata(db,c,{quote:text}),{shared:true,manager_ids:[],audience:'group'});
  assert.deepEqual(privateReminderCue('Люмен, щодня нагадуй у приватній групі про воду.'),{private:false,ambiguous:false});
  assert.deepEqual(privateReminderCue('Люмен, щодня нагадуй мені приватно у чаті про воду.'),{private:false,ambiguous:true});
  const ambiguous=await source('Люмен, щодня нагадуй мені приватно у чаті про воду.');
  await assert.rejects(()=>reminderMetadata(db,ambiguous,{quote:ambiguous.requestText!}));
 });
 it('the Russian public-delivery word is not mistaken for a private cue embedded inside it',async()=>{
  const text='Люмен, напоминай публично каждый день про воду.',c=await source(text);
  assert.deepEqual(await reminderMetadata(db,c,{quote:text}),{shared:true,manager_ids:[],audience:'group'});
  assert.equal((await db.tx(sql=>createReminderSeries(sql,{...rule('Вода'),instruction:'Выпить воду'},c,{quote:text}))).status,'active');
 });
 it('the Russian pronoun мне before напоминай is not mistaken for a negated imperative',async()=>{
  const text='Люмен, мне напоминай ежедневно про воду.',c=await source(text);
  assert.equal((await db.tx(sql=>createReminderSeries(sql,{...rule('Вода'),instruction:'Выпить воду'},c,{quote:text}))).status,'active');
 });
 it('names in the actual reminder clause authorize the known participant, including Ukrainian inflection',async()=>{
  const {row}=await create('Люмен, щодня нагадуй про картоплю для мене і Пані Калини.');
  assert.deepEqual(row.manager_ids,['22']);
  const text='Люмен, видали ці нагадування про картоплю нарешті🙃 Для обох, і для мене і для Пані Калини.';
  const c=await source(text,22),result=await cancel(text,c);
  assert.equal(result.status,'cancelled');assert.match(result.message,/Майбутні повтори зупинив/u);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[row.id]))!.status,'ended');
  assert.equal(await new Recurring(db).tick(),false);
 });
 for(const subject of ['день народження Пані Калини','повернення книжки Пані Калини','подарунок для Пані Калини'])it(`a name in the reminder subject (${subject}) is not a manager grant`,async()=>{
  const {row}=await create('Люмен, щодня нагадуй про '+subject+'.');
  assert.deepEqual(row.manager_ids,[]);
  const c=await source('Люмен, видали всі нагадування про '+subject+'.',22);
  assert.equal((await cancel(c.requestText!,c)).status,'not_found');
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[row.id]))!.status,'active');
 });
 it('a pre-subject named recipient is distinct from the gift recipient in a subject',async()=>{
  const {row}=await create('Люмен, щодня о 04:00 нагадуй для Пані Калини про картоплю.');
  assert.deepEqual(row.manager_ids,['22']);
 });
 it('old group rows, strangers, private reminders and a different topic retain their authority fences',async()=>{
  const old=await manualSeries('11'),priv=await manualSeries('11',{audience:'private',shared:true,manager_ids:['22']}),shared=await manualSeries('11',{shared:true,manager_ids:['22']});
  const c=await source('Люмен, видали всі нагадування про картоплю.',22);
  assert.deepEqual((await listReminders(db,c)).map(r=>r.id),[shared]);
  assert.deepEqual(await resolveReminders(db,{...c,administrator:true},{id:priv}),[]);
  assert.deepEqual(await resolveReminders(db,{...c,administrator:true},{id:old}),[]);
  assert.deepEqual(await resolveReminders(db,{...c,topicId:'101'},{id:shared}),[]);
  await db.query("INSERT INTO members(user_id,name) VALUES('33','Гість')");
  const stranger=await source('Люмен, видали всі нагадування про картоплю.',33);
  assert.equal((await cancel(stranger.requestText!,stranger)).status,'not_found');
  assert.equal((await cancel(stranger.requestText!,{...stranger,administrator:true})).status,'cancelled');
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[shared]))!.status,'ended');
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[priv]))!.status,'active');
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[old]))!.status,'active');
 });
 it('the author can stop a private group-origin reminder by literal ID without exposing it in public lists or receipts',async()=>{
  const {row}=await create('Люмен, щодня нагадуй мені приватно про картоплю.');
  assert.equal(row.shared,false);assert.equal((await one(db,'SELECT audience FROM recurring_series WHERE id=$1',[row.id]))!.audience,'private');
  const c=await source('/cancel '+row.id);assert.deepEqual(await listReminders(db,c),[]);assert.deepEqual(await resolveReminders(db,c,{id:row.id}),[]);
  const other=await source('/cancel '+row.id,22);assert.equal((await cancel(other.requestText!,{...other,administrator:true},{id:row.id})).status,'not_found');
  await assert.rejects(()=>cancel(c.requestText!,{...c,topicId:'101'},{id:row.id}));
  await assert.rejects(()=>cancel(c.requestText!,{...c,chatId:'-200'},{id:row.id}));
  const result=await cancel(c.requestText!,c,{id:row.id});assert.equal(result.status,'cancelled');assert.doesNotMatch(result.message,/Картопля|картоплю|04:00/u);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[row.id]))!.status,'ended');
 });
 it('an explicit own-private name query stops only private roots and gives a content-free receipt',async()=>{
  const priv=await create('Люмен, щодня нагадуй мені приватно про картоплю.'),pub=await create();
  const c=await source('Люмен, видали всі мої приватні нагадування про картоплю.');
  const result=await cancel(c.requestText!,c);assert.equal(result.status,'cancelled');assert.doesNotMatch(result.message,/картоп|04:00/iu);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[priv.row.id]))!.status,'ended');
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[pub.row.id]))!.status,'active');
 });
 it('a negative private qualifier targets the public reminder rather than the same-title private one',async()=>{
  const priv=await create('Люмен, щодня нагадуй мені приватно про картоплю.'),pub=await create();
  const c=await source('Люмен, видали всі не приватні нагадування про картоплю.');
  assert.equal((await cancel(c.requestText!,c)).status,'cancelled');
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[priv.row.id]))!.status,'active');
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[pub.row.id]))!.status,'ended');
 });
 it('ambiguous private cancellation keeps candidate content hidden and an affirmative bound all answer can finish',async()=>{
  const a=await create('Люмен, щодня нагадуй мені приватно про картоплю.'),b=await create('Люмен, щодня нагадуй мені приватно про картоплю.');
  const c=await source('Люмен, скасуй моє приватне нагадування про картоплю.');const question=await cancel(c.requestText!,c);
  assert.equal(question.status,'needs_input');assert.doesNotMatch(question.message,/картоп|04:00/iu);
  const result=await cancel('усі',await source('усі'));assert.equal(result.status,'cancelled');
  for(const id of [a.row.id,b.row.id])assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[id]))!.status,'ended');
 });
 it('an explicit series UUID ends the root; a materialized UUID preserves occurrence-only scope',async()=>{
  const {row,c}=await create();await new Recurring(db).tick();
  const o=await one(db,'SELECT schedule_id FROM recurring_occurrences WHERE series_id=$1 AND schedule_id IS NOT NULL LIMIT 1',[row.id]);
  if(o?.schedule_id){assert.equal((await resolveReminders(db,c,{id:o.schedule_id}))[0]!.ref,'occurrence:'+o.schedule_id);assert.equal((await resolveReminders(db,c,{id:o.schedule_id,scope:'series'}))[0]!.ref,'series:'+row.id);}
  const text='/cancel '+row.id,request=await source(text);
  assert.equal((await cancel(text,request,{id:row.id})).status,'cancelled');
  const replay=await db.tx(sql=>createReminderSeries(sql,rule(),c,{quote:c.requestText!}));
  assert.equal(replay.status,'ended','replaying the old create may not resurrect an ended series');
 });
 it('numeric legacy and standalone UUID cancellation use the same controller',async()=>{
  const legacy=(await one(db,"INSERT INTO reminders(title,due_at,author_id) VALUES('Вода',now()+interval '1 hour','11') RETURNING id"))!;
  let text='/cancel '+legacy.id,c=await source(text);assert.equal((await cancel(text,c,{id:legacy.id})).status,'cancelled');
  const id=randomUUID();await db.query("INSERT INTO scheduled_actions(id,dedup_key,author_id,topic_id,title,instruction,mode,due_at,timezone,status,action_hash,revision,expires_at) VALUES($1::uuid,$1::text,'11','0','Вода','Випити воду','reminder',now()+interval '1 hour','Europe/Kyiv','pending','hash',0,now()+interval '1 hour')",[id]);
  text='/cancel '+id;c=await source(text);assert.equal((await cancel(text,c,{id})).status,'cancelled');
  assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[id]))!.status,'cancelled');
 });
 it('query filtering finds an older matching reminder beyond the display window',async()=>{
  const old=(await one(db,"INSERT INTO reminders(title,due_at,author_id,created_at) VALUES('Картопля',now()+interval '1 hour','11',now()-interval '1 day') RETURNING id"))!;
  await db.query("INSERT INTO reminders(title,due_at,author_id) SELECT 'Інший запис '||n,now()+interval '1 hour','11' FROM generate_series(1,60) n");
  const c=await source('Люмен, видали нагадування про картоплю.');
  const shown=await listReminders(db,c);assert.equal(shown.truncated,true);assert.equal(shown.some(r=>r.id===String(old.id)),false);
  const found=await resolveReminders(db,c,{query:'картоплю'});assert.equal(found.truncated,false);assert.deepEqual(found.map(r=>r.id),[String(old.id)]);
  assert.equal((await cancel(c.requestText!,c)).status,'cancelled');
  assert.equal((await one(db,"SELECT count(*) AS n FROM reminders WHERE status='pending'"))!.n,60);
 });
 it('bulk cancellation over the bounded matching window makes no partial change or false completeness claim',async()=>{
  await db.query("INSERT INTO reminders(title,due_at,author_id) SELECT 'Картопля '||n,now()+interval '1 hour','11' FROM generate_series(1,101) n");
  const c=await source('Люмен, видали всі нагадування про картоплю.');
  const found=await resolveReminders(db,c,{query:'картоплю'});assert.equal(found.truncated,true);
  assert.equal((await cancel(c.requestText!,c)).status,'needs_input');
  assert.equal((await one(db,"SELECT count(*) AS n FROM reminders WHERE status='pending'"))!.n,101);
  assert.equal((await one(db,'SELECT count(*) AS n FROM domain_commands'))!.n,0);
 });
 it('a name clarification is stored, ignores generic yes, and whole-series continuation actually ends it',async()=>{
  const {row}=await create();let text='Люмен, скасуй нагадування про картоплю.',c=await source(text);
  assert.equal((await cancel(text,c)).status,'needs_input');
  assert.ok(await one(db,'SELECT * FROM reminder_clarifications WHERE actor_id=$1',['11']));
  text='так';c=await source(text);assert.equal((await cancel(text,c)).handled,false);
  text='усю серію';c=await source(text);assert.equal((await cancel(text,c)).status,'cancelled');
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[row.id]))!.status,'ended');
  assert.equal(await one(db,'SELECT * FROM reminder_clarifications'),undefined);
 });
 for(const text of ['Не всю серію.','А хто просив усю серію?','Якщо всю серію, то що буде?'])it(`a nonaffirmative clarification answer (${text}) cannot end the series`,async()=>{
  const {row}=await create();const initial=await source('Люмен, скасуй нагадування про картоплю.');await cancel(initial.requestText!,initial);
  const c=await source(text);assert.equal((await cancel(text,c)).handled,false);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[row.id]))!.status,'active');
 });
 it('an informational infinitive without punctuation is not a cancellation instruction',async()=>{
  const item=(await one(db,"INSERT INTO reminders(title,due_at,author_id) VALUES('Картопля',now()+interval '1 hour','11') RETURNING id"))!;
  const text='Люмен, які нагадування видалити',c=await source(text);
  assert.equal((await cancel(text,c)).handled,false);
  assert.equal((await one(db,'SELECT status FROM reminders WHERE id=$1',[item.id]))!.status,'pending');
 });
 it('a targeted polite cancellation works while an unrelated note deletion stays in its own domain',async()=>{
  const item=(await one(db,"INSERT INTO reminders(title,due_at,author_id) VALUES('Картопля',now()+interval '1 hour','11') RETURNING id"))!;
  const unrelated=await source('Люмен, видали нотатку про картоплю.');assert.equal((await cancel(unrelated.requestText!,unrelated)).handled,false);
  const text='Люмен, можеш видалити нагадування про картоплю?',c=await source(text);
  assert.equal((await cancel(text,c)).status,'cancelled');
  assert.equal((await one(db,'SELECT status FROM reminders WHERE id=$1',[item.id]))!.status,'cancelled');
 });
 it('clarification answers cannot cross actors/topics or survive version/source revocation',async()=>{
  const {row}=await create();let c=await source('Люмен, скасуй нагадування про картоплю.');await cancel(c.requestText!,c);
  assert.equal((await cancel('усю серію',await source('усю серію',22))).handled,false);
  assert.equal((await cancel('усю серію',await source('усю серію',11,'101'))).handled,false);
  await db.query('UPDATE recurring_series SET version=version+1 WHERE id=$1',[row.id]);
  assert.equal((await cancel('усю серію',await source('усю серію'))).status,'stale');
  c=await source('Люмен, скасуй нагадування про картоплю.');await cancel(c.requestText!,c);
  await db.query('DELETE FROM messages WHERE id=$1',[c.sourceId]);
  assert.equal((await cancel('усю серію',await source('усю серію'))).handled,false);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[row.id]))!.status,'active');
 });
 it('a whole-series answer replying to a different bot card is not applied to the pending question',async()=>{
  const {row}=await create();let c=await source('Люмен, скасуй нагадування про картоплю.');await cancel(c.requestText!,c);
  c=await source('усю серію',11,'0',{reply_to_message:{message_id:98765,from:{id:999,is_bot:true,first_name:'Люмен'}}});
  assert.equal((await cancel(c.requestText!,c)).handled,false);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[row.id]))!.status,'active');
 });
 it('same title/time in independent requests stays distinct, while explicit plural stops only authorized roots',async()=>{
  const a=await create(),b=await create();assert.notEqual(a.row.id,b.row.id);
  const untouched=await manualSeries('22');
  const c=await source('Люмен, видали всі нагадування про картоплю.');const result=await cancel(c.requestText!,c);
  assert.equal(result.roots!.length,2);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[untouched]))!.status,'active');
 });
 it('needs_input occurrences/review notices and pending delivery are stopped; sending and uncertain receipts remain truthful',async()=>{
  const {row}=await create();
  for(const [status,n] of [['pending',1],['uncertain',2],['sending',3]] as const){
   const id=randomUUID();await db.query("INSERT INTO scheduled_actions(id,dedup_key,author_id,topic_id,title,instruction,mode,due_at,timezone,status,action_hash,revision,expires_at) VALUES($1::uuid,$1::text,'11','0','Картопля','З’їсти картоплю','reminder',now(),'Europe/Kyiv','queued','hash',0,now()+interval '1 hour')",[id]);
   await db.query("INSERT INTO recurring_occurrences(series_id,occurrence_key,due_at,status,schedule_id) VALUES($1,$2,now(),'needs_input',$3)",[row.id,'sample:'+n,id]);
   await queueText(db,'Нагадування: картопля',0,'scheduled:'+id,false,{actorId:'11'});
   await db.query('UPDATE outbox SET status=$1 WHERE dedup_key LIKE $2',[status,'scheduled:'+id+':%']);
  }
  await queueText(db,'Переглянь пропущений запуск',0,'series-review:'+row.id+':missed:v1',false,{actorId:'11'});
  const c=await source('Люмен, видали всі нагадування про картоплю.');const result=await cancel(c.requestText!,c);
  assert.equal(result.inFlight,2);assert.equal(result.status,'stopped_with_in_flight');assert.match(result.message,/не видаю його за скасований/u);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[row.id]))!.status,'ended');
  assert.equal((await db.query("SELECT id FROM outbox WHERE status='pending'")).rows.length,0);
  assert.equal((await db.query("SELECT id FROM outbox WHERE status IN ('sending','uncertain')")).rows.length,2);
  assert.equal((await db.query("SELECT * FROM recurring_occurrences WHERE series_id=$1 AND status='cancelled'",[row.id])).rows.length,1);
 });
 it('only the next occurrence can be skipped without ending the parent',async()=>{
  const {row}=await create();await new Recurring(db).tick();
  const c=await source('Люмен, скасуй лише найближчий повтор нагадування про картоплю.');
  const result=await cancel(c.requestText!,c);assert.equal(result.status,'cancelled');
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[row.id]))!.status,'active');
  assert.equal((await db.query("SELECT * FROM recurring_occurrences WHERE series_id=$1 AND status='skipped'",[row.id])).rows.length,1);
 });
 it('an immediate nearest skip reserves the civil-time key before tick and replay cannot skip a second date',async()=>{
  const {row}=await create(),stored=(await one(db,'SELECT rule FROM recurring_series WHERE id=$1',[row.id]))!.rule;
  const first=occurrences(stored,new Date(Date.now()-1).toISOString(),2)[0]!,text='Люмен, скасуй лише найближчий повтор нагадування про картоплю.',c=await source(text);
  const result=await cancel(text,c);assert.equal(result.status,'cancelled');
  assert.deepEqual(await cancel(text,c),result);
  assert.equal((await one(db,'SELECT version FROM recurring_series WHERE id=$1',[row.id]))!.version,2);
  assert.equal((await db.query("SELECT * FROM recurring_occurrences WHERE series_id=$1 AND status='skipped'",[row.id])).rows.length,1);
  await new Recurring(db).tick();
  assert.equal((await one(db,'SELECT status FROM recurring_occurrences WHERE series_id=$1 AND occurrence_key=$2',[row.id,first.key]))!.status,'skipped');
  assert.ok((await db.query("SELECT occurrence_key FROM recurring_occurrences WHERE series_id=$1 AND status IN ('pending','scheduled')",[row.id])).rows.length>0);
 });
 it('a completed child is reconciled before choosing the next occurrence, preserving its sent history',async()=>{
  const {row}=await create();await new Recurring(db).tick();
  let first=(await one(db,'SELECT * FROM recurring_occurrences WHERE series_id=$1 ORDER BY due_at LIMIT 1',[row.id]))!;
  if(!first.schedule_id){await db.query("UPDATE recurring_occurrences SET due_at=now()-interval '1 second' WHERE series_id=$1 AND occurrence_key=$2",[row.id,first.occurrence_key]);await new Recurring(db).tick();first=(await one(db,'SELECT * FROM recurring_occurrences WHERE series_id=$1 AND occurrence_key=$2',[row.id,first.occurrence_key]))!;}
  await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 second' WHERE id=$1",[first.schedule_id]);await dispatchSchedules(db);await new Delivery(db,h.tg as unknown as Telegram,h.config).next();
  assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[first.schedule_id]))!.status,'completed');
  const c=await source('Люмен, скасуй лише найближчий повтор нагадування про картоплю.');assert.equal((await cancel(c.requestText!,c)).status,'cancelled');
  assert.equal((await one(db,'SELECT status FROM recurring_occurrences WHERE series_id=$1 AND occurrence_key=$2',[row.id,first.occurrence_key]))!.status,'completed');
  const skipped=(await db.query("SELECT occurrence_key FROM recurring_occurrences WHERE series_id=$1 AND status='skipped'",[row.id])).rows;assert.equal(skipped.length,1);assert.notEqual(skipped[0]!.occurrence_key,first.occurrence_key);
 });
 it('an uncertain occurrence is not claimed as cancelled and unclaimed sibling chunks are still stopped',async()=>{
  const {row}=await create(),id=randomUUID();
  await db.query("INSERT INTO scheduled_actions(id,dedup_key,author_id,topic_id,title,instruction,mode,due_at,timezone,status,action_hash,revision,expires_at) VALUES($1::uuid,$1::text,'11','0','Картопля','Картоплю','reminder',now()+interval '1 hour','Europe/Kyiv','queued','hash',0,now()+interval '2 hours')",[id]);
  await db.query("INSERT INTO recurring_occurrences(series_id,occurrence_key,due_at,status,schedule_id) VALUES($1,'claimed',now()+interval '1 hour','scheduled',$2)",[row.id,id]);
  await queueText(db,'Частина1',0,'scheduled:'+id,false,{actorId:'11'});await db.query("UPDATE outbox SET status='uncertain' WHERE dedup_key LIKE $1",['scheduled:'+id+':%']);
  await queueText(db,'Частина2',0,'scheduled:'+id+':remaining',false,{actorId:'11'});
  const text='/cancel '+id,c=await source(text),result=await cancel(text,c,{id,scope:'occurrence'});
  assert.equal(result.status,'stopped_with_in_flight');assert.doesNotMatch(result.message,/скасував/u);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[row.id]))!.status,'active');
  assert.equal((await db.query("SELECT id FROM outbox WHERE status='pending'")).rows.length,0);assert.equal((await db.query("SELECT id FROM outbox WHERE status='uncertain'")).rows.length,1);
 });
 it('a finite rule with no remaining future date gives an honest unchanged result',async()=>{
  const {row}=await create(undefined,{...rule(),count:1});let c=await source('Люмен, скасуй лише найближчий повтор нагадування про картоплю.');await cancel(c.requestText!,c);
  c=await source('Люмен, скасуй лише найближчий повтор нагадування про картоплю.');const result=await cancel(c.requestText!,c);
  assert.equal(result.status,'already_done');assert.doesNotMatch(result.message,/скасував/u);
  assert.equal((await one(db,'SELECT version FROM recurring_series WHERE id=$1',[row.id]))!.version,2);
 });
 it('a different nearest-skip operation invalidates an older clarification version',async()=>{
  const {row}=await create();const question=await source('Люмен, скасуй нагадування про картоплю.');await cancel(question.requestText!,question);
  const skip=await source('Люмен, скасуй лише найближчий повтор нагадування про картоплю.',22);await cancel(skip.requestText!,skip);
  const answer=await source('найближчий повтор');assert.equal((await cancel(answer.requestText!,answer)).status,'stale');
  assert.equal((await db.query("SELECT * FROM recurring_occurrences WHERE series_id=$1 AND status='skipped'",[row.id])).rows.length,1);
 });
 for(const kind of ['blockquote','code','forwarded','via_bot','negated'] as const)it(`${kind} does not create a series or cancel an existing one`,async()=>{
  const {row}=await create();const text=kind==='negated'?'Люмен, не видали всі нагадування про картоплю.':'Люмен, видали всі нагадування про картоплю.';
  const extra:Partial<Message>=kind==='blockquote'||kind==='code'?{entities:[{type:kind,offset:0,length:text.length}]}:kind==='forwarded'?{forward_origin:{type:'hidden_user'}} as Partial<Message>:kind==='via_bot'?{via_bot:{id:888,first_name:'Other',is_bot:true}} as Partial<Message>:{};
  const c=await source(text,11,'0',extra);
  if(kind==='forwarded'||kind==='via_bot')await assert.rejects(()=>cancel(text,c));else assert.equal((await cancel(text,c)).handled,false);
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[row.id]))!.status,'active');
  const createText='Люмен, щодня нагадуй про воду.';
  const created=await source(createText,11,'0',kind==='blockquote'||kind==='code'?{entities:[{type:kind,offset:0,length:createText.length}]}:extra);
  if(kind!=='negated')await assert.rejects(()=>db.tx(sql=>createReminderSeries(sql,rule('Вода'),created,{quote:createText})));
 });
 it('quoted or ambiguous names never grant manager authority; negative/other-source targets do not cancel',async()=>{
  await db.query("INSERT INTO members(user_id,name) VALUES('33','Пані Калина')");
  const {row}=await create('Люмен, щодня нагадуй про картоплю для Пані Калини.');assert.deepEqual(row.manager_ids,[]);
  const text='Люмен, щодня нагадуй про воду. Процитуй ім’я Пані Калина.';
  const c=await source(text);assert.deepEqual((await reminderMetadata(db,c,{quote:'Люмен, щодня нагадуй про воду.'})).manager_ids,[]);
  const wrong=await source('Люмен, видали нагадування про собак.');
  assert.equal((await cancel(wrong.requestText!,wrong,{id:row.id})).status,'needs_input');
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[row.id]))!.status,'active');
 });
 it('Russian and English explicit stop phrases use the same bound lifecycle',async()=>{
  const {row}=await create('Люмен, ежедневно в 04:00 напоминай про картошку для обоих.');
  const c=await source('Люмен, удали все напоминания про картоплю для обоих.');
  assert.equal((await cancel(c.requestText!,c)).status,'cancelled');
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[row.id]))!.status,'ended');
  const en=await create('Lumen, remind us about potatoes every day at 04:00.');
  const stop=await source('Lumen, delete all reminders about картопля.');
  assert.equal((await cancel(stop.requestText!,stop)).status,'cancelled');
  assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[en.row.id]))!.status,'ended');
 });
 it('a negated recurring request is not affirmative scheduling authority',async()=>{
  const c=await source('Люмен, не нагадуй щодня про воду.');
  await assert.rejects(()=>db.tx(sql=>createReminderSeries(sql,rule('Вода'),c,{quote:c.requestText!})));
  assert.equal((await one(db,'SELECT count(*) AS n FROM recurring_series'))!.n,0);
 });
 it('trusted voice transcription preserves scheduling/cancel while a missing or changed attachment cannot grant authority',async()=>{
  const transcript='Люмен, щодня о 04:00 нагадуй про картоплю для обох.',v=await voiceSource(transcript);
  assert.equal((await reminderRequestSource(db,v.c))!.modality,'voice_transcription');
  const row=await db.tx(sql=>createReminderSeries(sql,rule(),v.c,{quote:transcript}));assert.deepEqual(row.manager_ids,['22']);
  const stop='Люмен, видали всі нагадування про картоплю.',control=await voiceSource(stop);
  const attachment=(await one(db,'SELECT id FROM attachments WHERE source_message_id=$1',[control.c.sourceId]))!;
  await db.query("UPDATE attachments SET file_id='different-native-file' WHERE id=$1",[attachment.id]);
  await assert.rejects(()=>cancel(stop,control.c));
  await db.query('UPDATE attachments SET file_id=$1 WHERE id=$2',[control.m.voice!.file_id,attachment.id]);
  assert.equal((await cancel(stop,control.c)).status,'cancelled');
  const fake=await source('not a voice');await db.query("UPDATE messages SET body=$1,request_context=NULL WHERE id=$2",['[голосове] '+transcript,fake.sourceId]);
  await assert.rejects(()=>db.tx(sql=>createReminderSeries(sql,rule(),{...fake,requestText:transcript},{quote:transcript})));
 });
 for(const kind of ['forwarded','via_bot','edited'] as const)it(`${kind} voice proof cannot authorize a new reminder`,async()=>{
  const transcript='Люмен, щодня нагадуй про воду.',extra=kind==='forwarded'?{forward_origin:{type:'hidden_user'}} as Partial<Message>:kind==='via_bot'?{via_bot:{id:888,is_bot:true,first_name:'Other'}} as Partial<Message>:{};
  const v=await voiceSource(transcript,extra);
  if(kind==='edited')await db.query('UPDATE messages SET edited_at=now() WHERE id=$1',[v.c.sourceId]);
  await assert.rejects(()=>db.tx(sql=>createReminderSeries(sql,rule('Вода'),v.c,{quote:transcript})));
  assert.equal((await one(db,'SELECT count(*) AS n FROM recurring_series'))!.n,0);
 });
});
