import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {TestDB,harness,paired} from './helpers.js';
import {one,forgetPhrase} from '../src/db.js';
import {Learning,LearningCommand,rebuildLearning} from '../src/learning.js';
import {MediaWorkshop,CollectionCommand,StudioCommand} from '../src/media-workshop.js';
import {AssetCommand} from '../src/media-assets.js';
import {BrowseQuery} from '../src/media-assets.js';
import {MediaBrowser} from '../src/media-browser.js';
import {Delivery} from '../src/delivery.js';
import {gateOutcome,toolOutcome} from '../src/outcomes.js';
import {evidenceCheckedResearch,verifyTask} from '../src/result-verifier.js';
import {Recurring,SeriesCommand} from '../src/recurring.js';
import {currentStyleCue} from '../src/behavior-engine.js';
import {AgentTools} from '../src/agent-tools.js';
import type {ToolContext} from '../src/agent-tools.js';
let db:TestDB,h:ReturnType<typeof harness>,n=90000;
const c=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:String(++n),requested:true,...extra});
before(async()=>{db=new TestDB();await db.init();});after(async()=>db.close());
beforeEach(async()=>{await db.reset();for(const table of ['domain_commands','learning_goals','recurring_series','media_assets','archive_collections','studio_projects'])await db.query(`DELETE FROM ${table}`);h=harness(db);await paired(h);});
async function source(body:string){return Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES($1,'11','A','user',$2) RETURNING id",[++n,body])).rows[0]!.id);}
test('new question key correction preserves old question grades and rebases an open attempt only in its lineage',async()=>{
 const l=new Learning(db,h.brain),run=(a:any)=>l.run(LearningCommand.parse(a),c({audience:'private'}));
 const g=await run({operation:'create',title:'Математика'}),first=await run({operation:'add_exercise',id:g.id,version:1,exercise:{skill:'сума',prompt:'2+2?',type:'number',answer:'4'}}),id=first.exercises[0].id;
 const old=await run({operation:'practice',id:g.id});await run({operation:'answer',id:g.id,attempt_id:old.attempt_id,answer:'4'});
 await run({operation:'revise_exercise',id:g.id,version:2,exercise_id:id,exercise:{skill:'сума',prompt:'2+3?',type:'number',answer:'6'}});
 const current=await run({operation:'practice',id:g.id});await run({operation:'answer',id:g.id,attempt_id:current.attempt_id,answer:'5'});const open=await run({operation:'practice',id:g.id});
 await run({operation:'revise_exercise',id:g.id,version:3,exercise_id:id,change_kind:'key_correction',correction:{answer:'5'}});
 assert.equal(Number((await one(db,'SELECT score FROM learning_attempts WHERE id=$1',[old.attempt_id]))!.score),1);
 assert.equal(Number((await one(db,'SELECT score FROM learning_attempts WHERE id=$1',[current.attempt_id]))!.score),1);
 assert.equal((await run({operation:'answer',id:g.id,attempt_id:open.attempt_id,answer:'5'})).score,1);
});
test('rubric evidence builds mastery and unlocks prerequisites, including legacy rubric grading',async()=>{
 h.brain.text=async()=>JSON.stringify({criteria:[{index:0,earned:2,evidence:'джерело'}],uncertainty:false,feedback:'Є посилання.'});
 const l=new Learning(db,h.brain),run=(a:any)=>l.run(LearningCommand.parse(a),c({audience:'private'}));const g=await run({operation:'create',title:'Аргументація'});
 const plan=await run({operation:'import_plan',id:g.id,version:1,exercises:[{skill:'основа',prompt:'На що спираєшся?',type:'rubric',rubric:[{criterion:'Названо джерело',points:2}]},{skill:'аналіз',prompt:'2+2?',type:'number',answer:'4',prerequisites:['основа']}]});
 const attempt=await run({operation:'practice',id:g.id,exercise_id:plan.exercises[0].id});assert.equal((await run({operation:'answer',id:g.id,attempt_id:attempt.attempt_id,answer:'Моє джерело'})).score,1);
 assert.equal(Number((await one(db,"SELECT mastery FROM learning_progress WHERE goal_id=$1 AND skill='основа'",[g.id]))!.mastery),1);
 assert.equal((await run({operation:'practice',id:g.id,exercise_id:plan.exercises[1].id})).prompt,'2+2?');
 await db.query("UPDATE learning_attempts SET grading=grading-'method' WHERE id=$1",[attempt.attempt_id]);await db.tx(sql=>rebuildLearning(sql,g.id));assert.equal((await db.query('SELECT * FROM learning_progress WHERE goal_id=$1',[g.id])).rows.length,1);
});
test('forgetting original question removes corrected descendants and their attempts',async()=>{
 const l=new Learning(db,h.brain),run=(a:any,sourceId?:number)=>l.run(LearningCommand.parse(a),c({audience:'private',sourceId}));const g=await run({operation:'create',title:'Джерела'}),s=await source('Початкове питання про суму');
 const ex=await run({operation:'add_exercise',id:g.id,version:1,exercise:{skill:'сума',prompt:'2+2?',type:'number',answer:'5'}},s);await run({operation:'revise_exercise',id:g.id,version:2,exercise_id:ex.exercises[0].id,change_kind:'key_correction',correction:{answer:'4'}},await source('Уточнений ключ'));
 await run({operation:'practice',id:g.id});await db.tx(sql=>forgetPhrase(sql,'Початкове питання про суму'));assert.equal((await db.query('SELECT * FROM learning_exercises WHERE goal_id=$1',[g.id])).rows.length,0);assert.equal((await db.query('SELECT * FROM learning_attempts WHERE goal_id=$1',[g.id])).rows.length,0);
});
test('studio and collection reads hide revoked private source metadata; curator can reorder contributions',async()=>{
 const hub=new MediaWorkshop(db,h.config),bytes=await sharp({create:{width:12,height:12,channels:3,background:'#456'}}).png().toBuffer();const hidden=await hub.store(bytes,'image/png','Таємна назва',c({audience:'private'}));const consent=await source('Дозволяю це фото групі');await hub.run(AssetCommand.parse({operation:'allow_group',id:hidden.id,version:1}),c({audience:'private',sourceId:consent}));
 const p=await hub.studio(StudioCommand.parse({operation:'create',title:'Спільна історія'}),c()),col=await hub.collection(CollectionCommand.parse({operation:'create',title:'Наш альбом'}),c());await hub.studio(StudioCommand.parse({operation:'add_scene',id:p.id,version:1,asset_id:hidden.id,asset_version:2}),c());await hub.collection(CollectionCommand.parse({operation:'add',id:col.id,version:1,asset_id:hidden.id,asset_version:2,caption:'Закритий підпис'}),c());
 await db.tx(sql=>forgetPhrase(sql,'Дозволяю це фото групі'));const other=c({actorId:'22',revision:1});assert.deepEqual((await hub.studio(StudioCommand.parse({operation:'read',id:p.id}),other)).scenes,[]);assert.deepEqual((await hub.collection(CollectionCommand.parse({operation:'read',id:col.id}),other)).items,[]);
 const plain=await hub.store(bytes,'image/png','Доступне фото',c({revision:1}));let version=2;for(const caption of ['Перше','Друге'])version=(await hub.collection(CollectionCommand.parse({operation:'add',id:col.id,version,asset_id:plain.id,asset_version:1,caption}),c({revision:1}))).version;
 let items=(await hub.collection(CollectionCommand.parse({operation:'read',id:col.id}),c({revision:1}))).items;const second=items.find((x:any)=>x.caption==='Друге');await assert.rejects(hub.collection(CollectionCommand.parse({operation:'move',id:col.id,version,item_id:second.id,position:0}),c({actorId:'22',revision:1})),/author_or_curator/);await hub.collection(CollectionCommand.parse({operation:'move',id:col.id,version,item_id:second.id,position:0}),c({revision:1}));items=(await hub.collection(CollectionCommand.parse({operation:'read',id:col.id}),c({revision:1}))).items;assert.equal(items[0].caption,'Друге');assert.equal(items.length,2);
});
test('outcome guard covers event, calendar, clip, album and image claims across languages',()=>{
 for(const reply of ['Подію створено.','Ролик надіслано.','Альбом надіслано.','Зображення надіслано.','Событие создано.','Album delivered.','Event created.'])assert.equal(gateOutcome({reply,actions:[]},[]).blocked,true,reply);
 for(const reply of ['Твою подію створено.','Наш альбом надіслано.','Я вже надіслав ролик.','Готово — подію створено.'])assert.equal(gateOutcome({reply,actions:[]},[]).blocked,true,reply);
 for(const reply of ['Він написав: «Подію створено».','Альбом не надіслано.','Я не надіслав ролик.','Якщо подію створено, побачиш її у календарі.','Не можу підтвердити, що альбом надіслано.','Подію створено?'])assert.equal(gateOutcome({reply,actions:[]},[]).blocked,false,reply);
 const fact=toolOutcome('calendar.write',{id:'event1',provider_readback:true,receipt:{uid:'uid1'}});assert.equal(gateOutcome({reply:'Подію створено.',actions:[]},[fact]).blocked,false);
 assert.equal(gateOutcome({reply:'Можемо створити альбом.',actions:[]},[]).blocked,false);
});
test('research verifier rejects URL-only and needs_review results; source discovery stays unverified',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),run=async(tool:string,result:any)=>Number((await db.query("INSERT INTO tool_runs(dedup_key,actor_id,tool,arguments,result,status,revision) VALUES($3,'11',$1,'{}',$2,'succeeded',0) RETURNING id",[tool,JSON.stringify(result),String(++n)])).rows[0]!.id);
 const raw=await run('web.search',{results:[{url:'https://example.org'}]});assert.equal((await tools.execute('result.verify',{run_id:raw},c())).verified,false);
 const review=await run('research.query',{status:'needs_review',sources:[{url:'https://example.org'}],claims:[]});await assert.rejects(tools.execute('result.verify',{run_id:review},c()),/research_evidence_not_checked/);
 const hash='a'.repeat(64),proof={status:'evidence_checked',sources:[{url:'https://example.org',content_sha256:hash}],claims:[{claim:'Факт',kind:'fact',evidence:[{url:'https://example.org',excerpt:'Дослівний уривок',content_sha256:hash,locator:{character_offset:0}}]}]};assert.equal(evidenceCheckedResearch(proof),true);assert.equal(evidenceCheckedResearch({...proof,claims:[{...proof.claims[0],evidence:[{...proof.claims[0]!.evidence[0],content_sha256:'b'.repeat(64)}]}]}),false);
 const verified=await run('research.query',proof);assert.equal((await tools.execute('result.verify',{run_id:verified},c())).verified,true);
});
test('late task occurrences require review and can only be moved to a future run',async()=>{
 const series=new Recurring(db),now=new Date(),start=new Date(now.getTime()-7*86400000).toISOString().slice(0,10);const draft=await series.run(SeriesCommand.parse({operation:'preview',rule:{title:'Оновити звіт',instruction:'Перевір актуальні дані',mode:'task',timezone:'UTC',start_date:start,time:'09:00',frequency:'daily'}}),c());assert.equal(draft.catch_up,'ask');await series.run(SeriesCommand.parse({operation:'confirm',id:draft.id,version:1}),c());await db.query("UPDATE recurring_series SET created_at=now()-interval '7 days' WHERE id=$1",[draft.id]);await series.tick();
 const late=(await db.query("SELECT * FROM recurring_occurrences WHERE series_id=$1 AND status='needs_input'",[draft.id])).rows;assert.equal(late.length,1);assert.ok(late[0]!.coalesced_count>=5);assert.equal((await db.query("SELECT * FROM scheduled_actions WHERE mode='task' AND status='pending' AND due_at<now()-interval '1 hour' ")).rows.length,0);
 await series.run(SeriesCommand.parse({operation:'move',id:draft.id,version:2,occurrence_key:late[0]!.occurrence_key,move_to:new Date(now.getTime()+7200000).toISOString()}),c());await series.tick(Date.now()+31000);assert.equal((await one(db,'SELECT status FROM recurring_occurrences WHERE series_id=$1 AND occurrence_key=$2',[draft.id,late[0]!.occurrence_key]))!.status,'scheduled');
});
test('temporary language, name and formality are scoped cues and quoted instructions do not apply',()=>{
 assert.equal(currentStyleCue('Сьогодні відповідай російською, звертайся на Ви')!.fields.language,'ru');assert.equal(currentStyleCue('Сьогодні називай мене Мишко')!.fields.preferred_name,'Мишко');assert.equal(currentStyleCue('Переклади «Сьогодні відповідай російською»'),undefined);assert.equal(currentStyleCue('Завжди відповідай російською'),undefined);
});
test('a current participant can privately download another author public attachment without taking ownership',async()=>{
 const s=await source('Наш спільний файл'),attachment=await one(db,"INSERT INTO attachments(source_message_id,kind,file_id,mime,description,revision) VALUES($1,'document','known-file','application/pdf','Спільний PDF',0) RETURNING id",[s]);const hub=new MediaWorkshop(db,h.config);(hub.telegram as any).file=async()=>Buffer.from('Original known bytes');const browser=new MediaBrowser(db,hub),view=await browser.open(BrowseQuery.parse({section:'materials'}),c({actorId:'22',audience:'private'}));
 const handled=await browser.callback({id:'download-other',from:{id:22,first_name:'Б'},message:{message_id:500,date:0,chat:{id:22,type:'private'}},data:`lm:${view.view_id}:send_0`},h.tg as any);assert.equal(handled,true);const asset=await one(db,'SELECT owner_id,audience FROM media_assets');assert.equal(asset!.owner_id,'11');assert.equal(asset!.audience,'group');assert.equal((await one(db,"SELECT audience,actor_id FROM outbox WHERE kind='media_asset'"))!.audience,'private');assert.equal(Number(attachment!.id)>0,true);
});
test('a partial Telegram album retains known provider IDs and never retries automatically',async()=>{
 const call=h.tg.call.bind(h.tg);(h.tg as any).call=async(method:string,body:any)=>method==='sendMediaGroup'?[{message_id:951}]:call(method,body);await db.query("INSERT INTO outbox(dedup_key,kind,body,revision,actor_id) VALUES('partial-album','telegram',$1,0,'11')",[JSON.stringify({operation:'send_album',files:[{file_id:'a'},{file_id:'b'}]})]);const delivery=new Delivery(db,h.tg as any,h.config);await delivery.next();const row=await one(db,"SELECT * FROM outbox WHERE dedup_key='partial-album'");assert.equal(row!.status,'uncertain');assert.deepEqual(row!.body.partialDeliveryReceipt.message_ids,[951]);assert.equal(row!.body.deliveryReceipt,undefined);assert.equal(await delivery.next(),false);
});
