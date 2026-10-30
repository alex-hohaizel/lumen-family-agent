import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {z} from 'zod';
import {TestDB,harness,message} from './helpers.js';
import {AgentTools,type ToolContext} from '../src/agent-tools.js';
import {MediaWorkshop,StudioCommand} from '../src/media-workshop.js';
import {Delivery} from '../src/delivery.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {TaskJournal,resolveTaskAudience} from '../src/task-journal.js';
import {one,forgetPhrase} from '../src/db.js';
import {verifyTask} from '../src/result-verifier.js';
import {saveSchedule,ScheduleSchema,dispatchSchedules} from '../src/scheduling.js';
import {ToolError} from '../src/safe-http.js';

let db:TestDB,h:ReturnType<typeof harness>,seq=1000;
beforeEach(async()=>{db=new TestDB();await db.init();h=harness(db);await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',participants='[{\"id\":\"11\"},{\"id\":\"22\"}]',consent='[\"11\",\"22\"]' WHERE id=1");await db.query("INSERT INTO members(user_id,name) VALUES('11','А'),('22','Б')");});
afterEach(async()=>{await db.close();});
const c=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'7',revision:0,updateId:String(++seq),requested:true,...extra});
async function source(text:string,topic='7',actor='11'){return Number((await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,$2,'Автор','user',$3,$4) RETURNING id",[++seq,actor,text,topic]))!.id);}

test('same-turn studio read observes a committed edit while replaying the write still creates only one scene',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),ctx=c(),hub=new MediaWorkshop(db,h.config),project=await hub.studio(StudioCommand.parse({operation:'create',title:'Монтаж'}),c()),args={operation:'read',id:project.id};
 const before=await tools.execute('studio.manage',args,ctx);assert.equal(before.version,1);assert.equal(before.scenes.length,0);
 const image=await hub.store(await sharp({create:{width:20,height:20,channels:3,background:'#8844cc'}}).png().toBuffer(),'image/png','Фото',c());
 const edit={operation:'add_scene',id:project.id,version:1,asset_id:image.id,asset_version:1,duration:1};
 const write=await tools.execute('studio.manage',edit,ctx),after=await tools.execute('studio.manage',args,ctx);assert.equal(after.version,2);assert.equal(after.scenes.length,1);
 assert.deepEqual(await tools.execute('studio.manage',edit,ctx),write);assert.equal((await one(db,'SELECT version FROM studio_projects WHERE id=$1',[project.id]))!.version,2);assert.equal(Number((await one(db,'SELECT count(*) n FROM studio_scenes WHERE project_id=$1',[project.id]))!.n),1);
});

test('cached private studio metadata never crosses audience/topic/actor and current membership is rechecked',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),hub=new MediaWorkshop(db,h.config),ctx=c({audience:'private'}),project=await hub.studio(StudioCommand.parse({operation:'create',title:'Особиста назва'}),ctx),args={operation:'read',id:project.id};
 assert.equal((await tools.execute('studio.manage',args,ctx)).title,'Особиста назва');
 for(const change of [{audience:'group' as const},{topicId:'8'},{actorId:'22'}])await assert.rejects(tools.execute('studio.manage',args,{...ctx,...change}),/resource_unavailable/);
 await db.query("UPDATE studio_projects SET title='Оновлена особиста назва',version=2 WHERE id=$1",[project.id]);assert.equal((await tools.execute('studio.manage',args,ctx)).title,'Оновлена особиста назва');
 await db.query("UPDATE members SET active=false WHERE user_id='11'");await assert.rejects(tools.execute('studio.manage',args,ctx),/member_required/);
 await db.query("UPDATE members SET active=true WHERE user_id='11'");await db.query('DELETE FROM studio_projects WHERE id=$1',[project.id]);await assert.rejects(tools.execute('studio.manage',args,ctx),/resource_unavailable/);
});

test('non-media mutable lists also re-read live rows at the same audit key',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),ctx=c(),read=c();
 await tools.execute('event.create',{title:'Перша подія',details:'{}'},ctx);assert.equal((await tools.execute('event.list',{},read))[0].title,'Перша подія');
 await db.query("UPDATE group_events SET title='Поточна подія'");assert.equal((await tools.execute('event.list',{},read))[0].title,'Поточна подія');
 await db.query("UPDATE members SET active=false WHERE user_id='11'");await assert.rejects(tools.execute('event.list',{},read),/member_required/);
});

