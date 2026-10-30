import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TestDB,harness,message} from './helpers.js';
import {one,state,forgetPhrase,reviseSource,pauseMemory,eraseAll} from '../src/db.js';
import {recordProvenance,transferProvenance} from '../src/provenance.js';
import {ScheduleSchema,saveSchedule,scheduleContext,dispatchSchedules} from '../src/scheduling.js';
import {AgentTools,approvalSummary,argumentHash,type ToolContext} from '../src/agent-tools.js';
import {SimpleLists,ListCommand,isListAddContinuation} from '../src/simple-lists.js';
import {MediaAssets} from '../src/media-assets.js';
import {Delivery} from '../src/delivery.js';
import {digest} from '../src/evolution-core.js';
import {createCommitment} from '../src/commitments.js';
import {TelegramError} from '../src/telegram.js';
import {captureOriginalRequestContext} from '../src/request-context.js';

let db:TestDB,h:ReturnType<typeof harness>,serial=0;
beforeEach(async()=>{
 db=new TestDB();await db.init();h=harness(db);
 await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',participants='[{\"id\":\"11\"},{\"id\":\"22\"}]',consent='[\"11\",\"22\"]',paused=false WHERE id=1");
 await db.query("INSERT INTO members(user_id,name) VALUES('11','А'),('22','Б')");
});
afterEach(async()=>{await db.close();});
const context=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:String(++serial),requested:true,...extra});
async function source(text:string,uid='11',topic='0'){
 const telegramId=++serial;
 const id=Number((await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,$2,'Автор','user',$3,$4) RETURNING id",[telegramId,uid,text,topic]))!.id);
 // These scenarios declare a real original user message. Capture that fixture
 // explicitly; raw legacy rows do not acquire authority as a side effect.
 const captured=await captureOriginalRequestContext(db,id,{
  message_id:telegramId,date:Math.floor(Date.now()/1000),
  from:{id:Number(uid),first_name:'Автор'},chat:{id:-100,type:'supergroup'},
  text,...(topic!=='0'?{message_thread_id:Number(topic)}:{}),
 },{namespaceChatId:'-100',sourceTopicId:topic});
 assert.ok(captured,'declared original fixture must have valid Telegram request context');
 return id;
}
async function reminder(text:string,sourceId:number,sourceIds:number[]=[],authorization:'explicit'|'ask'='explicit'){
 const m=message(text).message!,a=ScheduleSchema.parse({kind:'schedule',title:'Побутове нагадування',instruction:text,mode:'reminder',due_at:new Date(Date.now()+3600000).toISOString(),timezone:'Europe/Kyiv',authorization,quote:text});
 const answer=await db.tx(sql=>saveSchedule(sql,a,m,sourceId,++serial,0,sourceIds));
 const row=await one(db,'SELECT * FROM scheduled_actions WHERE source_message_id=$1',[sourceId]);return {answer,row:row!};
}
function delivery(){return new Delivery(db,h.tg as any,h.config);}

test('unrelated forget carries only surviving schedule revisions and delivers once with the original time',async()=>{
 const keep=await source('Нагадай випити води'),other=await source('Забудь секретний пароль для тесту'),dependency=await source('Нагадай принести лист');
 const first=await reminder('Нагадай випити води',keep),dependent=await reminder('Нагадай принести лист',dependency,[other]);
 assert.match(first.answer,/Europe\/Kyiv/);assert.doesNotMatch(first.answer,/[a-f0-9]{8}-[a-f0-9-]{27,}|Запис #/);
 assert.equal((await scheduleContext(db,'11','0',0))[0]!.id,dependent.row.id);
 await db.tx(sql=>forgetPhrase(sql,'секретний пароль'));
 const kept=(await one(db,'SELECT * FROM scheduled_actions WHERE id=$1',[first.row.id]))!;
 assert.equal(kept.revision,1);assert.equal(kept.status,'pending');assert.equal(new Date(kept.due_at).getTime(),new Date(first.row.due_at).getTime());
 assert.equal(await one(db,'SELECT id FROM scheduled_actions WHERE id=$1',[dependent.row.id]),undefined);
 await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 second'");
 assert.equal(await dispatchSchedules(db),1);assert.equal(await dispatchSchedules(db),0);
 const d=delivery();assert.equal(await d.next(),true);assert.equal(await d.next(),false);
 assert.equal(h.tg.sent.filter(x=>x.text==='Нагадування: Нагадай випити води').length,1);
 assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[kept.id]))!.status,'completed');
});

