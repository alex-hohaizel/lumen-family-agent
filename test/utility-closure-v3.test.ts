import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {TestDB,harness,paired,message} from './helpers.js';
import {SimpleLists,ListCommand,isListAddContinuation} from '../src/simple-lists.js';
import {forgetPhrase,one,state} from '../src/db.js';
import type {ToolContext} from '../src/agent-tools.js';
import {captureOriginalRequestContext} from '../src/request-context.js';

let db:TestDB,n=3300000;
const context=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:String(++n),requested:true,...extra});
async function source(body:string,actor='11',topic='0',native:Record<string,unknown>|false={}){
 const telegramId=++n,id=Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,$2,'Автор','user',$3,$4) RETURNING id",[telegramId,actor,body,topic])).rows[0]!.id);
 if(native!==false){const namespace=String((await state(db)).chat_id);await db.tx(sql=>captureOriginalRequestContext(sql,id,{message_id:telegramId,from:{id:Number(actor)},chat:{id:Number(namespace),type:Number(namespace)>0?'private':'supergroup'},text:body,...(topic!=='0'?{message_thread_id:Number(topic)}:{}),...native},{namespaceChatId:namespace,sourceTopicId:topic}));}
 return id;
}
const run=(args:any,c:ToolContext)=>new SimpleLists(db).run(ListCommand.parse(args),c);
async function request(body:string,args:any,extra:Partial<ToolContext>={}){
 const sourceId=await source(body,extra.actorId||'11',extra.topicId||'0');
 return run(args,context({sourceId,requestText:body,...extra}));
}
before(async()=>{db=new TestDB();await db.init();});after(async()=>db.close());
beforeEach(async()=>{
 await db.reset();await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');
 await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',memory_revision=0,paused=false WHERE id=1");
 for(const id of ['11','22'])await db.query('INSERT INTO members(user_id,name,active) VALUES($1,$2,true)',[id,'Учасник '+id]);
});

test('actual shopping read keeps the following additive request in the same list without another imperative',async()=>{
 await request('Список покупок: гречка, яблука',{operation:'add',category:'shopping',items:['гречка','яблука']});
 await request('Ще сир',{operation:'add',category:'shopping',text:'сир'});
 await request('Познач яблука як куплені',{operation:'complete',category:'shopping',text:'яблука'});
 const read=await request('Що лишилося купити?',{operation:'list',category:'shopping'});
 assert.deepEqual(read.items.map((x:any)=>x.text),['гречка','сир']);
 const result=await request('Ще кефір',{operation:'add',category:'shopping',text:'кефір'});
 assert.deepEqual(result.added,['кефір']);
 assert.equal((await one(db,"SELECT count(*)::int n FROM simple_list_events WHERE operation='add'"))!.n,4);
 assert.equal((await one(db,'SELECT count(*)::int n FROM stock_movements'))!.n,0);
});

test('current UA/RU/EN list views select only their real category, including an empty viewed list',async()=>{
 for(const [view,category,more,item] of [
  ['Покажи список справ','todo','Ще помити посуд','помити посуд'],
  ['Покажи список покупок','shopping','Ще хліб','хліб'],
  ['Что осталось купить?','shopping','Ещё кефир','кефир'],
  ['Покажи список дел','todo','Ещё позвонить мастеру','позвонить мастеру'],
  ['What remains to buy?','shopping','Also milk','milk'],
  ['What is on my shopping list?','shopping','Also bread','bread'],
  ['Show my task list','todo','Also call the plumber','call the plumber'],
 ] as const){
  await assert.rejects(request(view,{operation:'list',category:category==='shopping'?'todo':'shopping'}),/list_category_unconfirmed/,view+' / wrong category');
  await request(view,{operation:'list',category});
  assert.deepEqual((await request(more,{operation:'add',category,text:item})).added,[item],view);
 }
 const contexts=(await db.query("SELECT result FROM domain_commands WHERE result->>'context_only'='true'")).rows;
 assert.ok(contexts.length<=2,'Only the latest selected read per actor/topic/audience/category is stored');
 assert.ok(contexts.every(x=>!('items' in x.result)&&!('message' in x.result)),'Read selection must not cache private item text or a stale visible result');
});

