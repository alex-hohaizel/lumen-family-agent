import {before,after,beforeEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TestDB,harness,paired,message} from './helpers.js';
import {one,queueText} from '../src/db.js';
import {AgentTools,argumentHash,type ToolContext} from '../src/agent-tools.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {Delivery} from '../src/delivery.js';
import {ImageJobs} from '../src/image-jobs.js';
import {WebMonitors} from '../src/web-monitors.js';
import {ModelError} from '../src/auth.js';
import {ToolError} from '../src/safe-http.js';
import {Telegram,TelegramError} from '../src/telegram.js';
import {Media} from '../src/media.js';
import {VisualMemory} from '../src/visual.js';
import {incidentForError,incidentForResult,validIncidentCode} from '../src/incidents.js';
import {z} from 'zod';
import {toolOutcome} from '../src/outcomes.js';

describe('whole-bot incident boundaries retain the actual cause and effect uncertainty',()=>{
 let db:TestDB,h:ReturnType<typeof harness>,c:ToolContext;
 before(async()=>{db=new TestDB();await db.init();});
 after(async()=>{await db.close();});
 beforeEach(async()=>{
  await db.reset();await db.query('DELETE FROM diagnostic_incidents');h=harness(db);await paired(h);
  const update=message('Люмен, перевір прохання.');await h.lumen.receive(update);
  const source=(await one(db,"SELECT id FROM messages WHERE role='user' AND telegram_id=$1",[update.message!.message_id]))!;
  await db.query('DELETE FROM inbox');await db.query('DELETE FROM outbox');
  c={actorId:'11',chatId:'-100',topicId:'0',revision:0,sourceId:Number(source.id),updateId:String(update.update_id),requested:true,audience:'group'};
 });
 it('records a rejected tool contract once with a reusable trusted receipt and no argument leakage',async()=>{
  const tools=new AgentTools(db,h.config,h.brain);let failure:unknown;
  try{await tools.execute('unknown.private_tool',{secret:'do-not-store-this'},c);}catch(error){failure=error;}
  assert.ok(failure instanceof ToolError);assert.equal(failure.code,'unknown_tool');
  const incident=incidentForError(failure,{...c,requestId:c.updateId,operation:'unknown.private_tool',operationKey:argumentHash('unknown.private_tool',{secret:'do-not-store-this'}),stage:'tool',attemptKey:`tool:${c.actorId}:${c.updateId}:unknown.private_tool`});assert.ok(incident&&validIncidentCode(incident.code));
  const stored=(await one(db,'SELECT * FROM diagnostic_incidents WHERE code=$1',[incident.code]))!;
  assert.equal(stored.reason_code,'unknown_tool');assert.equal(stored.source_message_id,c.sourceId);assert.doesNotMatch(JSON.stringify(stored),/do-not-store-this/);
  assert.match(incident.message,/немає в поточному каталозі/u);
 });
 it('publishes a terminal background model failure with the same durable code and factual cause',async()=>{
  const id=randomUUID();await db.query("INSERT INTO agent_tasks(id,dedup_key,actor_id,topic_id,title,goal,revision,source_message_id,audience) VALUES($1,$2,'11','0','Перевірка','Перевірити стан',0,$3,'group')",[id,id,c.sourceId]);
  h.brain.block=async()=>{throw new ModelError('model_network');};
  assert.equal(await new AgentTasks(db,h.config,h.brain).next(),true);
  const task=(await one(db,'SELECT status,result,error_code FROM agent_tasks WHERE id=$1',[id]))!;
  assert.equal(task.status,'failed');assert.equal(task.error_code,'model_network');assert.match(task.result,/З’єднання з сервісом моделі/u);
  const record=(await one(db,'SELECT code,reason_code FROM diagnostic_incidents WHERE task_id=$1',[id]))!;
  assert.ok(validIncidentCode(record.code));assert.match(task.result,new RegExp(record.code));
  assert.ok((await db.query("SELECT body FROM outbox WHERE body->>'text' LIKE $1",['%'+record.code+'%'])).rows.length);
 });
 it('a reused singleton Error cannot borrow a previous actor, source, update or namespace receipt',async()=>{
  const shared=new ToolError('invalid_tool_arguments'),tools=new AgentTools(db,h.config,h.brain);
  tools.preflight=()=>{throw shared;};
  const fail=async(instance:AgentTools,context:ToolContext,args:unknown={})=>{let error:unknown;try{await instance.execute('tools.list',args,context);}catch(failure){error=failure;}const receipt=incidentForError(error,{...context,requestId:context.updateId,operation:'tools.list',operationKey:argumentHash('tools.list',args),stage:'tool',attemptKey:`tool:${context.actorId}:${context.updateId}:tools.list`});assert.ok(receipt);return receipt.code;};
  const first=await fail(tools,c),otherActor=await fail(tools,{...c,actorId:'22',updateId:'other-actor'}),otherSource=await fail(tools,{...c,sourceId:undefined,updateId:'other-source'}),otherUpdate=await fail(tools,{...c,updateId:'other-update'}),otherArguments=await fail(tools,c,{limit:2});
  const other=new TestDB();await other.init();try{
   await other.query("UPDATE app_state SET chat_id='-200',owner_id='11' WHERE id=1");
   await other.query("INSERT INTO messages(id,user_id,author,role,body,topic_id) VALUES($1,'11','Автор','user','Окремий запит','0')",[c.sourceId]);
   const isolated=new AgentTools(other,h.config,h.brain);isolated.preflight=()=>{throw shared;};
   const otherNamespace=await fail(isolated,{...c,chatId:'-200'});assert.equal(new Set([first,otherActor,otherSource,otherUpdate,otherArguments,otherNamespace]).size,6);
  }finally{await other.close();}
 });
 it('normalizes a persisted pg string source before a current-source list mutation and rejects unsafe IDs',async()=>{
  const body='Люмен, додай у список покупок молоко.',update=message(body);await h.lumen.receive(update);
  const source=(await one(db,"SELECT id FROM messages WHERE role='user' AND telegram_id=$1",[update.message!.message_id]))!;
  const tools=new AgentTools(db,h.config,h.brain),context={...c,sourceId:String(source.id) as any,requestText:body,updateId:'retained-composition'};
  const result=await tools.execute('lists.manage',{operation:'add',category:'shopping',text:'молоко',quote:'додай у список покупок молоко'},context);
  assert.equal(result.operation,'add');assert.ok(result.added?.includes('молоко'));
  await assert.rejects(()=>tools.execute('lists.manage',{operation:'add',category:'shopping',text:'пшоно'},{...context,sourceId:'9007199254740993' as any}),error=>error instanceof ToolError&&error.code==='request_source_invalid');
 });
 it('adds a trusted receipt to returned local failures and rebuilds it after a cached result reload',async()=>{
  const tools=new AgentTools(db,h.config,h.brain);
  (tools as any).definitions.set('qa.failure',{description:'Local failure',schema:z.object({}),run:async()=>({status:'failed',error:'http_timeout'})});
  const first=await tools.execute('qa.failure',{},c),code=incidentForResult(first)!.code;
  assert.equal(toolOutcome('qa.failure',first).incidentCode,code);
  const restored=await new AgentTools(db,h.config,h.brain);
  (restored as any).definitions.set('qa.failure',{description:'Local failure',schema:z.object({}),run:async()=>assert.fail('successful tool receipt must replay')});
  const second=await restored.execute('qa.failure',{},c);
  assert.equal(incidentForResult(second)!.code,code);assert.match(toolOutcome('qa.failure',second).failureMessage!,/не відповів у відведений час/u);
 });
 it('a large history listing with failed records remains a successful read without new incidents',async()=>{
  const tools=new AgentTools(db,h.config,h.brain),rows=Array.from({length:1500},()=>({status:'failed',error:'http_timeout'}));
  (tools as any).definitions.set('qa.history',{description:'Failed history',schema:z.object({}),run:async()=>rows});
  const before=JSON.stringify(rows),result=await tools.execute('qa.history',{},c);
  assert.equal(result,rows);assert.equal(JSON.stringify(result),before);assert.equal(incidentForResult(result),undefined);
  assert.equal(Number((await one(db,"SELECT count(*) n FROM diagnostic_incidents WHERE operation='qa.history'"))!.n),0);
 });
 it('an explicit failed batch aggregate produces one trusted current-action code for all its retained data',async()=>{
  const tools=new AgentTools(db,h.config,h.brain),value={status:'failed',error:'http_timeout',items:Array.from({length:1500},()=>({status:'failed'}))};
  (tools as any).definitions.set('qa.batch',{description:'Failed batch',schema:z.object({}),run:async()=>value});
  const before=JSON.stringify(value),result=await tools.execute('qa.batch',{},c);
  assert.equal(JSON.stringify(result),before);assert.notEqual(result,value);assert.equal(incidentForResult(value),undefined);
  assert.ok(validIncidentCode(incidentForResult(result)!.code));assert.equal(toolOutcome('qa.batch',result).incidentCode,incidentForResult(result)!.code);
  assert.equal(Number((await one(db,"SELECT count(*) n FROM diagnostic_incidents WHERE operation='qa.batch'"))!.n),1);
 });
 it('a task reopened after a nonresource tool failure publishes its persisted cause and an incident code',async()=>{
  const id=randomUUID();await db.query("INSERT INTO agent_tasks(id,dedup_key,actor_id,topic_id,title,goal,revision,source_message_id,audience) VALUES($1,$2,'11','0','Перевірка','Перевірити стан',0,$3,'group')",[id,id,c.sourceId]);
  const worker=new AgentTasks(db,h.config,h.brain);
  (worker.tools as any).definitions.set('qa.failure',{description:'Local failure',schema:z.object({}),run:async()=>{throw new ToolError('http_timeout');}});
  h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'qa.failure',arguments:'{}'}]});await worker.next();
  await db.query('UPDATE agent_tasks SET available_at=now() WHERE id=$1',[id]);
  h.brain.replies.push({reply:'Не вдалося перевірити стан.',actions:[]});await new AgentTasks(db,h.config,h.brain).next();
  const task=(await one(db,'SELECT status,result FROM agent_tasks WHERE id=$1',[id]))!;
  assert.equal(task.status,'needs_input');assert.match(task.result,/не відповів у відведений час/u);assert.match(task.result,/LM-[0-9A-Z]{26}/u);
  assert.ok((await db.query("SELECT tool_run_id FROM diagnostic_incidents WHERE task_id=$1 AND operation='task'",[id])).rows.some(row=>row.tool_run_id));
 });
 it('keeps an uncertain delivery unreplayed while retaining its exact reason and lookup code',async()=>{
  await db.tx(sql=>queueText(sql,'Результат',0,'incident-delivery',false,{actorId:'11',sourceMessageId:c.sourceId}));
  h.tg.failure=new TelegramError('telegram_network',0,true);
  assert.equal(await new Delivery(db,h.tg as unknown as Telegram,h.config).next(),true);
  const row=(await one(db,"SELECT id,status,error_code,body FROM outbox WHERE dedup_key='incident-delivery:0'"))!;
  assert.equal(row.status,'uncertain');assert.equal(row.error_code,'telegram_network');assert.equal(row.body.incidentCode,undefined);
  const record=(await one(db,'SELECT code,effect_state FROM diagnostic_incidents WHERE outbox_id=$1',[row.id]))!;
  assert.ok(validIncidentCode(record.code));assert.equal(record.effect_state,'uncertain');
  assert.equal(await new Delivery(db,h.tg as unknown as Telegram,h.config).next(),false);
 });
 it('reports image setup failure precisely without suggesting an unproven prompt retry',async()=>{
  const job=(await one(db,"INSERT INTO image_jobs(dedup_key,prompt,author_id,author_name,revision,source_message_id) VALUES('incident-image','Зображення','11','Автор',0,$1) RETURNING id",[c.sourceId]))!;
  const media={image:async()=>{throw new ModelError('image_not_configured');}} as unknown as Media;
  assert.equal(await new ImageJobs(db,h.config,h.tg as unknown as Telegram,{} as VisualMemory,media).next(),true);
  const failed=(await one(db,'SELECT status,error_code FROM image_jobs WHERE id=$1',[job.id]))!;
  assert.equal(failed.status,'failed');assert.equal(failed.error_code,'image_not_configured');
  const record=(await one(db,"SELECT code FROM diagnostic_incidents WHERE operation='image'"))!;
  const text=(await one(db,"SELECT body->>'text' AS text FROM outbox WHERE dedup_key=$1",['image-failed:'+job.id+':0']))!.text;
  assert.match(text,new RegExp(record.code));assert.match(text,/не підключено/iu);assert.doesNotMatch(text,/уточнити задум/u);
 });
 it('retains the website timeout instead of replacing five failures with a guessed access cause',async()=>{
  const id=randomUUID();await db.query("INSERT INTO web_monitors(id,actor_id,topic_id,url,label,expires_at,revision,source_message_id) VALUES($1,'11','0','https://example.com/','Перевірка',now()+interval '1 day',0,$2)",[id,c.sourceId]);
  const monitors=new WebMonitors(db,h.config,async()=>{throw new ToolError('http_timeout');});
  for(let n=0;n<5;n++){await db.query('UPDATE web_monitors SET next_check_at=now() WHERE id=$1',[id]);assert.equal(await monitors.next(),true);}
  const row=(await one(db,'SELECT status,error_code,failures FROM web_monitors WHERE id=$1',[id]))!;
  assert.equal(row.status,'needs_input');assert.equal(row.error_code,'http_timeout');assert.equal(row.failures,5);
  const notice=(await one(db,"SELECT body->>'text' AS text FROM outbox WHERE dedup_key=$1",['watch-failed:'+id+':0']))!.text;
  assert.match(notice,/не відповів у відведений час/u);assert.match(notice,/LM-[0-9A-Z]{26}/);assert.doesNotMatch(notice,/може вимагати вхід/u);
  assert.equal(Number((await one(db,"SELECT count(*) n FROM diagnostic_incidents WHERE operation='monitor'"))!.n),5);
 });
});
