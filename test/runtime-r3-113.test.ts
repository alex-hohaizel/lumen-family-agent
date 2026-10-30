import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import {PDFDocument,PDFName} from 'pdf-lib';
import {TestDB,harness} from './helpers.js';
import {AgentTools,type ToolContext} from '../src/agent-tools.js';
import {MediaWorkshop,CollectionCommand,StudioCommand} from '../src/media-workshop.js';
import {MediaAssets,invalidateAsset} from '../src/media-assets.js';
import {Delivery} from '../src/delivery.js';
import {one,forgetPhrase} from '../src/db.js';
import {digest} from '../src/evolution-core.js';
import {createCommitment} from '../src/commitments.js';
import {TelegramError} from '../src/telegram.js';
import {verifyTask} from '../src/result-verifier.js';
import {resolveMediaAudioExpectation} from '../src/media-expectation.js';

let db:TestDB,h:ReturnType<typeof harness>,sequence=3000;
beforeEach(async()=>{
 db=new TestDB();await db.init();h=harness(db);
 await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',participants='[{\"id\":\"11\"},{\"id\":\"22\"}]',consent='[\"11\",\"22\"]' WHERE id=1");
 await db.query("INSERT INTO members(user_id,name) VALUES('11','А'),('22','Б')");
});
afterEach(async()=>{await db.close();});
const c=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'7',revision:0,updateId:String(++sequence),requested:true,...extra});
async function source(body:string,actor='11',topic='7'){
 return Number((await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,$2,'Автор','user',$3,$4) RETURNING id",[++sequence,actor,body,topic]))!.id);
}

async function renderedAlbum(audience:'group'|'private'='group',options:{task?:boolean;action?:boolean}={}){
 const src=await source('Підготуй альбом із фото та документа'),base=c({sourceId:src,audience}),hub=new MediaWorkshop(db,h.config),tools=new AgentTools(db,h.config,h.brain);
 const task=options.task?await tools.execute('tasks.create',{title:'Особисті спогади',goal:'Підготувати альбом із фото та документа'},base):undefined;
 if(task)await db.query("UPDATE agent_tasks SET status='verifying' WHERE id=$1",[task.id]);
 const action=options.action?await db.tx(sql=>createCommitment(sql,{actorId:base.actorId,topicId:base.topicId,revision:0,sourceId:src,kind:'media',spec:{goal:'Альбом'},expectedResult:'delivery_confirmed',phase:'runnable'})):undefined;
 const original=await PDFDocument.create();original.addPage([160,120]);
 const image=await hub.store(await sharp({create:{width:24,height:24,channels:3,background:'#cc8844'}}).png().toBuffer(),'image/png','Фото',base),document=await hub.store(await original.save(),'application/pdf','Документ',base);
 const collection=await hub.collection(CollectionCommand.parse({operation:'create',title:'Особисті спогади'}),c({...base,updateId:String(++sequence)}));let version=1;
 for(const asset of [image,document]){
  const added=await hub.collection(CollectionCommand.parse({operation:'add',id:collection.id,version,asset_id:asset.id,asset_version:1,caption:'Матеріал автора',claim:'fact'}),c({...base,updateId:String(++sequence)}));version=added.version;
 }
 const queued=await tools.execute('archive.manage',{operation:'export',id:collection.id,version},c({...base,updateId:String(++sequence),taskId:task?.id,goalVersion:task?1:undefined,actionId:action?.id}));
 assert.equal(await hub.next(),true);await hub.idle();
 const job=(await one(db,'SELECT * FROM media_jobs WHERE id=$1',[queued.id]))!;
 assert.equal(job.status,'ready');assert.equal(job.stage,'verified');
 const output=(await one(db,'SELECT * FROM media_assets WHERE id=$1',[job.output_id]))!,out=(await one(db,"SELECT * FROM outbox WHERE body->>'mediaJobId'=$1",[job.id]))!;
 assert.ok(out,'album export must queue its actual output through the existing media publication path');
 return {hub,src,base,task,action,collection,version,job,output,out,image,document};
}

for(const audience of ['group','private'] as const)test(`actual ${audience} album PDF is sent once with exact logical topic and receipt`,async()=>{
 const f=await renderedAlbum(audience,{task:true,action:true}),uploads:any[]=[],upload=h.tg.upload.bind(h.tg);
 (h.tg as any).upload=async(...args:any[])=>{uploads.push(args);return (upload as any)(...args);};
 const d=new Delivery(db,h.tg as any,h.config);assert.equal(await d.next('media'),true);assert.equal(await d.next('media'),false);
 assert.equal(uploads.length,1);const args=uploads[0];assert.equal(args[0],'sendDocument');assert.equal(args[1],audience==='private'?'11':'-100');assert.equal(args[4],'application/pdf');assert.equal(args[5],audience==='private'?undefined:7);assert.equal(args[7],'11');
 assert.equal((await PDFDocument.load(args[2])).getPageCount(),f.job.verification.pdf.pages);assert.ok(f.job.verification.pdf.pages>=2);assert.equal(f.job.verification.pdf.attachments_verified,true);assert.equal(digest(args[2]),f.output.sha256);assert.equal(args[3],f.out.body.caption);
 const sent=(await one(db,'SELECT * FROM outbox WHERE id=$1',[f.out.id]))!,publication=(await one(db,'SELECT * FROM media_publications WHERE id=$1',[f.out.body.publicationId]))!;
 assert.equal(sent.status,'sent');assert.equal(sent.body.scopeTopicId,'7');assert.equal(sent.body.deliveryReceipt.scope_topic_id,'7');assert.equal(sent.body.deliveryReceipt.audience,audience);assert.equal(sent.body.deliveryReceipt.task_id,f.task!.id);assert.equal(sent.body.deliveryReceipt.goal_version,1);assert.equal(sent.body.deliveryReceipt.media_job_id,f.job.id);assert.equal(publication.status,'delivered');assert.equal(publication.receipts[0].scope_topic_id,'7');assert.equal(publication.receipts[0].chat_id,audience==='private'?'11':'-100');
 assert.equal(sent.body.threadId,audience==='private'?undefined:7);assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[f.action!.id]))!.phase,'completed');
 assert.equal((await db.query("SELECT id FROM outbox WHERE dedup_key LIKE 'render-ready:%'")).rows.length,0,'the acknowledged PDF caption is the ready notice');
});