test('source edits preserve independent reminders and erase the reminder derived from the edited request',async()=>{
 const keep=await source('Нагадай подзвонити'),edit=await source('Старий незалежний текст');
 const saved=await reminder('Нагадай подзвонити',keep);
 await db.tx(sql=>reviseSource(sql,edit,'Оновлений незалежний текст'));
 assert.equal((await one(db,'SELECT revision FROM scheduled_actions WHERE id=$1',[saved.row.id]))!.revision,1);
 await db.tx(sql=>reviseSource(sql,keep,'Нагадування відкликано'));
 assert.equal(await one(db,'SELECT id FROM scheduled_actions WHERE id=$1',[saved.row.id]),undefined);
 assert.equal(await dispatchSchedules(db),0);assert.equal(await delivery().next(),false);
});

for(const mode of ['reminder','task'] as const)test(`forget after schedule conversion erases the dependent ${mode} output`,async()=>{
 const request=await source('Нагадай про погоджений план'),dependency=await source('Секретна деталь погодженого плану');
 const saved=await reminder('Нагадай про погоджений план',request,[dependency]);
 await db.query("UPDATE scheduled_actions SET mode=$1,due_at=now()-interval '1 second' WHERE id=$2",[mode,saved.row.id]);
 assert.equal(await dispatchSchedules(db),1);
 if(mode==='reminder')assert.equal(Number((await one(db,'SELECT count(*) n FROM outbox'))!.n),1);
 else assert.equal(Number((await one(db,'SELECT count(*) n FROM agent_tasks'))!.n),1);
 await db.tx(sql=>forgetPhrase(sql,'Секретна деталь'));
 assert.equal((await db.query('SELECT id FROM scheduled_actions')).rows.length,0);
 assert.equal((await db.query('SELECT id FROM outbox')).rows.length,0);
 assert.equal((await db.query('SELECT id FROM agent_tasks')).rows.length,0);
 assert.equal(await delivery().next(),false);assert.equal(h.tg.sent.length,0);
});

test('pause and revoked consent prevent dispatch; a later forget does not revive paused or cancelled schedules',async()=>{
 const id=await source('Нагадай полити квіти'),unrelated=await source('Непов’язаний фрагмент до стирання');
 const saved=await reminder('Нагадай полити квіти',id);
 await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 second'");
 await db.query("UPDATE app_state SET consent='[\"11\"]'");assert.equal(await dispatchSchedules(db),0);
 await db.tx(pauseMemory);await db.tx(sql=>forgetPhrase(sql,'Непов’язаний фрагмент'));
 await db.query("UPDATE app_state SET paused=false,consent='[\"11\",\"22\"]'");
 assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[saved.row.id]))!.status,'paused');
 assert.equal(await dispatchSchedules(db),0);assert.equal((await db.query('SELECT id FROM outbox')).rows.length,0);
 // Cancellation is another terminal choice; revision carry-forward cannot change it.
 await db.query("UPDATE scheduled_actions SET status='cancelled' WHERE id=$1",[saved.row.id]);
 const another=await source('Ще один незалежний запис');await db.tx(sql=>reviseSource(sql,another,'Нова редакція'));
 assert.equal((await one(db,'SELECT status FROM scheduled_actions WHERE id=$1',[saved.row.id]))!.status,'cancelled');assert.equal(await dispatchSchedules(db),0);
 assert.ok(unrelated>0);
});