test('a generic list view needs the immediately preceding real unique list selection',async()=>{
 await request('Додай молоко до покупок',{operation:'add',category:'shopping',text:'молоко'});
 await request('Покажи список',{operation:'list',category:'shopping'});
 assert.deepEqual((await request('Ще сир',{operation:'add',category:'shopping',text:'сир'})).added,['сир']);
 await source('Поговорімо про іншу справу');
 await request('Покажи список',{operation:'list',category:'todo'});
 await assert.rejects(request('Ще кефір',{operation:'add',category:'todo',text:'кефір'}),/list_request_unconfirmed/);
});

test('a view-shaped message without an actual read is not mutation authority',async()=>{
 await request('Додай молоко до покупок',{operation:'add',category:'shopping',text:'молоко'});
 await source('Що лишилося купити?');
 await assert.rejects(request('Ще сир',{operation:'add',category:'shopping',text:'сир'}),/list_request_unconfirmed/);
 assert.equal((await one(db,'SELECT count(*)::int n FROM simple_list_events'))!.n,1);
});

test('read continuation keeps actor/topic/audience, immediate-topic and time boundaries',async()=>{
 const scenarios=['other_actor','other_topic','other_audience','unrelated_turn','expired'] as const;
 for(const scenario of scenarios){
  await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');await db.query('DELETE FROM messages');
  const id=await source('Покажи список покупок',scenario==='other_actor'?'22':'11');
  await run({operation:'list',category:'shopping'},context({sourceId:id,actorId:scenario==='other_actor'?'22':'11',...(scenario==='other_audience'?{audience:'private' as const}:{})}));
  if(scenario==='unrelated_turn')await source('Як погода сьогодні?');
  if(scenario==='expired')await db.query("UPDATE messages SET created_at=now()-interval '16 minutes' WHERE id=$1",[id]);
  const sourceId=await source('Ще сир','11',scenario==='other_topic'?'7':'0'),c=context({sourceId,topicId:scenario==='other_topic'?'7':'0'});
  assert.equal(await isListAddContinuation(db,c,'shopping'),false,scenario);
  await assert.rejects(run({operation:'add',category:'shopping',text:'сир'},c),/list_request_unconfirmed/,scenario);
 }
});

test('forwarded, quoted, translated, negated and definition views cannot create additive authority',async()=>{
 for(const kind of ['forward','quote','translate','negation','definition_uk','definition_en'] as const){
  await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');await db.query('DELETE FROM messages');
  const body=kind==='quote'?'«Покажи список покупок»':kind==='translate'?'Переклади «Що лишилося купити?»':kind==='negation'?'Не показуй список покупок':kind==='definition_uk'?'Що таке список покупок?':kind==='definition_en'?'What is a shopping list?':'Покажи список покупок';
  const id=await source(body,'11','0',kind==='forward'?{forward_origin:{type:'user'}}:{});
  if(kind==='forward')await db.query('INSERT INTO inbox(update_id,payload,revision) VALUES($1,$2,0)',[++n,JSON.stringify({sourceId:id,message:{forward_origin:{type:'user'}}})]);
  await run({operation:'list',category:'shopping'},context({sourceId:id}));
  await assert.rejects(request('Ще сир',{operation:'add',category:'shopping',text:'сир'}),/list_request_unconfirmed/,kind);
 }
});

for(const [id,body,follow,text] of [
 ['UA-EXAMPLE','Покажи приклад списку покупок','Ще кефір','кефір'],
 ['RU-EXAMPLE','Покажи пример списка покупок','Ещё кефир','кефир'],
 ['EN-EXAMPLE','Show an example shopping list','Also milk','milk'],
 ['UA-TRANSLATE-INDIRECT','Покажи, як перекласти список покупок','Ще кефір','кефір'],
 ['RU-TRANSLATE-INDIRECT','Покажи, как перевести список покупок','Ещё кефир','кефир'],
 ['EN-TRANSLATE-INDIRECT','Show how to say shopping list in Ukrainian','Also milk','milk'],
] as const)test('R2 QA exact '+id+' cannot select a real list for a later additive request',async()=>{
 await request(body,{operation:'list',category:'shopping'});
 const pointers=(await one(db,"SELECT count(*)::int n FROM domain_commands WHERE result->>'context_only'='true'"))!.n;
 let result:any,error='';
 try{result=await request(follow,{operation:'add',category:'shopping',text});}catch(e){error=String(e);}
 const events=(await one(db,'SELECT count(*)::int n FROM simple_list_events'))!.n;
 assert.equal(pointers,0,JSON.stringify({body,pointers,result,error,events}));
 assert.match(error,/list_request_unconfirmed/);assert.equal(events,0);
});

