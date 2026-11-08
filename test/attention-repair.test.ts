import {describe,it,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {TestDB,harness,paired,message} from './helpers.js';
import {one,state,pauseMemory} from '../src/db.js';
import {Delivery} from '../src/delivery.js';
import {Telegram,TelegramError} from '../src/telegram.js';
import {ambientGapSeconds,sameDiscussion,cancelAmbient} from '../src/attention.js';
import type {Plan} from '../src/model.js';

describe('Причинний ремонт уваги: eligibility → queued → actual delivery',()=>{
 let db:TestDB,h:ReturnType<typeof harness>,delivery:Delivery;
 beforeEach(async()=>{db=new TestDB();await db.init();h=harness(db);await paired(h);await db.query("UPDATE app_state SET open_group=true,mention_only=true,mode='quiet',quiet_start=0,quiet_end=0,proactive_mode='helpful',conversation_style='adaptive',proactive_gap_minutes=45,ambient_gap_seconds=120");delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);});
 afterEach(async()=>{await db.close();});
 const contribution=(reply:string):Plan=>({reply,actions:[],behavior:{move:'answer',recipient:'unspecified',relation:'ambient',reason:'Змістовне продовження розмови',contribution:{key:reply,summary:reply}},engagement:{respond:true,reason:'social'}});
 async function observe(text:string,uid=11,topic?:number){const u=message(text,uid);u.message!.message_thread_id=topic;await h.lumen.receive(u);return u;}
 async function ready(){await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");}
 async function answer(reply:string){h.brain.replies.push(contribution(reply));await ready();await h.lumen.processNext();}
 async function expireAttempt(){await db.query("UPDATE topic_attention SET checked_at=now()-interval '46 seconds'");await db.query("UPDATE app_state SET last_social_at=now()-interval '46 seconds'");await ready();}

 it('schema default120sec не маскується legacy45min; queued не є сказаним',async()=>{
  assert.equal(ambientGapSeconds(await state(db)),120);
  await observe('Картопля на кухні знову стала мемом');await answer('Картопля офіційно очолила кухню.');
  assert.equal((await one(db,'SELECT spoke_at FROM topic_attention'))!.spoke_at,null);
  assert.equal((await state(db)).last_bot_at,null);assert.equal(h.tg.sent.length,0);
  await delivery.next();assert.equal(h.tg.sent.length,1);assert.ok((await one(db,'SELECT spoke_at FROM topic_attention'))!.spoke_at);assert.ok((await state(db)).last_bot_at);
  await db.query("UPDATE topic_attention SET spoke_at=now()-interval '3 minutes',checked_at=now()-interval '46 seconds'");
  await observe('Картопля тепер ще й керує меню',22);await answer('Тоді картоплі час видати фартух.');await delivery.next();assert.equal(h.tg.sent.length,2);
 });
 it('після listen лишає одного latest кандидата і розглядає його без третьої події',async()=>{
  await observe('Ключі лежать на полиці');h.brain.replies.push({reply:'',actions:[],behavior:{move:'listen',recipient:'unspecified',relation:'ambient',reason:'Приводу відповідати немає'}});await ready();await h.lumen.processNext();
  const latest=await observe('Ключі з полиці переїхали до рюкзака',22);await observe('Ключі все-таки лишилися у рюкзаку',11);
  const pending=(await db.query("SELECT * FROM inbox WHERE status='pending'")).rows;assert.equal(pending.length,1);assert.ok(new Date(pending[0]!.available_at).getTime()>Date.now()+40000);assert.notEqual(pending[0]!.payload.message.message_id,latest.message!.message_id);
  assert.equal(h.brain.calls.length,1);await expireAttempt();h.brain.replies.push(contribution('Рюкзак переміг полицю у боротьбі за ключі.'));await h.lumen.processNext();await delivery.next();assert.equal(h.brain.calls.length,2);assert.equal(h.tg.sent.length,1);
 });
 it('same-discussion burst під час generation не спричиняє нескінченне discard',async()=>{
  await observe('Картопля на кухні знову стала мемом');await ready();let finish!:(p:Plan)=>void;h.brain.block=()=>new Promise(r=>{finish=r;});const running=h.lumen.processNext();while(!finish)await delay(1);
  await observe('Картоплю на кухні знову обговорюємо',22);await observe('Та картопля з кухні точно перемогла');finish(contribution('Картопля отримує звання директора кухні.'));await running;await delivery.next();
  assert.equal(h.brain.calls.length,1);assert.equal(h.tg.sent.length,1);assert.match(h.tg.sent[0]!.text,/Картопля/);
 });
 it('справжня зміна теми прибирає queued reply без spoken cooldown; latest не губиться',async()=>{
  await observe('Кумедна історія про картоплю');await answer('Картопля знову керує парадом.');
  await observe('Завтра обговоримо продаж машини',22);assert.equal(await delivery.next(),false);assert.equal(h.tg.sent.length,0);assert.equal((await one(db,'SELECT spoke_at FROM topic_attention'))!.spoke_at,null);assert.equal((await state(db)).last_bot_at,null);
  assert.equal((await db.query("SELECT * FROM inbox WHERE status='pending'")).rows.length,1);await expireAttempt();h.brain.replies.push(contribution('Для продажу машини варто зібрати історію обслуговування.'));await h.lumen.processNext();await delivery.next();assert.equal(h.tg.sent.length,1);
 });
 for(const [error,status] of [[new TelegramError('telegram_400'),'failed'],[new TelegramError('telegram_network',0,true),'uncertain']] as const){
  it(`${status} delivery не рахується spoken; uncertain не відкриває новий unsolicited ефект`,async()=>{
   await observe('Картопля почала нову кар’єру');await answer('Картопля отримала підвищення.');h.tg.failure=error;await delivery.next();
   assert.equal((await one(db,"SELECT status FROM outbox WHERE body->>'ambient'='true'"))!.status,status);assert.equal((await state(db)).last_bot_at,null);assert.equal((await one(db,'SELECT spoke_at FROM topic_attention'))!.spoke_at,null);
   if(status==='uncertain'){h.tg.failure=undefined;await expireAttempt();await observe('Картопля ще й очолила ресторан',22);await answer('Картопля відкрила ресторан.');assert.equal((await db.query("SELECT id FROM outbox WHERE status='pending'")).rows.length,0);assert.equal(h.tg.sent.length,0);}
  });
 }
 for(const mentionOnly of [true,false]){
  it(`один actor повертається до older bot discussion до10/16msgs, mention_only=${mentionOnly}`,async()=>{
   await db.query("UPDATE app_state SET mention_only=$1,open_group=$1,mode='social'",[mentionOnly]);
   await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,created_at,topic_id) VALUES(90001,'lumen','Люмен','assistant','Картопля у нашому експерименті стала хрусткою',now()-interval '3 days','202')");
   await observe('Картопля з експерименту знову вийшла хрусткою');h.brain.replies.push({...contribution('Тоді експеримент із картоплею пора повторити.'),actions:[{kind:'remember',content:'Непроханий запис'}]});await ready();await h.lumen.processNext();await delivery.next();
   assert.equal(h.brain.calls.length,1);assert.equal(h.tg.sent.length,1);assert.ok(JSON.parse(h.brain.calls[0]!.context).related_discussions.some((r:any)=>r.message_id===90001));assert.equal((await db.query('SELECT * FROM memories')).rows.length,0);
  });
  it(`off/addressed блокують social candidate, direct працює, mention_only=${mentionOnly}`,async()=>{
   await db.query("UPDATE app_state SET mention_only=$1,open_group=$1,mode='social'",[mentionOnly]);
   await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES(90002,'lumen','Люмен','assistant','Наше обговорення картоплі','0')");
   await db.query("UPDATE app_state SET proactive_mode='off'");await observe('Картопля знову хрустка');await ready();while(await h.lumen.processNext()){}assert.equal(h.brain.calls.length,0);
   await db.query("UPDATE app_state SET proactive_mode='helpful',conversation_style='addressed'");await observe('Картопля знову підгоріла');await ready();while(await h.lumen.processNext()){}assert.equal(h.brain.calls.length,0);
   await observe('Люмен, поясни приготування картоплі');await h.lumen.processNext();await delivery.next();assert.equal(h.brain.calls.length,1);assert.equal(h.tg.sent.length,1);
  });
 }
 it('custom group gap не обходиться іншою темою, direct залишається foreground',async()=>{
  await db.query('UPDATE app_state SET ambient_gap_seconds=5400,proactive_gap_minutes=90');await observe('Картопля знову стала зіркою');await answer('Картопля варта окремої премії.');await delivery.next();
  await observe('Картопля тепер у новому ресторані',22,101);assert.equal((await db.query("SELECT update_id FROM inbox WHERE status='pending'")).rows.length,0);
  await observe('Люмен, скільки варити картоплю?',11,101);await h.lumen.processNext();await delivery.next();assert.equal(h.tg.sent.length,2);
 });
 it('cap4/group/10min охоплює різні теми; direct не є п’ятим unsolicited',async()=>{
  for(let i=0;i<5;i++){await expireAttempt();await observe('Картопля у ресторані '+i,11,100+i);await answer('Картопля отримує премію '+i);await delivery.next();}
  assert.equal(h.tg.sent.length,4);assert.equal((await db.query("SELECT id FROM outbox WHERE status='sent' AND body->>'ambient'='true'")).rows.length,4);
  await observe('Люмен, допоможи скласти меню');await h.lumen.processNext();await delivery.next();assert.equal(h.tg.sent.length,5);
 });
 it('сусідня тема не інвалідовує scoped reply, pause прибирає deferred candidate',async()=>{
  await observe('Картопля готується до премії',11,101);await answer('Картопля чекає на червону доріжку.');await observe('Обговорімо продаж машини',22,202);await delivery.next();assert.equal(h.tg.sent.length,1);
  await db.tx(pauseMemory);assert.equal((await db.query("SELECT update_id FROM inbox WHERE status='pending'")).rows.length,0);assert.equal(await h.lumen.processNext(),false);
 });
 it('новий direct запит скасовує ambient generation навіть із тим самим словником',async()=>{
  await observe('Картопля на кухні стала мемом');await ready();let finish!:(p:Plan)=>void;h.brain.block=()=>new Promise(r=>{finish=r;});const running=h.lumen.processNext();while(!finish)await delay(1);
  await observe('Люмен, поясни чому картопля не зварилась');finish(contribution('Картопля отримала корону.'));await running;
  assert.equal((await db.query("SELECT id FROM outbox WHERE status='pending'")).rows.length,0);h.brain.block=undefined;await h.lumen.processNext();await delivery.next();assert.equal(h.tg.sent.length,1);assert.match(h.brain.calls.at(-1)!.current,/поясни/);
 });
 it('новий серйозний контекст відкидає жарт навіть зі спільним словом',async()=>{
  await observe('Картопля на кухні стала мемом');await answer('Картопля отримала корону.');await observe('Картопля не при чому, мені дуже важко, я в лікарні',22);assert.equal(await delivery.next(),false);assert.equal(h.tg.sent.length,0);assert.equal((await state(db)).last_bot_at,null);
 });
 it('одне повторене слово не дозволяє застарілий жарт після звичайної зміни предмета',async()=>{
  await observe('Картопля на кухні стала мемом');await answer('Картопля отримала корону.');await observe('Картопля не при чому, поговорімо про продаж машини',22);assert.equal(await delivery.next(),false);assert.equal(h.tg.sent.length,0);assert.equal((await state(db)).last_bot_at,null);
 });
 it('короткий повтор предмета все ще продовжує епізод і не відкидає готову репліку',async()=>{
  await observe('Картопля на кухні стала мемом');await answer('Картопля отримала корону.');await observe('Картопля!',22);await delivery.next();assert.equal(h.tg.sent.length,1);
 });
 it('replay старих helpful/social_candidate jobs скасовується без скасування справжнього діалогу',async()=>{
  await observe('Картопля на кухні стала мемом');const original=(await one(db,'SELECT payload FROM inbox'))!.payload;await db.query('DELETE FROM inbox');let updateId=990000;
  for(const status of ['pending','processing'])for(const engagement of [{reason:'ambient'},{reason:'helpful'},{reason:'continuation',dialogue:{origin:'social_candidate'}},{reason:'continuation',dialogue:{origin:'explicit_dialogue'}}]){
   const id=updateId++;await db.query('INSERT INTO inbox(update_id,payload,revision,status) VALUES($1,$2,0,$3)',[id,JSON.stringify({...original,engagement}),status]);await db.tx(sql=>cancelAmbient(sql,'0'));const row=await one(db,'SELECT * FROM inbox WHERE update_id=$1',[id]);
   if(engagement.dialogue?.origin==='explicit_dialogue'){assert.ok(row);assert.equal(row!.payload.engagement.cancelled,undefined);}
   else if(status==='pending')assert.equal(row,undefined);else assert.equal(row!.payload.engagement.cancelled,true);
   await db.query('DELETE FROM inbox WHERE update_id=$1',[id]);
  }
 });
});

describe('Обмежений continuity fence, не оцінка людського змісту',()=>{
 it('відрізняє brief anchor й same-theme деталі від повтору anchor перед явною зміною предмета',()=>{
  const source='Картопля на кухні стала мемом';
  assert.equal(sameDiscussion(source,'Картопля!'),true);
  assert.equal(sameDiscussion(source,'Картоплю на кухні знову обговорюємо'),true);
  assert.equal(sameDiscussion(source,'Та картопля з кухні точно перемогла'),true);
  assert.equal(sameDiscussion(source,'Картопля не при чому, поговорімо про продаж машини'),false);
  assert.equal(sameDiscussion(source,'Картопля, але змінимо тему'),false);
  assert.equal(sameDiscussion(source,'Картопля, мені дуже важко, я в лікарні'),false);
 });
});