test('lists.manage refreshes the same read audit row after changes and rechecks membership on replay',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),lists=new SimpleLists(db),add=await source('Додай молоко до покупок'),read=context();
 await tools.execute('lists.manage',{operation:'add',category:'shopping',text:'молоко'},context({sourceId:add}));
 assert.equal((await tools.execute('lists.manage',{operation:'list',category:'shopping'},read)).items.length,1);
 const next=await source('Додай хліб до покупок');await lists.run(ListCommand.parse({operation:'add',category:'shopping',text:'хліб'}),context({sourceId:next}));
 assert.equal((await tools.execute('lists.manage',{operation:'list',category:'shopping'},read)).items.length,2);
 assert.equal(Number((await one(db,"SELECT count(*) n FROM tool_runs WHERE tool='lists.manage' AND arguments->>'operation'='list'"))!.n),1);
 await db.query("UPDATE members SET active=false WHERE user_id='11'");
 await assert.rejects(tools.execute('lists.manage',{operation:'list',category:'shopping'},read),/member_required/);
});

test('list mutation replay uses its receipt once and cannot serve a private cached result in the group',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),id=await source('Додай особисті ліки до покупок'),c=context({sourceId:id,audience:'private'});
 const args={operation:'add',category:'shopping',text:'особисті ліки'},first=await tools.execute('lists.manage',args,c),again=await tools.execute('lists.manage',args,c);
 assert.deepEqual(again,first);assert.equal(Number((await one(db,'SELECT count(*) n FROM simple_list_events'))!.n),1);
 await db.query("UPDATE tool_runs SET status='uncertain',result=NULL,error_code='restart_during_tool' WHERE tool='lists.manage'");
 assert.deepEqual(await new AgentTools(db,h.config,h.brain).execute('lists.manage',args,c),first);
 assert.equal(Number((await one(db,'SELECT count(*) n FROM simple_list_events'))!.n),1);
 assert.equal(Number((await one(db,"SELECT count(*) n FROM domain_commands WHERE domain='lists'"))!.n),1);
 const read=context({audience:'private'}),readArgs={operation:'list',category:'shopping'};
 assert.equal((await tools.execute('lists.manage',readArgs,read)).items[0].text,'особисті ліки');
 assert.deepEqual((await tools.execute('lists.manage',readArgs,{...read,audience:'group'})).items,[]);
 assert.deepEqual((await tools.execute('lists.manage',readArgs,{...read,actorId:'22',audience:'private'})).items,[]);
 await db.tx(sql=>forgetPhrase(sql,'особисті ліки'));
 assert.equal((await tools.execute('lists.manage',readArgs,{...read,revision:1})).items.length,0);
 assert.equal(Number((await one(db,'SELECT count(*) n FROM simple_list_events'))!.n),0);
 const fresh=await source('Додай яблука до покупок');await tools.execute('lists.manage',{operation:'add',category:'shopping',text:'яблука'},context({sourceId:fresh,revision:1}));
 await db.tx(eraseAll);assert.equal(Number((await one(db,'SELECT count(*) n FROM simple_list_events'))!.n),0);
});

test('forgetting a list completion restores the surviving add and invalidates prior tool results',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),add=await source('Додай чай до покупок');
 await tools.execute('lists.manage',{operation:'add',category:'shopping',text:'чай'},context({sourceId:add}));
 const done=await source('Познач чай зробленим');await tools.execute('lists.manage',{operation:'complete',category:'shopping',text:'чай'},context({sourceId:done}));
 await db.tx(sql=>forgetPhrase(sql,'Познач чай зробленим'));
 const result=await tools.execute('lists.manage',{operation:'list',category:'shopping'},context({revision:1}));assert.equal(result.items[0].status,'open');assert.deepEqual(result.items[0].source_ids,[add]);
});

