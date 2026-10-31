import { describe,it,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TestDB,harness,paired,message,PIN } from './helpers.js';
import { state,one,queueText } from '../src/db.js';
import { Delivery } from '../src/delivery.js';
import { Telegram,TelegramError } from '../src/telegram.js';
import { isQuietHour } from '../src/engine.js';

describe('Реальна PostgreSQL-логіка приватної групи',()=>{
  const db=new TestDB();let h:ReturnType<typeof harness>;
  before(async()=>{await db.init();});after(async()=>{await db.close();});
  beforeEach(async()=>{await db.reset();h=harness(db);});
  it('прив’язує лише правильний код і дозволеного власника, код у пам’ять не потрапляє',async()=>{
    await h.lumen.receive(message('/bind wrong'));await h.lumen.receive(message(`/bind ${PIN}`,22));assert.equal((await state(db)).chat_id,null);
    await h.lumen.receive(message(`/bind ${PIN}`));assert.equal((await state(db)).chat_id,'-100');
    assert.equal((await db.query('SELECT * FROM messages')).rows.length,0);assert.equal((await db.query('SELECT * FROM inbox')).rows.length,0);
  });
  it('повторний код не прив’язує другу групу',async()=>{await paired(h);await h.lumen.receive(message(`/bind ${PIN}`,11,-200));assert.equal((await state(db)).chat_id,'-100');});
  it('до згоди двох нічого з розмови не записує',async()=>{
    await h.lumen.receive(message(`/bind ${PIN}`));await h.lumen.receive(message('/consent'));await h.lumen.receive(message('дуже приватний факт'));
    assert.equal((await db.query('SELECT * FROM messages')).rows.length,0);assert.equal((await db.query('SELECT * FROM inbox')).rows.length,0);
  });
  it('чужі групи, приватні повідомлення й третя людина не потрапляють у пам’ять',async()=>{
    await paired(h);await h.lumen.receive(message('foreign',11,-200));await h.lumen.receive(message('private',11,11,'private'));await h.lumen.receive(message('/consent',33));await h.lumen.receive(message('third',33));
    assert.equal((await db.query('SELECT * FROM messages')).rows.length,0);assert.equal((await state(db)).participants.length,2);
  });
  it('одне повідомлення зберігає і виконує лише один раз',async()=>{
    await paired(h);const update=message('Люмен, запам’ятай: сьогодні граємо.');h.brain.replies.push({reply:'',actions:[{kind:'remember',content:'Сьогодні граємо.'}]});
    await h.lumen.receive(update);await h.lumen.receive(update);await h.lumen.processNext();await h.lumen.processNext();
    assert.equal((await db.query('SELECT * FROM memories')).rows.length,1);assert.equal((await db.query('SELECT * FROM inbox')).rows.length,1);assert.equal(h.brain.calls.length,1);
    const note=await one(db,'SELECT * FROM memories');assert.equal(note!.author_id,'11');assert.ok(note!.source_message_id);
  });
  it('починає без зовнішньої біографії й передає лише груповий контекст',async()=>{
    await paired(h);await h.lumen.receive(message('Люмен, що ти про нас знаєш?'));await h.lumen.processNext();
    const context=JSON.parse(h.brain.calls[0]!.context);assert.deepEqual(context.notes,[]);assert.equal(context.participants.length,2);
    assert.ok(!h.brain.calls[0]!.context.includes(h.config.token));assert.ok(!('email' in context));
  });
  it('звичайні репліки пам’ятає без виклику моделі на кожну',async()=>{
    await paired(h);await h.lumen.receive(message('Як минув день?'));await h.lumen.processNext();assert.equal(h.brain.calls.length,0);assert.equal((await db.query('SELECT * FROM messages')).rows.length,1);
  });
  it('самостійно долучається лише до найновішої репліки після розмови двох',async()=>{
    await paired(h);await db.query('UPDATE app_state SET quiet_start=0,quiet_end=0 WHERE id=1');for(let i=0;i<16;i++)await h.lumen.receive(message(`Репліка ${i}`,i%2?22:11));while(await h.lumen.processNext()){}
    assert.equal(h.brain.calls.length,1);assert.equal(h.brain.calls[0]!.current,'Репліка 15');
  });
  it('не втручається самостійно у потік повідомлень лише одного учасника',async()=>{
    await paired(h);await db.query('UPDATE app_state SET quiet_start=0,quiet_end=0 WHERE id=1');for(let i=0;i<16;i++)await h.lumen.receive(message(`Соло ${i}`));while(await h.lumen.processNext()){}assert.equal(h.brain.calls.length,0);
  });
  it('обмеження контексту залишає місце старішим нотаткам навіть після довгої розмови',async()=>{
    await paired(h);for(let i=0;i<45;i++)await db.query("INSERT INTO messages(user_id,author,role,body) VALUES ('11','А','user',$1)",['Довгий текст '.repeat(300)]);await db.query("INSERT INTO memories(content,author_id) VALUES ('Важлива давня нотатка','22')");await h.lumen.receive(message('Люмен, що ми пам’ятаємо?'));await h.lumen.processNext();const ctx=JSON.parse(h.brain.calls[0]!.context);assert.equal(ctx.notes[0].content,'Важлива давня нотатка');assert.equal(ctx.recent.length,28);
  });
  it('відповідає на reply без згадки імені',async()=>{
    await paired(h);const update=message('Розкажи');update.message!.reply_to_message={from:{id:999,first_name:'Люмен',is_bot:true},message_id:77};await h.lumen.receive(update);await h.lumen.processNext();assert.equal(h.brain.calls.length,1);
  });
  it('не виконує команду, адресовану іншому боту',async()=>{await paired(h);await h.lumen.receive(message('/pause@someone_else_bot'));assert.equal((await state(db)).paused,false);});
  it('відхиляє непрохану зміну пам’яті, яку запропонувала модель',async()=>{
    await paired(h);h.brain.replies.push({reply:'',actions:[{kind:'remember',content:'вигадка'}]});await h.lumen.receive(message('Люмен, розкажи жарт'));await h.lumen.processNext();assert.equal((await db.query('SELECT * FROM memories')).rows.length,0);
  });
  it('інструкції з файла не дають повноваження записувати факти',async()=>{
    await paired(h);h.brain.replies.push({reply:'',actions:[{kind:'remember',content:'вигадка з файла'}]});const update=message('Люмен, поясни цей документ');update.message!.document={file_id:'x',file_name:'rules.md'};
    await h.lumen.receive(update);await h.lumen.processNext();assert.equal((await db.query('SELECT * FROM memories')).rows.length,0);
  });
  it('помилка в другій дії відкочує першу без удаваного успіху',async()=>{
    await paired(h);h.brain.replies.push({reply:'',actions:[{kind:'remember',content:'тест'},{kind:'remind',title:'минуле',due_at:'2020-01-01T00:00:00Z'}]});
    await h.lumen.receive(message('Люмен, запам’ятай тест і нагадай про нього'));await h.lumen.processNext();assert.equal((await db.query('SELECT * FROM memories')).rows.length,0);assert.equal((await db.query('SELECT * FROM reminders')).rows.length,0);
    assert.match((await one(db,'SELECT body FROM outbox'))!.body.text,/час уже минув/);
  });
  it('пауза скасовує незавершену відповідь моделі та потребує двох повторних згод',async()=>{
    await paired(h);let resolve!:(p:any)=>void;h.brain.block=()=>new Promise(r=>{resolve=r;});await h.lumen.receive(message('Люмен, запам’ятай секрет'));const processing=h.lumen.processNext();
    while(!resolve)await new Promise(r=>setTimeout(r,1));await h.lumen.receive(message('/pause',22));resolve({reply:'',actions:[{kind:'remember',content:'секрет'}]});await processing;
    assert.equal((await db.query('SELECT * FROM memories')).rows.length,0);assert.equal((await state(db)).paused,true);
    await h.lumen.receive(message('інший секрет'));assert.equal((await db.query('SELECT body FROM messages')).rows.some(x=>x.body==='інший секрет'),false);
    await h.lumen.receive(message('/consent'));assert.equal((await state(db)).paused,true);await h.lumen.receive(message('/consent',22));assert.equal((await state(db)).paused,false);
  });
  it('повне забування прибирає активні й похідні дані, а також вкладення черги',async()=>{
    await paired(h);await h.lumen.receive(message('Люмен, запам’ятай: кота звати Нокс'));h.brain.replies.push({reply:'',actions:[{kind:'remember',content:'Кота звати Нокс'}]});await h.lumen.processNext();await h.lumen.receive(message('/game story'));await h.lumen.receive(message('Так',22));await h.lumen.processNext();
    await h.lumen.receive(message('/forget_all',22));for(const table of ['messages','memories','games','rules','reminders','inbox'])assert.equal((await db.query(`SELECT * FROM ${table}`)).rows.length,0,table);
    const outbox=await db.query('SELECT * FROM outbox');assert.equal(outbox.rows.length,1);assert.ok(!JSON.stringify(outbox.rows).includes('Нокс'));assert.equal((await state(db)).chat_id,'-100');
  });
  it('прохання забути звичайною мовою очищає дані й доставляє підтвердження з новою ревізією',async()=>{
    await paired(h);await h.lumen.receive(message('Таємний пароль — тест'));await h.lumen.processNext();h.brain.replies.push({reply:'',actions:[{kind:'forget',phrase:'Таємний пароль'}]});await h.lumen.receive(message('Люмен, забудь Таємний пароль'));await h.lumen.processNext();assert.equal((await db.query('SELECT * FROM messages')).rows.length,0);
    await new Delivery(db,h.tg as unknown as Telegram,h.config).next();assert.match(h.tg.sent[0]!.text,/Прибрав/);assert.equal((await state(db)).memory_revision,1);
  });
  it('прохання призупинити запам’ятовування виконується звичайною мовою',async()=>{
    await paired(h);h.brain.replies.push({reply:'',actions:[{kind:'pause_memory'}]});await h.lumen.receive(message('Люмен, призупини запам’ятовування'));await h.lumen.processNext();assert.equal((await state(db)).paused,true);assert.equal((await state(db)).consent.length,0);
  });
  it('часткове забування трактує % буквально, очищає перекази та похідні дані',async()=>{
    await paired(h);await h.lumen.receive(message('Секрет 100%'));await h.lumen.receive(message('Інша історія'));await db.query("INSERT INTO messages(user_id,author,role,body) VALUES ('lumen','Люмен','assistant','Переказ без точного фрагмента')");
    await h.lumen.receive(message('/forget 100%'));const rows=(await db.query('SELECT body FROM messages')).rows;assert.deepEqual(rows.map(x=>x.body),['Інша історія']);
  });
  it('редагування джерела прибирає старі похідні твердження',async()=>{
    await paired(h);const u=message('Люмен, запам’ятай: зустріч у п’ятницю');h.brain.replies.push({reply:'',actions:[{kind:'remember',content:'Зустріч у п’ятницю'}]});await h.lumen.receive(u);await h.lumen.processNext();
    await db.query("INSERT INTO reminders(title,due_at,author_id) VALUES ('Зустріч у п’ятницю',now()+interval '1 day','11')");
    const edit=message('');edit.edited_message={...u.message!,text:'Люмен, зустріч у суботу'};delete edit.message;await h.lumen.receive(edit);
    assert.equal((await db.query('SELECT * FROM memories')).rows.length,0);assert.equal((await db.query('SELECT * FROM reminders')).rows.length,0);assert.match((await one(db,'SELECT body FROM messages'))!.body,/суботу/);
  });
  it('перезапуск об’єкта бота зберігає нотатки й гру',async()=>{
    await paired(h);await h.lumen.receive(message('/game story'));await h.lumen.receive(message('Так',22));await h.lumen.processNext();h.brain.replies.push({reply:'',actions:[{kind:'game_turn',content:'Я додав перший рядок.'}],behavior:{move:'facilitate',recipient:'bot',relation:'activity_move',reference_id:(await one(db,'SELECT id FROM interactions'))!.id,reason:'Учасник робить хід у спільній історії'}});await h.lumen.receive(message('Я додав перший рядок.'));await h.lumen.processNext();
    const restarted=harness(db);restarted.brain.replies.push({reply:'',actions:[{kind:'game_turn',content:'Це другий рядок.'}],behavior:{move:'facilitate',recipient:'bot',relation:'activity_move',reference_id:(await one(db,'SELECT id FROM interactions'))!.id,reason:'Другий учасник продовжує історію'}});await restarted.lumen.receive(message('Це другий рядок.',22));await restarted.lumen.processNext();assert.equal((await one(db,'SELECT state FROM games'))!.state.turn,2);
  });
  it('пошук історії повертає першоджерело й автора, а не вигадану пам’ять',async()=>{
    await paired(h);const original=message('Подорож запланована у Львів.',22);original.message!.date-=30;await h.lumen.receive(original);await h.lumen.processNext();const originalRow=await one(db,'SELECT id FROM messages WHERE telegram_id=$1',[original.message!.message_id]);h.brain.replies.push({reply:'',actions:[{kind:'history',query:'Львів'}]},{reply:'Про Львів говорив другий учасник.',actions:[]});
    await h.lumen.receive(message('Люмен, що ми домовлялися про Львів?'));await h.lumen.processNext();const sources=JSON.parse(h.brain.calls[1]!.context).tool_results_untrusted;assert.equal(sources[0].tool,'history');const found=sources[0].result.find((row:any)=>String(row.id)===String(originalRow!.id));assert.ok(found);assert.equal(found.user_id,'22');assert.equal(found.author,'Гравець Б');assert.equal(found.body,'Подорож запланована у Львів.');
  });
  it('нагадування ставиться в чергу один раз і зберігається до доставки',async()=>{
    await paired(h);await db.query("INSERT INTO reminders(title,due_at,author_id) VALUES ('чай',now()-interval '1 minute','11')");await h.lumen.scheduleDue();await h.lumen.scheduleDue();assert.equal((await db.query('SELECT * FROM outbox')).rows.length,1);assert.equal((await one(db,'SELECT status FROM reminders'))!.status,'queued');
    await new Delivery(db,h.tg as unknown as Telegram,h.config).next();assert.equal((await one(db,'SELECT status FROM reminders'))!.status,'sent');
  });
  it('пауза не губить нагадування, яке вже чекало відправлення',async()=>{
    await paired(h);await db.query("INSERT INTO reminders(title,due_at,author_id) VALUES ('чай',now()-interval '1 minute','11')");await h.lumen.scheduleDue();await h.lumen.receive(message('/pause'));assert.equal((await one(db,'SELECT status FROM reminders'))!.status,'pending');await h.lumen.scheduleDue();assert.equal((await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'reminder:%'")).rows.length,0);
    await h.lumen.receive(message('/consent'));await h.lumen.receive(message('/consent',22));await h.lumen.scheduleDue();assert.equal((await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'reminder:%'")).rows.length,1);
  });
  it('скасування нагадування прибирає вже підготовлену доставку',async()=>{
    await paired(h);await db.query("INSERT INTO reminders(title,due_at,author_id) VALUES ('чай',now()-interval '1 minute','11')");await h.lumen.scheduleDue();await h.lumen.receive(message('/cancel 1'));assert.equal((await one(db,'SELECT status FROM reminders'))!.status,'cancelled');assert.equal((await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'reminder:%'")).rows.length,0);
  });
  it('невизначена доставка не породжує автоматичних дублів',async()=>{
    await paired(h);await queueText(db,'Тест',0,'test');h.tg.failure=new TelegramError('telegram_network',0,true);const delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);await delivery.next();assert.equal((await one(db,'SELECT status FROM outbox'))!.status,'uncertain');h.tg.failure=undefined;assert.equal(await delivery.next(),false);assert.equal(h.tg.sent.length,0);
  });
  it('429 планує повтор за Telegram retry_after',async()=>{
    await paired(h);await queueText(db,'Тест',0,'test');h.tg.failure=new TelegramError('telegram_429',30);await new Delivery(db,h.tg as unknown as Telegram,h.config).next();const row=await one(db,'SELECT * FROM outbox');assert.equal(row!.status,'pending');assert.ok(new Date(row!.available_at).getTime()>Date.now()+20000);
  });
  it('довгі повідомлення ділить без розриву emoji і в межах UTF-16 ліміту',async()=>{
    const text='✨🐈'.repeat(3000);await queueText(db,text,0,'long');const rows=(await db.query('SELECT body FROM outbox ORDER BY id')).rows;assert.equal(rows.map(x=>x.body.text).join(''),text);assert.ok(rows.every(x=>x.body.text.length<=3500));assert.ok(rows.every(x=>!/[\uD800-\uDBFF]$/.test(x.body.text)));
  });
  it('години тиші враховують Київ та перехід через північ',()=>{
    assert.equal(isQuietHour(new Date('2026-10-25T22:00:00Z'),'Europe/Kyiv',23,9),true);assert.equal(isQuietHour(new Date('2026-10-25T12:00:00Z'),'Europe/Kyiv',23,9),false);assert.equal(isQuietHour(new Date(),'Europe/Kyiv',9,9),false);
  });
});