test('fresh-read policy never re-executes an uncertain external effect',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),ctx=c({audience:'private'});let attempts=0;
 (tools as any).add('test.external',{description:'Погоджена зовнішня дія',schema:z.object({value:z.number()}),effect:true,run:async()=>{attempts++;throw new ToolError('provider_timeout');}});
 const proposed=await tools.execute('test.external',{value:1},ctx);await db.query("UPDATE tool_approvals SET status='approved' WHERE id=$1",[proposed.approval_id]);
 await assert.rejects(tools.execute('test.external',{value:1},{...ctx,approvalId:proposed.approval_id}),/provider_timeout/);
 await assert.rejects(tools.execute('test.external',{value:1},{...ctx,approvalId:proposed.approval_id}),/previous_tool_result_uncertain/);assert.equal(attempts,1);assert.equal((await one(db,"SELECT phase FROM effect_operations WHERE actor_id='11'"))!.phase,'uncertain');
});

test('media task criteria and exact private audience are persisted before any export, using the actual source request',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),src=await source('Зроби відео з наданих фото'),ctx=c({sourceId:src,audience:'private',requestText:'Підготуй текст'}),task=await tools.execute('tasks.create',{title:'Результат',goal:'Підготувати результат',criteria:['response']},ctx);
 const row=(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[task.id]))!;assert.ok(row.criteria.includes('media'));assert.equal(row.audience,'private');assert.equal((await db.query('SELECT id FROM media_jobs')).rows.length,0);
 const proof=await verifyTask(db,row,'Ролик готовий.');assert.equal(proof.ok,false);assert.ok(proof.missing.includes('media_output'));
 const explicitly=await tools.execute('tasks.create',{title:'Фізичний результат',goal:'Виконати погоджене',criteria:['response','media']},c());assert.ok((await one(db,'SELECT criteria FROM agent_tasks WHERE id=$1',[explicitly.id]))!.criteria.includes('media'));
});

test('research, recommendations and document/image descriptions about video keep their original task contracts',async()=>{
 const tools=new AgentTools(db,h.config,h.brain);
 for(const [goal,criteria] of [['Досліди сучасні відео формати',['research']],['Порадь, як зробити відео',['response']],['Поясни, як створити відео',['response']],['Створи PDF про історію відео',['document']],['Створи картинку про відео',['document']]] as [string,string[]][]){
  const task=await tools.execute('tasks.create',{title:goal,goal,criteria},c()),stored=(await one(db,'SELECT criteria,audience FROM agent_tasks WHERE id=$1',[task.id]))!;
  assert.deepEqual(stored.criteria,criteria,goal);assert.equal(stored.audience,'group');
 }
});

test('deferred media work receives its expected criterion at conversion before execution',async()=>{
 const text='Завтра створи відео з фото',src=await source(text),m=message(text).message!;m.message_thread_id=7;
 await db.tx(sql=>saveSchedule(sql,ScheduleSchema.parse({kind:'schedule',title:'Відео',instruction:'Створи відео з фото',mode:'task',due_at:new Date(Date.now()+3600000).toISOString(),timezone:'UTC',authorization:'explicit',quote:text}),m,src,++seq,0));
 await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 second'");assert.equal(await dispatchSchedules(db),1);
 const task=(await one(db,'SELECT * FROM agent_tasks'))!;assert.ok(task.criteria.includes('media'));assert.equal(task.audience,'group');assert.equal((await db.query('SELECT id FROM media_jobs')).rows.length,0);
});

test('resume atomically strengthens the changed goal contract while retaining private audience and source lineage',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),original=await source('Підготуй результат'),created=await tools.execute('tasks.create',{title:'Особистий результат',goal:'Підготувати результат'},c({sourceId:original,audience:'private'}));
 await db.query("UPDATE agent_tasks SET status='needs_input' WHERE id=$1",[created.id]);
 const clarification=await source('Продовжуй: тепер створи відео з фото'),ctx=c({sourceId:clarification,audience:'private',goalVersion:1}),args={id:created.id,clarification:'Тепер створи відео з фото'},resumed=await tools.execute('tasks.resume',args,ctx);
 assert.equal(resumed.goal_version,2);const task=(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[created.id]))!;assert.ok(task.criteria.includes('media'));assert.equal(task.audience,'private');assert.equal(task.status,'pending');
 assert.deepEqual(await tools.execute('tasks.resume',args,ctx),resumed);assert.equal((await one(db,'SELECT goal_version FROM agent_tasks WHERE id=$1',[created.id]))!.goal_version,2);
 await db.query("UPDATE agent_tasks SET status='paused' WHERE id=$1",[created.id]);assert.equal((await tools.execute('tasks.resume',{id:created.id},c({actorId:'22'}))).resumed,false);assert.equal((await tools.execute('tasks.resume',{id:created.id},c({goalVersion:1}))).resumed,false);
 await db.query("UPDATE agent_tasks SET status='cancelled' WHERE id=$1",[created.id]);assert.equal((await tools.execute('tasks.resume',{id:created.id},c())).resumed,false);
 await db.tx(sql=>forgetPhrase(sql,'Продовжуй: тепер'));assert.equal(await one(db,'SELECT id FROM agent_tasks WHERE id=$1',[created.id]),undefined);
});