test('surviving list admission continues across unrelated forget and stops when its add source is erased',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),unrelated=await source('Зайвий фрагмент для forget'),add=await source('Додай молоко до покупок');
 await tools.execute('lists.manage',{operation:'add',category:'shopping',text:'молоко'},context({sourceId:add}));
 await db.tx(sql=>forgetPhrase(sql,'Зайвий фрагмент'));
 assert.equal((await one(db,'SELECT revision FROM simple_list_events'))!.revision,1);
 const follow=await source('Ще сир'),c=context({sourceId:follow,requestText:'Ще сир',revision:1});
 assert.equal(await isListAddContinuation(db,c,'shopping'),true);
 await db.tx(sql=>forgetPhrase(sql,'Додай молоко до покупок'));
 assert.equal(await isListAddContinuation(db,{...c,revision:2},'shopping'),false);assert.ok(unrelated>0);
});

test('forget after a pause does not restore implicit list admission from before that pause',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),unrelated=await source('Незалежне старе повідомлення'),add=await source('Додай молоко до покупок');
 await tools.execute('lists.manage',{operation:'add',category:'shopping',text:'молоко'},context({sourceId:add}));
 await db.tx(pauseMemory);await db.tx(sql=>forgetPhrase(sql,'Незалежне старе повідомлення'));
 await db.query("UPDATE app_state SET paused=false,consent='[\"11\",\"22\"]'");
 const follow=await source('Ще сир');assert.equal(await isListAddContinuation(db,context({sourceId:follow,revision:2}),'shopping'),false);assert.ok(unrelated>0);
});

async function readyMedia(options:{private?:boolean;task?:boolean;action?:boolean;topic?:string}={}){
 const topic=options.topic||'0',audience=options.private?'private':'group',src=await source('Зроби відео з наданою музикою','11',topic),c=context({sourceId:src,topicId:topic,audience});
 const assets=new MediaAssets(db,h.config,h.tg as any),input=await assets.store(Buffer.from('fixture image bytes'),'image/png','Фото',c),track=await assets.store(Buffer.from('fixture audio bytes'),'audio/wav','Музика',c),output=await assets.store(Buffer.from('fixture encoded video bytes'),'video/mp4','Спогади',c);
 const resource=randomUUID(),job=randomUUID(),publication=randomUUID(),task=options.task?randomUUID():null;
 const action=options.action?await db.tx(sql=>createCommitment(sql,{actorId:'11',topicId:topic,revision:0,sourceId:src,kind:'media',spec:{goal:'Відео'},expectedResult:'delivery_confirmed',phase:'delivering'})):null;
 await db.query('INSERT INTO studio_projects(id,owner_id,title,audience,source_message_id,topic_id) VALUES($1,\'11\',\'Спогади\',$2,$3,$4)',[resource,audience,src,topic]);
 if(task)await db.query("INSERT INTO agent_tasks(id,dedup_key,actor_id,topic_id,title,goal,status,revision,source_message_id,goal_version,audience) VALUES($1,$2,'11',$3,'Відео','Зроби відео','verifying',0,$4,1,$5)",[task,'fixture:'+task,topic,src,audience]);
 const manifest={kind:'story',resource_id:resource,version:1,title:'Спогади',preview:false,audience,items:[{asset_id:input.id,asset_version:1}],soundtrack:{asset_id:track.id,asset_version:1},require_audio:true};
 const verification={expected_duration:2,video:{codec:'h264',duration:2,decoded:true},audio:{codec:'aac',duration:2,decoded:true,non_silent:true,max_db:-4,mean_db:-18},has_soundtrack:true};
 await db.query("INSERT INTO media_jobs(id,kind,resource_id,resource_version,manifest,manifest_hash,status,stage,actor_id,topic_id,audience,revision,source_message_id,output_id,verification,task_id,goal_version,action_id) VALUES($1,'story',$2,1,$3,$4,'ready','verified','11',$5,$6,0,$7,$8,$9,$10,$11,$12)",[job,resource,JSON.stringify(manifest),digest(manifest),topic,audience,src,output.id,JSON.stringify(verification),task,task?1:null,action?.id||null]);
 for(const asset of [input,track])await db.query('INSERT INTO media_job_inputs(job_id,asset_id,asset_version) VALUES($1,$2,1)',[job,asset.id]);
 await recordProvenance(db,'media_job',job,[src]);
 const publicationManifest={id:output.id,version:1,sha256:output.sha256,caption:'Готово: «Спогади» з наданою музикою.',audience};
 await db.query('INSERT INTO media_publications(id,asset_id,actor_id,manifest) VALUES($1,$2,\'11\',$3)',[publication,output.id,JSON.stringify(publicationManifest)]);
 const out=(await one(db,"INSERT INTO outbox(dedup_key,kind,body,revision,actor_id,audience,source_message_id) VALUES($1,'media_asset',$2,0,'11',$3,$4) RETURNING id",['render-delivery:'+job,JSON.stringify({...publicationManifest,publicationId:publication,mediaJobId:job,threadId:topic==='0'?undefined:Number(topic),taskId:task||undefined,goalVersion:task?1:undefined,actionId:action?.id}),audience,src]))!;
 await transferProvenance(db,'media_job',job,'outbox',out.id);
 return {src,input,track,output,resource,job,publication,outboxId:Number(out.id),task,action};
}

