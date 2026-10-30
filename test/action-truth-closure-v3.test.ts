import {describe,it,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';
import {PDFDocument} from 'pdf-lib';
import {explicitDiagnosticRequest,gateOutcome,outcomeMessage,toolOutcome,type OutcomeFact} from '../src/outcomes.js';
import {AgentTools,type ToolContext} from '../src/agent-tools.js';
import {Delivery} from '../src/delivery.js';
import {one} from '../src/db.js';
import {evolution} from '../src/evolution-tools.js';
import {CollectionCommand,StudioCommand} from '../src/media-workshop.js';
import {binaryArtifact} from '../src/document-workshop.js';
import {verifyTask} from '../src/result-verifier.js';
import {TestDB,harness,paired,message} from './helpers.js';

const list=()=>toolOutcome('lists.manage',{operation:'add',category:'shopping',added:['молоко'],items:[{text:'молоко'}],message:'Додав у покупки: молоко.'});
const check=(reply:string,facts:OutcomeFact[]=[list()])=>gateOutcome({reply,actions:[]},facts);
function wave(seconds:number){
 const samples=Math.round(seconds*44100),bytes=Buffer.alloc(44+samples*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(44100,24);bytes.writeUInt32LE(88200,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)bytes.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/44100)*10000),44+i*2);return bytes;
}

