import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import {TestDB,harness,paired} from './helpers.js';
import {MediaWorkshop,StudioCommand,CollectionCommand} from '../src/media-workshop.js';
import {MediaBrowser} from '../src/media-browser.js';
import {inspectAlbumPdf} from '../src/media-pdf.js';
import {parseMediaAudioIntent,resolveMediaAudioExpectation} from '../src/media-expectation.js';
import {Delivery} from '../src/delivery.js';
import {one,forgetPhrase} from '../src/db.js';
import {recordProvenance} from '../src/provenance.js';
import type {ToolContext} from '../src/agent-tools.js';
import type {Telegram} from '../src/telegram.js';

const exec=promisify(execFile);let db:TestDB,h:ReturnType<typeof harness>,dir:string,png:Buffer,wav:Buffer,n=130000;
let uploads:{method:string;chatId:string;bytes:Buffer;caption:string;mime:string;threadId?:number}[]=[];
const c=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'7',revision:0,updateId:String(++n),requested:true,...extra});
const source=async(body:string,uid='11',topic='7')=>Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,$2,'Автор','user',$3,$4) RETURNING id",[++n,uid,body,topic])).rows[0]!.id);
const studio=(hub:MediaWorkshop,args:any,ctx=c())=>hub.studio(StudioCommand.parse(args),ctx);
const archive=(hub:MediaWorkshop,args:any,ctx=c())=>hub.collection(CollectionCommand.parse(args),ctx);
async function project(hub:MediaWorkshop,ctx=c()){const p=await studio(hub,{operation:'create',title:'Осінній ролик'},ctx),photo=await hub.store(png,'image/png','Фото',ctx);return studio(hub,{operation:'add_scene',id:p.id,version:1,asset_id:photo.id,asset_version:1,duration:1},ctx);}
async function render(hub:MediaWorkshop,p:any,ctx=c(),extra:any={}){const q=await studio(hub,{operation:'export',id:p.id,version:p.version,...extra},ctx);await hub.next();await hub.idle();return (await one(db,'SELECT * FROM media_jobs WHERE id=$1',[q.id]))!;}
async function attach(hub:MediaWorkshop,p:any,ctx=c()){const a=await hub.store(wav,'audio/wav','Наданий трек',ctx),next=await studio(hub,{operation:'set_soundtrack',id:p.id,version:p.version,asset_id:a.id,asset_version:1},ctx);return {p:next,a};}
async function album(hub:MediaWorkshop,ctx=c(),originals=false){const col=await archive(hub,{operation:'create',title:'Осінні спогади'},ctx),photo=await hub.store(png,'image/png','Прогулянка',ctx);let next=await archive(hub,{operation:'add',id:col.id,version:1,asset_id:photo.id,asset_version:1,caption:'Разом у парку',claim:'fact'},ctx);if(originals){const audio=await hub.store(wav,'audio/wav','Сімейна пісня',ctx);for(let i=0;i<2;i++)next=await archive(hub,{operation:'add',id:col.id,version:next.version,asset_id:audio.id,asset_version:1,caption:'Запис нашого вечора',claim:'fact'},ctx);}return next;}
async function exportAlbum(hub:MediaWorkshop,p:any,ctx=c()){const q=await archive(hub,{operation:'export',id:p.id,version:p.version},ctx);assert.match(q.notice,/альбом/iu);await hub.next();await hub.idle();return (await one(db,'SELECT * FROM media_jobs WHERE id=$1',[q.id]))!;}

before(async()=>{db=new TestDB();await db.init();dir=await mkdtemp(join(tmpdir(),'lumen-media-r3-'));png=await sharp({create:{width:120,height:96,channels:3,background:'#347c65'}}).png().toBuffer();const path=join(dir,'provided.wav');await exec(ffmpeg as unknown as string,['-v','error','-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=1.25','-c:a','pcm_s16le','-y',path],{timeout:15000});wav=await readFile(path);});
after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
beforeEach(async()=>{await db.reset();await db.query('TRUNCATE domain_commands,media_assets,studio_projects,media_jobs,archive_collections RESTART IDENTITY CASCADE');h=harness(db);await paired(h);uploads=[];h.tg.upload=async(...args:any[])=>{uploads.push({method:args[0],chatId:args[1],bytes:Buffer.from(args[2]),caption:args[3],mime:args[4],threadId:args[5]});return {message_id:++h.tg.counter};};});