test('R2 indirect examples, language, definitions and instructions never become a current list selection',async()=>{
 for(const [body,category,follow,text] of [
  ['Покажи, будь ласка, зразок списку покупок','shopping','Ще кефір','кефір'],
  ['Покажи список покупок як приклад','shopping','Ще кефір','кефір'],
  ['Покажи на прикладі списку покупок, як його вести','shopping','Ще кефір','кефір'],
  ['Покажи, як правильно скласти список покупок','shopping','Ще кефір','кефір'],
  ['Покажи, що значить список покупок','shopping','Ще кефір','кефір'],
  ['Покажи, як сказати список покупок англійською','shopping','Ще кефір','кефір'],
  ['Покажи образец списка дел','todo','Ещё позвонить мастеру','позвонить мастеру'],
  ['Покажи, как произносится список покупок','shopping','Ещё кефир','кефир'],
  ['Покажи толкование слов список покупок','shopping','Ещё кефир','кефир'],
  ['Show me an example shopping list','shopping','Also milk','milk'],
  ['Show how to write a shopping list','shopping','Also milk','milk'],
  ['Read an example task list','todo','Also call the plumber','call the plumber'],
  ['Display a template shopping list','shopping','Also milk','milk'],
  ['Show the translation of shopping list','shopping','Also milk','milk'],
  ['Show what shopping list means','shopping','Also milk','milk'],
  ['What examples of shopping lists can you show?','shopping','Also milk','milk'],
 ] as const){
  await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');await db.query('DELETE FROM messages');
  await request(body,{operation:'list',category});
  assert.equal((await one(db,"SELECT count(*)::int n FROM domain_commands WHERE result->>'context_only'='true'"))!.n,0,body);
  await assert.rejects(request(follow,{operation:'add',category,text}),/list_request_unconfirmed/,body);
  assert.equal((await one(db,'SELECT count(*)::int n FROM simple_list_events'))!.n,0,body);
 }
});

test('R2 genuine own-list reads keep their own clause category beside a separate meta request',async()=>{
 for(const [body,category,follow,text] of [
  ['Покажи наш список справ і переклади слово «shopping»','todo','Ще подзвонити майстру','подзвонити майстру'],
  ['Переклади приклад списку покупок. Покажи наш список справ','todo','Ще подзвонити майстру','подзвонити майстру'],
  ['Покажи наш список справ; покажи приклад списку покупок','todo','Ще подзвонити майстру','подзвонити майстру'],
  ['Покажи наш список дел и объясни, как перевести список покупок','todo','Ещё позвонить мастеру','позвонить мастеру'],
  ['Show my task list and explain how to say shopping list in Ukrainian','todo','Also call the plumber','call the plumber'],
  ['Show my task list; show an example shopping list','todo','Also call the plumber','call the plumber'],
  ['Show how to say shopping list in Ukrainian. Show my task list','todo','Also call the plumber','call the plumber'],
  ['Show my task list containing «Example: translate shopping list»','todo','Also call the plumber','call the plumber'],
  ['Покажи мій список справ із пунктом «приклад списку покупок»','todo','Ще подзвонити майстру','подзвонити майстру'],
  ['Show how many items are in my shopping list','shopping','Also milk','milk'],
  ['Покажи, скільки пунктів у нашому списку покупок','shopping','Ще кефір','кефір'],
  ['Read my shopping list','shopping','Also milk','milk'],
 ] as const){
  await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');await db.query('DELETE FROM messages');
  await assert.rejects(request(body,{operation:'list',category:category==='shopping'?'todo':'shopping'}),/list_category_unconfirmed/,body+' / foreign meta category');
  await request(body,{operation:'list',category});
  const pointers=(await db.query("SELECT result FROM domain_commands WHERE result->>'context_only'='true'")).rows;
  assert.deepEqual(pointers.map(row=>row.result.category),[category],body);
  assert.deepEqual((await request(follow,{operation:'add',category,text})).added,[text],body);
 }
});

