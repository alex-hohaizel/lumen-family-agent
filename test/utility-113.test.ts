import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {TestDB,harness,paired,message} from './helpers.js';
import {SimpleLists,ListCommand} from '../src/simple-lists.js';
import {AgentTools,type ToolContext} from '../src/agent-tools.js';
import {eraseAll,forgetPhrase,one,state} from '../src/db.js';
import {recordProvenance,resultSources} from '../src/provenance.js';
import type {Plan} from '../src/model.js';
import {ModelError} from '../src/auth.js';
import {captureOriginalRequestContext} from '../src/request-context.js';

let db:TestDB,lists:SimpleLists,n=113000;
const context=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:String(++n),requested:true,...extra});
const run=(args:any,c=context())=>lists.run(ListCommand.parse({category:'shopping',...args}),c);
async function source(body:string,actor='11',topic='0',native:Record<string,unknown>|false={}){
 const telegramId=++n,id=Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,$2,'Автор','user',$3,$4) RETURNING id",[telegramId,actor,body,topic])).rows[0]!.id);
 if(native!==false){const namespace=String((await state(db)).chat_id);await db.tx(sql=>captureOriginalRequestContext(sql,id,{message_id:telegramId,from:{id:Number(actor)},chat:{id:Number(namespace),type:Number(namespace)>0?'private':'supergroup'},text:body,...(topic!=='0'?{message_thread_id:Number(topic)}:{}),...native},{namespaceChatId:namespace,sourceTopicId:topic}));}
 return id;
}
async function mutate(args:any,body:string,extra:Partial<ToolContext>={}){
 const sourceId=await source(body,extra.actorId||'11',extra.topicId||'0');
 return run(args,context({sourceId,requestText:body,...extra}));
}

before(async()=>{db=new TestDB();await db.init();});
after(async()=>db.close());
beforeEach(async()=>{
 await db.reset();await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');
 await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',memory_revision=0,paused=false WHERE id=1");
 for(const id of ['11','22'])await db.query('INSERT INTO members(user_id,name,active) VALUES($1,$2,true)',[id,'Учасник '+id]);
 lists=new SimpleLists(db);
});

test('a direct unitless batch produces real shopping entries and preserves inventory boundaries',async()=>{
 const body='Люмен, запиши купити молоко й хліб',sourceId=await source(body),c=context({sourceId,requestText:body});
 const result=await run({operation:'add',items:['молоко','хліб','  МОЛОКО  ']},c);
 assert.deepEqual(new Set(result.added),new Set(['молоко','хліб']));
 assert.equal(result.items.length,2);assert.match(result.message,/Додав у покупки:/);
 for(const item of result.items){assert.equal(item.status,'open');assert.equal('quantity' in item,false);assert.equal('unit' in item,false);}
 assert.deepEqual(await new SimpleLists(db).run(ListCommand.parse({operation:'add',category:'shopping',items:['хліб','молоко']}),{...c,updateId:c.updateId+':4',operationKey:'tool:replan-step-changed'}),result);
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,2);
 for(const table of ['stock_items','stock_movements','stock_needs','stock_receipts','project_tasks'])assert.equal((await one(db,`SELECT count(*)::integer AS n FROM ${table}`))!.n,0);
 const repeated=await mutate({operation:'add',text:'молоко'},'Додай молоко до покупок');
 assert.deepEqual(repeated.already_present,['молоко']);assert.equal((await run({operation:'list'})).items.length,2);
 assert.equal(ListCommand.safeParse({operation:'add',category:'shopping',text:'молоко',quantity:1,unit:'piece'}).success,false);
 assert.equal(ListCommand.safeParse({operation:'add',category:'shopping',items:Array(51).fill('рядок')}).success,false);
});

test('a brief additive continuation uses the immediately preceding committed list without adding from unrelated context',async()=>{
 await mutate({operation:'add',text:'молоко'},'Люмен, додай молоко до покупок');
 const continuation=await mutate({operation:'add',text:'сир'},'Ще сир');
 assert.deepEqual(continuation.added,['сир']);
 await source('До речі, як погода?');
 await assert.rejects(mutate({operation:'add',text:'масло'},'Ще масло'),/list_request_unconfirmed/);
 await mutate({operation:'add',text:'яблука'},'Додай яблука до покупок',{actorId:'22'});
 await assert.rejects(mutate({operation:'add',text:'масло'},'Ще масло'),/list_request_unconfirmed/);
 await mutate({operation:'add',text:'хліб'},'Додай хліб до покупок');
 await assert.rejects(mutate({operation:'add',text:'масло'},'Ще масло?'),/list_request_unconfirmed/);
 await mutate({operation:'add',text:'кефір'},'Додай кефір до покупок');
 await assert.rejects(mutate({operation:'add',text:'масло'},'Ще сир'),/list_request_unconfirmed/);
 assert.deepEqual(new Set((await run({operation:'list'})).items.map((item:any)=>item.text)),new Set(['молоко','сир','яблука','хліб','кефір']));
});

