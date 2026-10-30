import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';
import {TestDB,harness,paired} from './helpers.js';
import {MediaWorkshop,StudioCommand} from '../src/media-workshop.js';
import {assetFor,selfContainedMediaInput} from '../src/media-assets.js';
import {rememberAttachments,VisualMemory} from '../src/visual.js';
import {one,forgetPhrase} from '../src/db.js';
import {stableId} from '../src/operations.js';
import {createCommitment} from '../src/commitments.js';
import {Delivery} from '../src/delivery.js';
import type {ToolContext} from '../src/agent-tools.js';
import type {Telegram,Message} from '../src/telegram.js';

const exec=promisify(execFile);let db:TestDB,h:ReturnType<typeof harness>,fixtures:string,tone:Buffer,shortTone:Buffer,withIntro:Buffer,silence:Buffer,n=65000;
const c=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:String(++n),requested:true,...extra});
const run=(hub:MediaWorkshop,args:any,ctx=c())=>hub.studio(StudioCommand.parse(args),ctx);
async function source(body:string,uid='11'){return Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES($1,$2,'Автор','user',$3) RETURNING id",[++n,uid,body])).rows[0]!.id);}
async function picture(hub:MediaWorkshop,color='#dd2211',ctx=c()){return hub.store(await sharp({create:{width:96,height:80,channels:3,background:color}}).png().toBuffer(),'image/png','Фото',ctx);}
async function project(hub:MediaWorkshop,ctx=c(),duration=1){const p=await run(hub,{operation:'create',title:'Наша осінь'},ctx),photo=await picture(hub,'#dd2211',c({audience:ctx.audience}));return run(hub,{operation:'add_scene',id:p.id,version:1,asset_id:photo.id,asset_version:1,duration},c({audience:ctx.audience}));}
async function soundtrack(hub:MediaWorkshop,p:any,bytes=tone,extra:any={},ctx=c()){const track=await hub.store(bytes,'audio/wav','Надана музика',ctx),updated=await run(hub,{operation:'set_soundtrack',id:p.id,version:p.version,asset_id:track.id,asset_version:1,...extra},c({audience:ctx.audience}));return {p:updated,track};}
async function finish(hub:MediaWorkshop,p:any,extra:any={},ctx=c()){const job=await run(hub,{operation:'export',id:p.id,version:p.version,require_audio:true,...extra},ctx);assert.equal(job.status,'queued');assert.equal(await hub.next(),true);await hub.idle();return (await one(db,'SELECT * FROM media_jobs WHERE id=$1',[job.id]))!;}

before(async()=>{
 db=new TestDB();await db.init();fixtures=await mkdtemp(join(tmpdir(),'lumen-music113-'));
 const synth=async(name:string,filter:string)=>{const path=join(fixtures,name+'.wav');await exec(ffmpeg as unknown as string,['-v','error','-nostdin','-f','lavfi','-i',filter,'-c:a','pcm_s16le','-y',path],{timeout:15000});return readFile(path);};
 tone=await synth('tone','sine=frequency=880:sample_rate=48000:duration=2');shortTone=await synth('short','sine=frequency=880:sample_rate=48000:duration=0.25');silence=await synth('silence','anullsrc=r=48000:cl=stereo:d=1');
 const intro=join(fixtures,'with-intro.wav');await exec(ffmpeg as unknown as string,['-v','error','-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=0.1','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=0.25','-filter_complex','[0:a][1:a]concat=n=2:v=0:a=1[out]','-map','[out]','-c:a','pcm_s16le','-y',intro],{timeout:15000});withIntro=await readFile(intro);
});
after(async()=>{await db.close();await rm(fixtures,{recursive:true,force:true});});
beforeEach(async()=>{await db.reset();await db.query('TRUNCATE domain_commands,media_assets,studio_projects,media_jobs RESTART IDENTITY CASCADE');h=harness(db);await paired(h);});

test('Telegram audio and audio documents enter durable materials without image/model decoding',async()=>{
 const s=await source('Ось музика'),message:Message={message_id:5,date:0,chat:{id:-100,type:'supergroup'},audio:{file_id:'tg-track',file_unique_id:'unique',mime_type:'audio/wav',file_name:'Осінь.wav',duration:2}};
 await rememberAttachments(db,message,s,0);await rememberAttachments(db,message,s,0);
 const row=(await db.query('SELECT * FROM attachments WHERE source_message_id=$1',[s])).rows[0]!;assert.equal((await db.query('SELECT * FROM attachments WHERE source_message_id=$1',[s])).rows.length,1);assert.equal(row.kind,'audio');assert.equal(row.status,'stored');assert.equal(row.metadata.file_name,'Осінь.wav');
 let downloads=0;const telegram={file:async()=>{downloads++;return tone;}} as unknown as Telegram,hub=new MediaWorkshop(db,h.config,telegram);
 const visual=new VisualMemory(db,telegram,h.brain);assert.deepEqual(await visual.frames(row),{images:[],mode:'audio_not_visually_decoded'});assert.equal(downloads,0);
 const track=await hub.run({operation:'capture',attachment_id:Number(row.id),caption:''},c({sourceId:s}));assert.equal(track.mime,'audio/wav');const saved=await hub.bytes(track.id,1,c());assert.deepEqual(saved.bytes,tone);assert.ok(saved.asset.path.endsWith('.wav'));assert.equal(downloads,1);
 const docSource=await source('Трек як документ');await rememberAttachments(db,{...message,audio:undefined,document:{file_id:'tg-mp3',file_name:'music.MP3',mime_type:'application/octet-stream'}},docSource,0);assert.equal((await one(db,'SELECT * FROM attachments WHERE source_message_id=$1',[docSource]))!.mime,'audio/mpeg');
});

test('fresh worker marks interrupted jobs repair once and allows an explicit new export',async()=>{
 const hub=new MediaWorkshop(db,h.config),p=await project(hub),withAudio=await soundtrack(hub,p),job=await run(hub,{operation:'export',id:p.id,version:withAudio.p.version,require_audio:true});await db.query("UPDATE media_jobs SET status='running' WHERE id=$1",[job.id]);
 assert.equal(await hub.next(),false);assert.equal((await one(db,'SELECT status FROM media_jobs WHERE id=$1',[job.id]))!.status,'repair');assert.match((await one(db,"SELECT body->>'text' AS text FROM outbox WHERE dedup_key=$1",['render-failed:'+job.id+':0']))!.text,/перервався/);
 assert.equal(await hub.next(),false);assert.equal((await db.query("SELECT id FROM outbox WHERE dedup_key=$1",['render-failed:'+job.id+':0'])).rows.length,1);
 const fixed=await finish(hub,withAudio.p);assert.equal(fixed.status,'ready',fixed.error_code);assert.notEqual(fixed.id,job.id);assert.equal((await db.query("SELECT id FROM outbox WHERE dedup_key=$1",['render-failed:'+job.id+':0'])).rows.length,0);
});

test('provided music survives trim/loop/levels/fades; real output has ordered picture and audible AAC',async()=>{
 const hub=new MediaWorkshop(db,h.config,{file:async()=>withIntro} as unknown as Telegram),p=await project(hub),blue=await picture(hub,'#1144dd'),p2=await run(hub,{operation:'add_scene',id:p.id,version:p.version,asset_id:blue.id,asset_version:1,duration:1,caption:'Разом'}),audioSource=await source('Тільки цей трек');await rememberAttachments(db,{message_id:9,date:0,chat:{id:-100,type:'supergroup'},audio:{file_id:'provided-music',mime_type:'audio/wav',file_name:'Наш трек.wav'}},audioSource,0);const attachment=await one(db,'SELECT id FROM attachments WHERE source_message_id=$1',[audioSource]),asset=await hub.run({operation:'capture',attachment_id:Number(attachment!.id),caption:''},c({sourceId:audioSource}));
 const p3=await run(hub,{operation:'set_soundtrack',id:p.id,version:p2.version,asset_id:asset.id,asset_version:1,start:.1,loop:true,volume:.4,fade_in:.1,fade_out:.1},c({sourceId:audioSource}));
 const job=await finish(hub,p3);assert.equal(job.status,'ready',job.error_code);assert.equal(job.stage,'verified');assert.equal(job.verification.has_soundtrack,true);assert.equal(job.verification.video.decoded,true);assert.equal(job.verification.audio.codec,'aac');assert.equal(job.verification.audio.non_silent,true);assert.ok(Math.abs(job.verification.audio.duration-2)<.15);assert.ok(job.verification.audio.max_db<-22&&job.verification.audio.max_db>-30,'volume .4 must attenuate the supplied tone');
 assert.ok(await one(db,"SELECT source_message_id FROM provenance_edges WHERE derived_kind='media_asset' AND derived_key=$1 AND source_message_id=$2",[job.output_id,audioSource]));assert.ok(await one(db,'SELECT * FROM media_job_inputs WHERE job_id=$1 AND asset_id=$2',[job.id,asset.id]));assert.ok(await one(db,'SELECT * FROM media_derivations WHERE input_id=$1 AND output_id=$2',[asset.id,job.output_id]));
 const output=await hub.bytes(job.output_id,1,c()),path=join(fixtures,'verified.mp4');await writeFile(path,output.bytes);const decoded=await exec(ffmpeg as unknown as string,['-v','info','-xerror','-i',path,'-map','0:v:0','-map','0:a:0','-f','null','-'],{timeout:15000,maxBuffer:50000});assert.match(decoded.stderr,/Video: h264/);assert.match(decoded.stderr,/Audio: aac/);
 for(const [at,dominant] of [[.2,0],[1.2,2]] as const){const frame=join(fixtures,'frame-'+at+'.png');await exec(ffmpeg as unknown as string,['-v','error','-ss',String(at),'-i',path,'-frames:v','1','-y',frame],{timeout:15000});const pixel=await sharp(frame).extract({left:320,top:200,width:1,height:1}).raw().toBuffer();assert.ok(pixel[dominant]!>pixel[dominant===0?2:0]!+70);}
 const pcm=join(fixtures,'signal.f32');await exec(ffmpeg as unknown as string,['-v','error','-i',path,'-map','0:a:0','-ac','1','-ar','48000','-f','f32le','-y',pcm],{timeout:15000});const samples=await readFile(pcm);let crossings=0;for(let i=4*Math.floor(.02*48000);i<4*Math.floor(.06*48000);i+=4)if(samples.readFloatLE(i-4)<0&&samples.readFloatLE(i)>=0)crossings++;assert.ok(crossings>=32&&crossings<=38,'Trim must remove the 220Hz intro, leaving the supplied 880Hz tone');
 const rms=(start:number,end:number)=>{let sum=0,count=0;for(let i=4*Math.floor(start*48000);i<Math.min(samples.length,4*Math.floor(end*48000));i+=4){sum+=samples.readFloatLE(i)**2;count++;}return Math.sqrt(sum/count);},middle=rms(.3,.4);assert.ok(rms(0,.02)<middle*.35,'Fade-in must reduce actual opening energy');assert.ok(rms(1.98,2)<middle*.35,'Fade-out must reduce actual ending energy');
 const pending=await one(db,"SELECT * FROM outbox WHERE kind='media_asset' AND body->>'mediaJobId'=$1",[job.id]);assert.equal(pending!.body.id,job.output_id);assert.equal(pending!.body.publicationId,stableId('render-publication:'+job.id));assert.match(pending!.body.caption,/з наданою музикою/);assert.equal((await hub.jobs(c()))[0]!.delivery_status,'queued');assert.equal((await hub.jobs(c()))[0]!.deliveryReceipt,undefined);
 const again=await run(hub,{operation:'export',id:p3.id,version:p3.version,require_audio:true});assert.equal(again.status,'ready');assert.equal(again.id,job.id);assert.equal(again.reused,true);assert.equal((await db.query("SELECT id FROM outbox WHERE kind='media_asset'")).rows.length,1);
});

test('music request without a source fails immediately; version and supported source types remain enforced',async()=>{
 const hub=new MediaWorkshop(db,h.config),p=await project(hub);await assert.rejects(run(hub,{operation:'export',id:p.id,version:p.version,require_audio:true}),/soundtrack_required/);assert.equal((await db.query('SELECT * FROM media_jobs')).rows.length,0);
 const photo=await picture(hub);await assert.rejects(run(hub,{operation:'set_soundtrack',id:p.id,version:p.version,asset_id:photo.id,asset_version:1}),/audio_track_required/);
 const added=await soundtrack(hub,p);await assert.rejects(run(hub,{operation:'export',id:p.id,version:p.version,require_audio:true}),/version_conflict/);await assert.rejects(run(hub,{operation:'set_soundtrack',id:p.id,version:added.p.version,asset_id:added.track.id,asset_version:2}),/version_conflict/);
});

test('short track fails with a concrete recovery and new looped export succeeds without stale failure notices',async()=>{
 const hub=new MediaWorkshop(db,h.config),p=await project(hub),a=await soundtrack(hub,p,shortTone),failed=await finish(hub,a.p);assert.equal(failed.status,'repair');assert.equal(failed.error_code,'soundtrack_shorter_than_story');assert.equal(failed.output_id,null);assert.equal((await db.query('SELECT * FROM media_publications')).rows.length,0);assert.match((await hub.jobs(c()))[0]!.notice,/повторити цей трек/);
 const fixed=await run(hub,{operation:'set_soundtrack',id:p.id,version:a.p.version,asset_id:a.track.id,asset_version:1,loop:true});const job=await finish(hub,fixed,{operation:'preview'});assert.equal(job.status,'ready',job.error_code);assert.equal((await db.query("SELECT * FROM outbox WHERE dedup_key=$1",['render-failed:'+failed.id+':0'])).rows.length,0);assert.ok(await one(db,"SELECT id FROM outbox WHERE kind='media_asset' AND body->>'mediaJobId'=$1",[job.id]));
});

test('silent and corrupt declared audio never produce ready or a success publication',async()=>{
 for(const [bytes,expected] of [[silence,'soundtrack_silent'],[Buffer.from('not audio'),'soundtrack_has_no_usable_audio']] as const){const hub=new MediaWorkshop(db,h.config),p=await project(hub),a=await soundtrack(hub,p,bytes,{loop:true}),job=await finish(hub,a.p);assert.equal(job.status,'repair');assert.equal(job.error_code,expected);assert.equal(job.output_id,null);assert.ok((await one(db,"SELECT body->>'text' AS text FROM outbox WHERE dedup_key=$1",['render-failed:'+job.id+':0']))!.text.length>40);}
 assert.equal((await db.query('SELECT * FROM media_publications')).rows.length,0);assert.equal((await db.query("SELECT * FROM outbox WHERE kind='media_asset'")).rows.length,0);
});

test('private track cannot widen group audience; private jobs stay private and revocation removes pending result',async()=>{
 const hub=new MediaWorkshop(db,h.config),group=await project(hub),privateTrack=await hub.store(tone,'audio/wav','Особистий трек',c({audience:'private'}));
 await assert.rejects(run(hub,{operation:'set_soundtrack',id:group.id,version:group.version,asset_id:privateTrack.id,asset_version:1},c({audience:'private'})),/widen_audience/);
 const personal=await project(hub,c({audience:'private'})),p=await run(hub,{operation:'set_soundtrack',id:personal.id,version:personal.version,asset_id:privateTrack.id,asset_version:1},c({audience:'private'})),job=await finish(hub,p,{},c({audience:'private'}));assert.equal(job.status,'ready',job.error_code);assert.equal((await hub.jobs(c())).length,0);assert.equal((await hub.jobs(c({audience:'private'}))).length,1);
 const out=await one(db,"SELECT * FROM outbox WHERE body->>'mediaJobId'=$1",[job.id]);assert.equal(out!.audience,'private');assert.equal(out!.actor_id,'11');await assert.rejects(assetFor(db,job.output_id,1,c({actorId:'22',audience:'private'})),/asset_unavailable/);
 await hub.run({operation:'revoke',id:privateTrack.id,version:1,caption:''},c({audience:'private'}));assert.equal((await one(db,'SELECT status FROM media_jobs WHERE id=$1',[job.id]))!.status,'stale');await assert.rejects(assetFor(db,job.output_id,1,c({audience:'private'})),/asset_unavailable/);assert.equal((await db.query("SELECT * FROM outbox WHERE body->>'mediaJobId'=$1 AND status='pending'",[job.id])).rows.length,0);
});

test('forget soundtrack selection removes its contract and invalidates ready output',async()=>{
 const hub=new MediaWorkshop(db,h.config),p=await project(hub),a=await soundtrack(hub,p),selection=await source('Вибери саме цю мелодію'),selected=await run(hub,{operation:'set_soundtrack',id:p.id,version:a.p.version,asset_id:a.track.id,asset_version:1},c({sourceId:selection})),job=await finish(hub,selected);assert.equal(job.status,'ready',job.error_code);
 await db.tx(sql=>forgetPhrase(sql,'Вибери саме цю мелодію'));assert.equal((await db.query('SELECT * FROM studio_soundtracks WHERE project_id=$1',[p.id])).rows.length,0);await assert.rejects(assetFor(db,job.output_id,1,c({revision:1})),/asset_unavailable/);assert.ok(await assetFor(db,a.track.id,1,c({revision:1})));assert.equal((await db.query("SELECT * FROM outbox WHERE body->>'mediaJobId'=$1 AND status='pending'",[job.id])).rows.length,0);
});

test('cancel running render and obsolete task goal cannot queue a result',async()=>{
 const hub=new MediaWorkshop(db,h.config),p=await project(hub,c(),12),a=await soundtrack(hub,p,tone,{loop:true}),queued=await run(hub,{operation:'export',id:p.id,version:a.p.version,require_audio:true});await hub.next();await run(hub,{operation:'cancel',id:p.id,version:a.p.version,job_id:queued.id});await hub.idle();assert.equal((await one(db,'SELECT status FROM media_jobs WHERE id=$1',[queued.id]))!.status,'cancelled');assert.equal((await db.query("SELECT * FROM outbox WHERE kind='media_asset'")).rows.length,0);assert.equal((await db.query("SELECT * FROM outbox WHERE dedup_key=$1",['render-cancelled:'+queued.id+':0'])).rows.length,1);
 const task=randomUUID();await db.query("INSERT INTO agent_tasks(id,dedup_key,actor_id,title,goal,status,revision,goal_version) VALUES($1,$2,'11','Ролик','Збери відео','verifying',0,1)",[task,'task:'+task]);const next=await run(hub,{operation:'export',id:p.id,version:a.p.version,require_audio:true},c({taskId:task,goalVersion:1}));await db.query('UPDATE agent_tasks SET goal_version=2 WHERE id=$1',[task]);await hub.next();await hub.idle();const old=await one(db,'SELECT * FROM media_jobs WHERE id=$1',[next.id]);assert.notEqual(old!.status,'ready');assert.equal(old!.output_id,null);assert.equal((await db.query("SELECT * FROM outbox WHERE kind='media_asset'")).rows.length,0);
});

test('queue and story bounds reject excess work before rendering',async()=>{
 const hub=new MediaWorkshop(db,h.config),p=await project(hub),a=await soundtrack(hub,p),photo=await picture(hub);let version=a.p.version;
 for(let i=0;i<7;i++)version=(await run(hub,{operation:'add_scene',id:p.id,version,asset_id:photo.id,asset_version:1,duration:12})).version;
 await assert.rejects(run(hub,{operation:'add_scene',id:p.id,version,asset_id:photo.id,asset_version:1,duration:12}),/story_limit_20_scenes_90_seconds/);
 for(let i=0;i<8;i++)await run(hub,{operation:'export',id:p.id,version,require_audio:true});await assert.rejects(run(hub,{operation:'export',id:p.id,version,require_audio:true}),/media_queue_full/);assert.equal((await db.query("SELECT * FROM media_jobs WHERE status='queued'")).rows.length,8);
});

test('self-contained MP3, M4A, AAC, OGG, FLAC sources decode into verified soundtracks',async()=>{
 const formats=[['mp3','audio/mpeg','libmp3lame','mp3'],['m4a','audio/mp4','aac','mov'],['aac','audio/aac','aac','aac'],['ogg','audio/ogg','libvorbis','ogg'],['flac','audio/flac','flac','flac']] as const;
 for(const [extension,mime,codec,format] of formats){const path=join(fixtures,'provided.'+extension);await exec(ffmpeg as unknown as string,['-v','error','-i',join(fixtures,'tone.wav'),'-t','1.1','-c:a',codec,'-y',path],{timeout:15000});const bytes=await readFile(path);assert.equal(selfContainedMediaInput(bytes,mime)[1],format);const hub=new MediaWorkshop(db,h.config),p=await project(hub),track=await hub.store(bytes,mime,'Трек '+extension,c()),selected=await run(hub,{operation:'set_soundtrack',id:p.id,version:p.version,asset_id:track.id,asset_version:1}),job=await finish(hub,selected);assert.equal(job.status,'ready',extension+': '+job.error_code);assert.equal(job.verification.audio.non_silent,true);}
});

test('spoofed audio playlists never open referenced local audio or queue a success',async()=>{
 const hub=new MediaWorkshop(db,h.config),referenced=join(fixtures,'tone.wav'),playlists=[Buffer.from('#EXTM3U\n'+referenced+'\n'),Buffer.from("ffconcat version 1.0\nfile '"+referenced+"'\n")];
 for(const bytes of playlists){assert.throws(()=>selfContainedMediaInput(bytes,'audio/mpeg'),/self_contained_audio_required/);const s=await source('Музичне вкладення'),telegram={file:async()=>bytes} as unknown as Telegram;await rememberAttachments(db,{message_id:8,date:0,chat:{id:-100,type:'supergroup'},audio:{file_id:'playlist-'+s,mime_type:'audio/mpeg',file_name:'track.mp3'}},s,0);const attachment=await one(db,'SELECT id FROM attachments WHERE source_message_id=$1',[s]);await assert.rejects(new MediaWorkshop(db,h.config,telegram).run({operation:'capture',attachment_id:Number(attachment!.id),caption:''},c()),/self_contained_audio_required/);}
 // Even a plausible ID3 header cannot switch the forced MP3 demuxer to concat.
 const disguised=Buffer.concat([Buffer.from([73,68,51,4,0,0,0,0,0,0]),playlists[1]!]),p=await project(hub),track=await hub.store(disguised,'audio/mpeg','track.mp3',c()),selected=await run(hub,{operation:'set_soundtrack',id:p.id,version:p.version,asset_id:track.id,asset_version:1}),job=await finish(hub,selected);assert.equal(job.status,'repair');assert.equal(job.error_code,'soundtrack_has_no_usable_audio');assert.equal(job.output_id,null);assert.equal((await db.query('SELECT * FROM media_publications')).rows.length,0);assert.throws(()=>selfContainedMediaInput(playlists[1]!,'video/mp4'),/self_contained_media_required/);
});

test('MP4 can supply its actual audio; an overlong scene fails duration verification',async()=>{
 const path=join(fixtures,'provided-video.mp4');await exec(ffmpeg as unknown as string,['-v','error','-nostdin','-f','lavfi','-i','color=c=blue:s=96x80:r=24:d=1.25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1.25','-threads','1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',path],{timeout:15000});
 const hub=new MediaWorkshop(db,h.config),video=await hub.store(await readFile(path),'video/mp4','Наданий кліп',c()),p=await run(hub,{operation:'create',title:'Кліп зі звуком'}),scene=await run(hub,{operation:'add_scene',id:p.id,version:1,asset_id:video.id,asset_version:1,start:.25,duration:1}),selected=await run(hub,{operation:'set_soundtrack',id:p.id,version:scene.version,asset_id:video.id,asset_version:1,start:.25}),job=await finish(hub,selected);assert.equal(job.status,'ready',job.error_code);assert.equal(job.verification.audio.non_silent,true);assert.equal((await db.query('SELECT * FROM media_job_inputs WHERE job_id=$1',[job.id])).rows.length,1);
 const read=await run(hub,{operation:'read',id:p.id}),edited=await run(hub,{operation:'edit_scene',id:p.id,version:read.version,scene_id:read.scenes[0].id,duration:2}),failed=await finish(hub,edited);assert.equal(failed.status,'repair');assert.equal(failed.error_code,'scene_exceeds_source_duration');assert.equal(failed.output_id,null);
});

test('media commitment waits for verified bytes and receipt; repair and cancellation cannot complete it',async()=>{
 const action=async()=>db.tx(sql=>createCommitment(sql,{actorId:'11',topicId:'0',revision:0,kind:'media',spec:{title:'Наша осінь'},expectedResult:'delivery_confirmed',phase:'executing'}));
 const hub=new MediaWorkshop(db,h.config),p=await project(hub),a=await soundtrack(hub,p),commitment=await action(),ctx=c({actionId:commitment!.id}),queued=await run(hub,{operation:'export',id:p.id,version:a.p.version,require_audio:true},ctx);
 assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[commitment!.id]))!.phase,'executing');assert.equal((await db.query("SELECT * FROM outbox WHERE kind='media_asset'")).rows.length,0);await hub.next();await hub.idle();const job=await one(db,'SELECT * FROM media_jobs WHERE id=$1',[queued.id]);assert.equal(job!.status,'ready',job!.error_code);assert.equal(job!.action_id,commitment!.id);assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[commitment!.id]))!.phase,'delivering');const out=await one(db,"SELECT * FROM outbox WHERE body->>'mediaJobId'=$1",[job!.id]);assert.equal(out!.body.actionId,commitment!.id);
 const delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);assert.equal(await delivery.next('media'),true);assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[commitment!.id]))!.phase,'completed');const pub=await one(db,'SELECT * FROM media_publications WHERE id=$1',[out!.body.publicationId]);assert.equal(pub!.status,'delivered');assert.ok(pub!.receipts[0].message_ids[0]);assert.equal((await hub.jobs(c()))[0]!.deliveryReceipt.message_id,pub!.receipts[0].message_ids[0]);
 const p2=await project(hub),silentTrack=await soundtrack(hub,p2,silence),broken=await action(),failed=await finish(hub,silentTrack.p,{},c({actionId:broken!.id}));assert.equal(failed.status,'repair');assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[broken!.id]))!.phase,'blocked');assert.equal((await db.query("SELECT * FROM outbox WHERE kind='media_asset' AND body->>'actionId'=$1",[broken!.id])).rows.length,0);
 const stopped=await action(),pending=await run(hub,{operation:'export',id:p.id,version:a.p.version,require_audio:true},c({actionId:stopped!.id}));await run(hub,{operation:'cancel',id:p.id,version:a.p.version,job_id:pending.id});assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[stopped!.id]))!.phase,'cancelled');assert.equal((await one(db,'SELECT output_id FROM media_jobs WHERE id=$1',[pending.id]))!.output_id,null);
});