test('legacy task audience backfill uses actual ingress, narrows private evidence and never treats default group progress as proof',async()=>{
 const sql=await readFile(new URL('../../docs/qa-1-13/runtime-schema-r2.sql',import.meta.url),'utf8'),groupSource=await source('Публічне доручення'),privateSource=await source('Приватне доручення'),unknownSource=await source('Невідоме старе доручення');
 const insert=async(src:number)=>{const id=randomUUID();await db.query("INSERT INTO agent_tasks(id,dedup_key,actor_id,topic_id,title,goal,revision,source_message_id,audience) VALUES($1,$3,'11','7','Назва','Мета завдання',0,$2,NULL)",[id,src,'legacy:'+id]);return id;};
 const group=await insert(groupSource),privateTask=await insert(privateSource),unknown=await insert(unknownSource);
 await db.query("INSERT INTO inbox(update_id,payload,revision) VALUES($1,$2,0)",[++seq,JSON.stringify({sourceId:groupSource,message:{from:{id:11},chat:{id:-100,type:'supergroup'},message_thread_id:7}})]);
 await db.query("INSERT INTO media_jobs(id,kind,resource_id,resource_version,manifest,manifest_hash,actor_id,topic_id,audience,revision,task_id,goal_version) VALUES($1,'story',$2,1,'{}','legacy','11','7','private',0,$3,1)",[randomUUID(),randomUUID(),privateTask]);
 for(const [id,status] of [[unknown,'pending'],[unknown,'uncertain']] as const)await db.query("INSERT INTO outbox(dedup_key,kind,body,revision,actor_id,audience,status) VALUES($1,'task_status',$2,0,'11','group',$3)",['legacy:'+status,JSON.stringify({taskId:id,text:'Невідома особиста назва',threadId:7}),status]);
 assert.equal(await resolveTaskAudience(db,(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[group]))!,'-100'),'group');assert.equal(await resolveTaskAudience(db,(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[unknown]))!,'-100'),'private');
 await db.pg.exec(sql);
 assert.equal((await one(db,'SELECT audience FROM agent_tasks WHERE id=$1',[group]))!.audience,'group');assert.equal((await one(db,'SELECT audience FROM agent_tasks WHERE id=$1',[privateTask]))!.audience,'private');assert.equal((await one(db,'SELECT audience FROM agent_tasks WHERE id=$1',[unknown]))!.audience,'private');
 assert.equal((await one(db,"SELECT audience FROM outbox WHERE dedup_key='legacy:pending'"))!.audience,'private');assert.equal((await one(db,"SELECT audience,status FROM outbox WHERE dedup_key='legacy:uncertain'"))!.status,'uncertain');
 const row=(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[unknown]))!;assert.equal(await resolveTaskAudience(db,row,'-100'),'private');await new TaskJournal(db).publish(unknown,true);assert.ok((await db.query("SELECT audience FROM outbox WHERE body->>'taskId'=$1 AND status='pending'",[unknown])).rows.every(out=>out.audience==='private'));
});

test('private task titles stay out of group reads and progress never edits a message from an unproved recipient',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),src=await source('Особисте доручення'),task=await tools.execute('tasks.create',{title:'Особиста назва',goal:'Підготувати особисту відповідь'},c({sourceId:src,audience:'private'}));
 assert.deepEqual(await tools.execute('tasks.list',{},c()),[]);await assert.rejects(tools.execute('tasks.status',{id:task.id},c()),/resource_unavailable/);await assert.rejects(tools.execute('diagnostics.status',{},c()),/resource_unavailable/);
 await db.query('UPDATE agent_tasks SET progress_message_id=12345 WHERE id=$1',[task.id]);await new TaskJournal(db).publish(task.id,true);
 const d=new Delivery(db,h.tg as any,h.config);for(let n=0;n<6;n++)await d.next();assert.ok(h.tg.sent.length>0);assert.ok(h.tg.sent.every(sent=>sent.chatId==='11'));assert.equal(h.tg.calls.filter(call=>call.method==='editMessageText').length,0);
});

