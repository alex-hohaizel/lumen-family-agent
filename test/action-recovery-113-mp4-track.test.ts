import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';
import {AgentTools} from '../src/agent-tools.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {MediaWorkshop} from '../src/media-workshop.js';
import {Delivery} from '../src/delivery.js';
import {verifyTask} from '../src/result-verifier.js';
import {one} from '../src/db.js';
import {TestDB,harness} from './helpers.js';

test('CTI02 MP4 soundtrack completes only with real decoded music, current input and exact delivery',async t=>{
  const db=new TestDB();await db.init();const h=harness(db),dir=await mkdtemp(join(tmpdir(),'lumen-mp4-track-')),exec=promisify(execFile);let serial=994000;
  try{
    await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',participants='[{\"id\":\"11\"},{\"id\":\"22\"}]',consent='[\"11\",\"22\"]'");await db.query("INSERT INTO members(user_id,name) VALUES('11','А'),('22','Б')");
    const make=async(name:string,audio:string)=>{const path=join(dir,name+'.mp4');await exec(ffmpeg as unknown as string,['-v','error','-nostdin','-f','lavfi','-i','color=c=blue:s=32x32:r=24:d=1.2','-f','lavfi','-i',audio,'-threads','1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',path],{timeout:15000});return readFile(path);};
    const audible=await make('provided','sine=frequency=440:sample_rate=48000:duration=1.2'),silent=await make('silent','anullsrc=r=48000:cl=stereo:d=1.2'),tools=new AgentTools(db,h.config,h.brain),hub=new MediaWorkshop(db,h.config);
    async function render(trackBytes:Buffer){
      const source=Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,'11','Автор','user','Зроби ролик з цього фото з наданою музикою.','7') RETURNING id",[++serial])).rows[0]!.id),context=()=>({actorId:'11',chatId:'-100',topicId:'7',revision:0,requested:true,sourceId:source,audience:'group' as const,updateId:'mp4-track:'+ ++serial});
      const created=await tools.execute('tasks.create',{title:'Результат',goal:'Підготувати результат',criteria:['response']},context()),task=(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[created.id]))!,c=()=>({...context(),taskId:task.id,goalVersion:task.goal_version});assert.ok(task.criteria.includes('media_audio'));
      const track=await hub.store(trackBytes,'video/mp4','Надана музика',c()),photo=await hub.store(await sharp({create:{width:24,height:24,channels:3,background:'#bb7744'}}).png().toBuffer(),'image/png','Фото',c()),p=await tools.execute('studio.manage',{operation:'create',title:'Ролик'},c()),scene=await tools.execute('studio.manage',{operation:'add_scene',id:p.id,version:1,asset_id:photo.id,asset_version:1,duration:1},c());
      await assert.rejects(tools.execute('studio.manage',{operation:'export',id:p.id,version:scene.version,require_audio:false},c()),/soundtrack_required/);
      const selected=await tools.execute('studio.manage',{operation:'set_soundtrack',id:p.id,version:scene.version,asset_id:track.id,asset_version:1},c()),queued=await tools.execute('studio.manage',{operation:'export',id:p.id,version:selected.version,require_audio:false},c());assert.equal(await hub.next(),true);await hub.idle();return {task,track,queued,media:(await one(db,'SELECT * FROM media_jobs WHERE id=$1',[queued.id]))!};
    }
    const f=await render(audible),check=()=>verifyTask(db,{...f.task,chatId:'-100'},'Ролик готовий і надісланий.');assert.equal(f.media.status,'ready',f.media.error_code);assert.equal(f.media.stage,'verified');assert.equal(f.media.verification.audio.codec,'aac');assert.equal(f.media.verification.audio.decoded,true);assert.equal(f.media.verification.audio.non_silent,true);assert.equal(f.media.verification.has_soundtrack,true);assert.ok((await check()).waiting.includes('media_delivery'));
    const d=new Delivery(db,h.tg as any,h.config);assert.equal(await d.next('media'),true);const publication=(await one(db,'SELECT * FROM media_publications WHERE asset_id=$1',[f.media.output_id]))!,out=(await one(db,"SELECT * FROM outbox WHERE body->>'mediaJobId'=$1",[f.media.id]))!;assert.equal(publication.status,'delivered');assert.equal(out.status,'sent');assert.equal(out.body.deliveryReceipt.task_id,f.task.id);assert.equal(out.body.deliveryReceipt.goal_version,1);assert.equal(out.body.deliveryReceipt.scope_topic_id,'7');assert.equal((await check()).ok,true);
    for(const mime of ['video/webm','image/png','application/octet-stream']){await db.query('UPDATE media_assets SET mime=$2 WHERE id=$1',[f.track.id,mime]);assert.ok((await check()).missing.includes('media_audio'),mime);}await db.query("UPDATE media_assets SET mime='video/mp4' WHERE id=$1",[f.track.id]);
    for(const audio of [{...f.media.verification.audio,decoded:false},{...f.media.verification.audio,non_silent:false},null]){await db.query('UPDATE media_jobs SET verification=$2 WHERE id=$1',[f.media.id,JSON.stringify({...f.media.verification,audio})]);assert.equal((await check()).ok,false);}await db.query('UPDATE media_jobs SET verification=$2 WHERE id=$1',[f.media.id,JSON.stringify(f.media.verification)]);
    await db.query('UPDATE media_job_inputs SET asset_version=2 WHERE job_id=$1 AND asset_id=$2',[f.media.id,f.track.id]);assert.ok((await check()).missing.includes('media_output_stale'));await db.query('UPDATE media_job_inputs SET asset_version=1 WHERE job_id=$1 AND asset_id=$2',[f.media.id,f.track.id]);
    await db.query("UPDATE media_assets SET status='revoked' WHERE id=$1",[f.track.id]);assert.ok((await check()).missing.includes('media_output_stale'));await db.query("UPDATE media_assets SET status='available' WHERE id=$1",[f.track.id]);
    await db.query('UPDATE media_jobs SET goal_version=2 WHERE id=$1',[f.media.id]);assert.ok((await check()).missing.includes('media_job'));await db.query('UPDATE media_jobs SET goal_version=1 WHERE id=$1',[f.media.id]);
    await db.query('UPDATE media_publications SET receipts=$2 WHERE id=$1',[publication.id,JSON.stringify(publication.receipts.map((receipt:any)=>({...receipt,message_ids:[Number(out.telegram_id)+1]})))]);assert.ok((await check()).waiting.includes('media_delivery'));await db.query('UPDATE media_publications SET receipts=$2 WHERE id=$1',[publication.id,JSON.stringify(publication.receipts)]);assert.equal((await check()).ok,true);
    await db.query("UPDATE agent_tasks SET status='verifying',result='Ролик готовий і надісланий.' WHERE id=$1",[f.task.id]);await new AgentTasks(db,h.config,h.brain).next();for(let n=0;n<12;n++)await d.next('text');assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[f.task.id]))?.status,'completed');
    const quiet=await render(silent);assert.equal(quiet.media.status,'repair');assert.equal(quiet.media.error_code,'soundtrack_silent');assert.equal(quiet.media.output_id,null);assert.equal((await verifyTask(db,{...quiet.task,chatId:'-100'},'Ролик готовий.')).ok,false);assert.equal((await db.query("SELECT id FROM outbox WHERE kind='media_asset' AND body->>'mediaJobId'=$1",[quiet.media.id])).rows.length,0);
    t.diagnostic(JSON.stringify({audible:{mime:'video/mp4',verification:f.media.verification,deliveryReceipt:out.body.deliveryReceipt,task:'completed'},actualSilentMp4:{status:quiet.media.status,error_code:quiet.media.error_code},negativeControls:['other MIME','decoded=false','non_silent=false','no audio','input version','revoked source','goal version','wrong message receipt']}));
  }finally{await db.close();await rm(h.config.runtimeDir,{recursive:true,force:true});await rm(dir,{recursive:true,force:true});}
});