test('preparing the render directory can fail without leaving a running job or claiming success',async()=>{
 const hub=new MediaWorkshop(db,h.config),p=await project(hub),a=await soundtrack(hub,p),queued=await run(hub,{operation:'export',id:p.id,version:a.p.version,require_audio:true});hub.directory=async()=>join(fixtures,'tone.wav');await hub.next();await hub.idle();const job=await one(db,'SELECT * FROM media_jobs WHERE id=$1',[queued.id]);assert.equal(job!.status,'repair');assert.equal(job!.error_code,'render_failed');assert.equal(job!.output_id,null);assert.ok(await one(db,'SELECT * FROM outbox WHERE dedup_key=$1',['render-failed:'+queued.id+':0']));assert.equal((await db.query('SELECT * FROM media_publications')).rows.length,0);
});

test('editing a preview within the same action invalidates its pending delivery and can finish the new version',async()=>{
 const hub=new MediaWorkshop(db,h.config),p=await project(hub),a=await soundtrack(hub,p),commitment=await db.tx(sql=>createCommitment(sql,{actorId:'11',topicId:'0',revision:0,kind:'media',spec:{title:'Редакція'},expectedResult:'delivery_confirmed',phase:'executing'})),ctx=()=>c({actionId:commitment!.id}),preview=await finish(hub,a.p,{operation:'preview'},ctx());assert.equal(preview.status,'ready',preview.error_code);const read=await run(hub,{operation:'read',id:p.id}),edited=await run(hub,{operation:'edit_scene',id:p.id,version:read.version,scene_id:read.scenes[0].id,caption:'Нова редакція'},ctx());assert.equal((await one(db,'SELECT status FROM media_jobs WHERE id=$1',[preview.id]))!.status,'stale');assert.equal((await db.query("SELECT * FROM outbox WHERE body->>'mediaJobId'=$1 AND status='pending'",[preview.id])).rows.length,0);assert.notEqual((await one(db,'SELECT phase FROM commitments WHERE id=$1',[commitment!.id]))!.phase,'blocked');const final=await finish(hub,edited,{},ctx());assert.equal(final.status,'ready',final.error_code);assert.equal(await new Delivery(db,h.tg as unknown as Telegram,h.config).next('media'),true);assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[commitment!.id]))!.phase,'completed');assert.equal(h.tg.sent.length,1);
});