test('todo complete/remove uses the actual item and asks one question for ambiguous text',async()=>{
 const first=await mutate({operation:'add',category:'todo',text:'Подзвонити майстру'},'Запиши до справ: Подзвонити майстру');
 const old=first.items[0];
 const completed=await mutate({operation:'complete',category:'todo',id:old.id,version:old.version},'Познач Подзвонити майстру як зроблене');
 assert.equal(completed.outcome,'completed');assert.equal((await run({operation:'list',category:'todo'})).items.length,0);
 assert.equal((await run({operation:'list',category:'todo',status:'completed'})).items[0].id,old.id);
 await assert.rejects(mutate({operation:'remove',category:'todo',id:old.id,version:old.version},'Прибери Подзвонити майстру зі справ'),/version_conflict_read_current/);
 const second=await mutate({operation:'add',category:'todo',text:'Подзвонити майстру'},'Додай до справ Подзвонити майстру');
 assert.notEqual(second.items[0].id,old.id);
 const ambiguous=await mutate({operation:'remove',category:'todo',text:'Подзвонити майстру'},'Прибери Подзвонити майстру зі списку');
 assert.equal(ambiguous.status,'needs_input');assert.equal(ambiguous.candidates.length,2);assert.equal((ambiguous.question.match(/\?/g)||[]).length,1);
 const removed=await mutate({operation:'remove',category:'todo',id:second.items[0].id,version:second.items[0].version},'Видали Подзвонити майстру зі справ');
 assert.equal(removed.outcome,'removed');assert.equal((await run({operation:'list',category:'todo',status:'all'})).items.length,1);
});

test('scope derives from topic/audience/actor and is checked before exact command replay',async()=>{
 const body='Запиши особисто до покупок ліки',sourceId=await source(body),c=context({sourceId,audience:'private'});
 const own=await run({operation:'add',text:'ліки'},c);
 assert.equal((await run({operation:'list'},context({audience:'private'}))).items.length,1);
 assert.equal((await run({operation:'list'})).items.length,0);
 assert.equal((await run({operation:'list'},context({audience:'private',actorId:'22'}))).items.length,0);
 assert.equal((await run({operation:'list'},context({audience:'private',topicId:'7'}))).items.length,0);
 const alien=await mutate({operation:'remove',id:own.items[0].id,version:own.items[0].version},'Прибери ліки зі списку',{actorId:'22',audience:'private'});
 assert.equal(alien.status,'needs_input');assert.equal(alien.candidates.length,0);
 await db.query("UPDATE members SET active=false WHERE user_id='11'");
 await assert.rejects(run({operation:'add',text:'ліки'},c),/member_required/);
 await assert.rejects(run({operation:'list'},context({audience:'private'})),/member_required/);
 assert.equal(ListCommand.safeParse({operation:'list',category:'shopping',actor_id:'22'}).success,false);
});

test('mutations need the current unquoted author source and explicit-key replay rejects changed arguments',async()=>{
 const quote='Переклади «додай молоко до покупок»',quoted=await source(quote);
 await assert.rejects(run({operation:'add',text:'молоко',quote:'додай молоко до покупок'},context({sourceId:quoted})),/list_request_unconfirmed/);
 const literal=await source('Переклади: додай молоко до покупок');
 await assert.rejects(run({operation:'add',text:'молоко',quote:'додай молоко до покупок'},context({sourceId:literal})),/list_request_unconfirmed/);
 const read=await source('Що в списку покупок?');
 await assert.rejects(run({operation:'add',text:'молоко'},context({sourceId:read})),/list_request_unconfirmed/);
 const forwarded=await source('Додай секрет до покупок','11','0',{forward_origin:{type:'user'}});
 await db.query('INSERT INTO inbox(update_id,payload,revision) VALUES($1,$2,0)',[++n,JSON.stringify({sourceId:forwarded,message:{forward_origin:{type:'user'}}})]);
 await assert.rejects(run({operation:'add',text:'секрет'},context({sourceId:forwarded})),/list_request_unconfirmed/);
 const body='Додай молоко до покупок',sourceId=await source(body),c=context({sourceId,operationKey:'stable-request'});
 await run({operation:'add',text:'молоко'},c);
 await assert.rejects(run({operation:'add',text:'хліб'},c),/operation_key_conflict/);
 await assert.rejects(run({operation:'add',text:'молоко'},context({sourceId,actorId:'22'})),/list_current_source_required/);
 await db.query('UPDATE app_state SET paused=true');
 await assert.rejects(run({operation:'add',text:'молоко'},c),/task_cancelled/);
});