test('R2 a meta-only read after a genuine view cannot refresh or reuse the previous view authority',async()=>{
 const first=await source('Покажи наш список покупок');await run({operation:'list',category:'shopping'},context({sourceId:first}));
 const meta=await source('Покажи, як перекласти список покупок');await run({operation:'list',category:'shopping'},context({sourceId:meta}));
 assert.deepEqual((await db.query("SELECT source_message_id FROM domain_commands WHERE result->>'context_only'='true'")).rows.map(row=>Number(row.source_message_id)),[first]);
 await assert.rejects(request('Ще кефір',{operation:'add',category:'shopping',text:'кефір'}),/list_request_unconfirmed/);
 assert.equal((await one(db,'SELECT count(*)::int n FROM simple_list_events'))!.n,0);
 await request('Покажи наш список покупок',{operation:'list',category:'shopping'});
 assert.deepEqual((await request('Ще кефір',{operation:'add',category:'shopping',text:'кефір'})).added,['кефір']);
});

for(const [id,body] of [
 ['UA-CREATE','Покажи, як створити список покупок'],
 ['UA-MAKE','Покажи, як зробити список покупок'],
 ['RU-MAKE','Покажи, как сделать список покупок'],
 ['EN-BUILD','Show how to build a shopping list'],
 ['EN-PRONUNCIATION','Display the pronunciation of shopping list'],
] as const)test('R3 QA exact '+id+' informational request cannot authorize a real additive mutation',async()=>{
 await request(body,{operation:'list',category:'shopping'});
 const pointers=(await one(db,"SELECT count(*)::int n FROM domain_commands WHERE result->>'context_only'='true'"))!.n;
 let result:any,error='';try{result=await request('Ще кефір',{operation:'add',category:'shopping',text:'кефір'});}catch(e){error=String(e);}
 const events=(await one(db,'SELECT count(*)::int n FROM simple_list_events'))!.n;
 assert.equal(pointers,0,JSON.stringify({body,pointers,result,error,events}));assert.match(error,/list_request_unconfirmed/);assert.equal(events,0);
});

for(const type of ['blockquote','expandable_blockquote'] as const)for(const kind of ['translation_quoted_read','real_read_outside_quote'] as const)test('R3 QA native '+type+' '+kind+' keeps only actual unquoted own-read authority',async()=>{
 await db.reset();const h=harness(db);await paired(h);
 const quoted=kind==='translation_quoted_read'?'Покажи список покупок':'Покажи список справ';
 const displayed=kind==='translation_quoted_read'?'Люмен, переклади англійською:\n'+quoted:'Люмен, покажи наш список покупок.\n'+quoted;
 const update=message(displayed);(update.message as any).entities=[{type,offset:displayed.indexOf(quoted),length:quoted.length}];
 const turn=async(update:ReturnType<typeof message>)=>{await h.lumen.receive(update);await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");return h.lumen.processNext();};
 h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'list',category:'shopping'})}]},{reply:'',actions:[]});
 assert.equal(await turn(update),true);
 const pointers=(await db.query("SELECT result,source_message_id FROM domain_commands WHERE result->>'context_only'='true'")).rows;
 h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',text:'кефір'})}]},{reply:'',actions:[]});
 await turn(message('Ще кефір'));
 const events=(await db.query('SELECT text,category,source_message_id FROM simple_list_events ORDER BY ordinal')).rows;
 const detail=JSON.stringify({kind,type,displayed,entities:(update.message as any).entities,pointers,events});
 assert.deepEqual(pointers.map(row=>row.result.category),kind==='translation_quoted_read'?[]:['shopping'],detail);
 assert.deepEqual(events.map(row=>row.text),kind==='translation_quoted_read'?[]:['кефір'],detail);
});