for(const mutation of ['missing_pdf','generic_video','pages_zero','pages_fractional','attachments_unverified','attachment_hash','missing_attachment','wrong_mime','wrong_hash','wrong_kind'] as const)test(`album refuses ${mutation} before uploading`,async()=>{
 const f=await renderedAlbum();let proof=f.job.verification;
 if(mutation==='missing_pdf')proof={};
 if(mutation==='generic_video')proof={expected_duration:1,video:{codec:'h264',decoded:true},audio:null,has_soundtrack:false};
 if(mutation==='pages_zero')proof={pdf:{...proof.pdf,pages:0}};
 if(mutation==='pages_fractional')proof={pdf:{...proof.pdf,pages:2.5}};
 if(mutation==='attachments_unverified')proof={pdf:{...proof.pdf,attachments_verified:false}};
 if(mutation==='attachment_hash')proof={pdf:{...proof.pdf,attachments:proof.pdf.attachments.map((entry:any)=>({...entry,sha256:'0'.repeat(64)}))}};
 if(mutation==='missing_attachment')proof={pdf:{...proof.pdf,attachments:[]}};
 await db.query('UPDATE media_jobs SET verification=$1 WHERE id=$2',[JSON.stringify(proof),f.job.id]);
 if(mutation==='wrong_mime')await db.query("UPDATE media_assets SET mime='video/mp4' WHERE id=$1",[f.output.id]);
 if(mutation==='wrong_hash')await db.query("UPDATE outbox SET body=jsonb_set(body,'{sha256}',to_jsonb($1::text)) WHERE id=$2",['0'.repeat(64),f.out.id]);
 if(mutation==='wrong_kind')await db.query("UPDATE outbox SET body=body||'{\"mediaKind\":\"story\"}'::jsonb WHERE id=$1",[f.out.id]);
 await new Delivery(db,h.tg as any,h.config).next('media');assert.equal(h.tg.sent.length,0);assert.equal((await one(db,'SELECT error_code FROM outbox WHERE id=$1',[f.out.id]))!.error_code,'media_delivery_not_verified');const publication=(await one(db,'SELECT status,receipts FROM media_publications WHERE id=$1',[f.out.body.publicationId]))!;assert.equal(publication.status,'failed');assert.deepEqual(publication.receipts,[]);
 const notice=(await one(db,"SELECT body FROM outbox WHERE dedup_key LIKE 'media-delivery-error:%'"))!;assert.match(notice.body.text,/надіслати альбом/);assert.doesNotMatch(notice.body.text,/ролик|відео|монтаж/);
});