test('forgetting completion/removal rebuilds state; forgetting addition removes dependents without touching other entries',async()=>{
 const addBody='Додай до покупок джерело-113-молоко',addSource=await source(addBody);
 const added=await run({operation:'add',text:'молоко'},context({sourceId:addSource}));
 const other=await mutate({operation:'add',text:'хліб'},'Додай до покупок незалежне-113-хліб');
 const doneBody='Познач молоко як зроблене завершення-113',doneSource=await source(doneBody);
 await run({operation:'complete',text:'молоко'},context({sourceId:doneSource}));
 assert.equal((await run({operation:'list',status:'completed'})).items.length,1);
 await db.tx(sql=>forgetPhrase(sql,'завершення-113'));
 let revision=(await state(db)).memory_revision;
 assert.equal((await run({operation:'list'},context({revision}))).items.length,2);
 const removeBody='Видали молоко зі списку вилучення-113',removeSource=await source(removeBody);
 await run({operation:'remove',text:'молоко'},context({revision,sourceId:removeSource}));
 await db.tx(sql=>forgetPhrase(sql,'вилучення-113'));revision=(await state(db)).memory_revision;
 assert.equal((await run({operation:'list'},context({revision}))).items.length,2);
 await db.tx(sql=>forgetPhrase(sql,'джерело-113-молоко'));revision=(await state(db)).memory_revision;
 const remaining=await run({operation:'list'},context({revision}));
 assert.deepEqual(remaining.items.map((item:any)=>item.id),[other.items[0].id]);
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events WHERE item_id=$1',[added.items[0].id]))!.n,0);
 await assert.rejects(run({operation:'add',text:'молоко'},context({sourceId:addSource,revision})),/list_current_source_required/);
});

test('an independent repeated addition survives forgetting the first source with its own attribution',async()=>{
 const first=await mutate({operation:'add',text:'молоко'},'Додай молоко первинне-113');
 await mutate({operation:'add',text:'Молоко'},'Додай Молоко незалежне-113',{actorId:'22'});
 await db.tx(sql=>forgetPhrase(sql,'первинне-113'));
 const current=await run({operation:'list'},context({revision:(await state(db)).memory_revision}));
 assert.equal(current.items.length,1);assert.equal(current.items[0].id,first.items[0].id);assert.equal(current.items[0].owner_id,'22');assert.equal(current.items[0].text,'Молоко');
});

test('referenced context has exact secondary provenance while unrelated history cannot erase a direct addition',async()=>{
 const reference=await source('Візьми парасольку secondary-reference-113');
 const assistant=Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,source_message_id) VALUES($1,'lumen','Люмен','assistant','Парасолька',$2) RETURNING id",[++n,reference])).rows[0]!.id);
 await recordProvenance(db,'message',assistant,[reference]);
 const unrelated=await source('Незалежний контекст history-only-113'),request=await source('Додай це до покупок');
 const c=context({sourceId:request,sourceIds:[request,assistant,unrelated]});
 await assert.rejects(run({operation:'add',text:'парасолька'},c),/list_reference_required/);
 await assert.rejects(run({operation:'add',text:'парасолька',source_ids:[reference]},c),/list_reference_unavailable/);
 const added=await run({operation:'add',text:'парасолька',source_ids:[assistant]},c);
 assert.ok(added.source_ids.includes(assistant));assert.equal(added.source_ids.includes(unrelated),false);
 const done=await mutate({operation:'complete',text:'парасолька'},'Познач парасольку як зроблене');
 assert.equal(done.outcome,'completed');
 const independent=await mutate({operation:'add',text:'хліб'},'Додай хліб до покупок',{sourceIds:[reference,unrelated]});
 await db.tx(sql=>forgetPhrase(sql,'history-only-113'));let revision=(await state(db)).memory_revision;
 assert.equal((await run({operation:'list',status:'all'},context({revision}))).items.length,2);
 await db.tx(sql=>forgetPhrase(sql,'secondary-reference-113'));revision=(await state(db)).memory_revision;
 assert.deepEqual((await run({operation:'list',status:'all'},context({revision}))).items.map((item:any)=>item.id),[independent.items[0].id]);
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events WHERE item_id=$1',[added.items[0].id]))!.n,0);
});

