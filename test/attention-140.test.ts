import {describe,it,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {TestDB,harness,paired,message} from './helpers.js';
import {one,state,eraseAll,forgetPhrase,pauseMemory,migrate} from '../src/db.js';
import {Delivery} from '../src/delivery.js';
import {Telegram} from '../src/telegram.js';
import {ModelError} from '../src/auth.js';
import type {Plan} from '../src/model.js';

describe('Адаптивна участь 1.4: контекст, темп, медіа та право промовчати',()=>{
  let db:TestDB,h:ReturnType<typeof harness>,delivery:Delivery;
  beforeEach(async()=>{db=new TestDB();await db.init();h=harness(db);await paired(h);await db.query("UPDATE app_state SET open_group=true,mention_only=true,mode='quiet',quiet_start=0,quiet_end=0 WHERE id=1");delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);});
  afterEach(async()=>{await db.close();});
  async function ready(){await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");}
  async function observe(text:string,uid=11,topic?:number){const u=message(text,uid);u.message!.message_thread_id=topic;await h.lumen.receive(u);return u;}
  async function speak(text='Здається, цей мем щойно переміг гравітацію.'){h.brain.replies.push({reply:text,actions:[],engagement:{respond:true,reason:'social'}});await ready();assert.equal(await h.lumen.processNext(),true);}

  it('збирає жвавий обмін без допоміжних ключових слів в одну доречну репліку',async()=>{
    await observe('Оце поворот');await observe('Та він просто впав зі стільця',22);await observe('У стільця були інші плани');const last=await observe('Стілець подав у відставку',22);
    assert.equal((await db.query("SELECT * FROM inbox WHERE status='pending'")).rows.length,1);
    await speak();assert.equal(h.brain.calls.length,1);const c=JSON.parse(h.brain.calls[0]!.context);
    assert.equal(c.engagement_context.reason,'ambient');assert.equal(c.current_author.id,'22');assert.match(c.recent.map((x:any)=>x.body).join('\n'),/інші плани/);
    const out=await one(db,"SELECT * FROM outbox WHERE body->>'ambient'='true'");assert.ok(out);assert.equal(out!.body.replyToMessageId,last.message!.message_id);
    await delivery.next();assert.equal(h.tg.sent.length,1);
  });
  it('мовчить за рішенням моделі й не показує typing для відкинутої можливості',async()=>{
    await observe('Ключі залишив на полиці');h.brain.replies.push({reply:'',actions:[],engagement:{respond:false,reason:'skip'}});await ready();await h.lumen.processNext();
    for(let i=0;i<20;i++)await observe('Гаразд, це вже обговорили',i%2?11:22);
    assert.equal(h.brain.calls.length,1);assert.equal((await db.query("SELECT * FROM inbox WHERE status='pending'")).rows.length,0);assert.equal((await db.query('SELECT * FROM outbox')).rows.length,0);assert.ok(!h.tg.calls.some(x=>x.method==='sendChatAction'));
  });
  it('не приймає відсутність явного рішення моделі за дозвіл на втручання',async()=>{
    await observe('Сьогодні цікаве небо');h.brain.replies.push({reply:'На зв’язку!',actions:[]});await ready();await h.lumen.processNext();assert.equal((await db.query('SELECT * FROM outbox')).rows.length,0);
  });
  it('повертає давнє обговорення, яке вже не поміщається в останні повідомлення',async()=>{
    await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,created_at,topic_id) VALUES(9123,'999','Люмен','assistant','Ми домовилися про зефір і рожеву гантелю',now()-interval '3 days','202')");
    for(let i=0;i<35;i++)await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,'11','А','user','Стороння розмова','0')",[9200+i]);
    await observe('А зефіру усе-таки приписали спортивні властивості');await speak();const c=JSON.parse(h.brain.calls[0]!.context);
    assert.ok(c.related_discussions.some((x:any)=>x.message_id===9123&&x.topic_id==='202'));assert.ok(!c.recent.some((x:any)=>x.message_id===9123));
  });
  it('може оцінити доречність навіть reply одного учасника іншому',async()=>{
    const u=message('І тепер цей кіт — директор дивана',22);u.message!.reply_to_message={message_id:77,from:{id:11,first_name:'А'},text:'Найняли кота на роботу'};await h.lumen.receive(u);await speak();assert.equal(JSON.parse(h.brain.calls[0]!.context).replying_to.author,'А');
  });
  it('прибирає непрохані дії та меню, але залишає доречне форматування',async()=>{
    await observe('Це вже мем');h.brain.replies.push({reply:'Мем офіційно подорослішав.',actions:[{kind:'remember',content:'Непроханий факт'},{kind:'poll',question:'Хто правий?',options:['А','Б']}],presentation:{choices:['Так','Ні'],formatting:[{text:'Мем',style:'bold'}]},engagement:{respond:true,reason:'social'}});await ready();await h.lumen.processNext();
    assert.equal((await db.query('SELECT * FROM memories')).rows.length,0);assert.equal((await db.query('SELECT * FROM choices')).rows.length,0);const out=await one(db,"SELECT * FROM outbox WHERE kind='text'");assert.equal(out!.body.replyMarkup,undefined);assert.equal(out!.body.entities[0].type,'bold');assert.equal((await db.query('SELECT * FROM dialogues')).rows.length,0);
  });
  it('дозволяє один стікер замість текстового дубля',async()=>{
    await db.query("INSERT INTO stickers(file_id,file_unique_id,emoji) VALUES('own-sticker','own-unique','😂')");const sticker=await one(db,'SELECT id FROM stickers');await observe('Я просто не можу з цього фото');h.brain.replies.push({reply:'',actions:[],presentation:{sticker_id:Number(sticker!.id)},engagement:{respond:true,reason:'social'}});await ready();await h.lumen.processNext();assert.equal((await db.query("SELECT * FROM outbox WHERE kind='text'")).rows.length,0);await delivery.next();assert.equal(h.tg.stickers.length,1);
  });
  it('стримує частоту вже після першої самостійної репліки',async()=>{
    await observe('Перший кіт');await speak();await db.query("UPDATE topic_attention SET checked_at=now()-interval '1 minute'");await observe('Другий кіт',22);await ready();await h.lumen.processNext();assert.equal(h.brain.calls.length,1);
  });
  it('не повторює ту саму репліку після завершення паузи',async()=>{
    await observe('Перший мем');await speak('Цей мем тепер працює директором.');await db.query("UPDATE topic_attention SET checked_at=now()-interval '1 minute',spoke_at=now()-interval '3 minutes'");await db.query('DELETE FROM outbox');await observe('Другий мем',22);await speak('Цей мем тепер працює директором.');assert.equal((await db.query('SELECT * FROM outbox')).rows.length,0);assert.equal((await state(db)).last_model_error,null);
  });
  it('відкидає жарт, якщо під час генерації учасники змінили тему',async()=>{
    await observe('Смішна історія');await ready();let finish!:(p:Plan)=>void;h.brain.block=()=>new Promise(r=>{finish=r;});const task=h.lumen.processNext();while(!finish)await delay(1);await observe('Тепер серйозно: змінимо тему',22);finish({reply:'Несвоєчасний жарт',actions:[],engagement:{respond:true,reason:'social'}});await task;
    assert.equal((await db.query('SELECT * FROM outbox')).rows.length,0);assert.equal((await db.query("SELECT * FROM inbox WHERE status='pending'")).rows.length,1);
  });
  it('перевіряє актуальність ще й перед реальною доставкою',async()=>{
    await observe('Кумедна сцена');await speak();await observe('До речі, зовсім інше питання',22);assert.equal(await delivery.next(),false);assert.equal(h.tg.sent.length,0);assert.equal((await db.query("SELECT * FROM outbox WHERE body->>'ambient'='true'")).rows.length,0);
  });
  it('пряме звернення скасовує фоновий чернетковий хід і має пріоритет',async()=>{
    await observe('Ми тут сперечаємося');const direct=await observe('Люмен, поясни результат');assert.equal((await db.query("SELECT * FROM inbox WHERE status='pending'")).rows.length,1);await h.lumen.processNext();assert.match(h.brain.calls[0]!.current,/поясни результат/);assert.equal((await one(db,"SELECT * FROM outbox WHERE kind='text'"))!.body.replyToMessageId,direct.message!.message_id);
  });
  it('вимкнення, addressed і тихі години блокують фон, але не пряме звернення',async()=>{
    await db.query("UPDATE app_state SET proactive_mode='off' WHERE id=1");await observe('Весела історія');await db.query("UPDATE app_state SET proactive_mode='helpful',conversation_style='addressed' WHERE id=1");await observe('Ще історія',22);const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:h.config.timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date()));await db.query("UPDATE app_state SET conversation_style='adaptive',quiet_start=$1,quiet_end=$2",[hour,(hour+1)%24]);await observe('І ще фото');assert.equal((await db.query('SELECT * FROM inbox')).rows.length,0);await observe('Люмен, озвися');await h.lumen.processNext();assert.equal(h.brain.calls.length,1);
  });
  it('бачить разом недавні фото різних людей, а не лише останню картинку',async()=>{
    const a=await sharp({create:{width:20,height:20,channels:3,background:'#ff0000'}}).png().toBuffer();const b=await sharp({create:{width:20,height:20,channels:3,background:'#0000ff'}}).png().toBuffer();h.tg.file=async(id?:string)=>id==='one'?a:b;
    for(const [file,uid] of [['one',11],['two',22]] as const){const u=message('',uid);delete u.message!.text;u.message!.photo=[{file_id:file}];await h.lumen.receive(u);}await speak();assert.equal(h.brain.calls[0]!.images!.length,2);assert.equal(new Set(h.brain.calls[0]!.images).size,2);const c=JSON.parse(h.brain.calls[0]!.context);assert.equal(new Set(c.media_context.map((x:any)=>x.user_id)).size,2);
  });
  it('не вставляє технічну помилку в чужу розмову після невдалої фонової оцінки',async()=>{
    await observe('Звичайна бесіда');h.brain.block=async()=>{throw new ModelError('model_http_401');};await ready();await h.lumen.processNext();assert.equal((await db.query('SELECT * FROM outbox')).rows.length,0);assert.equal((await state(db)).last_model_error,'model_http_401');
  });
  it('загальний бюджет групи не перетворюється на чотири репліки в кожній темі',async()=>{
    for(let i=0;i<4;i++){
      const source=await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,'11','А','user','Джерело попереднього включення',$2) RETURNING id",[13000+i,String(200+i)]);
      await db.query("INSERT INTO outbox(dedup_key,kind,body,revision,source_message_id,status) VALUES($1,'text','{\"ambient\":true,\"text\":\"Попередня репліка\"}',0,$2,'sent')",['budget-'+i,source.rows[0]!.id]);
    }
    await observe('Тут іще кумедна сцена',22,500);await ready();await h.lumen.processNext();assert.equal(h.brain.calls.length,0);
  });
  it('зміна налаштування на addressed зупиняє вже обчислену самостійну відповідь',async()=>{
    await observe('Звичайна розмова');await ready();let finish!:(p:Plan)=>void;h.brain.block=()=>new Promise(r=>{finish=r;});const task=h.lumen.processNext();while(!finish)await delay(1);await db.query("UPDATE app_state SET conversation_style='addressed'");finish({reply:'Не надсилати',actions:[],engagement:{respond:true,reason:'social'}});await task;assert.equal((await db.query('SELECT * FROM outbox')).rows.length,0);
  });
  it('міграція зберігає власну довшу паузу й не скидає її при перезапуску',async()=>{
    await db.query('DELETE FROM schema_version WHERE version=8');await db.query('UPDATE app_state SET proactive_gap_minutes=90,ambient_gap_seconds=120');await migrate(db);assert.equal((await state(db)).ambient_gap_seconds,5400);await db.query('UPDATE app_state SET ambient_gap_seconds=7200');await migrate(db);assert.equal((await state(db)).ambient_gap_seconds,7200);
  });
  it('очищає похідні сліди уваги разом із пам’яттю й паузою',async()=>{
    for(const operation of [pauseMemory,eraseAll]){await db.query("UPDATE app_state SET paused=false");await db.query("INSERT INTO topic_attention(topic_id,last_reply) VALUES('0','забути') ON CONFLICT DO NOTHING");await db.tx(operation);assert.equal((await db.query('SELECT * FROM topic_attention')).rows.length,0);}
    await db.query("INSERT INTO topic_attention(topic_id,last_reply) VALUES('0','секрет')");await db.tx(sql=>forgetPhrase(sql,'секрет'));assert.equal((await db.query('SELECT * FROM topic_attention')).rows.length,0);
  });
});