test('R3 direct objects and concrete data questions preserve natural current-list views',async()=>{
 for(const [body,category,follow,text] of [
  ['Будь ласка, покажи мені наш список покупок','shopping','Ще кефір','кефір'],
  ['Пожалуйста, покажи мне наш список дел','todo','Ещё позвонить мастеру','позвонить мастеру'],
  ['Please show me my shopping list','shopping','Also milk','milk'],
  ['Покажіть наш список покупок','shopping','Ще кефір','кефір'],
  ['Перегляньте наш список справ','todo','Ще подзвонити майстру','подзвонити майстру'],
  ['Що залишилося зробити?','todo','Ще подзвонити майстру','подзвонити майстру'],
  ['Что осталось сделать?','todo','Ещё позвонить мастеру','позвонить мастеру'],
  ['What is left to do?','todo','Also call the plumber','call the plumber'],
  ['Що є в нашому списку покупок?','shopping','Ще кефір','кефір'],
  ['Скільки пунктів у нашому списку покупок?','shopping','Ще кефір','кефір'],
  ['How many items are on my shopping list?','shopping','Also milk','milk'],
  ['Покажи, як виглядає наш список покупок','shopping','Ще кефір','кефір'],
  ['Show how my shopping list looks','shopping','Also milk','milk'],
  ['Show how does my shopping list look','shopping','Also milk','milk'],
 ] as const){
  await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');await db.query('DELETE FROM messages');
  await request(body,{operation:'list',category});
  assert.deepEqual((await request(follow,{operation:'add',category,text})).added,[text],body);
 }
});

test('R3 a generic method or informational object has no current-list authority regardless of its verb vocabulary',async()=>{
 for(const body of [
  'Покажи, як організувати список покупок','Покажи, як буде список покупок українською',
  'Покажи алгоритм списку покупок','Покажи, як ремонтувати список покупок',
  'Покажи, как устроить список покупок','Show how to curate a shopping list',
  'Show how shopping lists work','What should a shopping list look like?',
  'Show a shopping list','Display the phonetic form of shopping list',
  'Show instructions for my shopping list','Покажи список покупок для прикладу',
  'Показав наш список покупок','Показ списку покупок','Прочитав наш список покупок',
 ]){
  await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');await db.query('DELETE FROM messages');
  await request(body,{operation:'list',category:'shopping'});
  assert.equal((await one(db,"SELECT count(*)::int n FROM domain_commands WHERE result->>'context_only'='true'"))!.n,0,body);
  await assert.rejects(request('Ще кефір',{operation:'add',category:'shopping',text:'кефір'}),/list_request_unconfirmed/,body);
  assert.equal((await one(db,'SELECT count(*)::int n FROM simple_list_events'))!.n,0,body);
 }
});

test('R3 received text and caption use original UTF16 quote ranges for both authority directions',async()=>{
 for(const type of ['blockquote','expandable_blockquote','pre','code'])for(const field of ['text','caption'])for(const positive of [false,true]){
  await db.reset();const h=harness(db);await paired(h);
  const quoted=positive?'Покажи список справ':'Покажи список покупок';
  const displayed=(positive?'Люмен, покажи наш список покупок.\n🧠 ':'Люмен, переклади англійською 🧠:\n')+quoted;
  const update=message(displayed),native=update.message as any;
  const entities=[{type,offset:displayed.indexOf(quoted),length:quoted.length}];
  if(field==='caption'){delete native.text;native.caption=displayed;native.caption_entities=entities;}else native.entities=entities;
  const turn=async(update:ReturnType<typeof message>)=>{await h.lumen.receive(update);await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");return h.lumen.processNext();};
  h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'list',category:'shopping'})}]},{reply:'',actions:[]});
  assert.equal(await turn(update),true);
  const selected=(await db.query("SELECT result FROM domain_commands WHERE result->>'context_only'='true'")).rows.map(row=>row.result.category);
  h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',text:'кефір'})}]},{reply:'',actions:[]});
  await turn(message('Ще кефір'));
  const items=(await db.query('SELECT text FROM simple_list_events ORDER BY ordinal')).rows.map(row=>row.text);
  const detail=JSON.stringify({type,field,positive,displayed,entities,selected,items});
  assert.deepEqual(selected,positive?['shopping']:[],detail);assert.deepEqual(items,positive?['кефір']:[],detail);
 }
});

