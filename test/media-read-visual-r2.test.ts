import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import {TestDB,harness,paired} from './helpers.js';
import {MediaAssets,AssetCommand} from '../src/media-assets.js';
import {AgentTools,type ToolContext} from '../src/agent-tools.js';
import {recordProvenance} from '../src/provenance.js';
import {VisualMemory} from '../src/visual.js';
import {forgetPhrase} from '../src/db.js';
import type {Telegram} from '../src/telegram.js';

const exec=promisify(execFile),sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
let db:TestDB,h:ReturnType<typeof harness>,dir:string,png:Buffer,wav:Buffer,mp4:Buffer,n=92000;
const c=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:String(++n),requested:true,...extra});
const source=async(body:string)=>Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES($1,'11','Автор','user',$2) RETURNING id",[++n,body])).rows[0]!.id);
const read=(assets:MediaAssets,id:string,version=1,ctx=c())=>assets.run(AssetCommand.parse({operation:'read',id,version}),ctx);
const types=()=>[[png,'image/png'],[wav,'audio/wav'],[mp4,'video/mp4']] as const;

before(async()=>{
 db=new TestDB();await db.init();dir=await mkdtemp(join(tmpdir(),'lumen-read-visual-r2-'));
 png=await sharp({create:{width:96,height:80,channels:3,background:'#3479ad'}}).png().toBuffer();
 const audio=join(dir,'provided.wav'),video=join(dir,'provided.mp4');
 await exec(ffmpeg as unknown as string,['-v','error','-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=0.5','-c:a','pcm_s16le','-y',audio],{timeout:15000});wav=await readFile(audio);
 await exec(ffmpeg as unknown as string,['-v','error','-f','lavfi','-i','testsrc2=s=96x80:r=24:d=3','-threads','1','-c:v','libx264','-pix_fmt','yuv420p','-y',video],{timeout:15000});mp4=await readFile(video);
});
after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
beforeEach(async()=>{await db.reset();await db.query('TRUNCATE domain_commands,media_assets,studio_projects,media_jobs RESTART IDENTITY CASCADE');h=harness(db);await paired(h);});

test('image, actual audio and video metadata read succeeds directly and through library.asset without source edges',async()=>{
 const assets=new MediaAssets(db,h.config),tools=new AgentTools(db,h.config,h.brain);
 for(const [bytes,mime] of types()){
  const stored=await assets.store(bytes,mime,'Матеріал '+mime,c()),direct=await read(assets,stored.id),wrapped=await tools.execute('library.asset',{operation:'read',id:stored.id,version:1},c());
  for(const result of [direct,wrapped]){assert.equal(result.id,stored.id);assert.equal(result.mime,mime);assert.equal(result.version,1);assert.equal(result.sha256,sha(bytes));assert.equal(Number(result.bytes),bytes.length);assert.deepEqual(result.source_ids,[]);assert.equal(result.durable,true);}
  assert.deepEqual((await assets.bytes(stored.id,1,c())).bytes,bytes);
 }
});

test('read returns only exact asset origin, provenance and permission sources across UUID and opaque polymorphic keys',async()=>{
 const assets=new MediaAssets(db,h.config),tools=new AgentTools(db,h.config,h.brain),unrelated=await source('Чуже джерело');
 await recordProvenance(db,'game',123,[unrelated]);await recordProvenance(db,'media_asset','legacy:opaque-key',[unrelated]);
 for(const [bytes,mime] of types()){
  const origin=await source('Оригінал '+mime),extra=await source('Походження '+mime),permission=await source('Дозволяю показати '+mime),asset=await assets.store(bytes,mime,'Наданий матеріал',c({audience:'private',sourceId:origin}));
  await recordProvenance(db,'media_asset',asset.id,[origin,extra]);await recordProvenance(db,'scene',asset.id,[unrelated]);
  await assets.run(AssetCommand.parse({operation:'allow_group',id:asset.id,version:1}),c({audience:'private',sourceId:permission}));
  for(const result of [await read(assets,asset.id,2),await tools.execute('library.asset',{operation:'read',id:asset.id,version:2},c())]){
   assert.equal(result.audience,'group');assert.equal(result.version,2);assert.deepEqual(new Set(result.source_ids),new Set([origin,extra,permission]));assert.equal(result.source_ids.length,3);assert.equal(result.sha256,sha(bytes));
  }
 }
});

