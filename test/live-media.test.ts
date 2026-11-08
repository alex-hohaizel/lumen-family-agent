import {describe,it,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {TestDB,harness,paired,message} from './helpers.js';
import {one,state} from '../src/db.js';
import {VisualMemory} from '../src/visual.js';
import {renderTGS} from '../src/vector-sticker.js';
import {ChatRegistry} from '../src/registry.js';
import {ChatRouter} from '../src/router.js';
import {Delivery} from '../src/delivery.js';
import {Telegram,type Update} from '../src/telegram.js';
import {ImageJobs} from '../src/image-jobs.js';
import {Media} from '../src/media.js';
import {PlanSchema,strictOutputSchema} from '../src/model.js';
import {z} from 'zod';

describe('Живі продовження, спільні рішення та медіа',()=>{
  let db:TestDB,h:ReturnType<typeof harness>;let sequence=800000;
  beforeEach(async()=>{db=new TestDB();await db.init();h=harness(db);await paired(h);await db.query("UPDATE app_state SET open_group=true,mention_only=true,mode='quiet',quiet_start=0,quiet_end=0 WHERE id=1");await db.query("INSERT INTO members(user_id,name) VALUES('11','Гравець А'),('22','Олена')");});
  afterEach(async()=>{await db.close();});
  const ask=async(u:Update)=>{await h.lumen.receive(u);await h.lumen.processNext();};
  const considerBackground=async()=>{const candidate=await one(db,"SELECT update_id,payload FROM inbox WHERE status='pending' AND payload->'engagement'->>'reason'='ambient'");assert.ok(candidate);await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE update_id=$1",[candidate!.update_id]);await h.lumen.processNext();return candidate!;};
  const visual=()=>new VisualMemory(db,h.tg as unknown as Telegram,h.brain);
  const router=async()=>{const registry=new ChatRegistry(db);const r=new ChatRouter(registry,h.config,h.tg as unknown as Telegram,{id:999,username:'lumen_test_bot'},()=>h.brain);await r.init();await r.runtime((await registry.find('-100'))!);return r;};
  const callback=(data:string,user=22,name='Олена'):Update=>({update_id:sequence++,callback_query:{id:'choice'+sequence,from:{id:user,first_name:name},data,message:{message_id:9999,date:Math.floor(Date.now()/1000),chat:{id:-100,type:'supergroup'},from:{id:999,first_name:'Люмен',is_bot:true},text:'Яку гру обираємо?'}}});

  it('приймає відповідь на своє уточнення без повторної згадки',async()=>{
    h.brain.replies.push({behavior:{move:'clarify',recipient:'bot',relation:'new_request',reason:'Потрібен час нагадування',clarification:{question:'О котрій годині?',missing_slot:'time',why:'Щоб поставити нагадування у потрібний час'}},reply:'О котрій годині?',actions:[]});await ask(message('Люмен, нагадай завтра купити квитки'));
    h.brain.replies.push({behavior:{move:'answer',recipient:'bot',relation:'answer_to_question',reference_id:(await one(db,'SELECT id FROM conversation_goals'))!.id,reason:'Автор уточнив час'},reply:'',actions:[{kind:'remind',title:'Квитки',due_at:new Date(Date.now()+3600000).toISOString()}]});await ask(message('О восьмій'));
    assert.equal((await db.query('SELECT * FROM reminders')).rows.length,1);assert.equal(JSON.parse(h.brain.calls[1]!.context).engagement_context.reason,'continuation');
  });
  it('розуміє очевидне уточнення до своєї відповіді, яка не містила питання',async()=>{
    h.brain.replies.push({reply:'Північне сяйво виникає через взаємодію заряджених частинок з атмосферою.',actions:[]});await ask(message('Люмен, що таке північне сяйво'));const delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);await delivery.next();
    h.brain.replies.push({reply:'Кисень і азот світяться різними кольорами.',actions:[],behavior:{move:'answer',recipient:'bot',relation:'reply',reason:'Автор уточнює попередню відповідь про сяйво',contribution:{key:'Колір сяйва залежить від газу',summary:'Пояснив роль кисню й азоту'}},engagement:{respond:true,reason:'continuation'}});await ask(message('А чому воно різнокольорове?'));assert.equal(h.brain.calls.length,1);const candidate=await considerBackground();assert.equal(candidate.payload.engagement.dialogue.origin,'social_candidate');assert.deepEqual(candidate.payload.engagement.dialogue.allowed,[]);assert.equal(h.brain.calls.length,2);const context=JSON.parse(h.brain.calls[1]!.context);assert.equal(context.engagement_context.reason,'ambient');assert.match(context.active_dialogue.question,/заряджених частинок/);await delivery.next();assert.equal(h.tg.sent.length,2);assert.match(h.tg.sent[1]!.text,/Кисень і азот/);assert.equal((await db.query('SELECT id FROM memories')).rows.length,0);assert.equal((await db.query('SELECT id FROM reminders')).rows.length,0);
  });
  it('особисте уточнення не приймає чужу відповідь і відповідь з іншої теми',async()=>{
    h.brain.replies.push({behavior:{move:'clarify',recipient:'bot',relation:'new_request',reason:'Потрібен час нагадування',clarification:{question:'О котрій годині?',missing_slot:'time',why:'Щоб поставити нагадування у потрібний час'}},reply:'О котрій годині?',actions:[]});await ask(message('Люмен, нагадай завтра про квитки'));await h.lumen.receive(message('О восьмій',22));const other=message('О восьмій');other.message!.message_thread_id=202;await h.lumen.receive(other);
    const candidates=(await db.query("SELECT * FROM inbox WHERE status='pending'")).rows;assert.ok(candidates.every(x=>x.payload.engagement.reason==='ambient'&&!x.payload.engagement.dialogue));assert.equal((await db.query('SELECT * FROM reminders')).rows.length,0);
  });
  it('не втручається, якщо модель визначила кандидат продовження як чужу розмову',async()=>{
    h.brain.replies.push({reply:'Який колір обереш?',actions:[]});await ask(message('Люмен, допоможи обрати колір'));await db.query('DELETE FROM outbox');
    h.brain.replies.push({reply:'',actions:[{kind:'remember',content:'Не можна зберігати'}],engagement:{respond:false,reason:'skip'}});await ask(message('Петре, ти вже вдома?'));await considerBackground();
    assert.equal(h.brain.calls.length,2);assert.equal((await db.query('SELECT * FROM outbox')).rows.length,0);assert.equal((await db.query('SELECT * FROM memories')).rows.length,0);
  });
  it('зберігає спільні вибори під справжніми іменами й оновлює повторний вибір',async()=>{
    h.brain.replies.push({reply:'Яку гру обираємо?',actions:[],presentation:{choices:['Детектив','Вікторина'],audience:'group'}});await ask(message('Люмен, запропонуй нам гру'));
    const stage=await one(db,'SELECT * FROM interactions');const r=await router();
    await r.receive(callback(`li:${stage!.id}:1:0`));
    assert.equal(h.brain.calls.length,1);const first=await one(db,'SELECT * FROM interaction_responses');assert.equal(first!.user_id,'22');assert.equal((await one(db,'SELECT phase FROM interactions'))!.phase,'collecting');
    await r.receive(callback(`li:${stage!.id}:1:1`));
    const votes=(await db.query('SELECT * FROM interaction_responses')).rows;assert.equal(votes.length,1);assert.deepEqual(votes[0]!.choices,[1]);
    assert.match(JSON.stringify((await db.query('SELECT body FROM outbox')).rows),/Олена/);
  });
  it('особистий вибір не дозволяє натиснути чужу кнопку',async()=>{
    h.brain.replies.push({reply:'Для тебе простіше чи складніше?',actions:[],presentation:{choices:['Простіше','Складніше'],audience:'personal'}});await ask(message('Люмен, допоможи мені з грою'));const c=await one(db,'SELECT id FROM choices LIMIT 1');const r=await router();await r.receive(callback('lumen:choice:'+c!.id));assert.equal((await db.query('SELECT * FROM choice_votes')).rows.length,0);
  });
  it('фото без звернення зберігає як медіа, не відповідаючи в чат',async()=>{
    const u=message('');u.message!.photo=[{file_id:'group-photo'}];await h.lumen.receive(u);assert.equal((await db.query('SELECT * FROM attachments')).rows.length,1);assert.equal(h.brain.calls.length,0);assert.equal((await db.query('SELECT * FROM outbox')).rows.length,0);assert.equal(h.brain.calls.length,0);
  });
  it('розуміє картинку, надіслану файлом, і передає її моделі як зображення',async()=>{
    const png=await sharp({create:{width:64,height:64,channels:4,background:'#29b6c8'}}).png().toBuffer();h.tg.file=async()=>png;
    const u=message('Люмен, що на цій картинці?');u.message!.document={file_id:'png-file',file_name:'picture.png',mime_type:'image/png'};await ask(u);assert.equal(h.brain.calls[0]!.images!.length,1);assert.equal((await state(db)).last_model_error,null);
  });
  it('альбом об’єднує в одне звернення і передає всі доступні кадри',async()=>{
    const png=await sharp({create:{width:32,height:32,channels:4,background:'#44aacc'}}).png().toBuffer();h.tg.file=async()=>png;
    for(let i=0;i<3;i++){const u=message(i===0?'Люмен, порівняй ці фото':'');u.message!.photo=[{file_id:'album-'+i}];u.message!.media_group_id='album';await h.lumen.receive(u);}
    assert.equal((await db.query('SELECT * FROM inbox')).rows.length,1);await db.query('UPDATE inbox SET available_at=now()');await h.lumen.processNext();assert.equal(h.brain.calls[0]!.images!.length,3);
  });
  it('аватарку показує тільки для учасника, відомого своїй групі',async()=>{
    const png=await sharp({create:{width:32,height:32,channels:4,background:'#f2c66d'}}).png().toBuffer();h.tg.file=async()=>png;const call=h.tg.call.bind(h.tg);h.tg.call=async(method:string,body:any)=>method==='getUserProfilePhotos'?{photos:[[{file_id:'avatar'}]]}:call(method,body) as any;
    const no=await visual().avatar('77','11');assert.equal(no.images.length,0);const yes=await visual().avatar('22','11');assert.equal(yes.images.length,1);assert.equal((await one(db,'SELECT user_id FROM avatars'))!.user_id,'22');
  });
  it('запам’ятовує зміст стікера за зображенням, а не лише за emoji',async()=>{
    const png=await sharp({create:{width:32,height:32,channels:4,background:'#e2a344'}}).png().toBuffer();h.tg.file=async()=>png;h.brain.text=async()=> 'Персонаж саркастично аплодує.';
    const u=message('');u.message!.sticker={file_id:'visual-sticker',file_unique_id:'unique',emoji:'🙂'};await h.lumen.receive(u);await visual().next();assert.match((await one(db,'SELECT description FROM stickers'))!.description,/саркастично/);assert.equal(h.tg.sent.length,0);
  });
  it('пауза під час візуального аналізу не дозволяє записати його результат',async()=>{
    const png=await sharp({create:{width:32,height:32,channels:4,background:'#eeeeee'}}).png().toBuffer();h.tg.file=async()=>png;let release!:(v:string)=>void;h.brain.text=()=>new Promise<string>(r=>{release=r;});const u=message('');u.message!.photo=[{file_id:'private-photo'}];await h.lumen.receive(u);const pending=visual().next();while(!release)await new Promise(r=>setTimeout(r,1));await h.lumen.receive(message('/pause'));release('Заборонений результат після паузи');await pending;assert.equal((await one(db,'SELECT description FROM attachments'))!.description,'');
  });
  it('TGS отримує три справжні різні векторні кадри без зовнішніх ресурсів',async()=>{
    const tgs={w:512,h:512,ip:0,op:60,layers:[{ty:4,ip:0,op:60,ks:{p:{a:1,k:[{t:0,s:[40,80],e:[350,80]},{t:60,s:[350,80]}]}},shapes:[{ty:'el',p:{k:[0,0]},s:{k:[60,60]}},{ty:'fl',c:{k:[0,1,1,1]},o:{k:100}}]}]};const frames=await renderTGS(gzipSync(JSON.stringify(tgs)));assert.equal(frames.length,3);assert.equal(new Set(frames.map(b=>createHash('sha256').update(b).digest('hex'))).size,3);
  });
  it('голоси неанонімного опитування записує без зайвих повідомлень і враховує зміну',async()=>{
    await db.query("INSERT INTO polls(poll_id,message_id,question,options,revision) VALUES('poll',500,'Куди?','[\"Львів\",\"Карпати\"]',0)");const r=await router(),noticeCount=(await db.query("SELECT id FROM outbox WHERE dedup_key LIKE 'release:%'")).rows.length;for(const option_ids of [[0],[1],[]])await r.receive({update_id:sequence++,poll_answer:{poll_id:'poll',user:{id:22,first_name:'Олена'},option_ids}});
    const vote=await one(db,'SELECT * FROM poll_votes');assert.equal(vote!.name,'Олена');assert.deepEqual(vote!.option_ids,[]);assert.equal((await db.query('SELECT * FROM outbox WHERE service=false')).rows.length,0);assert.equal((await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'release:%'")).rows.length,noticeCount);assert.equal(h.brain.calls.length,0);
  });
  it('редагування одного джерела зберігає незалежні нотатки та нагадування',async()=>{
    const a=message('Люмен, запам’ятай: зустріч у п’ятницю'),b=message('Люмен, запам’ятай: квитки в неділю');h.brain.replies.push({reply:'',actions:[{kind:'remember',content:'Зустріч у п’ятницю'}]},{reply:'',actions:[{kind:'remember',content:'Квитки в неділю'}]});await ask(a);await ask(b);const sources=(await db.query("SELECT id FROM messages WHERE role='user' ORDER BY id")).rows;await db.query('INSERT INTO reminders(title,due_at,author_id,source_message_id) VALUES($1,now()+interval \'1 day\',\'11\',$2)',['Квитки в неділю',sources[1]!.id]);
    await h.lumen.receive({update_id:sequence++,edited_message:{...a.message!,text:'Люмен, зустріч у суботу'}});assert.deepEqual((await db.query('SELECT content FROM memories')).rows.map(x=>x.content),['Квитки в неділю']);assert.equal((await db.query('SELECT * FROM reminders')).rows.length,1);
  });
  it('не дозволяє діяти з чужим повідомленням через вигаданий message_id',async()=>{
    h.brain.replies.push({reply:'',actions:[{kind:'telegram',operation:'pin_message',message_id:123456}]});await ask(message('Люмен, закріпи повідомлення'));assert.equal((await state(db)).last_model_error,'own_message_required');assert.ok(!h.tg.calls.some(x=>x.method==='pinChatMessage'));
  });
  it('скасування незавершеної генерації запобігає доставці та не блокує звичайний діалог',async()=>{
    h.config.apiKey='test';h.config.imageModel='test-image';h.brain.replies.push({reply:'',actions:[{kind:'image',prompt:'Море'}]});await ask(message('Люмен, намалюй море'));let release!:(b:Buffer)=>void;const media={image:()=>new Promise<Buffer>(r=>{release=r;})} as unknown as Media;const jobs=new ImageJobs(db,h.config,h.tg as unknown as Telegram,visual(),media);const pending=jobs.next();while(!release)await new Promise(r=>setTimeout(r,1));h.brain.replies.push({reply:'На зв’язку.',actions:[]});await ask(message('Люмен, привіт'));h.brain.replies.push({reply:'',actions:[{kind:'cancel_image'}]});await ask(message('Люмен, скасуй малювання'));release(Buffer.from('image'));await pending;assert.equal((await one(db,'SELECT status FROM image_jobs'))!.status,'cancelled');assert.equal(h.tg.sent.length,0);assert.match(JSON.stringify((await db.query('SELECT body FROM outbox')).rows),/На зв’язку/);
  });
  it('structured schema явно вимагає поля, дозволяє null лише для необов’язкових',()=>{
    const schema=strictOutputSchema(z.toJSONSchema(z.object({required:z.string(),optional:z.string().optional()})));assert.deepEqual(schema.required,['required','optional']);assert.equal(schema.additionalProperties,false);assert.ok(schema.properties.optional.anyOf.some((x:any)=>x.type==='null'));assert.equal(schema.properties.required.type,'string');const full=strictOutputSchema(z.toJSONSchema(PlanSchema));assert.ok(!JSON.stringify(full).includes('\"oneOf\"'));assert.ok(full.properties.actions.items.anyOf.length>20);
  });
});