test('album readback rejects corrupt bytes, page proof and missing embedded originals even with a matching current hash',async()=>{
 for(const mutation of ['corrupt','pages','stripped_attachment']){
  const f=await renderedAlbum();let bytes=await readFile(f.output.path);
  if(mutation==='corrupt')bytes=Buffer.from('not a PDF');
  if(mutation==='stripped_attachment'){const pdf=await PDFDocument.load(bytes);pdf.catalog.delete(PDFName.of('Names'));bytes=Buffer.from(await pdf.save());}
  const sha256=digest(bytes);
  await writeFile(f.output.path,bytes);await db.query('UPDATE media_assets SET sha256=$1,bytes=$2 WHERE id=$3',[sha256,bytes.length,f.output.id]);
  await db.query('UPDATE outbox SET body=jsonb_set(body,\'{sha256}\',to_jsonb($1::text)) WHERE id=$2',[sha256,f.out.id]);
  await db.query('UPDATE media_publications SET manifest=jsonb_set(manifest,\'{sha256}\',to_jsonb($1::text)) WHERE id=$2',[sha256,f.out.body.publicationId]);
  if(mutation==='pages')await db.query("UPDATE media_jobs SET verification=jsonb_set(verification,'{pdf,pages}',to_jsonb($1::integer)) WHERE id=$2",[f.job.verification.pdf.pages+1,f.job.id]);
  await new Delivery(db,h.tg as any,h.config).next('media');assert.equal((await one(db,'SELECT error_code FROM outbox WHERE id=$1',[f.out.id]))!.error_code,'media_delivery_not_verified');
 }
 assert.equal(h.tg.sent.length,0);
});

test('album preserves live resource, source, task, action, member and audience guards',async()=>{
 for(const mutation of ['resource','input','task','action','member','audience'] as const){
  const f=await renderedAlbum('private',{task:true,action:true});
  if(mutation==='resource')await db.query('UPDATE archive_collections SET version=version+1 WHERE id=$1',[f.collection.id]);
  if(mutation==='input')await db.query('UPDATE media_assets SET version=version+1 WHERE id=$1',[f.image.id]);
  if(mutation==='task')await db.query('UPDATE agent_tasks SET goal_version=goal_version+1 WHERE id=$1',[f.task!.id]);
  if(mutation==='action')await db.query("UPDATE commitments SET phase='cancelled' WHERE id=$1",[f.action!.id]);
  if(mutation==='member')await db.query("UPDATE members SET active=false WHERE user_id='11'");
  if(mutation==='audience')await db.query("UPDATE outbox SET audience='group',body=jsonb_set(body,'{audience}','\"group\"'::jsonb) WHERE id=$1",[f.out.id]);
  await new Delivery(db,h.tg as any,h.config).next('media');assert.equal(h.tg.sent.length,0,mutation);assert.notEqual((await one(db,'SELECT status FROM media_publications WHERE id=$1',[f.out.body.publicationId]))!.status,'delivered',mutation);assert.notEqual((await one(db,'SELECT phase FROM commitments WHERE id=$1',[f.action!.id]))!.phase,'completed',mutation);
  await db.query("UPDATE members SET active=true WHERE user_id='11'");
 }
});