test('pagination reports more entries explicitly and result provenance includes the whole page',async()=>{
 const all=[];
 for(let i=0;i<3;i++)all.push(await mutate({operation:'add',items:[`пункт ${i}А`,`пункт ${i}Б`]},`Додай пункт ${i}А і пункт ${i}Б batch-113-${i}`));
 const first=await run({operation:'list',limit:2});assert.equal(first.items.length,2);assert.equal(first.has_more,true);assert.ok(first.next_after>0);
 const second=await run({operation:'list',limit:2,after:first.next_after});
 assert.equal(second.has_more,true);assert.equal(second.items.some((item:any)=>first.items.some((prev:any)=>prev.id===item.id)),false);
 const last=await run({operation:'list',limit:2,after:second.next_after});assert.equal(last.has_more,false);assert.equal(last.next_after,null);
 assert.deepEqual(new Set(resultSources('lists.manage',first)),new Set(all[0].source_ids));
});

test('AgentTools performs fresh list reads and rechecks membership before replay; erasure removes event data',async()=>{
 const h=harness(db),tools=new AgentTools(db,h.config,h.brain),body='Додай молоко до покупок',sourceId=await source(body),c=context({sourceId});
 await tools.execute('lists.manage',{operation:'add',category:'shopping',text:'молоко'},c);
 const readArgs={operation:'list',category:'shopping'},readContext=context();
 assert.equal((await tools.execute('lists.manage',readArgs,readContext)).items.length,1);
 await mutate({operation:'add',text:'хліб'},'Додай хліб до покупок');
 assert.equal((await tools.execute('lists.manage',readArgs,readContext)).items.length,2);
 await db.query("UPDATE members SET active=false WHERE user_id='11'");
 await assert.rejects(tools.execute('lists.manage',{operation:'add',category:'shopping',text:'молоко'},c),/member_required/);
 await db.tx(eraseAll);assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,0);
});

test('a large list provenance envelope retains secondary dependencies through AgentTools and erasure',async()=>{
 const itemId='c8b26304-a747-4c8b-9dce-5bf968461113';
 await db.query(`WITH sources AS (
  INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id)
  SELECT 900000+i,'11','А','user','Додай молоко secondary-source-113-'||i,'0' FROM generate_series(1,1105) i RETURNING id
 ) INSERT INTO simple_list_events(id,item_id,operation,category,text,normalized_text,topic_id,audience,scope_actor,owner_id,actor_id,source_message_id)
 SELECT md5('list113-event-'||id)::uuid,$1,'add','shopping','молоко','молоко','0','group','','11','11',id FROM sources`,[itemId]);
 const h=harness(db),tools=new AgentTools(db,h.config,h.brain),c=context(),args={operation:'list',category:'shopping'};
 const result=await tools.execute('lists.manage',args,c),sources=resultSources('lists.manage',result);
 assert.equal(sources.length,1105);assert.ok(JSON.stringify(result).length<100000);
 const lastSource=Number((await one(db,"SELECT id FROM messages WHERE body='Додай молоко secondary-source-113-1105'"))!.id);
 assert.ok(sources.includes(lastSource));
 assert.equal((await one(db,"SELECT count(*)::integer AS n FROM provenance_edges WHERE derived_kind='tool_run'"))!.n,1105);
 await db.tx(sql=>forgetPhrase(sql,'secondary-source-113-1105'));
 const refreshed=await tools.execute('lists.manage',args,{...c,revision:(await state(db)).memory_revision});
 assert.equal(resultSources('lists.manage',refreshed).length,1104);assert.equal(resultSources('lists.manage',refreshed).includes(lastSource),false);
});

