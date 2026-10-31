import {describe,it,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {TestDB,harness,paired,message} from './helpers.js';
import {one,state} from '../src/db.js';
import {ambientEnabled} from '../src/attention.js';
import {queueReleaseNotice,RELEASE} from '../src/release.js';
import {Delivery} from '../src/delivery.js';
import {VisualMemory} from '../src/visual.js';
import {Telegram,TelegramError} from '../src/telegram.js';
import {ensureStickerPack,stickerAssets,STICKER_SET,STICKER_COUNT,STICKER_TITLE} from '../src/sticker-pack.js';
import {ImageJobs} from '../src/image-jobs.js';
import {Media} from '../src/media.js';

describe('Публікація 1.3, реальні відеокадри та тиха ініціатива',()=>{
  let db:TestDB,h:ReturnType<typeof harness>;
  beforeEach(async()=>{db=new TestDB();await db.init();h=harness(db);await paired(h);await db.query("UPDATE app_state SET open_group=true,mention_only=true,mode='quiet',quiet_start=0,quiet_end=0 WHERE id=1");});
  afterEach(async()=>{await db.close();});
  const visual=()=>new VisualMemory(db,h.tg as unknown as Telegram,h.brain);
  async function context(){for(let i=0;i<6;i++)await h.lumen.receive(message(i%2?'треба обрати маршрут поїздки':'плануємо їхати у Львів',i%2?11:22));}
  it('ініціативна відповідь лише пропонує допомогу, не виконує непроханих дій та має паузу',async()=>{
    await context();h.brain.replies.push({reply:'Можу зібрати ваші варіанти маршруту в коротке порівняння.',actions:[{kind:'remember',content:'непроханий запис'}],behavior:{move:'answer',recipient:'bot',relation:'ambient',reason:'Продовжити конкретну тему розмови',contribution:{key:'Предметний новий внесок',summary:'Додав доречну думку до поточної теми'}},engagement:{respond:true,reason:'helpful'},presentation:{choices:['Так','Ні']}});
    await h.lumen.receive(message('Як нам краще спланувати маршрут?',22));await db.query('UPDATE inbox SET available_at=now()');assert.equal(await h.lumen.processNext(),true);assert.equal(JSON.parse(h.brain.calls[0]!.context).engagement_context.reason,'ambient');assert.equal((await db.query('SELECT * FROM memories')).rows.length,0);assert.equal((await db.query('SELECT * FROM choices')).rows.length,0);
    assert.ok((await one(db,"SELECT body FROM outbox WHERE kind='text'"))!.body.ambient);
  });
  it('поважає вимкнення й тихі години та стримує прикраси у складній розмові',async()=>{
    const m=message('треба обрати маршрут').message!,s=await state(db);
    assert.equal(ambientEnabled(s,m,'Europe/Kyiv'),true);
    assert.equal(ambientEnabled({...s,proactive_mode:'off'},m,'Europe/Kyiv'),false);
    const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Kyiv',hour:'2-digit',hourCycle:'h23'}).format(new Date()));assert.equal(ambientEnabled({...s,quiet_start:hour,quiet_end:(hour+1)%24},m,'Europe/Kyiv'),false);
    await h.lumen.receive(message('Мені дуже важко, помер близький'));
    h.brain.replies.push({reply:'Можу допомогти з організаційними питаннями, якщо потрібно.',actions:[],presentation:{reaction:'😁'},behavior:{move:'answer',recipient:'bot',relation:'ambient',reason:'Продовжити конкретну тему розмови',contribution:{key:'Предметний новий внесок',summary:'Додав доречну думку до поточної теми'}},engagement:{respond:true,reason:'helpful'}});await db.query('UPDATE inbox SET available_at=now()');await h.lumen.processNext();
    assert.equal((await db.query("SELECT * FROM outbox WHERE kind='reaction'")).rows.length,0);assert.match(h.brain.calls[0]!.instructions!,/тактовну подачу/);
  });
  it('одноразове оголошення стає sent лише після підтвердженої доставки',async()=>{
    await db.query("INSERT INTO release_notices(version,status,telegram_id) VALUES('1.8.0','sent',900)");
    const url='https://t.me/addstickers/'+STICKER_SET;
    assert.equal(await queueReleaseNotice(db,url),true);assert.equal(await queueReleaseNotice(db,url),false);
    const pending=(await one(db,'SELECT status,telegram_id FROM release_notices WHERE version=$1',[RELEASE]))!;
    assert.equal(pending.status,'pending');assert.equal(pending.telegram_id,null);
    const queued=(await db.query("SELECT * FROM outbox WHERE dedup_key=$1",[`release:${RELEASE}:0`])).rows;
    assert.equal(queued.length,1);assert.equal(queued[0]!.status,'pending');
    assert.ok(queued[0]!.body.text.startsWith('Люмен '+RELEASE));assert.ok(queued[0]!.body.text.includes(url));assert.ok(queued[0]!.body.text.length<1500);
    const d=new Delivery(db,h.tg as unknown as Telegram,h.config);assert.equal(await d.next(),true);
    assert.equal(h.tg.sent.length,1);assert.equal(h.tg.sent[0]!.text,queued[0]!.body.text);
    const delivered=(await one(db,'SELECT status,telegram_id FROM release_notices WHERE version=$1',[RELEASE]))!;
    assert.equal(delivered.status,'sent');assert.equal(delivered.telegram_id,h.tg.counter);
    assert.equal(await queueReleaseNotice(db,url),false);assert.equal(await d.next(),false);assert.equal(h.tg.sent.length,1);
    assert.equal((await one(db,"SELECT telegram_id FROM release_notices WHERE version='1.8.0'"))!.telegram_id,900);
  });
  it('оголошує виправлення наліпок один раз без зайвого завантаження набору',async()=>{
    assert.equal(await queueReleaseNotice(db),true);assert.equal((await db.query('SELECT * FROM release_notices')).rows.length,1);assert.equal((await db.query('SELECT * FROM outbox')).rows.length,1);
  });
  it('дістає три різні реальні кадри з готового WEBM-стікера',async()=>{
    h.tg.file=async()=>readFile(new URL('../../assets/stickers/lumen_50.webm',import.meta.url));const frames=await visual().frames({kind:'sticker_video',file_id:'own-wave'});assert.equal(frames.mode,'sampled_animation_frames');assert.equal(frames.images.length,3);assert.ok(new Set(frames.images).size>=2);
  });
  it('пауза скасовує незавершене зображення й активні продовження',async()=>{
    h.config.apiKey='test';h.config.imageModel='test';h.brain.replies.push({reply:'Який колір?',actions:[{kind:'image',prompt:'Море'}],dialogue:{kind:'media',audience:'personal',expecting:'Який колір?'}});await h.lumen.receive(message('Люмен, намалюй море'));await h.lumen.processNext();let release!:(b:Buffer)=>void;const jobs=new ImageJobs(db,h.config,h.tg as unknown as Telegram,visual(),{image:()=>new Promise<Buffer>(r=>{release=r;})} as unknown as Media);const pending=jobs.next();while(!release)await new Promise(r=>setTimeout(r,1));await h.lumen.receive(message('/pause'));release(Buffer.from('image'));await pending;assert.equal((await one(db,'SELECT status FROM image_jobs'))!.status,'cancelled');assert.equal((await db.query('SELECT * FROM dialogues')).rows.length,0);assert.equal(h.tg.sent.length,0);
  });
  it('перевіряє байти початкових 50 і наступних 70 WEBM та відновлює непевне створення',async()=>{
    const assets=await stickerAssets();assert.equal(assets.length,STICKER_COUNT);let reads=0,creates=0,adds=0;
    const stickers=assets.map((a,i)=>({file_id:'video-'+i,file_unique_id:'unique-'+i,is_video:true,set_name:STICKER_SET,emoji:(a.telegram_emoji??a.emoji)}));
    const pack={name:STICKER_SET,title:STICKER_TITLE,stickers:[] as typeof stickers};
    const verify=async(blob:Blob,i:number)=>{const bytes=Buffer.from(await blob.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),assets[i]!.sha256);assert.ok(bytes.length<=256*1024);};
    const tg={call:async(method:string)=>{assert.equal(method,'getStickerSet');if(++reads===1)throw new TelegramError('telegram_400');return structuredClone(pack);},multipart:async(method:string,form:FormData)=>{
      if(method==='createNewStickerSet'){
        creates++;const input=JSON.parse(String(form.get('stickers')));assert.equal(input.length,50);
        for(let i=0;i<50;i++){assert.equal(input[i].format,'video');await verify(form.get('sticker'+i) as Blob,i);}
        pack.stickers=stickers.slice(0,50);throw new TelegramError('telegram_network',0,true);
      }
      assert.equal(method,'addStickerToSet');const i=pack.stickers.length;await verify(form.get('video') as Blob,i);assert.equal(JSON.parse(String(form.get('sticker'))).emoji_list[0],(assets[i]!.telegram_emoji??assets[i]!.emoji));pack.stickers.push(stickers[i]!);adds++;return true;
    }} as unknown as Telegram;
    assert.equal((await ensureStickerPack(tg,'11',undefined,0)).stickers.length,STICKER_COUNT);assert.equal(creates,1);assert.equal(adds,STICKER_COUNT-50);assert.equal(reads,3+STICKER_COUNT-50);
  });
});