test('album source change during bytes read is caught by the final check',async()=>{
 const f=await renderedAlbum('private'),original=MediaAssets.prototype.bytes;let changed=false;
 MediaAssets.prototype.bytes=async function(...args:Parameters<typeof original>){const result=await original.apply(this,args);if(args[0]===f.output.id&&!changed){changed=true;await db.query('UPDATE archive_collections SET version=version+1 WHERE id=$1',[f.collection.id]);}return result;};
 try{await new Delivery(db,h.tg as any,h.config).next('media');}finally{MediaAssets.prototype.bytes=original;}
 assert.equal(changed,true);assert.equal(h.tg.sent.length,0);assert.equal((await one(db,'SELECT error_code FROM outbox WHERE id=$1',[f.out.id]))!.error_code,'media_delivery_resource_changed');
});

test('revoked and forgotten album sources leave no deliverable PDF',async()=>{
 const revoked=await renderedAlbum('private');await db.tx(sql=>invalidateAsset(sql,revoked.document.id));await new Delivery(db,h.tg as any,h.config).next('media');assert.equal(h.tg.sent.length,0);
 const forgotten=await renderedAlbum('private');await db.tx(sql=>forgetPhrase(sql,'Підготуй альбом із фото та документа'));await new Delivery(db,h.tg as any,h.config).next('media');assert.equal(h.tg.sent.length,0);assert.equal(await one(db,'SELECT id FROM media_jobs WHERE id=$1',[forgotten.job.id]),undefined);
});

test('uncertain album delivery explains the actual album subject and never resends',async()=>{
 const f=await renderedAlbum('private'),upload=h.tg.upload.bind(h.tg);let uploads=0;
 (h.tg as any).upload=async(...args:any[])=>{uploads++;return (upload as any)(...args);};h.tg.failure=new TelegramError('telegram_network',0,true);
 const d=new Delivery(db,h.tg as any,h.config);await d.next('media');assert.equal((await one(db,'SELECT status FROM outbox WHERE id=$1',[f.out.id]))!.status,'uncertain');assert.equal((await one(db,'SELECT status FROM media_publications WHERE id=$1',[f.out.body.publicationId]))!.status,'uncertain');h.tg.failure=undefined;
 assert.equal(await d.next('media'),false);assert.equal(uploads,1);await d.next('text');assert.equal(h.tg.sent[0]!.chatId,'11');assert.match(h.tg.sent[0]!.text,/доставку альбому/);assert.match(h.tg.sent[0]!.text,/автоматично не надсилаю повторно/);assert.doesNotMatch(h.tg.sent[0]!.text,/ролик|відео|монтаж/);
});