test('real foreground mixed turn commits lists plus an independent reminder after replanning',async()=>{
 await db.reset();const h=harness(db);await paired(h);
 const text='Люмен, запиши купити молоко й хліб і через годину нагадай про аптеку';
 const schedule:Plan['actions'][number]={kind:'schedule',title:'Аптека',instruction:'Зайти в аптеку',mode:'reminder',due_at:new Date(Date.now()+3600000).toISOString(),timezone:'Europe/Kyiv',authorization:'explicit',quote:'через годину нагадай про аптеку'};
 h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',items:['молоко','хліб'],quote:'запиши купити молоко й хліб'})},schedule]},{reply:'Додав у покупки: молоко, хліб.',actions:[]});
 await h.lumen.receive(message(text));await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");
 assert.equal(await h.lumen.processNext(),true);
 assert.equal((await one(db,"SELECT count(*)::integer AS n FROM simple_list_events WHERE operation='add'"))!.n,2);
 assert.equal((await one(db,"SELECT count(*)::integer AS n FROM scheduled_actions WHERE status='pending'"))!.n,1);
 const visible=JSON.stringify((await db.query("SELECT body FROM outbox WHERE dedup_key LIKE 'answer:%'")).rows);
 assert.match(visible,/молоко/);assert.match(visible,/хліб/);assert.match(visible,/аптек/iu);assert.doesNotMatch(visible,/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
});

test('real addressed-only foreground admits short list continuation but rejects forwarding and other actors/topics',async()=>{
 await db.reset();const h=harness(db);await paired(h);await db.query("UPDATE app_state SET mention_only=true,mode='quiet' WHERE id=1");
 const tool=(text:string):Plan=>({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',text})}]});
 async function positive(text:string,item:string){h.brain.replies.push(tool(item),{reply:`Додав у покупки: ${item}.`,actions:[]});await h.lumen.receive(message(text));await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");assert.equal(await h.lumen.processNext(),true);}
 async function negative(update:ReturnType<typeof message>){
  const before=(await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n;
  h.brain.replies.push(tool('масло'),{reply:'Додав у покупки: масло.',actions:[]});
  await h.lumen.receive(update);await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");await h.lumen.processNext();h.brain.replies=[];
  assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,before);
 }
 await positive('Люмен, додай молоко до покупок','молоко');await positive('Ще сир','сир');
 await positive('Люмен, додай кефір до покупок','кефір');const forwarded=message('Ще масло');(forwarded.message as any).forward_origin={type:'user'};await negative(forwarded);
 await positive('Люмен, додай яблука до покупок','яблука');await negative(message('Ще масло',22));
 await positive('Люмен, додай хліб до покупок','хліб');const topic=message('Ще масло');topic.message!.message_thread_id=7;await negative(topic);
 assert.deepEqual(new Set((await run({operation:'list'})).items.map((item:any)=>item.text)),new Set(['молоко','сир','кефір','яблука','хліб']));
});

test('a real list failure preserves an independent reminder and a specific honest recovery',async()=>{
 await db.reset();const h=harness(db);await paired(h);
 const text='Люмен, додай хліб до покупок і через годину нагадай купити хліб';
 h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',items:[]})},{kind:'schedule',title:'Хліб',instruction:'Купити хліб',mode:'reminder',due_at:new Date(Date.now()+3600000).toISOString(),timezone:'Europe/Kyiv',authorization:'explicit',quote:'через годину нагадай купити хліб'}]},{reply:'Не вдалося додати хліб до покупок. Можемо спробувати ще раз.',actions:[]});
 await h.lumen.receive(message(text));await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");
 assert.equal(await h.lumen.processNext(),true);
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,0);
 assert.equal((await one(db,"SELECT count(*)::integer AS n FROM scheduled_actions WHERE status='pending'"))!.n,1);
 const visible=JSON.stringify((await db.query("SELECT body FROM outbox WHERE dedup_key LIKE 'answer:%'")).rows);
 assert.match(visible,/Не вдалося додати хліб/);assert.match(visible,/нагадаю|Запланував нагадування/iu);assert.doesNotMatch(visible,/Додав у покупки/);
});

test('restart after a committed list and model failure retains the independent reminder exactly once',async()=>{
 await db.reset();const h=harness(db);await paired(h);
 const text='Люмен, додай молоко до покупок і через годину нагадай купити молоко';
 const initial:Plan={reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',text:'молоко'})},{kind:'schedule',title:'Молоко',instruction:'Купити молоко',mode:'reminder',due_at:new Date(Date.now()+3600000).toISOString(),timezone:'Europe/Kyiv',authorization:'explicit',quote:'через годину нагадай купити молоко'}]};
 let calls=0;h.brain.block=async()=>{if(++calls===1)return initial;throw new ModelError('model_network');};
 const update=message(text);await h.lumen.receive(update);await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");
 assert.equal(await h.lumen.processNext(),true);
 assert.equal((await one(db,"SELECT count(*)::integer AS n FROM simple_list_events WHERE operation='add'"))!.n,1);
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM scheduled_actions'))!.n,0);
 const pending=await one(db,"SELECT payload,status FROM inbox WHERE update_id=$1",[update.update_id]);
 assert.equal(pending!.status,'pending');assert.equal(pending!.payload.pendingIndependent.length,1);
 const restarted=harness(db);restarted.brain.replies.push({reply:'',actions:[]});
 await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");
 assert.equal(await restarted.lumen.processNext(),true);
 await restarted.lumen.receive(update);
 assert.equal((await one(db,"SELECT count(*)::integer AS n FROM simple_list_events WHERE operation='add'"))!.n,1);
 assert.equal((await one(db,"SELECT count(*)::integer AS n FROM scheduled_actions WHERE status='pending'"))!.n,1);
 assert.equal((await one(db,"SELECT status FROM inbox WHERE update_id=$1",[update.update_id]))!.status,'done');
});

test('QA UC-05 a personal list request in a group crosses to DM without a shared mutation or false confirmation',async()=>{
 await db.reset();const h=harness(db);await paired(h);
 const text='Люмен, додай особисто мені до покупок ліки, це мій особистий список';
 h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',text:'ліки'})}]},{reply:'Додав у твій особистий список: ліки.',actions:[]});
 await h.lumen.receive(message(text));await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");assert.equal(await h.lumen.processNext(),true);
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,0);
 assert.equal((await run({operation:'list'},context({actorId:'22'}))).items.length,0);
 const visible=JSON.stringify((await db.query("SELECT body FROM outbox WHERE dedup_key LIKE 'answer:%'")).rows);
 assert.match(visible,/особистому чаті/);assert.doesNotMatch(visible,/Додав|ліки/);
 h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',text:'хліб'})}]},{reply:'Додав у покупки: хліб.',actions:[]});
 await h.lumen.receive(message('Люмен, додай мені хліб у список покупок'));await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");assert.equal(await h.lumen.processNext(),true);
 assert.deepEqual((await run({operation:'list'},context({actorId:'22'}))).items.map((item:any)=>item.text),['хліб']);
});

test('personal group reads do not return private list material to the group planner or output',async()=>{
 await db.reset();const h=harness(db);await paired(h);
 const sourceId=await source('Збережений особистий запис');
 await db.query("INSERT INTO simple_list_events(id,item_id,operation,category,text,normalized_text,topic_id,audience,scope_actor,owner_id,actor_id,revision,source_message_id) VALUES('70ebaf12-35c6-4d60-a6c9-66ddd88f2113','52c36fc9-b42e-4a40-a4bd-b6da319c2113','add','shopping','PRIVATE_MEDICINE_113','private_medicine_113','0','private','11','11','11',0,$1)",[sourceId]);
 h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'list',category:'shopping'})}]},{reply:'Для особистого списку напиши мені в особистому чаті.',actions:[]});
 await h.lumen.receive(message('Люмен, покажи мій особистий список покупок'));await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");assert.equal(await h.lumen.processNext(),true);
 assert.doesNotMatch(JSON.stringify(h.brain.calls),/PRIVATE_MEDICINE_113/);
 assert.doesNotMatch(JSON.stringify((await db.query('SELECT body FROM outbox')).rows),/PRIVATE_MEDICINE_113/);
 assert.equal((await run({operation:'list'},context({actorId:'22'}))).items.length,0);
 assert.equal((await run({operation:'list'},context({audience:'private'}))).items[0].text,'PRIVATE_MEDICINE_113');
});

