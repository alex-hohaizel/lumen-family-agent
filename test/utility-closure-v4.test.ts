import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {TestDB,harness,paired,message} from './helpers.js';
import {SimpleLists,ListCommand} from '../src/simple-lists.js';
import {one,state,forgetPhrase} from '../src/db.js';

let db:TestDB,h:ReturnType<typeof harness>;
before(async()=>{db=new TestDB();await db.init();});after(async()=>db.close());
beforeEach(async()=>{await db.reset();await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');h=harness(db);await paired(h);});
async function turn(body:string,args:any,extra:{type?:string;quoted?:string;caption?:boolean;actor?:number;topic?:number}={}){
 const update=message(body,extra.actor||11),native=update.message as any;
 if(extra.topic)native.message_thread_id=extra.topic;
 const entities=extra.type&&extra.quoted?[{type:extra.type,offset:body.indexOf(extra.quoted),length:extra.quoted.length}]:undefined;
 if(extra.caption){delete native.text;native.caption=body;if(entities)native.caption_entities=entities;}else if(entities)native.entities=entities;
 h.brain.replies.push({reply:'',actions:(Array.isArray(args)?args:[args]).map(value=>({kind:'tool' as const,name:'lists.manage',arguments:JSON.stringify(value)}))},{reply:'',actions:[]});
 await h.lumen.receive(update);await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");
 return {processed:await h.lumen.processNext(),update};
}
const events=async()=>(await db.query('SELECT operation,text,category,source_message_id FROM simple_list_events ORDER BY ordinal')).rows;
const pointers=async()=>(await db.query("SELECT result,source_message_id,source_ids FROM domain_commands WHERE result->>'context_only'='true'")).rows;
const mutations=async()=>(await db.query("SELECT result,source_message_id FROM domain_commands WHERE result->>'operation'<>'list'")).rows;

for(const type of ['blockquote','expandable_blockquote'])test('V4 baseline exact native translation '+type+' cannot write a quoted imperative',async()=>{
 const quoted='Додай кефір до покупок',body='Люмен, переклади англійською:\n'+quoted;
 assert.equal((await turn(body,{operation:'add',category:'shopping',text:'кефір',quote:quoted},{type,quoted})).processed,true);
 assert.deepEqual(await events(),[]);assert.deepEqual(await mutations(),[]);
 assert.doesNotMatch(JSON.stringify((await db.query("SELECT body FROM outbox WHERE dedup_key LIKE 'answer:%'")).rows),/Додав[^\n]{0,80}кефір/iu);
});

for(const [id,view] of [['UA','Що у нас у списку покупок?'],['EN','Can you show our shopping list?'],['CONTROL','Покажи наш список покупок']] as const)test('V4 baseline own-view '+id+' keeps the next simple additive request',async()=>{
 assert.equal((await turn('Люмен, '+view,{operation:'list',category:'shopping'})).processed,true);
 assert.deepEqual((await pointers()).map(row=>row.result.category),['shopping']);
 await turn('Ще кефір',{operation:'add',category:'shopping',text:'кефір'});
 assert.deepEqual((await events()).map(row=>row.text),['кефір']);
 assert.equal((await one(db,'SELECT count(*)::int n FROM stock_movements'))!.n,0);
});

test('V4 actual outer add preserves quoted literal DATA and does not execute quoted item verbs',async()=>{
 for(const [body,target,category,type,quoted,caption] of [
  ['Люмен, додай «кефір» до покупок','кефір','shopping',undefined,undefined,false],
  ['Люмен, додай ‘кефір’ до покупок','кефір','shopping',undefined,undefined,false],
  ['Люмен, додай кефір до покупок','кефір','shopping','blockquote','кефір',false],
  ['Люмен, додай до покупок:\nкефір','кефір','shopping','blockquote','кефір',false],
  ['Люмен, додай до покупок:\nкефір','кефір','shopping','expandable_blockquote','кефір',true],
  ['Люмен, запиши до справ:\nПрибери молоко з покупок','Прибери молоко з покупок','todo','pre','Прибери молоко з покупок',false],
 ] as const){
  await db.reset();await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');h=harness(db);await paired(h);
  await turn('Люмен, додай молоко до покупок',{operation:'add',category:'shopping',text:'молоко'});
  await turn(body,{operation:'add',category,text:target},{type,quoted,caption});
  assert.deepEqual((await events()).map(row=>[row.operation,row.text,row.category]),[['add','молоко','shopping'],['add',target,category]],body);
 }
});

test('V4 actual native translated add complete remove in text and caption have zero committed effects or receipts',async()=>{
 for(const type of ['blockquote','expandable_blockquote','code','pre'])for(const caption of [false,true])for(const operation of ['add','complete','remove'] as const){
  await db.reset();await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');h=harness(db);await paired(h);
  await turn('Люмен, додай молоко до покупок',{operation:'add',category:'shopping',text:'молоко'});
  const target=operation==='add'?'кефір':'молоко',quoted=operation==='add'?'Додай кефір до покупок':operation==='complete'?'Познач молоко як зроблене':'Прибери молоко з покупок';
  const before=await events(),receipts=await mutations();
  await turn('Люмен, переклади англійською 🧠:\n'+quoted,{operation,category:'shopping',text:target,quote:quoted},{type,quoted,caption});
  assert.deepEqual(await events(),before,JSON.stringify({type,caption,operation}));assert.deepEqual(await mutations(),receipts);
 }
});

test('V4 real outside add beside a quoted other command only commits its own category and material',async()=>{
 const quoted='Прибери молоко з покупок',body='Люмен, додай молоко до покупок.\n'+quoted;
 await turn(body,[{operation:'add',category:'shopping',text:'молоко',quote:'додай молоко до покупок'},{operation:'remove',category:'shopping',text:'молоко',quote:quoted}],{type:'blockquote',quoted});
 assert.deepEqual((await events()).map(row=>[row.operation,row.text]),[['add','молоко']]);assert.equal((await mutations()).length,1);
 await turn('Люмен, додай список покупок до справ',{operation:'add',category:'todo',text:'список покупок'},{type:'code',quoted:'список покупок'});
 assert.deepEqual((await events()).map(row=>[row.text,row.category]),[['молоко','shopping'],['список покупок','todo']]);
});

test('V4 original proof survives cleaned inbox and replay but legacy unknown and forgotten sources grant no authority',async()=>{
 const read=await turn('Люмен, Can you show our shopping list?',{operation:'list',category:'shopping'});
 const selected=(await pointers())[0]!;assert.ok(selected);
 assert.ok((await one(db,'SELECT request_context FROM messages WHERE id=$1',[selected.source_message_id]))!.request_context);
 await db.query('DELETE FROM inbox');
 const add=await turn('Ще кефір',{operation:'add',category:'shopping',text:'кефір'}),source=(await one(db,"SELECT id FROM messages WHERE role='user' AND telegram_id=$1",[add.update.message!.message_id]))!;
 const context={actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:'v4-repeat',requested:true,sourceId:Number(source.id)};
 await db.query('DELETE FROM inbox');await new SimpleLists(db).run(ListCommand.parse({operation:'add',category:'shopping',text:'кефір'}),context);
 assert.equal((await events()).length,1);assert.equal((await mutations()).length,1);
 const legacy=(await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES(44000001,'11','Legacy','user','Додай банани до покупок','0') RETURNING id"))!;
 await assert.rejects(new SimpleLists(db).run(ListCommand.parse({operation:'add',category:'shopping',text:'банани'}),{...context,sourceId:Number(legacy.id)}),/list_request_unconfirmed/);
 assert.equal((await events()).length,1);
 await db.tx(sql=>forgetPhrase(sql,'Ще кефір'));const revision=(await state(db)).memory_revision;
 await assert.rejects(new SimpleLists(db).run(ListCommand.parse({operation:'add',category:'shopping',text:'кефір'}),{...context,revision}),/list_current_source_required|list_request_unconfirmed/);
 assert.equal((await events()).length,0);assert.ok(read.processed);
});

test('V4 the two natural wrappers cannot select a model chosen wrong category or authorize quoted continuation',async()=>{
 for(const view of ['Що у нас у списку покупок?','Can you show our shopping list?']){
  await db.reset();await db.query('TRUNCATE simple_list_events,domain_commands CASCADE');h=harness(db);await paired(h);
  await turn('Люмен, '+view,{operation:'list',category:'todo'});assert.deepEqual(await pointers(),[]);
  await turn('Ще кефір',{operation:'add',category:'shopping',text:'кефір'});assert.deepEqual(await events(),[]);
 }
 await turn('Люмен, покажи наш список покупок',{operation:'list',category:'shopping'});
 const quoted='Ще кефір';await turn('Люмен, переклади:\n'+quoted,{operation:'add',category:'shopping',text:'кефір',quote:quoted},{type:'expandable_blockquote',quoted});
 assert.deepEqual(await events(),[]);
});