describe('V3 actual effect and claim binding',()=>{
 it('list acknowledgements cannot certify a physical purchase, order, payment or delivery in three languages',()=>{
  for(const reply of ['Купив молоко.','Молоко вже купив.','Молоко куплено.','Я замовив молоко.','Я оплатив молоко.','Доставив покупки.','Купил молоко.','Молоко купил.','Молоко уже куплено.','Я заказал молоко.','Я оплатил молоко.','I bought milk.','I purchased milk.','I ordered milk.','I paid for milk.','I delivered the groceries.','The milk was purchased.']){
   const result=check(reply);assert.equal(result.blocked,true,reply);assert.equal(result.plan.reply,'Додав у покупки: молоко.',reply);
  }
 });
 it('retains reported user purchases, protected quotes, code, roleplay, questions, negation, future and word explanations',()=>{
  for(const reply of ['Ти купив молоко — тепер його можна використати для каші.','Молоко купив ти.','Milk was bought by you.','Олена купила молоко.','Ти написав, що купив молоко.','Користувач сказав: купив молоко.','Ти написав «Купив молоко».','`I bought milk.`','```text\nКупил молоко.\n```','У нашій грі я купив молоко.','Я купив молоко в грі.','Roleplay: I bought milk.','In our story, I bought milk.','Купив молоко?','Ты купил молоко?','Did I buy milk?','Я не купив молоко.','Я не купил молоко.','I have not bought milk.','I never ordered milk.','Я куплю молоко завтра.','I will buy milk tomorrow.','Якщо купив молоко, постав його в холодильник.','Слово купив — це форма минулого часу.','Фраза купив молоко описує завершену покупку.','The word bought is a past tense form.','I paid attention to the shopping list.','An ordered list uses numbers.','Додав у покупки: молоко.']){
   const result=check(reply);assert.equal(result.blocked,false,reply);assert.equal(result.plan.reply,reply,reply);
  }
 });
 it('keeps independent answers and card facts while replacing only a false physical result',()=>{
  const calendar=toolOutcome('calendar.write',{id:'event',provider_readback:true,receipt:{uid:'event-uid'}});
  const result=gateOutcome({reply:'Подію створено.\nМолоко вже купив.\n2 + 2 = 4.',actions:[],presentation:{card:{title:'Результати',summary:'Купив молоко.',facts:['Зустріч о 10:00.','Молоко зберігай у холодильнику.'],question:'Що ще додати?'}}},[list(),calendar]);
  assert.equal(result.blocked,true);assert.match(result.plan.reply,/Подію створено/u);assert.match(result.plan.reply,/2 \+ 2 = 4/u);assert.match(result.plan.reply,/Зустріч о 10:00/u);assert.match(result.plan.reply,/зберігай у холодильнику/u);assert.match(result.plan.reply,/Що ще додати/u);assert.doesNotMatch(result.plan.reply,/Купив|вже купив/u);
  const compound=check('Купив молоко, а 2 + 2 = 4.');assert.equal(compound.blocked,true);assert.match(compound.plan.reply,/2 \+ 2 = 4/u);
 });
 it('does not add a physical-action censor to conversations without a list outcome',()=>{
  assert.equal(check('У моєму оповіданні я купив молоко.',[]).blocked,false);
 });
 it('does not let a generic TXT receipt certify unnamed video, album, image, audio or PDF claims',()=>{
  const text=toolOutcome('artifact.delivery',{id:'txt',name:'План.txt',status:'delivered',deliveryReceipt:{message_id:1}});
  for(const reply of ['Ролик готовий.','Видео готово.','The video is ready.','Альбом готовий.','Зображення надіслано.','Аудіофайл готовий.','PDF готовий.'])assert.equal(check(reply,[text]).blocked,true,reply);
  for(const reply of ['Файл надіслано.','Документ готовий.','Файл «План.txt» надіслано.','Файл «Відео» надіслано.']){
   const fact=reply.includes('«Відео»')?{...text,targets:['Відео']}:text;assert.equal(check(reply,[fact]).blocked,false,reply);
  }
  for(const name of ['video.txt','image.png','audio.wav']){const fact=toolOutcome('artifact.delivery',{id:'named',name,status:'delivered',deliveryReceipt:{message_id:2}});assert.equal(check(`Файл ${name} надіслано.`,[fact]).blocked,false,name);}
  assert.equal(check('Файл Інший.txt надіслано.',[text]).blocked,true);
 });
 it('requires actual readback proof with exact result identity and receipt, not MIME, names, requests or ready flags',()=>{
  const base={id:'video',name:'Video.mp4',mime:'video/mp4',status:'delivered',kind:'story',deliveryReceipt:{message_id:9}},proof={id:'video',sha256:'a'.repeat(64),bytes:100,mime:'video/mp4',revision:0,readback_verified:true,receipt_message_id:9,kinds:['video']};
  assert.equal(check('Ролик готовий.',[toolOutcome('artifact.delivery',{...base,outputProof:proof})]).blocked,false);
  for(const outputProof of [undefined,{...proof,readback_verified:false},{...proof,id:'other'},{...proof,receipt_message_id:10},{...proof,sha256:'unknown'},{...proof,kinds:['pdf']}])assert.equal(check('Ролик готовий.',[toolOutcome('artifact.delivery',{...base,outputProof},{operation:'render',require_audio:true})]).blocked,true,JSON.stringify(outputProof));
  const mismatched={...base,outputProof:proof,deliveryReceipt:{message_id:9,output:{id:'video',sha256:'b'.repeat(64),bytes:100,mime:'video/mp4',revision:0}}};
  assert.equal(check('Ролик готовий.',[toolOutcome('artifact.delivery',mismatched)]).blocked,true);
 });
 it('repairs invented diagnosis, raw service failures and a phantom retry while keeping an independent answer',()=>{
  const failed=toolOutcome('studio.manage',{error:'invalid_tool_arguments'});
  for(const reply of ['З роликом не вийшло, бо твій файл пошкоджений. Надішли його заново.','Сталася помилка invalid_tool_arguments. Надішли відео ще раз.','Код помилки: invalid_tool_arguments.','Код помилки: ffmpeg_failed.','Не вийшло. Автоматично спробую знову через хвилину.','Не получилось, потому что твой файл повреждён.','Ошибка invalid_tool_arguments.','Автоматически попробую ещё раз через минуту.','It failed because your file is damaged.','An error invalid_tool_arguments occurred.','I will automatically try again in a minute.']){
   const result=check(reply+'\nЗустріч о 10:00.',[failed]);assert.equal(result.blocked,true,reply);assert.match(result.plan.reply,/Зустріч о 10:00/u);assert.match(result.plan.reply,/З роликом поки не вийшло/u);assert.doesNotMatch(result.plan.reply,/пошкоджен|поврежд[её]н|damaged|invalid_tool_arguments|Автоматич|Автоматическ|automatically|Надішли його заново|Надішли відео ще раз/iu,reply);
  }
 });
 it('preserves truthful humane recovery, protected discussion, conditions, negated retry and explanations',()=>{
  const failed=toolOutcome('studio.manage',{error:'invalid_tool_arguments'});
  for(const reply of ['З роликом поки не вийшло. Надішли фото, які беремо.','Можемо спробувати ще раз або змінити матеріали.','Якщо файл пошкоджений, спробуй відкрити його на телефоні.','If your file is damaged, check the original.','Ти написав «Сталася помилка invalid_tool_arguments».','Ти сказав, що файл пошкоджений.','He said the file is damaged.','У нашій грі файл пошкоджений.','Файл не пошкоджений.','Автоматично повторювати не буду.','I will not retry automatically.','Спробую пояснити це ще раз простіше.','Повторювані нагадування допомагають із щоденними справами.']){
   const result=check(reply,[failed]);assert.equal(result.blocked,false,reply);assert.equal(result.plan.reply,reply);
  }
  const missing=toolOutcome('studio.manage',{error:'soundtrack_required'});assert.equal(check('З роликом не вийшло, бо потрібен аудіофайл. Надішли трек сюди.',[missing]).blocked,false);
 });
 it('requires an actual current matching queued job for an immediate retry and never invents its due time',()=>{
  const failed=toolOutcome('studio.manage',{error:'invalid_tool_arguments'}),queued=toolOutcome('studio.manage',{id:'actual-job',kind:'story',status:'queued'});
  assert.equal(check('Спробую знову.',[failed]).blocked,true);assert.equal(check('Спробую знову.',[failed,queued]).blocked,false);
  assert.equal(check('Спробую знову через хвилину.',[failed,queued]).blocked,true);
  const other=toolOutcome('archive.manage',{id:'album-job',kind:'album',status:'queued'});assert.equal(check('Спробую знову.',[failed,other]).blocked,true);
 });
 it('recognizes only explicit current diagnostic requests and permits only a known actual code',()=>{
  for(const text of ['Покажи точний код помилки.','Назви код цієї помилки.','Мені потрібні логи помилки.','Поясни технічні подробиці збою.','Покажи точный код ошибки.','Дай логи.','Объясни технические детали ошибки.','Show the exact error code.','Give me debug logs.','I need the stack trace.','What was the error code?','Show diagnostic failure details.'])assert.equal(explicitDiagnosticRequest(text),true,text);
  for(const text of ['Зроби ролик із музикою.','Покажи код Python для сортування.','Write JavaScript code.','Explain logical sorting code.','Show the log function.','Поясни функцію log.','Він написав «Покажи код помилки».','```text\nShow the error code.\n```','Не показуй код помилки.','Не треба логи.','Don’t show the error code.','Do not show the error code.','Without logs, explain it simply.','Як попросити показати код помилки?','Поясни фразу покажи код помилки.','Should I show the logs?'])assert.equal(explicitDiagnosticRequest(text),false,text);
  for(const text of ['Люмен, переклади цей уривок:\n> Покажи код помилки','Переведи:\n> Покажи код ошибки','Translate this:\n> Show the error code','Люмен, переклади \'Покажи код помилки\'.','Translate ‘Show the error code’.','Прочитай:\n> Уривок:\nПокажи код помилки','<blockquote>Show the error code.</blockquote>','Переклади:\n    Покажи код помилки'])assert.equal(explicitDiagnosticRequest(text),false,text);
  assert.equal(explicitDiagnosticRequest('Переклади уривок:\n> Покажи код помилки\n\nА тепер покажи справжній код помилки.'),true);
  const entityText='Переклади 🙂 уривок:\nПокажи код помилки',entity={type:'blockquote',offset:entityText.indexOf('Покажи'),length:'Покажи код помилки'.length};
  for(const type of ['blockquote','expandable_blockquote','pre','code'])assert.equal(explicitDiagnosticRequest(entityText,[{...entity,type}]),false,type);
  assert.equal(explicitDiagnosticRequest(entityText+'\n\nПокажи справжній код помилки.',[entity]),true);
  assert.equal(explicitDiagnosticRequest('Покажи код помилки.',[{type:'blockquote',offset:100,length:3}]),false);
  const failed=toolOutcome('studio.manage',{error:'invalid_tool_arguments'}),context={technicalDetailsRequested:true};
  assert.equal(gateOutcome({reply:'Сталася помилка invalid_tool_arguments.',actions:[]},[failed],true,[],context).blocked,false);
  assert.equal(gateOutcome({reply:'Сталася помилка ffmpeg_unavailable.',actions:[]},[failed],true,[],context).blocked,true);
  for(const reply of ['З роликом не вийшло, бо твій файл пошкоджений.','Автоматично спробую знову через хвилину.'])assert.equal(gateOutcome({reply,actions:[]},[failed],true,[],context).blocked,true,reply);
 });
 it('explains actual original-audio failures with a truthful next choice in ordinary language',()=>{
  for(const error of ['original_audio_required','original_audio_silent','original_audio_has_no_usable_audio','original_audio_shorter_than_scene']){
   const fact=toolOutcome('studio.manage',{error}),reply=outcomeMessage([fact]);assert.match(reply,/звук/iu);assert.match(reply,/відео|фрагмент/iu);assert.match(reply,/мож|надішли|обери/iu);assert.doesNotMatch(reply,/original_audio|AAC|MP4|пошкоджен|автоматич|повторю/iu);assert.equal(check(reply,[fact]).blocked,false,error);
  }
 });
});