test('source audio intent honors exact music request, explicit silence and informational controls',()=>{
 for(const text of ['Зроби ролик з цього фото з наданою музикою.','Додай музику до ролика.','Make a video with supplied music.'])assert.equal(parseMediaAudioIntent(text),'required',text);
 for(const text of ['Зроби ролик без музики.','Прибери музику.','Не додавай музику.','Зроби з музикою. Уточнення автора: без музики.','Make a silent video.'])assert.equal(parseMediaAudioIntent(text),'silent',text);
 for(const text of ['Зроби ролик з фото.','Люмен, поясни як створити ролик з музикою.','Поясни як додати музику до відео.','Порівняй «відео з музикою» та тихе відео.'])assert.equal(parseMediaAudioIntent(text),'unspecified',text);
});

test('actual source makes omitted audio flags fail until supplied WAV is selected, then actual audio and receipt succeed',async()=>{
 const id=await source('Зроби ролик з цього фото з наданою музикою.'),ctx=()=>c({sourceId:id}),hub=new MediaWorkshop(db,h.config),p=await project(hub,ctx()),track=await hub.store(wav,'audio/wav','Наданий WAV',ctx());await assert.rejects(studio(hub,{operation:'export',id:p.id,version:p.version},ctx()),/soundtrack_required/);assert.equal((await db.query('SELECT * FROM media_jobs')).rows.length,0);
 const selected=await studio(hub,{operation:'set_soundtrack',id:p.id,version:p.version,asset_id:track.id,asset_version:1},ctx()),job=await render(hub,selected,ctx(),{require_audio:false});assert.equal(job.status,'ready',job.error_code);assert.equal(job.manifest.require_audio,true);assert.equal(job.manifest.audio_expectation.required,true);assert.deepEqual(job.manifest.audio_expectation.source_ids,[id]);assert.equal(job.verification.audio_required,true);assert.equal(job.verification.audio.non_silent,true);assert.equal(await new Delivery(db,h.tg as unknown as Telegram,h.config).next('media'),true);assert.equal(uploads[0]!.method,'sendVideo');assert.equal(uploads[0]!.threadId,7);
 const path=join(dir,'source-bound.mp4'),pcm=join(dir,'source-bound.f32');await writeFile(path,uploads[0]!.bytes);await exec(ffmpeg as unknown as string,['-v','error','-i',path,'-map','0:a:0','-ac','1','-ar','48000','-f','f32le','-y',pcm],{timeout:15000});const signal=await readFile(pcm);let energy=0,crossings=0;for(let i=4;i<Math.min(signal.length,4*48000);i+=4){energy+=signal.readFloatLE(i)**2;if(signal.readFloatLE(i-4)<0&&signal.readFloatLE(i)>=0)crossings++;}assert.ok(energy>1);assert.ok(crossings>640&&crossings<680);assert.equal((await hub.jobs(ctx()))[0]!.delivery_status,'delivered');
});

test('plain video stays silent; explicit without-music overrides a selected track and erroneous model audio flag',async()=>{
 for(const text of ['Зроби ролик із цього фото.','Зроби ролик без музики.']){const id=await source(text),ctx=()=>c({sourceId:id,requestText:'модель каже з музикою'}),hub=new MediaWorkshop(db,h.config),p=await project(hub,ctx()),selected=text.includes('без')?(await attach(hub,p,ctx())).p:p,job=await render(hub,selected,ctx(),{require_audio:text.includes('без')});assert.equal(job.status,'ready',job.error_code);assert.equal(job.manifest.require_audio,false);assert.equal(job.verification.audio_required,false);assert.equal(job.verification.has_soundtrack,false);assert.equal(job.verification.audio,null);const path=join(dir,'silent-'+id+'.mp4');await writeFile(path,(await hub.bytes(job.output_id,1,ctx())).bytes);const decoded=await exec(ffmpeg as unknown as string,['-v','info','-i',path,'-map','0:v:0','-f','null','-'],{timeout:15000,maxBuffer:50000});assert.doesNotMatch(decoded.stderr,/Audio:/);}
});