test('QA UC-06 the current milk request cannot authorize bananas or any partly invented batch',async()=>{
 await db.reset();const h=harness(db);await paired(h);
 h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',text:'банани'})}]},{reply:'Додав у покупки: банани.',actions:[]});
 await h.lumen.receive(message('Люмен, додай молоко до покупок'));await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");assert.equal(await h.lumen.processNext(),true);
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,0);
 const visible=JSON.stringify((await db.query("SELECT body FROM outbox WHERE dedup_key LIKE 'answer:%'")).rows);assert.match(visible,/Який саме пункт/);assert.doesNotMatch(visible,/Додав|банани/);
 const batch=await mutate({operation:'add',items:['молоко','банани']},'Додай молоко і хліб до покупок');assert.equal(batch.status,'needs_input');
 const otherClause=await mutate({operation:'add',text:'яйця'},'Додай молоко; через годину нагадай про яйця');assert.equal(otherClause.status,'needs_input');
 const substring=await mutate({operation:'add',text:'сир'},'Додай сироп до покупок');assert.equal(substring.status,'needs_input');
 const excluded=await mutate({operation:'add',text:'банани'},'Додай молоко без бананів');assert.equal(excluded.status,'needs_input');
 const reason=await mutate({operation:'add',text:'банани'},'Додай молоко бо банани вже є');assert.equal(reason.status,'needs_input');
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,0);
});