describe('V3 actual foreground and acknowledged-byte controls',()=>{
 const db=new TestDB();let h:ReturnType<typeof harness>,tools:AgentTools,ctx:ToolContext;
 before(async()=>{await db.init();});
 beforeEach(async()=>{
  await db.reset();h=harness(db);await paired(h);tools=new AgentTools(db,h.config,h.brain);
  const seed=message('Люмен, підготуй з наданих матеріалів ролик з музикою, альбом і файли.');await h.lumen.receive(seed);
  const source=await one(db,"SELECT id FROM messages WHERE role='user' AND telegram_id=$1",[seed.message!.message_id]);
  ctx={actorId:'11',chatId:'-100',topicId:'0',revision:0,sourceId:Number(source!.id),updateId:'truth-v3',requested:true,audience:'group'};
  await db.query("UPDATE inbox SET status='done' WHERE status='pending'");
 });
 after(async()=>{await db.close();});
 const delivery=()=>new Delivery(db,h.tg as any,h.config);
 const operation=():ToolContext=>({...ctx,operationKey:randomUUID(),updateId:randomUUID()});
 async function foreground(text:string,actions:any[],reply:string){
  const update=message(text);h.brain.replies.push({reply:'',actions},{reply,actions:[]});await h.lumen.receive(update);await h.lumen.processNext();
  const source=await one(db,"SELECT id FROM messages WHERE role='user' AND telegram_id=$1",[update.message!.message_id]);
  const row=await one(db,"SELECT body FROM outbox WHERE kind='text' AND source_message_id=$1 AND dedup_key LIKE 'answer:%' ORDER BY id DESC LIMIT 1",[source!.id]);assert.ok(row);
  for(let n=0;n<12;n++)await delivery().next('text');return {text:String(row.body.text),sourceId:Number(source!.id)};
 }
 async function publish(bytes:Buffer,mime:string,title:string){
  const media=evolution(db,h.config,h.brain).media,asset=await media.store(bytes,mime,title,operation());
  const publication=await media.run({operation:'publish',id:asset.id,version:asset.version,caption:''},operation());assert.equal(await delivery().next('media'),true);
  const result=await tools.execute('library.delivery',{id:publication.id},operation());return {asset,publication,result};
 }
 async function pdf(){const doc=await PDFDocument.create();doc.addPage([200,200]);return Buffer.from(await doc.save());}
 it('repairs the exact physical purchase claim while keeping the actual list and independent reminder',async()=>{
  const result=await foreground('Люмен, додай молоко до покупок і нагадай через годину купити молоко',[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',text:'молоко',quote:'додай молоко до покупок'})},{kind:'schedule',mode:'reminder',authorization:'explicit',title:'Молоко',instruction:'Купити молоко',timezone:'UTC',due_at:new Date(Date.now()+3600000).toISOString(),quote:'нагадай через годину купити молоко'}],'Молоко вже купив.');
  assert.doesNotMatch(result.text,/вже купив|молоко куплено/iu);assert.match(result.text,/Додав у покупки: молоко/u);assert.match(result.text,/Запланував нагадування/u);assert.equal((result.text.match(/Додав у покупки/gu)||[]).length,1);
  assert.equal((await db.query('SELECT id FROM simple_list_events')).rows.length,1);assert.equal((await db.query("SELECT id FROM scheduled_actions WHERE status='pending'")).rows.length,1);assert.equal((await db.query('SELECT id FROM stock_movements')).rows.length,0);assert.ok(h.tg.sent.some(row=>row.text===result.text));
 });
 it('repairs TXT receipt plus failed video and retains the actual TXT delivery acknowledgement',async()=>{
  const artifact=await tools.execute('artifact.create',{name:'План.txt',content:'Прогулянка о 10:00.'},operation());assert.equal(await delivery().next('media'),true);
  const actual=await tools.execute('artifact.delivery',{id:artifact.id},operation());assert.equal(actual.status,'delivered');assert.equal(actual.outputProof.readback_verified,true);assert.deepEqual(actual.outputProof.kinds,[]);assert.equal(actual.deliveryReceipt.output.sha256,actual.outputProof.sha256);
  const result=await foreground('Люмен, перевір доставку файла План.txt і зроби ролик із музикою.',[{kind:'tool',name:'artifact.delivery',arguments:JSON.stringify({id:artifact.id})},{kind:'tool',name:'studio.manage',arguments:JSON.stringify({operation:'invalid'})}],'Файл «План.txt» надіслано.\nРолик готовий.\nЗустрінемося о 10:00.');
  assert.doesNotMatch(result.text,/Ролик готовий/u);assert.match(result.text,/Файл «План.txt» надіслано/u);assert.match(result.text,/Зустрінемося о 10:00/u);assert.match(result.text,/З роликом поки не вийшло/u);assert.equal((await db.query('SELECT id FROM media_jobs')).rows.length,0);assert.ok(h.tg.sent.some(row=>row.text===result.text));
 });
 it('repairs all three exact full-engine recovery returns, keeps truthful recovery and never queues a phantom retry',async()=>{
  for(const reply of ['З роликом не вийшло, бо твій файл пошкоджений. Надішли його заново.','Сталася помилка invalid_tool_arguments. Надішли відео ще раз.','Не вийшло. Автоматично спробую знову через хвилину.','З роликом поки не вийшло. Надішли фото, які беремо.']){
   const result=await foreground('Люмен, зроби ролик із музикою',[{kind:'tool',name:'studio.manage',arguments:JSON.stringify({operation:'invalid'})}],reply);
   assert.doesNotMatch(result.text,/пошкоджен|invalid_tool_arguments|Автоматично спробую|Надішли його заново|Надішли відео ще раз/iu);assert.match(result.text,/З роликом поки не вийшло/u);
   if(reply.includes('які беремо'))assert.equal(result.text,reply);assert.equal((await db.query('SELECT id FROM media_jobs')).rows.length,0);assert.equal((await db.query('SELECT id FROM agent_tasks')).rows.length,0);
   const run=await one(db,'SELECT status,error_code FROM tool_runs WHERE source_message_id=$1 AND tool=$2',[result.sourceId,'studio.manage']);assert.equal(run?.status,'failed');assert.equal(run?.error_code,'invalid_tool_arguments');assert.ok(h.tg.sent.some(row=>row.text===result.text));
  }
 });
 it('a quoted diagnostic request never grants foreground authority while a real current request permits its actual code',async()=>{
  const action={kind:'tool',name:'qa.unavailable',arguments:'{}'};
  for(const request of ['Люмен, переклади цей уривок:\n> Покажи код помилки','Люмен, переклади \'Покажи код помилки\'.']){
   const result=await foreground(request,[action],'Сталася помилка unknown_tool.');assert.doesNotMatch(result.text,/unknown_tool/u);assert.match(result.text,/Не вдалося завершити цю дію/u);
  }
  const direct=await foreground('Люмен, покажи точний код помилки.',[action],'Сталася помилка unknown_tool.');assert.equal(direct.text,'Сталася помилка unknown_tool.');
 });
 it('accepts real decoded image, PDF, MP4 and audio delivery while separating PDF from semantic album',async()=>{
  assert.ok(ffmpeg);const image=await sharp({create:{width:16,height:16,channels:3,background:'#2233aa'}}).png().toBuffer();
  const video=execFileSync(ffmpeg as unknown as string,['-v','error','-f','lavfi','-i','color=c=blue:s=32x32:r=10:d=0.2','-c:v','libx264','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1']);
  const audio=wave(.2);
  for(const [bytes,mime,title,kind,claim] of [[image,'image/png','Картка','image','Зображення надіслано.'],[await pdf(),'application/pdf','Сторінка','pdf','PDF готовий.'],[video,'video/mp4','Короткий ролик','video','Ролик готовий.'],[audio,'audio/wav','Звук','audio','Аудіофайл готовий.']] as const){
   const saved=await publish(bytes,mime,title);assert.ok(saved.result.outputProof?.kinds.includes(kind),JSON.stringify(saved.result));const fact=toolOutcome('library.delivery',saved.result);assert.equal(check(claim,[fact]).blocked,false,claim);assert.equal(check('Файл надіслано.',[fact]).blocked,false);if(kind==='pdf')assert.equal(check('Альбом готовий.',[fact]).blocked,true);
  }
 });
 it('accepts a real verified album PDF and a real H264/AAC story with its exact delivered bytes',async()=>{
  assert.ok(ffmpeg);const media=evolution(db,h.config,h.brain).media;
  const image=await media.store(await sharp({create:{width:80,height:80,channels:3,background:'#5599cc'}}).png().toBuffer(),'image/png','Кадр',operation());
  const audio=await media.store(wave(2),'audio/wav','Музика',operation());
  const album=await media.collection(CollectionCommand.parse({operation:'create',title:'Спогади'}),operation());const albumEdit=await media.collection(CollectionCommand.parse({operation:'add',id:album.id,version:album.version,asset_id:image.id,asset_version:image.version,caption:'Разом'}),operation());await media.collection(CollectionCommand.parse({operation:'export',id:album.id,version:albumEdit.version}),operation());
  assert.equal(await media.next(),true);await media.idle();assert.equal(await delivery().next('media'),true);
  const albumJob=await one(db,"SELECT * FROM media_jobs WHERE kind='album'");assert.equal(albumJob?.status,'ready');const albumPub=await one(db,'SELECT id FROM media_publications WHERE asset_id=$1',[albumJob!.output_id]);const albumResult=await tools.execute('library.delivery',{id:albumPub!.id},operation());assert.ok(albumResult.outputProof?.kinds.includes('album'),JSON.stringify(albumResult));assert.equal(check('Альбом «Спогади» готовий.',[toolOutcome('library.delivery',albumResult)]).blocked,false);
  const project=await media.studio(StudioCommand.parse({operation:'create',title:'Подорож'}),operation());const scene=await media.studio(StudioCommand.parse({operation:'add_scene',id:project.id,version:project.version,asset_id:image.id,asset_version:image.version,duration:1}),operation());const track=await media.studio(StudioCommand.parse({operation:'set_soundtrack',id:project.id,version:scene.version,asset_id:audio.id,asset_version:audio.version}),operation());await media.studio(StudioCommand.parse({operation:'export',id:project.id,version:track.version}),operation());
  assert.equal(await media.next(),true);await media.idle();const story=await one(db,"SELECT * FROM media_jobs WHERE kind='story'");assert.equal(story?.status,'ready',story?.error_code);assert.equal(story?.verification.video.decoded,true);assert.equal(story?.verification.audio.non_silent,true);assert.equal(await delivery().next('media'),true);
  const storyPub=await one(db,'SELECT id FROM media_publications WHERE asset_id=$1',[story!.output_id]);const result=await tools.execute('library.delivery',{id:storyPub!.id},operation());assert.ok(result.outputProof?.kinds.includes('video'),JSON.stringify(result));assert.equal(check('Ролик «Подорож» з музикою готовий.',[toolOutcome('library.delivery',result)]).blocked,false);
 });
 it('native original audio crosses actual delivery and task verification only with current source and output proof',async()=>{
  assert.ok(ffmpeg);const request=message('Люмен, зроби ролик із цього відео й збережи оригінальний звук.');await h.lumen.receive(request);const source=await one(db,"SELECT id FROM messages WHERE role='user' AND telegram_id=$1",[request.message!.message_id]);ctx={...ctx,sourceId:Number(source!.id)};
  const created=await tools.execute('tasks.create',{title:'Ролик',goal:'Підготувати ролик',criteria:['response']},operation()),task=await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[created.id]);assert.ok(task?.criteria.includes('media_audio'));ctx={...ctx,taskId:created.id,goalVersion:1};
  const media=evolution(db,h.config,h.brain).media,native=execFileSync(ffmpeg as unknown as string,['-v','error','-f','lavfi','-i','color=c=blue:s=32x32:r=24:d=1.2','-f','lavfi','-i','sine=frequency=523:duration=1.2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1']),asset=await media.store(native,'video/mp4','Відео зі звуком',operation());
  const project=await tools.execute('studio.manage',{operation:'create',title:'Оригінальний звук'},operation()),scene=await tools.execute('studio.manage',{operation:'add_scene',id:project.id,version:project.version,asset_id:asset.id,asset_version:asset.version,start:0,duration:1},operation()),queued=await tools.execute('studio.manage',{operation:'export',id:project.id,version:scene.version,require_audio:false},operation());
  assert.equal(await media.next(),true);await media.idle();const job=await one(db,'SELECT * FROM media_jobs WHERE id=$1',[queued.id]);assert.equal(job?.status,'ready',job?.error_code);assert.equal(job?.manifest.audio_source,'original');assert.equal(job?.manifest.soundtrack,null);assert.equal(job?.verification.has_original_audio,true);assert.equal(job?.verification.audio.non_silent,true);
  const output=await media.bytes(job!.output_id,1,operation()),outbox=await one(db,"SELECT * FROM outbox WHERE kind='media_asset' AND body->>'mediaJobId'=$1",[job!.id]);assert.ok(outbox);const d=delivery(),scope={...outbox,scopeTopicId:'0'};
  for(const mutate of [(proof:any)=>proof.original_audio[0].sha256='f'.repeat(64),(proof:any)=>proof.original_audio=[],(proof:any)=>proof.output_sha256='f'.repeat(64),(proof:any)=>proof.output_bytes++,(proof:any)=>proof.audio.non_silent=false]){
   const proof=structuredClone(job!.verification);mutate(proof);await db.query('UPDATE media_jobs SET verification=$2 WHERE id=$1',[job!.id,JSON.stringify(proof)]);await assert.rejects(()=>(d as any).checkMediaJob(scope,db,output),/media_delivery_not_verified/u);assert.equal((await verifyTask(db,{...task,chatId:'-100'},'Ролик готовий.')).ok,false);
  }
  await db.query('UPDATE media_jobs SET verification=$2 WHERE id=$1',[job!.id,JSON.stringify(job!.verification)]);const before=await verifyTask(db,{...task,chatId:'-100'},'Ролик готовий.');assert.ok(before.waiting.includes('media_delivery'));assert.equal(before.ok,false);
  assert.equal(await d.next('media'),true);const delivered=await one(db,"SELECT status,body FROM outbox WHERE id=$1",[outbox!.id]);assert.equal(delivered?.status,'sent');assert.equal(delivered?.body.deliveryReceipt.output.sha256,job!.verification.output_sha256);assert.equal(delivered?.body.deliveryReceipt.output.bytes,job!.verification.output_bytes);
  const after=await verifyTask(db,{...task,chatId:'-100'},'Ролик готовий.');assert.equal(after.ok,true,JSON.stringify(after));assert.ok(after.outcomes.every(fact=>fact.fileKinds?.includes('video')));
 });
 it('will not type-certify an artifact after changed bytes, source or a missing or different receipt output',async()=>{
  const bytes=await pdf();const artifact=await binaryArtifact(db,operation(),'План.pdf','application/pdf',bytes);assert.equal(await delivery().next('media'),true);
  const original=await one(db,"SELECT body FROM outbox WHERE kind='artifact' AND body->>'id'=$1",[artifact.id]);const originalRow=await one(db,'SELECT source_message_id,content FROM agent_artifacts WHERE id=$1',[artifact.id]);
  const valid=await tools.execute('artifact.delivery',{id:artifact.id},operation());assert.ok(valid.outputProof?.kinds.includes('pdf'));assert.equal(check('PDF готовий.',[toolOutcome('artifact.delivery',valid)]).blocked,false);
  for(const mutation of ['bytes','source','missing-output','wrong-output']){
   await db.query('UPDATE agent_artifacts SET content=$2,source_message_id=$3 WHERE id=$1',[artifact.id,originalRow!.content,originalRow!.source_message_id]);await db.query("UPDATE outbox SET body=$2 WHERE kind='artifact' AND body->>'id'=$1",[artifact.id,JSON.stringify(original!.body)]);
   if(mutation==='bytes')await db.query('UPDATE agent_artifacts SET content=$2 WHERE id=$1',[artifact.id,Buffer.from('changed bytes').toString('base64')]);
   if(mutation==='source')await db.query('UPDATE agent_artifacts SET source_message_id=NULL WHERE id=$1',[artifact.id]);
   if(mutation==='missing-output')await db.query("UPDATE outbox SET body=body #- '{deliveryReceipt,output}' WHERE kind='artifact' AND body->>'id'=$1",[artifact.id]);
   if(mutation==='wrong-output')await db.query("UPDATE outbox SET body=jsonb_set(body,'{deliveryReceipt,output,id}',$2) WHERE kind='artifact' AND body->>'id'=$1",[artifact.id,JSON.stringify(randomUUID())]);
   const result=await tools.execute('artifact.delivery',{id:artifact.id},operation());assert.equal(result.outputProof,undefined,mutation);assert.equal(check('PDF готовий.',[toolOutcome('artifact.delivery',result)]).blocked,true,mutation);
  }
 });
 it('rejects a fake video MIME and a library output whose bytes, version or receipt changed',async()=>{
  const fake=await publish(Buffer.from('a text document, not video'),'video/mp4','fake.mp4');assert.deepEqual(fake.result.outputProof?.kinds,[]);assert.equal(check('Ролик готовий.',[toolOutcome('library.delivery',fake.result)]).blocked,true);
  const image=await sharp({create:{width:16,height:16,channels:3,background:'#aa2233'}}).png().toBuffer();const saved=await publish(image,'image/png','Картка');const path=saved.asset.path,publication=await one(db,'SELECT receipts FROM media_publications WHERE id=$1',[saved.publication.id]);
  await writeFile(path,Buffer.from('changed'));let result=await tools.execute('library.delivery',{id:saved.publication.id},operation());assert.equal(result.outputProof,undefined);await writeFile(path,image);assert.deepEqual(await readFile(path),image);
  await db.query('UPDATE media_assets SET version=version+1 WHERE id=$1',[saved.asset.id]);result=await tools.execute('library.delivery',{id:saved.publication.id},operation());assert.equal(result.outputProof,undefined);await db.query('UPDATE media_assets SET version=version-1 WHERE id=$1',[saved.asset.id]);
  await db.query("UPDATE outbox SET source_message_id=NULL WHERE kind='media_asset' AND body->>'publicationId'=$1",[saved.publication.id]);result=await tools.execute('library.delivery',{id:saved.publication.id},operation());assert.equal(result.outputProof,undefined);await db.query("UPDATE outbox SET source_message_id=$2 WHERE kind='media_asset' AND body->>'publicationId'=$1",[saved.publication.id,ctx.sourceId]);
  const other=fake.result.deliveryReceipt;await db.query('UPDATE media_publications SET receipts=$2 WHERE id=$1',[saved.publication.id,JSON.stringify([other])]);result=await tools.execute('library.delivery',{id:saved.publication.id},operation());assert.equal(result.outputProof,undefined);assert.equal(check('Зображення надіслано.',[toolOutcome('library.delivery',result)]).blocked,true);await db.query('UPDATE media_publications SET receipts=$2 WHERE id=$1',[saved.publication.id,JSON.stringify(publication!.receipts)]);
 });
 it('preserves private delivery boundaries and cannot widen typed receipt proof to another logical topic',async()=>{
  const bytes=await pdf(),privateContext={...operation(),audience:'private' as const};
  const artifact=await binaryArtifact(db,privateContext,'Особисте.pdf','application/pdf',bytes);assert.equal(await delivery().next('media'),true);
  await assert.rejects(()=>tools.execute('artifact.delivery',{id:artifact.id},operation()),/private_delivery/u);
  const own=await tools.execute('artifact.delivery',{id:artifact.id},{...operation(),audience:'private'});assert.ok(own.outputProof?.kinds.includes('pdf'));
  await assert.rejects(()=>tools.execute('artifact.delivery',{id:artifact.id},{...operation(),audience:'private',topicId:'7'}),/resource_unavailable/u);
  const media=evolution(db,h.config,h.brain).media,image=await media.store(await sharp({create:{width:16,height:16,channels:3,background:'#55aa77'}}).png().toBuffer(),'image/png','Особиста картка',privateContext);
  const publication=await media.run({operation:'publish',id:image.id,version:image.version,caption:''},{...operation(),audience:'private'});assert.equal(await delivery().next('media'),true);
  await assert.rejects(()=>tools.execute('library.delivery',{id:publication.id},operation()),/resource_unavailable/u);
  const privateResult=await tools.execute('library.delivery',{id:publication.id},{...operation(),audience:'private'});assert.ok(privateResult.outputProof?.kinds.includes('image'));
  await assert.rejects(()=>tools.execute('library.delivery',{id:publication.id},{...operation(),audience:'private',topicId:'7'}),/resource_unavailable/u);
 });
});