test('verified media output delivers once with the ready caption and a receipt from the acknowledged send',async()=>{
 const fixture=await readyMedia({task:true,action:true,topic:'7'}),d=delivery();
 assert.equal(await d.next(),true);assert.equal(await d.next(),false);assert.equal(h.tg.sent.length,1);assert.match(h.tg.sent[0]!.text,/Готово:.*з наданою музикою/);
 const sent=(await one(db,'SELECT * FROM outbox WHERE id=$1',[fixture.outboxId]))!,publication=(await one(db,'SELECT * FROM media_publications WHERE id=$1',[fixture.publication]))!;
 assert.equal(sent.status,'sent');assert.equal(sent.body.deliveryReceipt.destination_chat_id,'-100');assert.equal(publication.status,'delivered');assert.equal(publication.receipts[0].message_ids[0],sent.telegram_id);
 assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[fixture.action!.id]))!.phase,'completed');
});

test('media delivery rechecks changed inputs after reading bytes and keeps private-source failure notices private',async()=>{
 const fixture=await readyMedia(),original=MediaAssets.prototype.bytes;
 MediaAssets.prototype.bytes=async function(...args:Parameters<MediaAssets['bytes']>){const result=await original.apply(this,args);await db.query("UPDATE media_assets SET audience='private',version=version+1 WHERE id=$1",[fixture.track.id]);return result;};
 try{await delivery().next();}finally{MediaAssets.prototype.bytes=original;}
 assert.equal(h.tg.sent.length,0);const out=(await one(db,'SELECT * FROM outbox WHERE id=$1',[fixture.outboxId]))!;assert.equal(out.status,'failed');assert.equal(out.error_code,'media_delivery_source_changed');
 const notice=(await one(db,"SELECT * FROM outbox WHERE dedup_key LIKE 'media-delivery-error:%'"))!;assert.equal(notice.audience,'private');assert.match(notice.body.text,/вихідних матеріалів/);
 await delivery().next();assert.equal(h.tg.sent[0]!.chatId,'11');
});

for(const change of ['resource','output','verification'] as const)test(`stale media ${change} is rejected before any upload`,async()=>{
  const fixture=await readyMedia();
  if(change==='resource')await db.query('UPDATE studio_projects SET version=2 WHERE id=$1',[fixture.resource]);
  if(change==='output')await db.query('UPDATE media_jobs SET output_id=$1 WHERE id=$2',[fixture.input.id,fixture.job]);
  if(change==='verification')await db.query("UPDATE media_jobs SET verification=verification||'{\"audio\":null}'::jsonb WHERE id=$1",[fixture.job]);
  await delivery().next('media');assert.equal(h.tg.sent.length,0);
  assert.equal((await one(db,'SELECT status FROM outbox WHERE id=$1',[fixture.outboxId]))!.status,'failed');
  await db.query("DELETE FROM outbox WHERE kind='text'");
});