test('preview/edit/generic export preserve source expectation; explicit silence replaces it and forget removes its snapshot',async()=>{
 const requested=await source('Зроби відео з наданою музикою.'),hub=new MediaWorkshop(db,h.config),p=await project(hub,c({sourceId:requested})),a=await attach(hub,p,c({sourceId:requested})),preview=await render(hub,a.p,c({sourceId:requested}),{operation:'preview'});assert.equal(preview.status,'ready',preview.error_code);
 const generic=await source('Зміни підпис і підготуй перегляд'),read=await studio(hub,{operation:'read',id:p.id}),edited=await studio(hub,{operation:'edit_scene',id:p.id,version:read.version,scene_id:read.scenes[0].id,caption:'Наша осінь'},c({sourceId:generic})),removed=await studio(hub,{operation:'remove_soundtrack',id:p.id,version:edited.version},c({sourceId:generic}));await assert.rejects(studio(hub,{operation:'preview',id:p.id,version:removed.version},c({sourceId:generic})),/soundtrack_required/);
 const changed=await source('Тепер зроби без музики.'),silent=await render(hub,removed,c({sourceId:changed}));assert.equal(silent.status,'ready',silent.error_code);assert.equal(silent.manifest.audio_expectation.mode,'silent');const repeated=await render(hub,removed,c({sourceId:generic}),{operation:'preview'});assert.equal(repeated.status,'ready',repeated.error_code);assert.equal(repeated.manifest.audio_expectation.mode,'silent');
 await db.tx(sql=>forgetPhrase(sql,'Тепер зроби без музики.'));assert.equal((await db.query("SELECT id FROM domain_commands WHERE result->'audio_expectation'->'source_ids' @> $1::jsonb",[JSON.stringify([changed])])).rows.length,0);await assert.rejects(studio(hub,{operation:'export',id:p.id,version:removed.version},c({sourceId:generic,revision:1})),/soundtrack_required/);
});

test('current persisted silent resume wins over original music source; wrong actor/topic cannot weaken expectation',async()=>{
 const original=await source('Зроби ролик з музикою.'),clarified=await source('Продовжуй без музики.'),hub=new MediaWorkshop(db,h.config),p=await project(hub,c({sourceId:original})),a=await attach(hub,p,c({sourceId:original})),task=randomUUID();await db.query("INSERT INTO agent_tasks(id,dedup_key,actor_id,topic_id,title,goal,status,revision,source_message_id,goal_version,criteria,audience) VALUES($1,$2,'11','7','Ролик','Зроби ролик з музикою. Уточнення автора: без музики.','verifying',0,$3,2,$4,'group')",[task,'task:'+task,original,JSON.stringify(['media','media_silent'])]);await recordProvenance(db,'task',task,[original,clarified]);const ctx=c({sourceId:original,taskId:task,goalVersion:2}),job=await render(hub,a.p,ctx);assert.equal(job.status,'ready',job.error_code);assert.equal(job.manifest.audio_expectation.mode,'silent');assert.equal(job.verification.has_soundtrack,false);assert.equal(await new Delivery(db,h.tg as unknown as Telegram,h.config).next('media'),true);
 for(const foreign of [await source('Без музики.','22'),await source('Без музики.','11','8')])await assert.rejects(resolveMediaAudioExpectation(db,c({sourceId:foreign})),/media_source_unavailable/);
});