async function renderedTask(audience:'group'|'private',topic:string){
 const src=await source('Створи відео з фото',topic),tools=new AgentTools(db,h.config,h.brain),base=c({sourceId:src,audience,topicId:topic}),hub=new MediaWorkshop(db,h.config),created=await tools.execute('tasks.create',{title:'Особлива назва ролика',goal:'Створи відео з фото'},base),taskContext={...base,taskId:created.id,goalVersion:1,updateId:String(++seq)};
 const project=await hub.studio(StudioCommand.parse({operation:'create',title:'Особливі спогади'}),base),picture=await hub.store(await sharp({create:{width:24,height:24,channels:3,background:'#cc8822'}}).png().toBuffer(),'image/png','Фото',base),edited=await hub.studio(StudioCommand.parse({operation:'add_scene',id:project.id,version:1,asset_id:picture.id,asset_version:1,duration:1}),{...base,updateId:String(++seq)});
 const queued=await tools.execute('studio.manage',{operation:'export',id:project.id,version:edited.version},taskContext);await db.query("UPDATE agent_tasks SET status='verifying',result='Відео готується.' WHERE id=$1",[created.id]);assert.equal(await hub.next(),true);await hub.idle();assert.equal((await one(db,'SELECT status FROM media_jobs WHERE id=$1',[queued.id]))!.status,'ready');
 return {task:(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[created.id]))!,jobId:queued.id};
}

for(const [audience,topic] of [['private','7'],['group','7'],['private','0']] as const)test(`${audience} media from logical topic ${topic} records exact receipt scope and completes only in the authorized audience`,async()=>{
 const prepared=await renderedTask(audience,topic),uploads:any[]=[],original=h.tg.upload.bind(h.tg);(h.tg as any).upload=async(...args:any[])=>{uploads.push({chat:args[1],thread:args[5],actor:args[7]});return (original as any)(...args);};
 const before=await verifyTask(db,{...prepared.task,chatId:'-100'},'Відео готове.');assert.equal(before.ok,false);assert.ok(before.waiting.includes('media_delivery'));
 const d=new Delivery(db,h.tg as any,h.config);assert.equal(await d.next('media'),true);const out=(await one(db,"SELECT * FROM outbox WHERE body->>'mediaJobId'=$1",[prepared.jobId]))!,pub=(await one(db,'SELECT * FROM media_publications WHERE id=$1',[out.body.publicationId]))!;
 assert.equal(uploads[0].chat,audience==='private'?'11':'-100');assert.equal(uploads[0].thread,audience==='private'?undefined:7);assert.equal(out.body.scopeTopicId,topic);assert.equal(out.body.deliveryReceipt.scope_topic_id,topic);assert.equal(pub.receipts[0].scope_topic_id,topic);assert.equal(pub.receipts[0].actor_id,'11');assert.equal(pub.receipts[0].audience,audience);assert.equal(pub.receipts[0].task_id,prepared.task.id);assert.equal(pub.receipts[0].goal_version,1);assert.equal(await d.next('media'),false);
 assert.equal((await verifyTask(db,{...prepared.task,chatId:'-100'},'Відео готове.')).ok,true);
 if(audience==='private'&&topic==='7'){
  for(const patch of [{scope_topic_id:'8'},{task_id:randomUUID()},{actor_id:'22'},{audience:'group'},{scope_topic_id:undefined}]){await db.query('UPDATE media_publications SET receipts=$1 WHERE id=$2',[JSON.stringify([{...pub.receipts[0],...patch}]),pub.id]);assert.equal((await verifyTask(db,{...prepared.task,chatId:'-100'},'Відео готове.')).ok,false);}
  await db.query('UPDATE media_publications SET receipts=$1 WHERE id=$2',[JSON.stringify(pub.receipts),pub.id]);
 }
 await new AgentTasks(db,h.config,h.brain).next();for(let i=0;i<16;i++)await d.next();
 assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[prepared.task.id]))!.status,'completed');assert.ok(h.tg.sent.every(sent=>sent.chatId===(audience==='private'?'11':'-100')),'progress and final title must keep the output audience');
});

test('a group media publication cannot claim logical topic7 while routing its file to topic8',async()=>{
 const prepared=await renderedTask('group','7');await db.query("UPDATE outbox SET body=body||'{\"scopeTopicId\":\"7\",\"threadId\":8}'::jsonb WHERE body->>'mediaJobId'=$1",[prepared.jobId]);
 await new Delivery(db,h.tg as any,h.config).next('media');assert.equal(h.tg.sent.length,0);assert.equal((await one(db,"SELECT status FROM outbox WHERE body->>'mediaJobId'=$1",[prepared.jobId]))!.status,'cleared');assert.equal((await verifyTask(db,{...prepared.task,chatId:'-100'},'Відео готове.')).ok,false);
});
