import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {TestDB,harness,paired,message} from './helpers.js';
import {SimpleLists,ListCommand} from '../src/simple-lists.js';
import {one,state} from '../src/db.js';
import {captureOriginalRequestContext} from '../src/request-context.js';
import type {ToolContext} from '../src/agent-tools.js';

let db:TestDB,n=1540000;
const context=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:String(++n),requested:true,...extra});
async function source(body:string,actor='11',topic='0',native:Record<string,unknown>|false={}){
 const telegramId=++n,id=Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,$2,'Автор','user',$3,$4) RETURNING id",[telegramId,actor,body,topic])).rows[0]!.id);
 if(native!==false){const namespace=String((await state(db)).chat_id);await db.tx(sql=>captureOriginalRequestContext(sql,id,{message_id:telegramId,from:{id:Number(actor)},chat:{id:Number(namespace),type:Number(namespace)>0?'private':'supergroup'},text:body,...(topic!=='0'?{message_thread_id:Number(topic)}:{}),...native},{namespaceChatId:namespace,sourceTopicId:topic}));}
 return id;
}
const run=(args:any,c:ToolContext)=>new SimpleLists(db).run(ListCommand.parse(args),c);
async function add(body:string,category:string,items:string[],extra:Partial<ToolContext>={},args:Record<string,unknown>={}){
 const sourceId=await source(body,extra.actorId||'11',extra.topicId||'0');
 return run({operation:'add',category,items,...args},context({sourceId,requestText:body,...extra}));
}
before(async()=>{db=new TestDB();await db.init();});after(async()=>db.close());
beforeEach(async()=>{
 await db.reset();await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');
 await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',memory_revision=0,paused=false WHERE id=1");
 for(const id of ['11','22'])await db.query('INSERT INTO members(user_id,name,active) VALUES($1,$2,true)',[id,'Учасник '+id]);
});

test('explicit UA/RU/EN list headings save current textual items with colon or newline and no imperative',async()=>{
 for(const [body,category,items] of [
  ['Список покупок: хліб, молоко','shopping',['хліб','молоко']],
  ['Список справ: подзвонити майстру, помити посуд','todo',['подзвонити майстру','помити посуд']],
  ['Покупки: хліб, молоко','shopping',['хліб','молоко']],
  ['Список покупок\n- хліб\n- молоко','shopping',['хліб','молоко']],
  ['Список дел: позвонить мастеру, помыть посуд','todo',['позвонить мастеру','помыть посуд']],
  ['Список задач\n• позвонить мастеру\n• помыть посуд','todo',['позвонить мастеру','помыть посуд']],
  ['Shopping list: bread, milk','shopping',['bread','milk']],
  ['Grocery list\n• bread\n• milk','shopping',['bread','milk']],
  ['To-do list: call the plumber, wash the dishes','todo',['call the plumber','wash the dishes']],
  ['Tasks\n1. call the plumber\n2. wash the dishes','todo',['call the plumber','wash the dishes']],
 ] as const){
  const result=await add(body,category,[...items]);assert.equal(result.operation,'add',body);assert.notEqual(result.status,'needs_input',body);
  assert.deepEqual(result.items.map((item:any)=>item.text),[...items],body);
  assert.ok(result.items.every((item:any)=>item.category===category&&item.status==='open'&&!('quantity' in item)&&!('unit' in item)),body);
 }
 for(const table of ['stock_items','stock_movements','stock_receipts','project_tasks'])assert.equal((await one(db,`SELECT count(*)::integer AS n FROM ${table}`))!.n,0);
});

test('headed list categories and individual targets cannot be replaced by model arguments',async()=>{
 await assert.rejects(add('Список покупок: хліб, молоко','todo',['хліб']),/list_category_unconfirmed/);
 await assert.rejects(add('Список справ: додати підпис','shopping',['додати підпис']),/list_category_unconfirmed/);
 assert.equal((await add('Список покупок: хліб, молоко','shopping',['хліб','банани'])).status,'needs_input');
 assert.equal((await add('Список справ: подзвонити майстру, помити посуд','todo',['подзвонити посуд'])).status,'needs_input');
 const mixed='Shopping list:\nmilk\nTo-do list:\ncall the plumber';
 assert.equal((await add(mixed,'shopping',['call the plumber'])).status,'needs_input');
 assert.equal((await add(mixed,'todo',['milk'])).status,'needs_input');
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,0);
 assert.equal((await add(mixed,'shopping',['milk'])).items[0].category,'shopping');
 assert.equal((await add(mixed,'todo',['call the plumber'])).items[0].category,'todo');
});