test('direct album export delivers actual PDF with exact originals, human content and a working exact cached entrypoint',async()=>{
 const id=await source('Збери альбом із цих матеріалів.'),ctx=()=>c({sourceId:id}),hub=new MediaWorkshop(db,h.config),p=await album(hub,ctx(),true),job=await exportAlbum(hub,p,ctx());assert.equal(job.status,'ready',job.error_code);assert.equal(job.verification.pdf.decoded,true);assert.equal(job.verification.pdf.pages,3);assert.equal(job.verification.pdf.attachments.length,2);assert.notEqual(job.verification.pdf.attachments[0].name,job.verification.pdf.attachments[1].name);const actual=await inspectAlbumPdf((await hub.bytes(job.output_id,1,ctx())).bytes);assert.equal(actual.pages,3);assert.deepEqual(actual.attachments,job.verification.pdf.attachments.map(({name,sha256,bytes}:any)=>({name,sha256,bytes})));assert.equal(await new Delivery(db,h.tg as unknown as Telegram,h.config).next('media'),true);assert.equal(uploads.length,1);assert.equal(uploads[0]!.method,'sendDocument');assert.equal(uploads[0]!.mime,'application/pdf');assert.equal(uploads[0]!.chatId,'-100');assert.equal(uploads[0]!.threadId,7);assert.match(uploads[0]!.caption,/альбом/iu);assert.doesNotMatch(uploads[0]!.caption,/SHA|MIME|байт|матеріалах/iu);
 const path=join(dir,'media-r3-album-preview.pdf');await writeFile(path,uploads[0]!.bytes);const text=(await exec('pdftotext',[path,'-'],{timeout:15000})).stdout;assert.match(text,/Осінні спогади/);assert.match(text,/Сімейна пісня/);assert.doesNotMatch(text,/SHA256|audio\/wav|байт|[a-f0-9]{8}-[a-f0-9]{4}-/i);
 const repeated=await archive(hub,{operation:'export',id:p.id,version:p.version},ctx());assert.equal(repeated.reused,true);const access=await one(db,"SELECT body FROM outbox WHERE dedup_key LIKE 'album-access:%' ORDER BY id DESC LIMIT 1"),button=access!.body.replyMarkup.inline_keyboard[0][0];assert.equal(button.text,'Отримати альбом');assert.equal(await new MediaBrowser(db,hub).callback({id:'album-exact-download',from:{id:11,first_name:'Автор'},data:button.callback_data,message:{message_id:99,date:0,chat:{id:-100,type:'supergroup'},message_thread_id:7}},h.tg as unknown as Telegram),true);assert.equal(await new Delivery(db,h.tg as unknown as Telegram,h.config).next('media'),true);assert.equal(uploads.length,2);assert.equal(uploads[1]!.chatId,'11');assert.deepEqual(uploads[1]!.bytes,uploads[0]!.bytes);
});

test('private album stays private; revoked, changed, cancelled album never sends a stale result',async()=>{
 const hub=new MediaWorkshop(db,h.config),p=await album(hub,c({audience:'private'})),job=await exportAlbum(hub,p,c({audience:'private'}));assert.equal(job.status,'ready',job.error_code);assert.equal(await new Delivery(db,h.tg as unknown as Telegram,h.config).next('media'),true);assert.equal(uploads[0]!.chatId,'11');assert.equal(uploads[0]!.threadId,undefined);
 const changed=await album(hub),ready=await exportAlbum(hub,changed),items=await archive(hub,{operation:'read',id:changed.id});await archive(hub,{operation:'caption',id:changed.id,version:changed.version,item_id:items.items[0].id,caption:'Оновлено'},c());assert.equal((await one(db,'SELECT status FROM media_jobs WHERE id=$1',[ready.id]))!.status,'stale');assert.equal(await new Delivery(db,h.tg as unknown as Telegram,h.config).next('media'),false);assert.equal(uploads.length,1);
 const canceled=await album(hub),queued=await archive(hub,{operation:'export',id:canceled.id,version:canceled.version});await archive(hub,{operation:'cancel',id:canceled.id,version:canceled.version,job_id:queued.id});await hub.next();await hub.idle();assert.equal((await one(db,'SELECT output_id FROM media_jobs WHERE id=$1',[queued.id]))!.output_id,null);
});
