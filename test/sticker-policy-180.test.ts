import {before,after,beforeEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {TestDB,harness,paired,message} from './helpers.js';
import {queueDecoration,explicitStickerRequest} from '../src/presentation.js';
import {one} from '../src/db.js';
import {Delivery} from '../src/delivery.js';
import type {Telegram} from '../src/telegram.js';
import type {Plan} from '../src/model.js';
import {STICKER_SET} from '../src/sticker-pack.js';

describe('Стікери 1.8: лише власний сильний акцент або прямий запит',()=>{
  const db=new TestDB();let h:ReturnType<typeof harness>;let seq=18000;
  before(async()=>{await db.init();});after(async()=>{await db.close();});
  beforeEach(async()=>{await db.reset();h=harness(db);await paired(h);await db.query("INSERT INTO stickers(file_id,file_unique_id,emoji) VALUES('laugh','u-laugh','😂'),('heart','u-heart','❤️'),('party','u-party','🎉'),('hug','u-hug','🤗')");await db.query('UPDATE stickers SET set_name=$1',[STICKER_SET]);});
  const plan=(patch:Partial<Plan>={}):Plan=>({reply:'Ця історія мене розсмішила до сліз!',actions:[],presentation:{sticker_id:1,sticker_purpose:'emphasis',sticker_quote:'розсмішила до сліз'},...patch});
  const queue=(p:Plan,text='Люмене, як тобі цей жарт?',serious=false,ownText=p.reply)=>queueDecoration(db,p,message(text).message!,0,seq++,serious,false,ownText);
  it('не надсилає непроханий самотній стікер чи прикрасу без наміру',async()=>{
    assert.equal(await queue(plan({reply:''})),false);
    assert.equal(await queue(plan({presentation:{sticker_id:1}}),'Люмен, привіт'),false);
    assert.equal((await db.query("SELECT * FROM outbox WHERE kind='sticker'")).rows.length,0);
  });
  it('акцент прив’язаний до справжніх видимих власних слів',async()=>{
    assert.equal(await queue(plan({reply:'Добре.'})),false);
    assert.equal(await queue(plan(),undefined,false,''),false);
    assert.equal(await queue(plan()),true);
    const row=await one(db,"SELECT body FROM outbox WHERE kind='sticker'");assert.equal(row!.body.stickerQuote,'розсмішила до сліз');assert.equal(row!.body.stickerPurpose,'emphasis');
  });
  it('прямий запит працює без зайвого тексту, навіть повторно чи в серйозній темі',async()=>{
    const p=plan({reply:'',presentation:{sticker_id:2,sticker_purpose:'requested'}});
    assert.equal(await queue(p,'Люмене, надішли стікер із серцем',true),true);
    assert.equal(await queue(p,'Покажи цей стікер ще раз',true),true);
    assert.equal(await queue(p,'Люмене, скинь ❤️',true),true);
  });
  it('згадка, скарга, заперечення й цитата не обходять правила',async()=>{
    const p=plan({reply:'',presentation:{sticker_id:1,sticker_purpose:'requested'}});
    for(const text of ['Стікери жах','Чому стікер смикається?','Не надсилай стікер','Не треба надсилати стікери','Не хочу стікерів','Поясни фразу «надішли стікер»'])assert.equal(await queue(p,text),false,text);
    assert.equal(explicitStickerRequest('Please show a sticker'),true);
  });
  it('власний акцент використовує Люмена, чужий набір доступний на прямий запит',async()=>{
    await db.query("UPDATE stickers SET set_name='OtherSet' WHERE id=1");assert.equal(await queue(plan()),false);
    assert.equal(await queue(plan({reply:'',presentation:{sticker_id:1,sticker_purpose:'requested'}}),'Надішли цей стікер'),true);
  });
  it('вимагає і паузу 20 хвилин, і 12 власних реплік між акцентами',async()=>{
    assert.equal(await queue(plan()),true);
    const another=plan({presentation:{sticker_id:2,sticker_purpose:'emphasis',sticker_quote:'розсмішила до сліз'}});
    assert.equal(await queue(another),false);
    await db.query("UPDATE outbox SET status='sent',created_at=now()-interval '21 minutes'");assert.equal(await queue(another),false);
    for(let i=0;i<12;i++)await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES($1,'lumen','Люмен','assistant','Змістовна відповідь')",[90000+i]);
    assert.equal(await queue(another),true);
  });
  it('не повторює одну з трьох останніх сцен навіть після достатньої паузи',async()=>{
    await queue(plan());await db.query("UPDATE outbox SET status='sent',created_at=now()-interval '21 minutes'");
    for(let i=0;i<12;i++)await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES($1,'lumen','Люмен','assistant','Змістовна відповідь')",[91000+i]);
    assert.equal(await queue(plan()),false);
  });
  it('не накопичує самостійні стікери, поки попередній не доставлений',async()=>{
    await queue(plan());await db.query("UPDATE outbox SET created_at=now()-interval '21 minutes'");
    for(let i=0;i<12;i++)await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES($1,'lumen','Люмен','assistant','Змістовна відповідь')",[92000+i]);
    for(const status of ['pending','sending','uncertain']){await db.query('UPDATE outbox SET status=$1',[status]);assert.equal(await queue(plan({presentation:{sticker_id:2,sticker_purpose:'emphasis',sticker_quote:'розсмішила до сліз'}})),false,status);}
  });
  it('серйозна розмова стримує власні акценти, метадані переживають доставку',async()=>{
    assert.equal(await queue(plan(),undefined,true),false);
    assert.equal(await queue(plan()),true);await new Delivery(db,h.tg as unknown as Telegram,h.config).next();
    const row=await one(db,"SELECT body,status FROM outbox WHERE kind='sticker'");assert.equal(row!.status,'sent');assert.equal(row!.body.emoji,'😂');assert.equal(Number(row!.body.stickerId),1);assert.equal(row!.body.stickerPurpose,'emphasis');
  });
});