test('changed task goals cannot publish an old ready media result',async()=>{
 const goal=await readyMedia({task:true});await db.query('UPDATE agent_tasks SET goal_version=2 WHERE id=$1',[goal.task]);await delivery().next();assert.equal(h.tg.sent.length,0);
 assert.equal((await one(db,'SELECT status FROM media_publications WHERE id=$1',[goal.publication]))!.status,'revoked');
 assert.equal((await one(db,'SELECT receipts FROM media_publications WHERE id=$1',[goal.publication]))!.receipts.length,0);
});

test('media job cannot claim an unrelated action and cancellation during a bytes read prevents upload',async()=>{
 const fixture=await readyMedia({action:true}),other=await db.tx(sql=>createCommitment(sql,{actorId:'22',topicId:'0',revision:0,kind:'media',spec:{goal:'Інше відео'},expectedResult:'delivery_confirmed',phase:'delivering'}));
 await db.query("UPDATE outbox SET body=jsonb_set(body,'{actionId}',to_jsonb($1::text)) WHERE id=$2",[other.id,fixture.outboxId]);
 await delivery().next();assert.equal(h.tg.sent.length,0);assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[other.id]))!.phase,'delivering');assert.equal(Number((await one(db,'SELECT count(*) n FROM effect_operations WHERE action_id=$1',[other.id]))!.n),0);
 const cancelled=await readyMedia({action:true}),original=MediaAssets.prototype.bytes;
 MediaAssets.prototype.bytes=async function(...args:Parameters<MediaAssets['bytes']>){const result=await original.apply(this,args);await db.query("UPDATE commitments SET phase='cancelled' WHERE id=$1",[cancelled.action!.id]);return result;};
 try{await delivery().next();}finally{MediaAssets.prototype.bytes=original;}
 assert.equal(h.tg.sent.length,0);assert.equal((await one(db,'SELECT status FROM outbox WHERE id=$1',[cancelled.outboxId]))!.status,'cleared');
});

test('paused memory cannot publish an old ready media result',async()=>{
 await readyMedia();await db.tx(pauseMemory);assert.equal(await delivery().next(),false);assert.equal(h.tg.sent.length,0);
 assert.ok((await state(db)).memory_revision>0);
});

test('forgotten sources cannot publish an old ready media result',async()=>{
 const forgotten=await readyMedia();await db.tx(sql=>forgetPhrase(sql,'Зроби відео з наданою музикою'));
 assert.equal(await delivery().next(),false);assert.equal(h.tg.sent.length,0);assert.equal(await one(db,'SELECT id FROM media_jobs WHERE id=$1',[forgotten.job]),undefined);
});

test('uncertain media delivery retains uncertainty, explains the next step, and never uploads again',async()=>{
 const fixture=await readyMedia({private:true}),d=delivery();let uploads=0;const upload=h.tg.upload.bind(h.tg);
 h.tg.upload=async(...args:Parameters<typeof upload>)=>{uploads++;return upload(...args);};h.tg.failure=new TelegramError('telegram_network',0,true);
 await d.next();h.tg.failure=undefined;const out=(await one(db,'SELECT * FROM outbox WHERE id=$1',[fixture.outboxId]))!;
 assert.equal(out.status,'uncertain');assert.equal(out.body.deliveryReceipt,undefined);assert.equal((await one(db,'SELECT status FROM media_publications WHERE id=$1',[fixture.publication]))!.status,'uncertain');
 await d.next();assert.match(h.tg.sent[0]!.text,/Можливо, він уже надійшов/);assert.match(h.tg.sent[0]!.text,/автоматично не надсилаю повторно/);assert.equal(h.tg.sent[0]!.chatId,'11');assert.equal(await delivery().next(),false);assert.equal(uploads,1);
});