test('R3 only matching actual-source native metadata can qualify a read and malformed metadata never falls back to raw text',async()=>{
 for(const scenario of ['absent_entities','bold','other_field_quote','wrong_message','wrong_actor','wrong_chat','wrong_topic','wrong_body','nonarray','null_entity','missing_range','negative_range','oversize_range','fractional_range'] as const){
  await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');await db.query('DELETE FROM messages');await db.query('DELETE FROM inbox');
  const body='Покажи наш список покупок',id=await source(body,'11','0',false),saved=(await one(db,'SELECT telegram_id FROM messages WHERE id=$1',[id]))!;
  const native:any={message_id:Number(saved.telegram_id),from:{id:11},chat:{id:-100,type:'supergroup'},text:body};
  if(scenario==='bold')native.entities=[{type:'bold',offset:0,length:body.length}];
  if(scenario==='other_field_quote')native.caption_entities=[{type:'blockquote',offset:0,length:'Покажи список справ'.length}];
  if(scenario==='wrong_message')native.message_id++;
  if(scenario==='wrong_actor')native.from.id=22;
  if(scenario==='wrong_chat')native.chat.id=-200;
  if(scenario==='wrong_topic')native.message_thread_id=7;
  if(scenario==='wrong_body')native.text='🧠 '+body;
  if(scenario==='nonarray')native.entities={type:'blockquote',offset:0,length:body.length};
  if(scenario==='null_entity')native.entities=[null];
  if(scenario==='missing_range')native.entities=[{type:'blockquote'}];
  if(scenario==='negative_range')native.entities=[{type:'blockquote',offset:-1,length:1}];
  if(scenario==='oversize_range')native.entities=[{type:'blockquote',offset:0,length:body.length+1}];
  if(scenario==='fractional_range')native.entities=[{type:'blockquote',offset:0.5,length:1}];
  await db.query('INSERT INTO inbox(update_id,payload,revision) VALUES($1,$2,0)',[++n,JSON.stringify({sourceId:id,message:native})]);
  await db.tx(sql=>captureOriginalRequestContext(sql,id,native,{namespaceChatId:'-100',sourceTopicId:'0'}));
  await run({operation:'list',category:'shopping'},context({sourceId:id,requestText:'untrusted extracted text is ignored'}));
  const positive=['absent_entities','bold','other_field_quote'].includes(scenario);
  assert.equal((await one(db,"SELECT count(*)::int n FROM domain_commands WHERE result->>'context_only'='true'"))!.n,positive?1:0,scenario);
  if(positive)assert.deepEqual((await request('Ще кефір',{operation:'add',category:'shopping',text:'кефір'})).added,['кефір'],scenario);
  else await assert.rejects(request('Ще кефір',{operation:'add',category:'shopping',text:'кефір'}),/list_request_unconfirmed/,scenario);
 }
});

test('read selection is erased with its source or viewed item sources and never bypasses a new revision or pause',async()=>{
 await request('Додай джерело-v3-молоко до покупок',{operation:'add',category:'shopping',text:'молоко'});
 await request('Покажи список покупок',{operation:'list',category:'shopping'});
 assert.equal((await one(db,"SELECT count(*)::int n FROM domain_commands WHERE result->>'context_only'='true'"))!.n,1);
 await db.tx(sql=>forgetPhrase(sql,'джерело-v3-молоко'));
 assert.equal((await one(db,"SELECT count(*)::int n FROM domain_commands WHERE result->>'context_only'='true'"))!.n,0);
 const revision=(await state(db)).memory_revision;
 await assert.rejects(request('Ще сир',{operation:'add',category:'shopping',text:'сир'},{revision}),/list_request_unconfirmed/);
 await request('Покажи список покупок',{operation:'list',category:'shopping'},{revision});
 await db.query('UPDATE app_state SET paused=true');
 await assert.rejects(request('Ще сир',{operation:'add',category:'shopping',text:'сир'},{revision}),/task_cancelled/);
});

test('an immediately preceding two-category request does not grant an arbitrary additive category',async()=>{
 const body='Додай хліб до покупок і запиши подзвонити майстру до справ',id=await source(body),c=context({sourceId:id});
 await run({operation:'add',category:'shopping',text:'хліб'},c);await run({operation:'add',category:'todo',text:'подзвонити майстру'},c);
 const follow=await source('Ще молоко');assert.equal(await isListAddContinuation(db,context({sourceId:follow}),'shopping'),false);
 await assert.rejects(run({operation:'add',category:'shopping',text:'молоко'},context({sourceId:follow})),/list_request_unconfirmed/);
});