test('delivery independently blocks a legacy silent story whose actual author source requires music',async()=>{
 const src=await source('Створи ролик з фото'),base=c({sourceId:src,audience:'private'}),hub=new MediaWorkshop(db,h.config),image=await hub.store(await sharp({create:{width:24,height:24,channels:3,background:'#8844cc'}}).png().toBuffer(),'image/png','Фото',base);
 const project=await hub.studio(StudioCommand.parse({operation:'create',title:'Спогади'}),c({...base,updateId:String(++sequence)})),edited=await hub.studio(StudioCommand.parse({operation:'add_scene',id:project.id,version:1,asset_id:image.id,asset_version:1,duration:1}),c({...base,updateId:String(++sequence)})),queued=await hub.studio(StudioCommand.parse({operation:'export',id:project.id,version:edited.version}),c({...base,updateId:String(++sequence)}));
 assert.equal(await hub.next(),true);await hub.idle();const job=(await one(db,'SELECT * FROM media_jobs WHERE id=$1',[queued.id]))!;assert.equal(job.status,'ready');assert.equal(job.verification.audio,null);
 const actualMusic=await source('Зроби ролик з цього фото з наданою музикою'),{audio_expectation,...legacyManifest}=job.manifest;
 // This is the independently reproduced pre-contract persisted shape: no audio
 // expectation/flag, a real silent output, and a same-author music instruction.
 await db.query('UPDATE media_jobs SET source_message_id=$1,manifest=$2,manifest_hash=$3 WHERE id=$4',[actualMusic,JSON.stringify(legacyManifest),digest(legacyManifest),job.id]);
 await new Delivery(db,h.tg as any,h.config).next('media');assert.equal(h.tg.sent.length,0);const out=(await one(db,"SELECT * FROM outbox WHERE body->>'mediaJobId'=$1",[job.id]))!;assert.equal(out.error_code,'media_delivery_not_verified');assert.equal((await one(db,'SELECT status FROM media_publications WHERE id=$1',[out.body.publicationId]))!.status,'failed');
});

test('source-bound audio criterion is admitted and an authorized silent resume clears only the superseded audio requirement',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),src=await source('Зроби ролик з фото з наданою музикою'),task=await tools.execute('tasks.create',{title:'Спогади',goal:'Створи ролик з фото',criteria:['response']},c({sourceId:src,audience:'private'}));
 let stored=(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[task.id]))!;assert.ok(stored.criteria.includes('media'));assert.ok(stored.criteria.includes('media_audio'));
 const explicit=await tools.execute('tasks.create',{title:'Явні критерії',goal:'Створи ролик з фото',criteria:['response','research','calculation','document','external','media','media_audio']},c());assert.equal((await one(db,'SELECT criteria FROM agent_tasks WHERE id=$1',[explicit.id]))!.criteria.length,7);
 await db.query("UPDATE agent_tasks SET status='paused' WHERE id=$1",[task.id]);
 await tools.execute('tasks.resume',{id:task.id,clarification:'Зроби цей ролик без музики'},c({audience:'private',goalVersion:1,requestText:'Без музики'}));
 stored=(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[task.id]))!;assert.ok(stored.criteria.includes('media_audio'),'model clarification or unbound text cannot remove an existing audio requirement');assert.equal(stored.goal_version,2);
 await db.query("UPDATE agent_tasks SET status='paused' WHERE id=$1",[task.id]);
 const silent=await source('Продовжуй: зроби цей ролик без музики'),ctx=c({sourceId:silent,audience:'private',goalVersion:2}),resumed=await tools.execute('tasks.resume',{id:task.id,clarification:'Зроби цей ролик без музики'},ctx);
 assert.equal(resumed.goal_version,3);stored=(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[task.id]))!;assert.ok(stored.criteria.includes('media'));assert.equal(stored.criteria.includes('media_audio'),false);assert.ok(stored.criteria.includes('media_silent'));assert.equal(stored.audience,'private');
 const expectation=await resolveMediaAudioExpectation(db,{actorId:'11',topicId:'7',revision:0,taskId:task.id,goalVersion:3,sourceId:src,audience:'private'});assert.equal(expectation.mode,'silent');assert.deepEqual(expectation.source_ids,[silent],'the superseded music request and ambient context are not audio authority');
 const proof=await verifyTask(db,{...stored,chatId:'-100'},'Ще готується.');assert.equal(proof.ok,false);assert.equal(proof.missing.includes('media_audio'),false,'the original music source cannot restore a superseded requirement');
 await db.query("UPDATE agent_tasks SET status='paused' WHERE id=$1",[task.id]);const foreign=await source('Тепер без музики','22');await assert.rejects(tools.execute('tasks.resume',{id:task.id,clarification:'Без музики'},c({sourceId:foreign,audience:'private',goalVersion:3})),/task_source_required/);assert.equal((await one(db,'SELECT goal_version FROM agent_tasks WHERE id=$1',[task.id]))!.goal_version,3);
});