test('QA UC-07 remove/complete and ID selectors remain bound to the requested item',async()=>{
 const milk=(await mutate({operation:'add',text:'молоко'},'Додай молоко до покупок')).items[0];
 const eggs=(await mutate({operation:'add',text:'яйця'},'Додай яйця до покупок')).items[0];
 assert.equal((await mutate({operation:'remove',text:'яйця'},'Видали молоко зі списку')).status,'needs_input');
 assert.equal((await mutate({operation:'complete',id:eggs.id,version:eggs.version},'Познач молоко як зроблене')).status,'needs_input');
 assert.equal((await mutate({operation:'remove',id:eggs.id,version:eggs.version},'Видали молоко зі списку')).status,'needs_input');
 assert.equal((await run({operation:'list'})).items.length,2);
 const inflected=await mutate({operation:'remove',id:milk.id,version:milk.version},'Прибери молока зі списку');assert.equal(inflected.outcome,'removed');
 const completed=await mutate({operation:'complete',text:'яйця'},'Познач яйце як зроблене');assert.equal(completed.outcome,'completed');
});

test('ordinary inflection, task verb paraphrases and literal IDs preserve their material meaning',async()=>{
 const milk=await mutate({operation:'add',text:'молоко'},'Додай молока до покупок');assert.equal(milk.added[0],'молоко');
 const task=(await mutate({operation:'add',category:'todo',text:'Подзвонити майстру'},'Додай до справ зателефонувати майстру')).items[0];
 assert.equal((await mutate({operation:'complete',category:'todo',id:task.id,version:task.version},'Познач написати майстру як зроблене')).status,'needs_input');
 assert.equal((await mutate({operation:'complete',category:'todo',id:task.id,version:task.version},'Познач зателефонувати майстрові як зроблене')).outcome,'completed');
 assert.equal((await mutate({operation:'remove',id:milk.items[0].id,version:milk.items[0].version},`Видали пункт ${milk.items[0].id} зі списку`)).outcome,'removed');
 assert.equal((await mutate({operation:'add',text:'зелене яблуко'},'Додай «зелене яблуко» до покупок')).added[0],'зелене яблуко');
});

test('contextual pronouns require an exact scoped source envelope matching the actual target',async()=>{
 const reference=await source('Візьми молоко');const request=await source('Додай це до покупок');const c=context({sourceId:request,sourceIds:[reference,request]});
 const wrong=await run({operation:'add',text:'банани',source_ids:[reference]},c);assert.equal(wrong.status,'needs_input');
 const right=await run({operation:'add',text:'молоко',source_ids:[reference]},c);assert.equal(right.added[0],'молоко');assert.ok(right.source_ids.includes(reference));
 const eggs=(await mutate({operation:'add',text:'яйця'},'Додай яйця до покупок')).items[0];
 const removeSource=await source('Прибери його зі списку'),refContext=context({sourceId:removeSource,sourceIds:[reference,removeSource]});
 assert.equal((await run({operation:'remove',id:eggs.id,version:eggs.version,source_ids:[reference]},refContext)).status,'needs_input');
 assert.equal((await run({operation:'remove',id:right.items[0].id,version:right.items[0].version,source_ids:[reference]},refContext)).outcome,'removed');
});

