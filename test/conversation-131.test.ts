import {describe,it,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {TestDB,harness,paired,message} from './helpers.js';
import {state,one} from '../src/db.js';
import {Delivery} from '../src/delivery.js';
import {activityFor} from '../src/activity-status.js';
import {Telegram} from '../src/telegram.js';
import type {Plan} from '../src/model.js';

describe('Живі реакції, природне налаштування та видиме приготування відповіді',()=>{
  let db:TestDB,h:ReturnType<typeof harness>,delivery:Delivery;
  beforeEach(async()=>{db=new TestDB();await db.init();h=harness(db);await paired(h);await db.query("UPDATE app_state SET open_group=true,mention_only=true,mode='quiet' WHERE id=1");delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);});
  afterEach(async()=>{await db.close();});
  async function ask(text:string,uid=11){await h.lumen.receive(message(text,uid));await h.lumen.processNext();}
  async function botTurn(){h.brain.replies.push({reply:'Рожево-біла гантеля — зефір із залізною начинкою.',actions:[]});await ask('Люмен, що ти скажеш?');await delivery.next();}
  it('підхоплює короткий жарт іншої учасниці без імені, питання чи reply',async()=>{
    await botTurn();h.brain.replies.push({reply:'Оце вже авторська начинка.',actions:[],behavior:{move:'answer',recipient:'bot',relation:'ambient',reason:'Продовжити конкретну тему розмови',contribution:{key:'Предметний новий внесок',summary:'Додав доречну думку до поточної теми'}},engagement:{respond:true,reason:'continuation'}});await ask('З моїми яйцями',22);assert.equal(h.brain.calls.length,2);const c=JSON.parse(h.brain.calls[1]!.context);assert.equal(c.active_dialogue.origin,'social_candidate');assert.match(c.active_dialogue.question,/зефір/);assert.equal(c.current_author.id,'22');assert.equal((await state(db)).last_model_error,null);
  });
  it('розуміє скаргу, чому його доводиться кликати, без повторного виклику',async()=>{
    await botTurn();h.brain.replies.push({reply:'Не треба щоразу кликати — якщо це продовження нашої розмови, я підхоплю.',actions:[],behavior:{move:'answer',recipient:'bot',relation:'ambient',reason:'Продовжити конкретну тему розмови',contribution:{key:'Предметний новий внесок',summary:'Додав доречну думку до поточної теми'}},engagement:{respond:true,reason:'continuation'}});await ask('А чого цього постійно кликати треба',22);assert.equal(h.brain.calls.length,2);
  });
  it('пропускає непов’язану репліку навіть усередині живого діалогу',async()=>{
    await botTurn();await db.query('DELETE FROM outbox');h.brain.replies.push({reply:'',actions:[],engagement:{respond:false,reason:'skip'}});await ask('Петре, де ти залишив ключі?',22);assert.equal((await db.query('SELECT * FROM outbox')).rows.length,0);
  });
  it('не розтягує активний діалог на іншу тему або давно завершену бесіду',async()=>{
    await db.query('UPDATE app_state SET quiet_start=0,quiet_end=0');await botTurn();const other=message('З моїми яйцями',22);other.message!.message_thread_id=202;await h.lumen.receive(other);await db.query("UPDATE messages SET created_at=now()-interval '16 minutes' WHERE role='assistant'");await h.lumen.receive(message('І зефір тоді теж мій',22));const candidates=(await db.query("SELECT * FROM inbox WHERE status='pending'")).rows;assert.equal(candidates.length,2);assert.ok(candidates.every(x=>x.payload.engagement.reason==='ambient'&&!x.payload.engagement.dialogue));
  });
  it('виконує дослівне прохання зі скріншота без вимоги потрібного ключового слова',async()=>{
    h.brain.replies.push({reply:'',actions:[{kind:'set_proactivity',level:'helpful',conversation:'adaptive'}]});await ask('Люмен, а давай ти включи більш вільний режим спілкування і не тільки коли тебе питають щось кажи, а взагалі коли стосується будь чого що ти казав, або робив');assert.equal((await state(db)).conversation_style,'adaptive');assert.equal((await state(db)).last_model_error,null);assert.doesNotMatch(JSON.stringify((await db.query('SELECT body FROM outbox')).rows),/Сформулюйте|явного доручення|обмеженн/);
  });
  it('старе формулювання set_mode теж вмикає адаптивне спілкування',async()=>{
    await db.query("UPDATE app_state SET conversation_style='addressed' WHERE id=1");h.brain.replies.push({reply:'',actions:[{kind:'set_mode',mode:'social'}]});await ask('Люмен, спілкуйся з нами вільніше');assert.equal((await state(db)).conversation_style,'adaptive');
  });
  it('цитата або переклад чужого прохання не змінює налаштування',async()=>{
    await db.query("UPDATE app_state SET conversation_style='addressed' WHERE id=1");h.brain.replies.push({reply:'',actions:[{kind:'set_proactivity',level:'helpful',conversation:'adaptive'}]});await ask('Люмен, переклади фразу «спілкуйся вільніше»');assert.equal((await state(db)).conversation_style,'addressed');
  });
  it('оновлює typing протягом обчислення й не продовжує після готової доставки',async()=>{
    activityFor(db,h.tg as unknown as Telegram,{intervalMs:25,noticeAfterMs:5000,deliveryGraceMs:1000});let release!:(p:Plan)=>void;h.brain.block=()=>new Promise(r=>{release=r;});await h.lumen.receive(message('Люмен, поясни детально'));const task=h.lumen.processNext();while(!release)await delay(1);await delay(95);assert.ok(h.tg.calls.filter(x=>x.method==='sendChatAction').length>=3);release({reply:'Готова відповідь.',actions:[]});await task;await delivery.next();const n=h.tg.calls.filter(x=>x.method==='sendChatAction').length;await delay(70);assert.equal(h.tg.calls.filter(x=>x.method==='sendChatAction').length,n);assert.equal((await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'progress:%'")).rows.length,0);
  });
  it('для довгої відповіді показує один короткий статус і замінює його готовим текстом',async()=>{
    activityFor(db,h.tg as unknown as Telegram,{intervalMs:20,noticeAfterMs:45,deliveryGraceMs:1000});let release!:(p:Plan)=>void;h.brain.block=()=>new Promise(r=>{release=r;});await h.lumen.receive(message('Люмен, порівняй складні варіанти'));const task=h.lumen.processNext();while(!release)await delay(1);const until=Date.now()+1500;while(!await one(db,"SELECT id FROM outbox WHERE dedup_key LIKE 'progress:%'")&&Date.now()<until)await delay(10);await delivery.next();assert.equal(h.tg.sent.length,1);assert.equal((await db.query("SELECT * FROM messages WHERE role='assistant'")).rows.length,0);release({reply:'Ось порівняння: перший варіант підходить краще.',actions:[]});await task;await delivery.next();const edit=h.tg.calls.find(x=>x.method==='editMessageText');assert.equal(edit?.body.text,'Ось порівняння: перший варіант підходить краще.');assert.equal(h.tg.sent.length,1);assert.equal((await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'progress:%'")).rows.length,1);
  });
  it('прибирає власний статус очікування після готового опитування без текстової відповіді',async()=>{
    activityFor(db,h.tg as unknown as Telegram,{intervalMs:20,noticeAfterMs:40,deliveryGraceMs:1000});let release!:(p:Plan)=>void;h.brain.block=()=>new Promise(r=>{release=r;});await h.lumen.receive(message('Люмен, створи опитування: чай чи кава'));const task=h.lumen.processNext();while(!release)await delay(1);const until=Date.now()+1500;while(!await one(db,"SELECT id FROM outbox WHERE dedup_key LIKE 'progress:%'")&&Date.now()<until)await delay(10);await delivery.next();const notice=await one(db,"SELECT telegram_id FROM outbox WHERE dedup_key LIKE 'progress:%'");release({reply:'',actions:[{kind:'poll',question:'Що п’ємо?',options:['Чай','Кава']}]});await task;await delivery.next();assert.equal(h.tg.polls.length,1);assert.equal(h.tg.calls.find(x=>x.method==='deleteMessage')?.body.message_id,Number(notice!.telegram_id));assert.equal((await one(db,"SELECT status FROM outbox WHERE dedup_key LIKE 'progress:%'"))!.status,'cleared');
  });
  it('пауза припиняє активний typing та відкидає пізню відповідь',async()=>{
    activityFor(db,h.tg as unknown as Telegram,{intervalMs:20,noticeAfterMs:1000,deliveryGraceMs:1000});let release!:(p:Plan)=>void;h.brain.block=()=>new Promise(r=>{release=r;});await h.lumen.receive(message('Люмен, допоможи'));const task=h.lumen.processNext();while(!release)await delay(1);await h.lumen.receive(message('/pause'));await delay(40);const n=h.tg.calls.filter(x=>x.method==='sendChatAction').length;await delay(50);assert.equal(h.tg.calls.filter(x=>x.method==='sendChatAction').length,n);release({reply:'Не має бути доставлено.',actions:[]});await task;assert.doesNotMatch(JSON.stringify((await db.query('SELECT body FROM outbox')).rows),/Не має бути доставлено/);
  });
});