test('rejected preflight leaves bounded failure lineage without raw arguments or unauthorized records',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),src=await source('Перевір сторінку'),c=context({sourceId:src}),secret='super-secret-token-value';
 await assert.rejects(tools.execute('web.read',{url:secret},c),/invalid_tool_arguments/);await assert.rejects(tools.execute('web.read',{url:secret},c),/invalid_tool_arguments/);
 await assert.rejects(tools.execute('unknown.external',{token:secret},context({sourceId:src})),/unknown_tool/);
 const runs=(await db.query('SELECT * FROM tool_runs ORDER BY id')).rows;assert.equal(runs.length,2);assert.equal(runs[0]!.status,'failed');assert.equal(runs[0]!.error_code,'invalid_tool_arguments');assert.equal(runs[0]!.source_message_id,src);assert.doesNotMatch(JSON.stringify(runs),new RegExp(secret));
 assert.match(runs[0]!.arguments.arguments_sha256,/^[a-f0-9]{64}$/);assert.ok(JSON.stringify(runs[0]!.arguments).length<250);
 await assert.rejects(tools.execute('web.read',{url:secret},context({actorId:'22',sourceId:src})),/invalid_tool_arguments/);
 await assert.rejects(tools.execute('web.read',{url:secret},context({sourceId:src,revision:999})),/invalid_tool_arguments/);
 assert.equal(Number((await one(db,'SELECT count(*) n FROM tool_runs'))!.n),2);assert.equal((await db.query('SELECT id FROM outbox')).rows.length,0);
 await assert.rejects(tools.execute('web.read',{url:'https://example.org'},context({sourceId:src,requested:false})),/tool_not_requested/);
 assert.equal((await one(db,"SELECT error_code FROM tool_runs WHERE error_code='tool_not_requested'"))!.error_code,'tool_not_requested');
});

test('approval text preserves every material value, including long connector arguments, without raw internal tool JSON',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),src=await source('Підготуй замовлення'),long='x'.repeat(1700)+'КІНЕЦЬ',args={connection:'store',tool:'order.create',arguments:JSON.stringify({items:[{title:'Чай',quantity:0}],comment:long,deliver:false,optional:null,empty:''}),share_result:false};
 const result=await tools.execute('connector.call',args,context({sourceId:src}));assert.equal(result.needs_approval,true);
 const approval=(await one(db,'SELECT * FROM tool_approvals WHERE id=$1',[result.approval_id]))!;
 assert.equal(approval.audience,'private');assert.equal(approval.argument_hash,argumentHash('connector.call',args));assert.match(approval.summary,/Виконати дію у твоєму підключенні/);assert.doesNotMatch(approval.summary,/connector\.call|\{"items"/);assert.ok(approval.summary.includes(long));assert.match(approval.summary,/quantity: 0/);assert.match(approval.summary,/deliver: ні/);assert.match(approval.summary,/optional: null \(порожнє значення\)/);assert.match(approval.summary,/empty: «»/);assert.match(approval.summary,/отримаєш особисто/);
 const browser=approvalSummary('browser.commit',{id:0,url:'https://example.org/order',summary:'Замовити чай за 10 грн',expected_fingerprint:'a'.repeat(64)},'');assert.ok(browser.includes('10 грн'));assert.ok(browser.includes('https://example.org/order'));assert.ok(browser.includes('a'.repeat(64)));
});

test('personal calendar approval is sent only to its owner even when the request starts in a group',async()=>{
 const tools=new AgentTools(db,h.config,h.brain),src=await source('Підготуй подію'),args={operation:'create',title:'Особиста подія',start:new Date(Date.now()+3600000).toISOString(),end:new Date(Date.now()+7200000).toISOString(),description:'Особисті подробиці'};
 const result=await tools.execute('calendar.write',args,context({sourceId:src}));assert.equal(result.needs_approval,true);assert.equal(result.approval_channel,'private');assert.match(result.private_approval_url,/start=approve_/);
 const rows=(await db.query('SELECT audience,actor_id,body FROM outbox')).rows;assert.ok(rows.length>0);assert.ok(rows.every(row=>row.audience==='private'&&row.actor_id==='11'));assert.ok(rows.some(row=>row.body.text.includes('Особисті подробиці')));
});