test('read still refuses private audience widening, another owner, stale versions, revoked and forgotten originals',async()=>{
 const assets=new MediaAssets(db,h.config),tools=new AgentTools(db,h.config,h.brain),privateAsset=await assets.store(wav,'audio/wav','Особиста мелодія',c({audience:'private'}));
 for(const context of [c(),c({audience:'private',actorId:'22'})]){await assert.rejects(read(assets,privateAsset.id,1,context),/asset_unavailable/);await assert.rejects(tools.execute('library.asset',{operation:'read',id:privateAsset.id,version:1},context),/(?:asset|resource)_unavailable/);}
 const shared=await assets.run(AssetCommand.parse({operation:'allow_group',id:privateAsset.id,version:1}),c({audience:'private'}));assert.equal(shared.version,2);await assert.rejects(read(assets,privateAsset.id,1),/version_conflict/);await assert.rejects(read(assets,randomUUID()),/asset_unavailable/);
 await assets.run(AssetCommand.parse({operation:'revoke',id:privateAsset.id,version:2}),c());await assert.rejects(read(assets,privateAsset.id,2),/asset_unavailable/);await assert.rejects(tools.execute('library.asset',{operation:'read',id:privateAsset.id,version:2},c()),/(?:asset|resource)_unavailable/);
 const origin=await source('Прибери оригінал із пам’яті'),forgotten=await assets.store(png,'image/png','Забутий оригінал',c({sourceId:origin}));assert.equal((await read(assets,forgotten.id)).sha256,sha(png));await db.tx(sql=>forgetPhrase(sql,'Прибери оригінал із пам’яті'));await assert.rejects(read(assets,forgotten.id,1,c({revision:1})),/asset_unavailable/);
});

test('unchanged original WEBM sticker without MIME yields three real decoded images and distinct frame pixels',async()=>{
 const path=new URL('../../assets/stickers/lumen_50.webm',import.meta.url),bytes=await readFile(path),expected='2a81c645a6facd9f33587704994593d7a044f0393ef9c2390bab40d617115dcc';assert.equal(sha(bytes),expected);
 const visual=new VisualMemory(db,{file:async()=>bytes} as unknown as Telegram,h.brain),missing=await visual.frames({kind:'sticker_video',file_id:'source50'}),explicit=await visual.frames({kind:'sticker_video',file_id:'source50',mime:'video/webm'}),empty=await visual.frames({kind:'sticker_video',file_id:'source50',mime:''});
 assert.equal(missing.mode,'sampled_animation_frames');assert.equal(missing.images.length,3);assert.deepEqual(missing,explicit);assert.deepEqual(missing,empty);
 const pixels:Buffer[]=[];for(const image of missing.images){const frame=Buffer.from(image.split(',')[1]!,'base64'),metadata=await sharp(frame).metadata();assert.equal(metadata.format,'jpeg');assert.ok(metadata.width!>0&&metadata.height!>0);pixels.push(await sharp(frame).resize(64,64).removeAlpha().raw().toBuffer());}
 assert.ok(pixels.some(frame=>!frame.equals(pixels[0]!)),'Actual decoded frame pixels must show movement');assert.equal(sha(await readFile(path)),expected);
});

test('MIME-less ordinary MP4 still samples real moving frames',async()=>{
 const result=await new VisualMemory(db,{file:async()=>mp4} as unknown as Telegram,h.brain).frames({kind:'video',file_id:'provided-video'});assert.equal(result.mode,'sampled_animation_frames');assert.equal(result.images.length,3);assert.ok(new Set(result.images).size>1);
});

test('WEBM default preserves self-contained validation and truthful thumbnail/audio fallbacks',async()=>{
 const playlist=Buffer.from("ffconcat version 1.0\nfile '/etc/passwd'\n"),visual=new VisualMemory(db,{file:async(id:string)=>id==='thumbnail'?png:playlist} as unknown as Telegram,h.brain);
 assert.deepEqual(await visual.frames({kind:'sticker_video',file_id:'spoofed'}),{images:[],mode:'unavailable'});
 const fallback=await visual.frames({kind:'sticker_video',file_id:'spoofed',metadata:{thumbnail:'thumbnail'}});assert.equal(fallback.mode,'thumbnail_only');assert.equal(fallback.images.length,1);assert.equal((await sharp(Buffer.from(fallback.images[0]!.split(',')[1]!,'base64')).metadata()).format,'jpeg');
 let downloaded=false;const audio=new VisualMemory(db,{file:async()=>{downloaded=true;return wav;}} as unknown as Telegram,h.brain);assert.deepEqual(await audio.frames({kind:'audio',file_id:'track'}),{images:[],mode:'audio_not_visually_decoded'});assert.equal(downloaded,false);
});
