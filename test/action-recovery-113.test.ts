import {after,before,beforeEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gateOutcome,toolOutcome,currentOutcomes,outcomeMessage} from '../src/outcomes.js';
import {verifyTask} from '../src/result-verifier.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {Delivery} from '../src/delivery.js';
import {layoutMessage} from '../src/message-layout.js';
import {one,state} from '../src/db.js';
import {stableId} from '../src/operations.js';
import {isAudioDocument} from '../src/engine.js';
import type {Action,Plan} from '../src/model.js';
import {TestDB,harness,paired,message} from './helpers.js';

const tool=(name:string,args:unknown):Action=>({kind:'tool',name,arguments:JSON.stringify(args)});

describe('1.13 causal action recovery',()=>{
  it('keeps a concrete missing-audio question and truthful queued progress',()=>{
    const reply='Для ролика з музикою надішли сюди аудіофайл.';
    const clarification:Plan={reply,actions:[],dialogue:{kind:'media',audience:'group',expecting:'Аудіофайл'}};
    const checked=gateOutcome(clarification,[toolOutcome('studio.manage',{error:'invalid_tool_arguments'},{operation:'set_music'})]);
    assert.equal(checked.plan.reply,reply);assert.deepEqual(checked.plan.dialogue,clarification.dialogue);assert.equal(checked.blocked,false);
    const progress='Монтую ролик із цих фото. Коли буде готовий, надішлю сюди.';
    assert.equal(gateOutcome({reply:progress,actions:[]},[toolOutcome('studio.manage',{id:'job',status:'queued'})]).plan.reply,progress);
    assert.match(outcomeMessage([toolOutcome('studio.manage',{error:'soundtrack_required'})]),/Надішли.*трек/u);
  });
  it('supersedes only the same attempted target and never clears external uncertainty by a new read',()=>{
    const failed=toolOutcome('web.read',{error:'read_failed'},{url:'https://first.test/'});
    assert.deepEqual(currentOutcomes([failed,toolOutcome('web.read',{text:'доказ'},{url:'https://first.test/'})]).map(x=>x.status),['observed']);
    assert.deepEqual(currentOutcomes([failed,toolOutcome('web.read',{text:'інше'},{url:'https://second.test/'})]).map(x=>x.status),['failed','observed']);
    const unclear=toolOutcome('calendar.write',{error:'provider_unconfirmed'},{id:'event'});
    assert.ok(currentOutcomes([unclear,toolOutcome('calendar.write',{status:'ready'},{id:'event'})]).some(x=>x.status==='uncertain'));
    assert.equal(currentOutcomes([unclear,toolOutcome('calendar.write',{status:'ready'},{id:'event'}),toolOutcome('calendar.write',{id:'event',provider_readback:true,receipt:{uid:'receipt'}},{id:'event'})]).some(x=>x.status==='uncertain'),false);
  });
  it('classifies repair, stale, cancel and job collections without turning a list into proof',()=>{
    assert.equal(toolOutcome('studio.manage',{status:'repair',error_code:'media_decode_or_render_failed'}).status,'failed');
    assert.equal(toolOutcome('studio.manage',{status:'stale'}).status,'failed');
    const interrupted=toolOutcome('studio.manage',{status:'repair',error_code:'worker_interrupted'});assert.equal(interrupted.status,'failed');assert.match(outcomeMessage([interrupted]),/Монтаж перервався/u);
    assert.equal(toolOutcome('studio.manage',{status:'cancelled'}).status,'cancelled');
    const collection=toolOutcome('library.jobs',[{id:'failed-job',status:'repair',error_code:'render_failed'},{id:'ready-job',status:'ready',output_id:'file'}]);
    assert.equal(collection.status,'observed');assert.equal(collection.items?.[0]?.status,'failed');assert.equal(collection.confirmed,undefined);
    assert.equal(gateOutcome({reply:'Ролик надіслано.',actions:[]},[collection]).blocked,true);
    assert.equal(outcomeMessage([toolOutcome('lists.manage',{status:'needs_input',question:'Який саме пункт маєш на увазі?'})]),'Який саме пункт маєш на увазі?');
  });
  it('blocks fabricated success and dependent actions while retaining explicitly admitted independent actions',()=>{
    const note:Action={kind:'remember',content:'Зустріч у середу'};
    const checked=gateOutcome({reply:'Готово!',actions:[note,{kind:'start_game',game:'story'}]},[toolOutcome('web.search',{error:'search_failed'})],true,[note]);
    assert.deepEqual(checked.plan.actions,[note]);assert.equal(checked.blocked,true);assert.doesNotMatch(checked.plan.reply,/Готово|крок|search_failed|JSON/u);
    const proof=toolOutcome('artifact.delivery',{id:'exact',name:'first.pdf',status:'delivered',deliveryReceipt:{message_id:42}});
    assert.equal(gateOutcome({reply:'Файл first.pdf надіслано.',actions:[]},[proof]).blocked,false);
    assert.equal(gateOutcome({reply:'Файл second.pdf надіслано.',actions:[]},[proof]).blocked,true);
    assert.equal(gateOutcome({reply:'Ок',actions:[],presentation:{card:{title:'Файл',summary:'Документ надіслано.',facts:[],question:''}}},[]).blocked,true);
    assert.equal(gateOutcome({reply:'Повідомлення надіслано.',actions:[]},[toolOutcome('code.run',{deliveryReceipt:{message_id:42}})]).blocked,true);
  });
});