test('explicit imperative destinations bind category for add even if the model quote omits the destination',async()=>{
 for(const [body,category,text,quote] of [
  ['Додай молоко до покупок','todo','молоко',undefined],
  ['Додай молоко до покупок','todo','молоко','Додай молоко'],
  ['Додай молоко до мого списку покупок','todo','молоко',undefined],
  ['Додай молоко до списку моїх покупок','todo','молоко',undefined],
  ['Запиши подзвонити майстру до справ','shopping','подзвонити майстру',undefined],
  ['Добавь молоко в список покупок','todo','молоко',undefined],
  ['Добавь позвонить мастеру в список дел','shopping','позвонить мастеру',undefined],
  ['Добавь позвонить мастеру в этот список дел','shopping','позвонить мастеру',undefined],
  ['Add milk to our shared shopping list','todo','milk',undefined],
  ['Add milk to my shopping list','todo','milk',undefined],
  ['Add call the plumber to my task list','shopping','call the plumber',undefined],
 ] as const)await assert.rejects(request(body,{operation:'add',category,text,...(quote?{quote}:{})}),/list_category_unconfirmed/,body);
 assert.equal((await one(db,'SELECT count(*)::int n FROM simple_list_events'))!.n,0);
 for(const [body,category,text] of [
  ['Додай молоко до мого списку покупок','shopping','молоко'],
  ['Добавь позвонить мастеру в этот список дел','todo','позвонить мастеру'],
  ['Add milk to our shared shopping list','shopping','milk'],
 ] as const)assert.deepEqual((await request(body,{operation:'add',category,text})).added,[text]);
});

test('complete/remove cannot target todo under an explicit shopping request',async()=>{
 await request('Додай молоко до покупок',{operation:'add',category:'shopping',text:'молоко'});
 await request('Додай молоко до справ',{operation:'add',category:'todo',text:'молоко'});
 for(const operation of ['complete','remove'] as const){
  const body=operation==='complete'?'Познач молоко в покупках як зроблене':'Прибери молоко з покупок';
  await assert.rejects(request(body,{operation,category:'todo',text:'молоко'}),/list_category_unconfirmed/);
 }
 assert.equal((await run({operation:'list',category:'todo'},context())).items.length,1);
 assert.equal((await run({operation:'list',category:'shopping'},context())).items.length,1);
});

test('mixed imperative clauses keep category and targets while quoted item words do not select another category',async()=>{
 const body='Додай молоко до покупок і запиши подзвонити майстру до справ';
 assert.equal((await request(body,{operation:'add',category:'shopping',text:'подзвонити майстру'})).status,'needs_input');
 assert.equal((await request(body,{operation:'add',category:'todo',text:'молоко'})).status,'needs_input');
 assert.deepEqual((await request(body,{operation:'add',category:'shopping',text:'молоко'})).added,['молоко']);
 assert.deepEqual((await request(body,{operation:'add',category:'todo',text:'подзвонити майстру'})).added,['подзвонити майстру']);
 assert.deepEqual((await request('Додай «список покупок» до справ',{operation:'add',category:'todo',text:'список покупок'})).added,['список покупок']);
 assert.deepEqual((await request('Додай «молоко до списку покупок» до справ',{operation:'add',category:'todo',text:'молоко до списку покупок'})).added,['молоко до списку покупок']);
 assert.equal((await request('Додай це до покупок, а до справ подзвонити майстру',{operation:'add',category:'shopping',text:'подзвонити майстру',quote:'Додай це до покупок'})).status,'needs_input');
});

test('actual foreground view then additive continuation persists once without a forced repeated command',async()=>{
 await db.reset();const h=harness(db);await paired(h);
 const turn=async(body:string,action:any)=>{
  h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'lists.manage',arguments:JSON.stringify(action)}]},{reply:'',actions:[]});
  await h.lumen.receive(message(body));await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");assert.equal(await h.lumen.processNext(),true);
 };
 await turn('Люмен, список покупок: молоко',{operation:'add',category:'shopping',text:'молоко'});
 await turn('Люмен, що лишилося купити?',{operation:'list',category:'shopping'});
 await turn('Ще кефір',{operation:'add',category:'shopping',text:'кефір'});
 assert.equal((await one(db,"SELECT count(*)::int n FROM simple_list_events WHERE text='кефір'"))!.n,1);
 const reply=String((await one(db,"SELECT body->>'text' text FROM outbox WHERE dedup_key LIKE 'answer:%' ORDER BY id DESC LIMIT 1"))?.text||'');
 assert.match(reply,/кефір/iu);assert.doesNotMatch(reply,/уточни|повтори|list_request_unconfirmed/iu);
});