test('headed data can contain quoted titles and task verbs without granting other mutations',async()=>{
 assert.equal((await add('Shopping list: "🧀🛒 milk, extra"','shopping',['🧀🛒 milk, extra'])).items[0].text,'🧀🛒 milk, extra');
 assert.equal((await add('Список справ:\nподзвонити майстру, коли звільнюся','todo',['подзвонити майстру, коли звільнюся'])).items[0].text,'подзвонити майстру, коли звільнюся');
 const body='To-do list:\nremove milk',sourceId=await source(body),c=context({sourceId});
 assert.equal((await run({operation:'add',category:'todo',text:'remove milk'},c)).items[0].text,'remove milk');
 await assert.rejects(run({operation:'remove',category:'todo',text:'remove milk'},c),/list_request_unconfirmed/);
 assert.equal((await add('Список покупок: без молока, хліб','shopping',['молоко'])).status,'needs_input');
 assert.equal((await add('Список покупок: без молока, хліб','shopping',['хліб'])).items[0].text,'хліб');
});

test('nouns, discussion, metadata, questions, negation and quoted labels do not become add authority',async()=>{
 for(const body of [
  'хліб, молоко',
  'Ми говорили про покупки: хліб, молоко',
  'Список покупок: хліб, молоко?',
  'Що таке список покупок: хліб, молоко?',
  'Не записуй:\nСписок покупок: хліб, молоко',
  'Список покупок: не додавай хліб',
  'Приклад: Список справ: додати підпис',
  'Translate:\nTo-do list:\nadd a caption',
  'Explain this example: Shopping list: add milk',
  '«Список покупок: хліб, молоко»',
  '> Список покупок: хліб, молоко',
  '```\nShopping list: bread, milk\n```',
  'Список покупок:\n> хліб',
  'Список покупок:',
 ]){
  await assert.rejects(add(body,body.includes('справ')||body.includes('To-do')?'todo':'shopping',[body.includes('підпис')?'підпис':body.includes('caption')?'caption':'хліб']),/list_request_unconfirmed/,body);
 }
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,0);
});

test('labels still require the actual current actor, topic, request, live revision and unforwarded source',async()=>{
 const body='Список покупок: хліб, молоко',sourceId=await source(body),args={operation:'add',category:'shopping',items:['хліб','молоко']};
 await assert.rejects(run(args,context({sourceId,actorId:'22'})),/list_current_source_required/);
 await assert.rejects(run(args,context({sourceId,topicId:'7'})),/list_current_source_required/);
 await assert.rejects(run(args,context({sourceId,chatId:'-200'})),/other_chat/);
 await assert.rejects(run(args,context({sourceId,requested:false})),/tool_not_requested/);
 await assert.rejects(run(args,context({sourceId,revision:1})),/task_cancelled/);
 for(const [field,value] of [['forward_origin',{type:'user'}],['forward_date',123],['via_bot',{id:999}]] as const){
  const id=await source(body,'11','0',{[field]:value});await db.query('INSERT INTO inbox(update_id,payload,revision) VALUES($1,$2,0)',[++n,JSON.stringify({sourceId:id,message:{[field]:value}})]);
  await assert.rejects(run(args,context({sourceId:id})),/list_request_unconfirmed/,field);
 }
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,0);
});

test('labeled lists use the actual private namespace and cannot cross actor or bound chat',async()=>{
 await db.query("UPDATE app_state SET chat_id='11' WHERE id=1");
 const body='Shopping list:\nmedicine',sourceId=await source(body),c=context({sourceId,chatId:'11',audience:'private'});
 const result=await run({operation:'add',category:'shopping',text:'medicine'},c);assert.equal(result.items[0].audience,'private');
 assert.deepEqual((await run({operation:'list',category:'shopping'},context({chatId:'11',actorId:'22',audience:'private'}))).items,[]);
 await assert.rejects(run({operation:'add',category:'shopping',text:'medicine'},context({sourceId,chatId:'11',actorId:'22',audience:'private'})),/list_current_source_required/);
 await assert.rejects(run({operation:'add',category:'shopping',text:'medicine'},context({sourceId})),/other_chat/);
});

test('actual addressed foreground saves a plainly headed list without quantities, mode selection or a pre-read',async()=>{
 await db.reset();const h=harness(db);await paired(h);
 h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',items:['хліб','молоко']})}]},{reply:'',actions:[]});
 await h.lumen.receive(message('Люмен, Список покупок: хліб, молоко'));await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");assert.equal(await h.lumen.processNext(),true);
 assert.equal((await one(db,'SELECT count(*)::integer AS n FROM simple_list_events'))!.n,2);
 assert.deepEqual((await db.query("SELECT arguments->>'operation' AS operation FROM tool_runs WHERE tool='lists.manage'")).rows.map(row=>row.operation),['add']);
 const visible=JSON.stringify((await db.query("SELECT body FROM outbox WHERE dedup_key LIKE 'answer:%'")).rows);assert.match(visible,/Додав у покупки: хліб, молоко/);assert.doesNotMatch(visible,/кількіст|обер|режим|PDF|inventory/iu);
});
