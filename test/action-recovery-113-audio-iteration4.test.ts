import {after,before,beforeEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {taskCompletionCriteria,verifyTask} from '../src/result-verifier.js';
import {parseMediaAudioIntent,resolveMediaAudioExpectation} from '../src/media-expectation.js';
import {AgentTools} from '../src/agent-tools.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {one} from '../src/db.js';
import {stableId} from '../src/operations.js';
import {TestDB,harness,paired,message} from './helpers.js';

const musicRequest='Зроби ролик з цього фото з наданою музикою.';

describe('1.13 iteration4 source-bound audio contract',()=>{
  it('CTI02 persists required/silent audio modes from operative sources and preserves information-only requests',()=>{
    const base={title:'Результат',goal:'Підготувати результат',criteria:['response']};
    assert.equal(parseMediaAudioIntent('Зроби ролик без музики.'),'silent');
    assert.ok(taskCompletionCriteria({...base,requestText:musicRequest}).includes('media_audio'));
    const silent=taskCompletionCriteria({...base,goal:'Зроби ролик',criteria:['response','media','media_audio'],requestText:'Без музики, будь ласка.'});assert.ok(silent.includes('media_silent'));assert.equal(silent.includes('media_audio'),false);
    const retained=taskCompletionCriteria({...base,goal:'Зроби ролик з музикою. Уточнення автора: без музики.',criteria:['response','media','media_audio']});assert.ok(retained.includes('media_audio'));assert.equal(retained.includes('media_silent'),false);
    for(const requestText of ['Зроби ролик із фото.','Зроби ролик без музики.','Поясни як зробити ролик з музикою.','Досліди відео з музикою.'])assert.equal(taskCompletionCriteria({...base,requestText}).includes('media_audio'),false,requestText);
  });
  const db=new TestDB();let h:ReturnType<typeof harness>;
  before(async()=>{await db.init();});beforeEach(async()=>{await db.reset();h=harness(db);await paired(h);});after(async()=>{await db.close();});
  const context=(sourceId:number|undefined,updateId:string)=>({actorId:'11',chatId:'-100',topicId:'0',revision:0,requested:true,audience:'group' as const,sourceId,updateId});
  async function source(text:string){const update=message('Люмен, '+text);await h.lumen.receive(update);return Number((await db.query("SELECT id FROM messages WHERE role='user' AND telegram_id=$1",[update.message!.message_id])).rows[0]!.id);}
  async function create(text:string){const sourceId=await source(text),created=await new AgentTools(db,h.config,h.brain).execute('tasks.create',{title:'Результат',goal:'Підготувати результат',criteria:['response']},context(sourceId,'audio-create:'+sourceId));return {sourceId,task:await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[created.id])};}
  async function delivered(task:any,sourceId:number,music=false){
    const project=randomUUID(),jobId=randomUUID(),output=stableId('render-output:'+jobId),publication=stableId('render-publication:'+jobId),trackId=randomUUID(),sha='c'.repeat(64);
    await db.query("INSERT INTO studio_projects(id,owner_id,title,audience,topic_id,source_message_id) VALUES($1,'11','Фотоісторія','group','0',$2)",[project,sourceId]);
    // Finite metadata fixture: the audio asset is available, but a model may omit it from the export.
    await db.query("INSERT INTO media_assets(id,owner_id,title,mime,path,sha256,bytes,audience,topic_id,source_message_id) VALUES($1,'11','Наданий трек','audio/wav','/test/provided.wav',$2,200,'group','0',$3)",[trackId,sha,sourceId]);
    await db.query("INSERT INTO media_assets(id,owner_id,title,mime,path,sha256,bytes,audience,topic_id,source_message_id) VALUES($1,'11','Фотоісторія','video/mp4','/test/output.mp4',$2,100,'group','0',$3)",[output,sha,sourceId]);
    const manifest={kind:'story',require_audio:false,soundtrack:music?{asset_id:trackId,asset_version:1}:null},verification={expected_duration:1,video:{codec:'h264',decoded:true,duration:1},audio:music?{codec:'aac',decoded:true,non_silent:true,duration:1}:null,has_soundtrack:music};
    await db.query("INSERT INTO media_jobs(id,kind,resource_id,resource_version,manifest,manifest_hash,status,stage,actor_id,topic_id,audience,revision,source_message_id,task_id,goal_version,output_id,verification) VALUES($1,'story',$2,1,$3,'hash','ready','verified','11','0','group',0,$4,$5,$6,$7,$8)",[jobId,project,JSON.stringify(manifest),sourceId,task.id,task.goal_version,output,JSON.stringify(verification)]);
    if(music)await db.query('INSERT INTO media_job_inputs(job_id,asset_id,asset_version) VALUES($1,$2,1)',[jobId,trackId]);
    await db.query("INSERT INTO tool_runs(dedup_key,task_id,actor_id,tool,arguments,status,result,revision,source_message_id,goal_version) VALUES($1,$2,'11','studio.manage',$3,'succeeded',$4,0,$5,$6)",['audio-export:'+jobId,task.id,JSON.stringify({operation:'export',id:project,version:1}),JSON.stringify({id:jobId,status:'queued',resource_id:project,version:1}),sourceId,task.goal_version]);
    const assetManifest={id:output,version:1,sha256:sha,audience:'group'},receipt={provider:'telegram',chat_id:'-100',scope_topic_id:'0',actor_id:'11',audience:'group',task_id:task.id,goal_version:task.goal_version,message_ids:[9901]};
    await db.query("INSERT INTO media_publications(id,asset_id,actor_id,manifest,status,receipts) VALUES($1,$2,'11',$3,'delivered',$4)",[publication,output,JSON.stringify(assetManifest),JSON.stringify([receipt])]);
    await db.query("INSERT INTO outbox(dedup_key,kind,body,revision,actor_id,audience,source_message_id,status,telegram_id) VALUES($1,'media_asset',$2,0,'11','group',$3,'sent',9901)",['audio-delivery:'+jobId,JSON.stringify({...assetManifest,mediaJobId:jobId,publicationId:publication,taskId:task.id,goalVersion:task.goal_version,scopeTopicId:'0'}),sourceId]);
    return {jobId,project,trackId,output,verification,manifest};
  }
  it('CTI02 actual source/weak goal requires music before export; silent exact delivery cannot complete it',async()=>{
    const f=await create(musicRequest);assert.ok(f.task?.criteria.includes('media_audio'));const job=await delivered(f.task,f.sourceId,false);const proof=await verifyTask(db,{...f.task,chatId:'-100'},'Ролик готовий.');assert.equal(proof.ok,false);assert.ok(proof.missing.includes('media_audio'));assert.equal((await one(db,'SELECT manifest FROM media_jobs WHERE id=$1',[job.jobId]))?.manifest.require_audio,false);
    h.brain.replies=[{reply:'Ролик готовий.',actions:[]}];await new AgentTasks(db,h.config,h.brain).next();const after=await one(db,'SELECT status,result FROM agent_tasks WHERE id=$1',[f.task!.id]);assert.equal(after?.status,'needs_input');assert.match(after?.result||'',/музик/u);assert.doesNotMatch(after?.result||'',/Ролик готовий/u);
  });
  it('required music needs a decoded non-silent soundtrack bound to the current audio input',async()=>{
    const f=await create(musicRequest),job=await delivered(f.task,f.sourceId,true),check=()=>verifyTask(db,{...f.task,chatId:'-100'},'Ролик готовий.');assert.equal((await check()).ok,true);
    await db.query('UPDATE media_jobs SET verification=$2 WHERE id=$1',[job.jobId,JSON.stringify({...job.verification,audio:{...job.verification.audio,non_silent:false}})]);assert.ok((await check()).missing.includes('media_audio'));
    await db.query('UPDATE media_jobs SET verification=$2 WHERE id=$1',[job.jobId,JSON.stringify(job.verification)]);await db.query('DELETE FROM media_job_inputs WHERE job_id=$1',[job.jobId]);assert.ok((await check()).missing.includes('media_audio'));
  });
  it('plain and explicitly silent videos remain valid without a music track',async()=>{
    for(const request of ['Зроби ролик із фото.','Зроби ролик без музики.']){const f=await create(request);assert.equal(f.task?.criteria.includes('media_audio'),false);const job=await delivered(f.task,f.sourceId,false);assert.equal((await verifyTask(db,{...f.task,chatId:'-100'},'Ролик готовий.')).ok,true,request);if(request.includes('без музики')){await db.query('UPDATE media_jobs SET verification=$2 WHERE id=$1',[job.jobId,JSON.stringify({...job.verification,has_soundtrack:true})]);assert.ok((await verifyTask(db,{...f.task,chatId:'-100'},'Ролик готовий.')).missing.includes('media_audio_unwanted'));}}
  });
  it('authorized silent resume supersedes music for the new goal without reviving original source or old receipts',async()=>{
    const f=await create(musicRequest);await delivered(f.task,f.sourceId,false);await db.query("UPDATE agent_tasks SET status='needs_input' WHERE id=$1",[f.task!.id]);const tools=new AgentTools(db,h.config,h.brain);
    await tools.execute('tasks.resume',{id:f.task!.id,clarification:'Без музики.'},{...context(undefined,'no-source-clear'),requestText:'Без музики.'});let current=await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[f.task!.id]);assert.ok(current?.criteria.includes('media_audio'));assert.equal(current?.criteria.includes('media_silent'),false);
    await db.query("UPDATE agent_tasks SET status='needs_input' WHERE id=$1",[f.task!.id]);const clarification=await source('Зроби цей ролик без музики.');await tools.execute('tasks.resume',{id:f.task!.id,clarification:'Без музики.'},context(clarification,'authorized-silent'));
    current=await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[f.task!.id]);assert.ok(current?.criteria.includes('media_silent'));assert.equal(current?.criteria.includes('media_audio'),false);assert.ok((await verifyTask(db,{...current,chatId:'-100'},'Ролик готовий.')).missing.includes('media_output'));
    await delivered(current,f.sourceId,false);const expectation=await resolveMediaAudioExpectation(db,{actorId:'11',topicId:'0',revision:0,sourceId:f.sourceId,taskId:f.task!.id,goalVersion:current!.goal_version,audience:'group'});assert.equal(expectation.mode,'silent');assert.equal((await verifyTask(db,{...current,chatId:'-100'},'Ролик готовий.')).ok,true);
  });
});