test('QA UC-14 actual Russian continuation Ещё сыр and ordinary English More cheese are admitted safely',async()=>{
 await db.reset();const h=harness(db);await paired(h);await db.query("UPDATE app_state SET mention_only=true,mode='quiet' WHERE id=1");
 async function turn(text:string,item:string){h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',text:item})}]},{reply:'',actions:[]});await h.lumen.receive(message(text));await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");assert.equal(await h.lumen.processNext(),true);}
 await turn('Люмен, добавь молоко в покупки','молоко');await turn('Ещё сыр','сыр');
 await turn('Lumen, add bread to shopping','bread');await turn('More cheese','cheese');
 assert.deepEqual(new Set((await run({operation:'list'})).items.map((item:any)=>item.text)),new Set(['молоко','сыр','bread','cheese']));
});

test('R2-C09 a noun in an already-bought aside cannot become an operative add target',async()=>{
 for(const [body,target] of [
  ['Додай молоко до покупок, а сир уже купив','сир'],
  ['Додай молоко до покупок, сир уже купив','сир'],
  ['Додай молоко та сир уже купив','сир'],
  ['Додай ще молоко, а сир вже купив','сир'],
  ['Добавь молоко, а сыр уже купил','сыр'],
  ['Add milk, but I already bought cheese','cheese'],
 ] as const){const result=await mutate({operation:'add',items:[target]},body);assert.equal(result.status,'needs_input',body);assert.equal(result.reason,'list_target_unconfirmed');}
 const batch=await mutate({operation:'add',items:['молоко','сир']},'Додай молоко до покупок, а сир уже купив');assert.equal(batch.status,'needs_input');
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,0);
 await db.reset();const h=harness(db);await paired(h);
 h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',items:['сир']})}]},{reply:'Додав у покупки: сир.',actions:[]});
 await h.lumen.receive(message('Люмен, додай молоко до покупок, а сир уже купив'));await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");assert.equal(await h.lumen.processNext(),true);
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,0);
 const visible=JSON.stringify((await db.query("SELECT body FROM outbox WHERE dedup_key LIKE 'answer:%'")).rows);assert.match(visible,/Який саме пункт/);assert.doesNotMatch(visible,/Додав у покупки: сир/);
});

test('operative lists retain natural enumeration, а ще and an explicit request for more after buying',async()=>{
 for(const [body,items] of [
  ['Додай молока, сиру і хліба',['молоко','сир','хліб']],
  ['Додай молоко, а ще масло',['молоко','масло']],
  ['Додай молоко до покупок, а сир уже купив',['молоко']],
  ['Сир уже купив, але додай ще сиру',['сир']],
  ['Сир уже купив, але додай ще',['сир']],
  ['Купив сир, додай ще',['сир']],
  ['Сир уже купив, але додай ще на завтра',['сир']],
  ['Сыр уже купил, но добавь ещё',['сыр']],
  ['Bread is already bought, but add more for tomorrow',['bread']],
 ] as const){
  const result=await mutate({operation:'add',items:[...items]},body);assert.notEqual(result.status,'needs_input',body);
  assert.deepEqual(result.items.map((item:any)=>item.text),[...items],body);
  for(const item of result.items)assert.ok(item.source_ids.includes(result.source_ids[0]),body);
 }
 const nearest=await mutate({operation:'add',text:'яблука'},'Яблука вже купив, сир уже є, але додай ще');assert.equal(nearest.status,'needs_input');
});

test('quoted item clauses and source-bound pronouns keep their authority without borrowing unrelated asides',async()=>{
 const title='🧀🛒 Молоко, а сир уже купив';
 const quoted=await mutate({operation:'add',category:'todo',items:[title,'Подзвонити майстру']},`Додай «${title}» до списку справ, а ще Подзвонити майстру`);
 assert.deepEqual(quoted.items.map((item:any)=>item.text),[title,'Подзвонити майстру']);
 const before=(await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n;
 await assert.rejects(mutate({operation:'add',text:'молоко'},'Процитуй: Додай молоко, а сир уже купив'),/list_request_unconfirmed/);
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,before);
 const reference=await source('Візьми чай'),request=await source('Додай ще'),c=context({sourceId:request,sourceIds:[reference,request]});
 assert.equal((await run({operation:'add',text:'кава',source_ids:[reference]},c)).status,'needs_input');
 assert.equal((await run({operation:'add',text:'чай',source_ids:[reference]},c)).items[0].text,'чай');
});