describe('1.13 real foreground and task integration',()=>{
  const db=new TestDB();let h:ReturnType<typeof harness>;
  before(async()=>{await db.init();});
  beforeEach(async()=>{await db.reset();await db.query('TRUNCATE media_publications,media_jobs,studio_projects,media_assets CASCADE');h=harness(db);await paired(h);});
  after(async()=>{await db.close();});
  const answer=async()=>String((await db.query("SELECT body->>'text' AS text FROM outbox WHERE dedup_key LIKE 'answer:%' ORDER BY id DESC LIMIT 1")).rows[0]?.text||'');

  it('invalid studio attempt -> discovery -> exact recovery survives full engine',async()=>{
    const reply='Для ролика з музикою надішли аудіофайл сюди — тоді додамо його до фото.';
    h.brain.replies=[{reply:'',actions:[tool('studio.manage',{operation:'set_music'})]},{reply:'',actions:[tool('tools.describe',{names:['studio.manage']})]},{reply,actions:[],dialogue:{kind:'media',audience:'group',expecting:'Аудіофайл'}}];
    await h.lumen.receive(message('Люмен, створи ролик з музикою'));await h.lumen.processNext();
    assert.match(await answer(),/надішли аудіофайл сюди/u);assert.doesNotMatch(await answer(),/потрібний крок|invalid_tool_arguments|JSON/u);assert.equal(h.brain.calls.length,3);
    const failures=(await db.query("SELECT tool,error_code,arguments FROM tool_runs WHERE status='failed'")).rows;
    assert.ok(failures.some(r=>r.tool==='studio.manage'));assert.ok(failures.every(r=>!JSON.stringify(r.arguments).includes('set_music')));
  });

  it('keeps independent note and reminder after tool failure and empty replan, using normal authorization and time checks',async()=>{
    const due=new Date(Date.now()+3600000).toISOString();const quote='нагадай через годину купити хліб';
    const reminder:Action={kind:'schedule',mode:'reminder',authorization:'explicit',title:'Хліб',instruction:'Купити хліб',timezone:'UTC',due_at:due,quote};
    h.brain.replies=[{reply:'',actions:[tool('studio.manage',{operation:'invalid'}),{kind:'remember',content:'Код дверей 789'},reminder]},{reply:'З роликом поки не вийшло. Надішли фото, які беремо.',actions:[]}];
    await h.lumen.receive(message('Люмен, зроби ролик; запам’ятай Код дверей 789 і '+quote));await h.lumen.processNext();
    assert.equal((await db.query('SELECT content FROM memories')).rows[0]?.content,'Код дверей 789');
    assert.equal((await db.query('SELECT instruction,status FROM scheduled_actions')).rows[0]?.instruction,'Купити хліб');
    assert.match(await answer(),/Надішли фото/u);assert.match(await answer(),/Хліб|хліб/u);
    assert.doesNotMatch(await answer(),/invalid_tool_arguments|потрібний крок/u);
  });

  it('journals independent actions before a tool commit and restores them on retry without a second reminder',async()=>{
    const due=new Date(Date.now()+3600000).toISOString(),quote='через годину нагадай про аптеку';
    const reminder:Action={kind:'schedule',mode:'reminder',authorization:'explicit',title:'Аптека',instruction:'Зайти в аптеку',timezone:'UTC',due_at:due,quote};
    h.brain.replies=[{reply:'',actions:[tool('tools.describe',{names:['studio.manage']}),reminder]}];
    const original=h.brain.plan.bind(h.brain);let calls=0;
    // ModelError is used by the real API; throw its typed equivalent at the replan boundary.
    const {ModelError}=await import('../src/auth.js');h.brain.plan=async input=>{calls++;if(calls===2)throw new ModelError('model_network');return original(input);};
    const update=message('Люмен, перевір можливості монтажу і '+quote);await h.lumen.receive(update);await h.lumen.processNext();
    const pending=await one(db,'SELECT status,payload FROM inbox WHERE update_id=$1',[update.update_id]);
    assert.equal(pending?.status,'pending');assert.equal(pending?.payload.pendingIndependent.length,1);
    assert.ok((await db.query("SELECT id FROM tool_runs WHERE tool='tools.describe' AND status='succeeded'")).rows.length);
    h.brain.replies=[{reply:'Продовжуємо.',actions:[]}];await db.query('UPDATE inbox SET available_at=now() WHERE update_id=$1',[update.update_id]);await h.lumen.processNext();
    assert.equal((await db.query('SELECT count(*)::int AS n FROM scheduled_actions')).rows[0]?.n,1);
    assert.equal((await one(db,'SELECT status FROM inbox WHERE update_id=$1',[update.update_id]))?.status,'done');
  });

  it('does not carry a result-dependent reminder or bypass unconfirmed schedule authorization',async()=>{
    const request='Люмен, зроби ролик і коли він буде готовий, через годину нагадай перевірити ролик';
    h.brain.replies=[{reply:'',actions:[tool('studio.manage',{operation:'bad'}),{kind:'schedule',mode:'reminder',authorization:'explicit',title:'Ролик',instruction:'Перевірити ролик',timezone:'UTC',due_at:new Date(Date.now()+3600000).toISOString(),quote:request}]},{reply:'З роликом поки не вийшло. Надішли потрібні фото.',actions:[]}];
    await h.lumen.receive(message(request));await h.lumen.processNext();assert.equal((await db.query('SELECT count(*)::int AS n FROM scheduled_actions')).rows[0]?.n,0);
    h.brain.replies=[{reply:'',actions:[tool('studio.manage',{operation:'bad'}),{kind:'schedule',mode:'reminder',authorization:'explicit',title:'Аптека',instruction:'Про аптеку',timezone:'UTC',due_at:new Date(Date.now()+3600000).toISOString(),quote:'наступний тиждень'}]},{reply:'Уточни час.',actions:[]}];
    await h.lumen.receive(message('Люмен, зроби ролик і нагадай про аптеку'));await h.lumen.processNext();assert.equal((await db.query('SELECT count(*)::int AS n FROM scheduled_actions')).rows[0]?.n,0);
  });

  it('passes Telegram audio and audio documents to planner attachments without text parsing or voice',async()=>{
    for(const document of [false,true]){
      const update=message('Люмен, додай цю музику до ролика');
      if(document)update.message!.document={file_id:'music-doc',mime_type:'application/octet-stream',file_name:'track.MP3'};
      else update.message!.audio={file_id:'music-audio',file_unique_id:'unique-audio',mime_type:'audio/mpeg',file_name:'track.mp3',duration:2};
      h.brain.replies=[{reply:'Музичний файл отримав. Які фото беремо для ролика?',actions:[]}];await h.lumen.receive(update);await h.lumen.processNext();
      assert.match(h.brain.calls.at(-1)!.context,/"kind":"audio"/u);assert.match(h.brain.calls.at(-1)!.instructions||'',/set_soundtrack/u);
    }
    assert.equal((await db.query("SELECT count(*)::int AS n FROM attachments WHERE kind='audio'")).rows[0]?.n,2);
    for(const ext of ['mp3','m4a','aac','wav','ogg','oga','flac'])assert.equal(isAudioDocument({file_name:'track.'+ext}),true);
    assert.equal(isAudioDocument({mime_type:'audio/x-music'}),true);assert.equal(isAudioDocument({file_name:'report.pdf'}),false);
    assert.equal(h.tg.calls.some(c=>/voice|audio|transcrib/i.test(c.method)),false);
  });

  it('retains the answer from a card-only summary in component and engine',async()=>{
    const presentation={card:{title:'Рішення',summary:'Їдьте ранковим потягом: 07:30, 420 грн.',facts:[],question:''}};
    const component=await layoutMessage(db,'',presentation,{key:'summary',actorId:'11',topicId:'0',revision:0});assert.match(component.text,/07:30, 420 грн/u);
    h.brain.replies=[{reply:'',actions:[],presentation}];await h.lumen.receive(message('Люмен, який потяг обрати?'));await h.lumen.processNext();assert.match(await answer(),/07:30, 420 грн/u);
  });

  it('lists, inspects and cancels the same modern reminder without exposing IDs or crossing actor/topic',async()=>{
    const request='Люмен, через годину нагадай про аптеку',due=new Date(Date.now()+3600000).toISOString();
    h.brain.replies=[{reply:'',actions:[{kind:'schedule',mode:'reminder',authorization:'explicit',title:'Аптека',instruction:'Зайти в аптеку',timezone:'UTC',due_at:due,quote:'через годину нагадай про аптеку'}]}];
    await h.lumen.receive(message(request));await h.lumen.processNext();const saved=(await db.query('SELECT id,status FROM scheduled_actions')).rows[0]!;
    await h.lumen.receive(message('/reminders'));const listing=(await db.query("SELECT body->>'text' AS text FROM outbox WHERE dedup_key LIKE 'control:%' ORDER BY id DESC LIMIT 1")).rows[0]!.text;
    assert.match(listing,/аптеку/u);assert.doesNotMatch(listing,/[a-f0-9]{8}-[a-f0-9-]{27}/u);
    h.brain.replies=[{reply:'',actions:[{kind:'inspect',subject:'reminders',query:'аптек'}]},{reply:'Ти просив нагадати зайти в аптеку через годину.',actions:[]}];
    await h.lumen.receive(message('Люмен, які в мене нагадування про аптеку?'));await h.lumen.processNext();assert.ok(h.brain.calls.at(-1)!.context.includes(saved.id));assert.match(await answer(),/аптеку/u);assert.doesNotMatch(await answer(),new RegExp(saved.id));
    await h.lumen.receive(message('/cancel аптека',22));assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[saved.id]))?.status,'pending');
    const otherTopic=message('/cancel аптека');otherTopic.message!.message_thread_id=7;await h.lumen.receive(otherTopic);assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[saved.id]))?.status,'pending');
    h.brain.replies=[{reply:'',actions:[{kind:'schedule_decision',id:String(saved.id),decision:'cancel',quote:'скасуй нагадування про аптеку'}]}];await h.lumen.receive(message('Люмен, скасуй нагадування про аптеку'));await h.lumen.processNext();assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[saved.id]))?.status,'cancelled');assert.doesNotMatch(await answer(),new RegExp(saved.id));
  });

  it('cancel-by-name uses the modern owner record and preserves legacy and recurring reminders',async()=>{
    const due=new Date(Date.now()+3600000).toISOString(),source=(await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES(811,'11','А','user','Нагадування') RETURNING id")).rows[0]!.id;
    const modern=randomUUID(),series=randomUUID();
    await db.query("INSERT INTO scheduled_actions(id,dedup_key,author_id,topic_id,title,instruction,mode,due_at,timezone,status,action_hash,revision,source_message_id,expires_at) VALUES($1,$2,'11','0','Аптека','Зайти в аптеку','reminder',$3,'UTC','pending','hash',0,$4,now()+interval '1 day')",[modern,'modern:'+modern,due,source]);
    await db.query("INSERT INTO reminders(title,due_at,author_id,topic_id,source_message_id) VALUES('Вода',$1,'11','0',$2)",[due,source]);
    await db.query("INSERT INTO recurring_series(id,actor_id,topic_id,rule,status,revision,source_message_id) VALUES($1,'11','0',$2,'active',0,$3)",[series,JSON.stringify({title:'Вітаміни',instruction:'Випити вітаміни',frequency:'daily',time:'09:00',timezone:'UTC'}),source]);
    await h.lumen.receive(message('/reminders'));const listing=(await db.query("SELECT body->>'text' AS text FROM outbox WHERE dedup_key LIKE 'control:%' ORDER BY id DESC LIMIT 1")).rows[0]!.text;assert.match(listing,/аптеку/u);assert.match(listing,/Вода/u);assert.match(listing,/Вітаміни/u);assert.doesNotMatch(listing,/[a-f0-9]{8}-[a-f0-9-]{27}/u);
    await h.lumen.receive(message('/cancel аптека'));assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[modern]))?.status,'cancelled');
    await h.lumen.receive(message('/cancel Вітаміни'));assert.equal((await one(db,'SELECT status FROM recurring_series WHERE id=$1',[series]))?.status,'active');assert.equal((await db.query("SELECT status FROM reminders WHERE title='Вода'")).rows[0]?.status,'pending');
  });

  async function mediaTask(){
    const task=randomUUID(),project=randomUUID(),jobId=randomUUID(),source=(await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES(99111,'11','А','user','Зроби ролик') RETURNING id")).rows[0]!.id;
    await db.query("INSERT INTO agent_tasks(id,dedup_key,actor_id,topic_id,title,goal,status,revision,source_message_id,audience) VALUES($1::uuid,$1::text,'11','0','Ролик','Зроби ролик','running',0,$2,'group')",[task,source]);
    await db.query("INSERT INTO studio_projects(id,owner_id,title,audience,topic_id,source_message_id) VALUES($1,'11','Подорож','group','0',$2)",[project,source]);
    await db.query("INSERT INTO media_jobs(id,kind,resource_id,resource_version,manifest,manifest_hash,actor_id,topic_id,audience,revision,source_message_id,task_id,goal_version) VALUES($1,'story',$2,1,$3,'hash','11','0','group',0,$4,$5,1)",[jobId,project,JSON.stringify({require_audio:true}),source,task]);
    await db.query("INSERT INTO tool_runs(dedup_key,task_id,actor_id,tool,arguments,status,result,revision,source_message_id,goal_version) VALUES($1,$2,'11','studio.manage',$3,'succeeded',$4,0,$5,1)",['run:'+task,task,JSON.stringify({operation:'export',id:project,version:1}),JSON.stringify({id:jobId,status:'queued',resource_id:project,version:1}),source]);
    return {task,project,jobId,source,job:await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[task])};
  }
  async function readyOutput(f:Awaited<ReturnType<typeof mediaTask>>,deliver=true){
    const output=stableId('render-output:'+f.jobId),publication=stableId('render-publication:'+f.jobId),sha='a'.repeat(64);
    await db.query("INSERT INTO media_assets(id,owner_id,title,mime,path,sha256,bytes,audience,topic_id,source_message_id) VALUES($1,'11','Подорож','video/mp4','/test/only.mp4',$2,10,'group','0',$3)",[output,sha,f.source]);
    await db.query("UPDATE media_jobs SET status='ready',stage='verified',output_id=$2,verification=$3 WHERE id=$1",[f.jobId,output,JSON.stringify({expected_duration:1,video:{decoded:true,codec:'h264',duration:1},audio:{decoded:true,non_silent:true,codec:'aac',duration:1}})]);
    const manifest={id:output,version:1,sha256:sha,audience:'group'};
    await db.query("INSERT INTO media_publications(id,asset_id,actor_id,manifest,status,receipts) VALUES($1,$2,'11',$3,$4,$5)",[publication,output,JSON.stringify(manifest),deliver?'delivered':'queued',JSON.stringify(deliver?[{provider:'telegram',chat_id:'-100',message_ids:[8001],verified_at:new Date().toISOString()}]:[])]);
    await db.query("INSERT INTO outbox(dedup_key,kind,body,revision,actor_id,audience,source_message_id,status,telegram_id) VALUES($1,'media_asset',$2,0,'11','group',$3,$4,$5)",['render-delivery:'+f.jobId,JSON.stringify({...manifest,mediaJobId:f.jobId,publicationId:publication,taskId:f.task,goalVersion:1}),f.source,deliver?'sent':'pending',deliver?8001:null]);
    return {output,publication};
  }

  it('queued export and ready output both wait for the exact media delivery receipt; text delivery cannot complete it',async()=>{
    const f=await mediaTask();let proof=await verifyTask(db,{...f.job,chatId:'-100'},'Монтаж триває.');assert.equal(proof.ok,false);assert.ok(proof.waiting.includes('media_output'));
    const runner=new AgentTasks(db,h.config,h.brain);await (runner as any).finish({...f.job,chatId:'-100'},'completed','Монтаж триває.');assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[f.task]))?.status,'verifying');
    const delivery=new Delivery(db,h.tg as any,h.config);for(let i=0;i<4;i++)await delivery.next();assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[f.task]))?.status,'verifying');
    const out=await readyOutput(f,false);proof=await verifyTask(db,{...f.job,chatId:'-100'},'Ролик готовий.');assert.ok(proof.waiting.includes('media_delivery'));
    await db.query("UPDATE media_publications SET status='delivered',receipts=$2 WHERE id=$1",[out.publication,JSON.stringify([{provider:'telegram',chat_id:'-100',message_ids:[8001],verified_at:new Date().toISOString()}])]);
    await db.query("UPDATE outbox SET status='sent',telegram_id=8001 WHERE body->>'mediaJobId'=$1",[f.jobId]);
    assert.equal((await verifyTask(db,{...f.job,chatId:'-100'},'Ролик готовий.')).ok,true);
    assert.equal(await runner.next(),true);assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[f.task]))?.status,'delivering');
    for(let i=0;i<5;i++)await delivery.next();assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[f.task]))?.status,'completed');
    assert.ok(h.tg.sent.some(x=>/Подорож/u.test(x.text)&&/надісланий/u.test(x.text)));
  });

  it('a verified delivered retry supersedes an older repaired export and invalid studio attempt',async()=>{
    const old=await mediaTask();await db.query("UPDATE media_jobs SET status='repair',error_code='render_failed' WHERE id=$1",[old.jobId]);
    const jobId=randomUUID();await db.query("INSERT INTO media_jobs(id,kind,resource_id,resource_version,manifest,manifest_hash,actor_id,topic_id,audience,revision,source_message_id,task_id,goal_version) SELECT $1,kind,resource_id,resource_version,manifest,manifest_hash,actor_id,topic_id,audience,revision,source_message_id,task_id,goal_version FROM media_jobs WHERE id=$2",[jobId,old.jobId]);
    await db.query("INSERT INTO tool_runs(dedup_key,task_id,actor_id,tool,arguments,status,result,revision,source_message_id,goal_version) VALUES($1,$2,'11','studio.manage',$3,'succeeded',$4,0,$5,1)",['retry:'+jobId,old.task,JSON.stringify({operation:'export',id:old.project,version:1}),JSON.stringify({id:jobId,status:'queued',resource_id:old.project,version:1}),old.source]);
    await db.query("INSERT INTO tool_runs(dedup_key,task_id,actor_id,tool,arguments,status,error_code,revision,source_message_id,goal_version) VALUES($1,$2,'11','studio.manage','{}','failed','invalid_tool_arguments',0,$3,1)",['failed:'+jobId,old.task,old.source]);
    await readyOutput({...old,jobId},true);assert.equal((await verifyTask(db,{...old.job,chatId:'-100'},'Готово!')).ok,true);
    await (new AgentTasks(db,h.config,h.brain) as any).finish({...old.job,chatId:'-100'},'completed','Готово!');assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[old.task]))?.status,'delivering');
  });

  it('media output/goal/audience/version/receipt mismatches and repair remain uncompleted',async()=>{
    const f=await mediaTask(),out=await readyOutput(f,true);
    const check=()=>verifyTask(db,{...f.job,chatId:'-100'},'Ролик готовий.');assert.equal((await check()).ok,true);
    await db.query("UPDATE media_publications SET status='uncertain' WHERE id=$1",[out.publication]);assert.ok((await check()).missing.includes('media_delivery_uncertain'));
    await db.query("UPDATE media_publications SET status='delivered' WHERE id=$1",[out.publication]);await db.query("UPDATE media_assets SET audience='private' WHERE id=$1",[out.output]);assert.ok((await check()).missing.includes('media_output'));
    await db.query("UPDATE media_assets SET audience='group',version=2 WHERE id=$1",[out.output]);assert.ok((await check()).missing.includes('media_delivery'));
    await db.query('UPDATE media_assets SET version=1 WHERE id=$1',[out.output]);await db.query('UPDATE media_jobs SET goal_version=2 WHERE id=$1',[f.jobId]);assert.ok((await check()).missing.includes('media_job'));
    await db.query("UPDATE media_jobs SET goal_version=1,status='repair',error_code='media_decode_or_render_failed' WHERE id=$1",[f.jobId]);assert.ok((await check()).missing.includes('media_output_failed'));
    await (new AgentTasks(db,h.config,h.brain) as any).finish({...f.job,chatId:'-100'},'completed','Готово!');const stopped=await one(db,'SELECT status,result FROM agent_tasks WHERE id=$1',[f.task]);assert.equal(stopped?.status,'needs_input');assert.doesNotMatch(stopped?.result||'',/media_output|render_failed|JSON|крок/u);
  });
});
