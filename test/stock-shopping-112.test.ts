import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TestDB,harness} from './helpers.js';
import {Household,StockCommand,stockSnapshotSourceSymbol} from '../src/household.js';
import {eraseAll,forgetPhrase,one} from '../src/db.js';
import {AgentTools} from '../src/agent-tools.js';
import type {ToolContext} from '../src/agent-tools.js';

let db:TestDB,stock:Household,n=42000;
const context=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:String(++n),requested:true,...extra});
const run=(args:any,c=context())=>stock.run(StockCommand.parse(args),c);
const source=async(body:string)=>Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES($1,'11','А','user',$2) RETURNING id",[++n,body])).rows[0]!.id);
const create=async(name='Яблука',quantity?:string)=>(await run({operation:'create',item:name,unit:'piece',...(quantity===undefined?{}:{quantity})})).item;
const change=async(item:any,operation:string,quantity:string,extra:any={},c=context())=>run({operation,id:item.id,version:item.version,quantity,unit:'piece',...extra},c);
const list=async(c=context())=>(await run({operation:'list'},c)).items;
const reserve=async(item:any,quantity:string,extra:any={},c=context())=>change(item,'reserve',quantity,extra,c);
const own=(item:any,id:string)=>item.own_reservations.find((r:any)=>r.id===id);

before(async()=>{db=new TestDB();await db.init();});
after(async()=>db.close());
beforeEach(async()=>{
 await db.reset();await db.query('TRUNCATE stock_items,domain_commands CASCADE');
 await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',participants='[]',memory_revision=0,paused=false WHERE id=1");
 for(const id of ['11','22','33'])await db.query('INSERT INTO members(user_id,name,active) VALUES($1,$2,true)',[id,'Учасник '+id]);
 stock=new Household(db);
});

test('shopping is the default and is limited by independent need, not physical stock',async()=>{
 let item=await create('Відомий запас','10');item=(await change(item,'need','2')).item;
 await assert.rejects(reserve(item,'8'),/insufficient_need/);
 const claim=await reserve(item,'2');item=claim.item;
 assert.deepEqual([item.stock,item.need,item.reserved,item.available,item.shopping_reserved,item.need_unclaimed],['10','2','0','10','2','0']);
 assert.equal(own(item,claim.operation_id).purpose,'shopping');
 item=(await reserve(item,'8',{purpose:'stock'})).item;
 assert.deepEqual([item.stock,item.reserved,item.available,item.shopping_reserved],['10','8','2','2']);

 let unknown=await create('Невідомий запас');unknown=(await change(unknown,'need','2')).item;unknown=(await reserve(unknown,'2')).item;
 assert.deepEqual([unknown.stock,unknown.available,unknown.shopping_reserved],[null,null,'2']);
 await assert.rejects(reserve(unknown,'1',{purpose:'stock'}),/stock_needs_recount/);
 let low=await create('Малий запас','1');low=(await change(low,'need','2')).item;low=(await reserve(low,'2')).item;
 assert.deepEqual([low.stock,low.available,low.shopping_reserved],['1','1','2']);
});

test('20 competing shopping claims on one version produce one commit and no purchases',async()=>{
 let item=await create();item=(await change(item,'need','2')).item;
 const results=await Promise.allSettled(Array.from({length:20},()=>reserve(item,'2'))),won=results.filter((r):r is PromiseFulfilledResult<any>=>r.status==='fulfilled');
 assert.equal(won.length,1);assert.ok(results.filter(r=>r.status==='rejected').every(r=>/version_conflict/.test(String(r.reason))));
 item=won[0]!.value.item;assert.deepEqual([item.stock,item.need,item.shopping_reserved,item.need_unclaimed],[null,'2','2','0']);
 await assert.rejects(reserve(item,'0.001'),/insufficient_need/);
 assert.equal((await one(db,'SELECT count(*)::int AS n FROM stock_reservations'))!.n,1);
 assert.equal((await one(db,"SELECT count(*)::int AS n FROM stock_movements WHERE kind='purchase'"))!.n,0);
});

test('partial purchases divide exact milli-units among the author claims and never credit another author',async()=>{
 let item=await create('Пропорції','1');item=(await change(item,'need','10')).item;
 const a=await reserve(item,'2');item=a.item;const b=await reserve(item,'4');item=b.item;const other=await reserve(item,'4',{},context({actorId:'22'}));item=other.item;
 item=(await change(item,'purchase','3')).item;
 assert.deepEqual([own(item,a.operation_id).quantity,own(item,b.operation_id).quantity],['1','2']);
 let theirs=(await list(context({actorId:'22'})))[0];assert.equal(own(theirs,other.operation_id).quantity,'4');
 assert.deepEqual([item.stock,item.need,item.reserved,item.available,item.shopping_reserved,item.need_unclaimed],['4','7','0','4','7','0']);
 // Immutable claim evidence is distinct from its current, derived remainder.
 assert.deepEqual((await db.query("SELECT quantity::text FROM stock_reservations WHERE actor_id='11' ORDER BY sequence")).rows.map(r=>r.quantity),['2000','4000']);
 item=(await change(item,'purchase','0.001')).item;
 assert.deepEqual([own(item,a.operation_id).quantity,own(item,b.operation_id).quantity],['1','1.999']);
 item=(await change(item,'purchase','1',{},context({actorId:'33'}))).item;
 theirs=(await list(context({actorId:'22'})))[0];assert.equal(own(theirs,other.operation_id).quantity,'4');
 assert.equal(item.shopping_reserved,'6.999');assert.equal(item.need,'5.999');assert.equal(item.need_unclaimed,'0');
 assert.ok(item.reservations_needing_reconcile.every((r:any)=>r.status==='needs_reconcile'));
 assert.equal(item.reservations_needing_reconcile.length,3);
});

test('need reduction exposes overclaims without subtracting physical stock or claiming a purchase',async()=>{
 let item=await create('Потреба','10');item=(await change(item,'need','4')).item;
 const first=await reserve(item,'2');item=first.item;const second=await reserve(item,'2',{},context({actorId:'22'}));item=second.item;
 item=(await change(item,'need','1')).item;
 assert.deepEqual([item.stock,item.available,item.need,item.shopping_reserved,item.need_unclaimed],['10','10','1','4','0']);
 assert.equal(item.reservations_needing_reconcile.length,2);assert.equal(own(item,first.operation_id).status,'needs_reconcile');
 await assert.rejects(run({operation:'release',id:item.id,version:item.version,reservation_id:first.operation_id},context({actorId:'22'})),/own_active_reservation_required/);
 item=(await run({operation:'release',id:item.id,version:item.version,reservation_id:second.operation_id},context({actorId:'22'}))).item;
 assert.equal(item.shopping_reserved,'2');assert.equal(item.need_unclaimed,'0');assert.equal(item.reservations_needing_reconcile.length,1);
 item=(await run({operation:'release',id:item.id,version:item.version,reservation_id:first.operation_id})).item;
 assert.deepEqual([item.shopping_reserved,item.need_unclaimed],['0','1']);
 assert.equal((await one(db,"SELECT count(*)::int AS n FROM stock_movements WHERE kind='purchase'"))!.n,0);
});

test('consumption can spend only an owned active stock hold and protects all other stock holds',async()=>{
 let item=await create('Фізичні резерви','10');item=(await change(item,'need','2')).item;
 const shopping=await reserve(item,'2');item=shopping.item;
 await assert.rejects(change(item,'consume','1',{reservation_id:shopping.operation_id}),/own_reservation_insufficient/);
 const physical=await reserve(item,'4',{purpose:'stock'});item=physical.item;
 await assert.rejects(change(item,'consume','1',{reservation_id:physical.operation_id},context({actorId:'22'})),/own_reservation_insufficient/);
 item=(await change(item,'consume','2',{reservation_id:physical.operation_id})).item;
 assert.deepEqual([item.stock,item.reserved,item.available,item.shopping_reserved],['8','2','6','2']);
 await assert.rejects(change(item,'consume','7'),/negative_or_reserved_stock/);
 item=(await run({operation:'release',id:item.id,version:item.version,reservation_id:physical.operation_id})).item;
 assert.deepEqual([item.stock,item.reserved,item.available,item.shopping_reserved],['8','0','8','2']);
});

test('reversing a linked consume restores exactly its owner stock hold once',async()=>{
 let item=await create('Точний physical undo','4');const held=await reserve(item,'2',{purpose:'stock'});item=held.item;
 const consumed=await change(item,'consume','2',{reservation_id:held.operation_id});item=consumed.item;
 assert.deepEqual([item.stock,item.reserved,item.available,item.own_reservations.length],['2','0','2',0]);
 const movement=await one(db,'SELECT reservation_id FROM stock_movements WHERE id=$1',[consumed.operation_id]);assert.equal(movement!.reservation_id,held.operation_id);
 const hold=await one(db,'SELECT initial_quantity::text,quantity::text FROM stock_reservations WHERE id=$1',[held.operation_id]);assert.deepEqual([hold!.initial_quantity,hold!.quantity],['2000','0']);
 const args={operation:'reverse',id:item.id,version:item.version,movement_id:consumed.operation_id},c=context({actorId:'22'}),reversed=await run(args,c);item=reversed.item;
 assert.deepEqual([item.stock,item.reserved,item.available,item.own_reservations.length],['4','2','2',0]);
 const owner=(await list())[0];assert.equal(own(owner,held.operation_id).quantity,'2');assert.equal(own(owner,held.operation_id).status,'active');
 assert.deepEqual(await run(args,c),reversed);await assert.rejects(run({operation:'reverse',id:item.id,version:item.version,movement_id:consumed.operation_id}),/already_reversed/);
 await assert.rejects(change(item,'consume','1',{reservation_id:held.operation_id},context({actorId:'22'})),/own_reservation_insufficient/);
 assert.deepEqual((await db.query('SELECT initial_quantity::text,quantity::text FROM stock_reservations WHERE id=$1',[held.operation_id])).rows.map(r=>[r.initial_quantity,r.quantity]),[['2000','2000']]);
});

test('forget consume and forget reversal replay a new physical hold from immutable quantity and linked ledger',async()=>{
 let item=await create('Джерело physical undo','4');const held=await reserve(item,'2',{purpose:'stock'});item=held.item;
 const used=await source('Використав із точного physical hold'),undo=await source('Скасував точний physical consume');
 const consumed=await change(item,'consume','1',{reservation_id:held.operation_id},context({sourceId:used}));item=consumed.item;
 assert.deepEqual([item.stock,item.reserved,own(item,held.operation_id).quantity],['3','1','1']);
 item=(await run({operation:'reverse',id:item.id,version:item.version,movement_id:consumed.operation_id},context({sourceId:undo}))).item;
 assert.deepEqual([item.stock,item.reserved,own(item,held.operation_id).quantity],['4','2','2']);
 await db.tx(sql=>forgetPhrase(sql,'Скасував точний physical consume'));
 item=(await list(context({revision:1})))[0];assert.deepEqual([item.stock,item.reserved,own(item,held.operation_id).quantity],['3','1','1']);
 await db.tx(sql=>forgetPhrase(sql,'Використав із точного physical hold'));
 item=(await list(context({revision:2})))[0];assert.deepEqual([item.stock,item.reserved,own(item,held.operation_id).quantity],['4','2','2']);
 const saved=await one(db,'SELECT initial_quantity::text,quantity::text FROM stock_reservations WHERE id=$1',[held.operation_id]);assert.deepEqual([saved!.initial_quantity,saved!.quantity],['2000','2000']);
 assert.equal((await one(db,"SELECT count(*)::int AS n FROM domain_commands WHERE domain='household'"))!.n,0);
});

test('physical undo does not reactivate an expired or explicitly released hold',async()=>{
 let expired=await create('Прострочений physical undo','4');const ttl=await reserve(expired,'2',{purpose:'stock',ttl_minutes:1});expired=ttl.item;
 const consumed=await change(expired,'consume','2',{reservation_id:ttl.operation_id});expired=consumed.item;
 await db.query("UPDATE stock_reservations SET expires_at=now()-interval '1 second' WHERE id=$1",[ttl.operation_id]);
 expired=(await run({operation:'reverse',id:expired.id,version:expired.version,movement_id:consumed.operation_id})).item;
 assert.deepEqual([expired.stock,expired.reserved,expired.available,expired.own_reservations.length],['4','0','4',0]);
 assert.equal((await one(db,'SELECT status FROM stock_reservations WHERE id=$1',[ttl.operation_id]))!.status,'expired');

 let released=await create('Звільнений physical undo','4');const held=await reserve(released,'2',{purpose:'stock'});released=held.item;
 const used=await source('Використав physical до явного release'),spent=await change(released,'consume','1',{reservation_id:held.operation_id},context({sourceId:used}));released=spent.item;
 released=(await run({operation:'release',id:released.id,version:released.version,reservation_id:held.operation_id})).item;
 await db.tx(sql=>forgetPhrase(sql,'Використав physical до явного release'));
 released=(await list(context({revision:1}))).find((i:any)=>i.id===released.id);
 assert.deepEqual([released.stock,released.reserved,released.available,released.own_reservations.length],['4','0','4',0]);
 assert.equal((await one(db,'SELECT status FROM stock_reservations WHERE id=$1',[held.operation_id]))!.status,'released');
 await assert.rejects(change(released,'consume','1',{reservation_id:held.operation_id},context({revision:1})),/own_reservation_insufficient/);
});

test('legacy physical holds retain mutable quantity without inventing historical consume links',async()=>{
 let item=await create('Legacy physical hold','4');const held=await reserve(item,'2',{purpose:'stock'});item=held.item;
 await db.query('UPDATE stock_reservations SET initial_quantity=NULL WHERE id=$1',[held.operation_id]);
 const consumed=await change(item,'consume','1',{reservation_id:held.operation_id});item=consumed.item;
 item=(await run({operation:'reverse',id:item.id,version:item.version,movement_id:consumed.operation_id})).item;
 assert.deepEqual([item.stock,item.reserved,own(item,held.operation_id).quantity],['4','1','1']);
 assert.equal((await one(db,'SELECT initial_quantity FROM stock_reservations WHERE id=$1',[held.operation_id]))!.initial_quantity,null);
 assert.equal((await one(db,"SELECT count(*)::int AS n FROM stock_movements WHERE kind='recount' AND reservation_id IS NOT NULL"))!.n,0);
});

test('TTL frees shopping capacity and an expired claim cannot be released as active',async()=>{
 let item=await create();item=(await change(item,'need','2')).item;const claim=await reserve(item,'2',{ttl_minutes:1});item=claim.item;
 await db.query("UPDATE stock_reservations SET expires_at=now()-interval '1 second' WHERE id=$1",[claim.operation_id]);
 const current=(await list())[0];assert.deepEqual([current.shopping_reserved,current.need_unclaimed,current.own_reservations.length],['0','2',0]);
 await assert.rejects(run({operation:'release',id:item.id,version:item.version,reservation_id:claim.operation_id}),/own_active_reservation_required/);
 item=(await reserve(item,'2')).item;assert.equal(item.shopping_reserved,'2');assert.equal(item.need_unclaimed,'0');
});

test('same reserve and purchase update replay after commit returns one operation across restarts',async()=>{
 let item=await create('Повтори','0');item=(await change(item,'need','3')).item;
 const claimArgs={operation:'reserve',id:item.id,version:item.version,quantity:'3',unit:'piece'},claimContext=context(),first=await run(claimArgs,claimContext);
 for(let i=0;i<10;i++){stock=new Household(db);assert.deepEqual(await run(claimArgs,claimContext),first);}
 item=first.item;const purchaseArgs={operation:'purchase',id:item.id,version:item.version,quantity:'1.125',unit:'piece'},purchaseContext=context(),bought=await run(purchaseArgs,purchaseContext);
 for(let i=0;i<10;i++){stock=new Household(db);assert.deepEqual(await run(purchaseArgs,purchaseContext),bought);}
 assert.deepEqual([bought.item.stock,bought.item.need,bought.item.shopping_reserved],['1.125','1.875','1.875']);
 assert.equal((await one(db,'SELECT count(*)::int AS n FROM stock_reservations'))!.n,1);
 assert.equal((await one(db,"SELECT count(*)::int AS n FROM stock_movements WHERE kind='purchase'"))!.n,1);
});

test('new purpose support preserves the argument digest of a committed purchase from the old command schema',async()=>{
 const item=await create('Сумісність повтору','0'),args={operation:'purchase',id:item.id,version:item.version,quantity:'1',unit:'piece'},c=context();
 const legacyArgs=StockCommand.omit({purpose:true}).parse(args),committed=await stock.run(legacyArgs,c);
 assert.deepEqual(await run(args,c),committed);
 assert.equal((await one(db,"SELECT count(*)::int AS n FROM stock_movements WHERE kind='purchase'"))!.n,1);
});

test('receipt draft does not fulfill a claim; confirmation uses exact units and only its author claims',async()=>{
 let item=(await run({operation:'create',item:'Молоко',unit:'l',quantity:'1'})).item;
 item=(await run({operation:'need',id:item.id,version:item.version,quantity:'2',unit:'l'})).item;
 const a=await run({operation:'reserve',id:item.id,version:item.version,quantity:'900',unit:'ml'});item=a.item;
 const b=await run({operation:'reserve',id:item.id,version:item.version,quantity:'1.1',unit:'l'},context({actorId:'22'}));item=b.item;
 const draft=await run({operation:'receipt',lines:[{id:item.id,version:item.version,quantity:'0.9',unit:'l'}]});
 assert.equal(draft.status,'draft');assert.equal((await list())[0].shopping_reserved,'2000');
 const confirm={operation:'confirm_receipt',receipt_id:draft.id},c=context(),confirmed=await run(confirm,c);item=confirmed.items[0];
 assert.deepEqual([item.stock,item.need,item.shopping_reserved,item.need_unclaimed],['1900','1100','1100','0']);
 assert.equal(item.own_reservations.length,0);assert.equal(own((await list(context({actorId:'22'})))[0],b.operation_id).quantity,'1100');
 assert.deepEqual(await run(confirm,c),confirmed);assert.equal((await run(confirm)).duplicate,true);
 await assert.rejects(run({operation:'receipt',lines:[{id:item.id,version:item.version,quantity:'1',unit:'piece'}]}),/receipt_unit_or_quantity_invalid/);
});

test('release fences historical purchase shares and reversals never revive a released claim',async()=>{
 let item=await create('Історія резерву','0');item=(await change(item,'need','4')).item;
 const first=await reserve(item,'2');item=first.item;const second=await reserve(item,'2');item=second.item;
 const p1=await change(item,'purchase','1');item=p1.item;assert.equal(own(item,second.operation_id).quantity,'1.5');
 item=(await run({operation:'release',id:item.id,version:item.version,reservation_id:first.operation_id})).item;
 assert.equal(own(item,second.operation_id).quantity,'1.5');
 const p2=await change(item,'purchase','1');item=p2.item;assert.equal(own(item,second.operation_id).quantity,'0.5');
 item=(await run({operation:'reverse',id:item.id,version:item.version,movement_id:p2.operation_id})).item;
 assert.equal(own(item,second.operation_id).quantity,'1.5');assert.equal(own(item,first.operation_id),undefined);
 item=(await run({operation:'reverse',id:item.id,version:item.version,movement_id:p1.operation_id})).item;
 assert.deepEqual([item.stock,item.need,item.shopping_reserved],['0','4','2']);assert.equal(own(item,second.operation_id).quantity,'2');
 const released=await one(db,'SELECT status,closed_sequence FROM stock_reservations WHERE id=$1',[first.operation_id]);assert.equal(released!.status,'released');assert.notEqual(released!.closed_sequence,null);
});

test('forgetting a release exposes a closed reconciliation record without renewing or reallocating the claim',async()=>{
 let item=await create('Забутий release','0');item=(await change(item,'need','6')).item;
 const first=await reserve(item,'2');item=first.item;const second=await reserve(item,'2');item=second.item;const other=await reserve(item,'2',{},context({actorId:'22'}));item=other.item;
 item=(await change(item,'purchase','1')).item;assert.equal(own(item,first.operation_id).quantity,'1.5');assert.equal(own(item,second.operation_id).quantity,'1.5');
 const released=await source('Явно звільнив перший shopping claim');
 item=(await run({operation:'release',id:item.id,version:item.version,reservation_id:first.operation_id},context({sourceId:released}))).item;
 const before=await one(db,'SELECT closed_sequence,closed_source_id FROM stock_reservations WHERE id=$1',[first.operation_id]);assert.equal(Number(before!.closed_source_id),released);
 item=(await change(item,'purchase','1')).item;
 assert.deepEqual([item.stock,item.need,item.shopping_reserved,own(item,second.operation_id).quantity],['2','4','2.5','0.5']);
 await db.tx(sql=>forgetPhrase(sql,'Явно звільнив перший shopping claim'));
 item=(await list(context({revision:1})))[0];
 assert.deepEqual([item.stock,item.need,item.shopping_reserved,item.need_unclaimed],['2','4','2.5','1.5']);
 assert.deepEqual([own(item,first.operation_id).status,own(item,first.operation_id).closed,own(item,first.operation_id).quantity],['needs_reconcile',true,'1.5']);
 assert.equal(own(item,second.operation_id).quantity,'0.5');assert.equal(item.reservations_needing_reconcile.length,1);
 const after=await one(db,'SELECT closed_sequence,closed_source_id FROM stock_reservations WHERE id=$1',[first.operation_id]);assert.equal(after!.closed_sequence,before!.closed_sequence);assert.equal(after!.closed_source_id,null);
 // Future purchases may finish the remaining open claim; they cannot buy for
 // the closed record or silently redirect its earlier share to the open one.
 item=(await change(item,'purchase','0.5',{},context({revision:1}))).item;
 assert.deepEqual([item.stock,item.need,item.shopping_reserved],['2.5','3.5','2']);assert.equal(own(item,second.operation_id),undefined);assert.equal(own(item,first.operation_id).quantity,'1.5');
 assert.equal(own((await list(context({revision:1,actorId:'22'})))[0],other.operation_id).quantity,'2');
 const renewed=await reserve(item,'1.5',{},context({revision:1}));item=renewed.item;assert.equal(item.shopping_reserved,'3.5');assert.equal(item.need_unclaimed,'0');assert.notEqual(renewed.operation_id,first.operation_id);
 item=(await run({operation:'release',id:item.id,version:item.version,reservation_id:first.operation_id},context({revision:1}))).item;
 assert.equal(own(item,first.operation_id),undefined);assert.equal((await one(db,'SELECT closed_sequence FROM stock_reservations WHERE id=$1',[first.operation_id]))!.closed_sequence,before!.closed_sequence);
});

test('forgetting reversal and purchase sources rebuilds the author claims and clears cached household results',async()=>{
 let item=await create('Джерела','0');item=(await change(item,'need','6')).item;const a=await reserve(item,'3');item=a.item;const b=await reserve(item,'3',{},context({actorId:'22'}));item=b.item;
 const p=await source('Факт покупки з унікального джерела'),undo=await source('Скасування факту з унікального джерела');
 const purchase=await change(item,'purchase','2',{},context({sourceId:p}));item=purchase.item;assert.equal(own(item,a.operation_id).quantity,'1');
 item=(await run({operation:'reverse',id:item.id,version:item.version,movement_id:purchase.operation_id},context({sourceId:undo}))).item;
 assert.deepEqual([item.stock,item.need,item.shopping_reserved],['0','6','6']);
 await db.tx(sql=>forgetPhrase(sql,'Скасування факту з унікального джерела'));
 item=(await list(context({revision:1})))[0];assert.deepEqual([item.stock,item.need,item.shopping_reserved],['2','4','4']);assert.equal(own(item,a.operation_id).quantity,'1');
 assert.equal(own((await list(context({revision:1,actorId:'22'})))[0],b.operation_id).quantity,'3');
 await db.tx(sql=>forgetPhrase(sql,'Факт покупки з унікального джерела'));
 item=(await list(context({revision:2})))[0];assert.deepEqual([item.stock,item.need,item.shopping_reserved],['0','6','6']);assert.equal(own(item,a.operation_id).quantity,'3');
 assert.equal((await one(db,"SELECT count(*)::int AS n FROM domain_commands WHERE domain='household'"))!.n,0);
});

test('purchase erasure makes dependent stock unknown but restores independent shopping claims; a later recount survives',async()=>{
 let item=await create('Незалежні залишки','0');item=(await change(item,'need','4')).item;const claim=await reserve(item,'2');item=claim.item;
 const p=await source('Придбав рівно два для erasure'),used=await source('Використав один для erasure'),counted=await source('Незалежно перерахував чотири');
 item=(await change(item,'purchase','2',{},context({sourceId:p}))).item;const physical=await reserve(item,'1',{purpose:'stock'});item=physical.item;
 item=(await change(item,'consume','1',{},context({sourceId:used}))).item;assert.equal(item.stock,'1');
 await db.tx(sql=>forgetPhrase(sql,'Придбав рівно два для erasure'));
 item=(await list(context({revision:1})))[0];assert.deepEqual([item.stock,item.available,item.need,item.shopping_reserved,item.reserved],[null,null,'4','2','0']);
 assert.equal(own(item,claim.operation_id).quantity,'2');assert.equal(own(item,claim.operation_id).status,'active');assert.equal(own(item,physical.operation_id).status,'needs_reconcile');
 item=(await change(item,'recount','4',{},context({sourceId:counted,revision:1}))).item;
 assert.equal(item.stock,'4');assert.equal(own(item,physical.operation_id).status,'needs_reconcile');
 await db.tx(sql=>forgetPhrase(sql,'Використав один для erasure'));
 item=(await list(context({revision:2})))[0];assert.deepEqual([item.stock,item.need,item.shopping_reserved],['4','4','2']);
});

test('erasing a claim cannot transfer its past purchase credit to a later claim',async()=>{
 let item=await create('Часова межа','0');item=(await change(item,'need','4')).item;const original=await source('Перший особистий shopping claim');
 const first=await reserve(item,'2',{},context({sourceId:original}));item=first.item;item=(await change(item,'purchase','1')).item;
 const later=await reserve(item,'2');item=later.item;assert.equal(item.shopping_reserved,'3');
 await db.tx(sql=>forgetPhrase(sql,'Перший особистий shopping claim'));
 item=(await list(context({revision:1})))[0];assert.deepEqual([item.stock,item.need,item.shopping_reserved,item.need_unclaimed],['1','3','2','1']);assert.equal(own(item,later.operation_id).quantity,'2');
});

test('erasing the only need source retains physical stock and makes shopping claims explicitly need reconciliation',async()=>{
 let item=await create('Без доказу потреби','10');const need=await source('Потрібні чотири незалежне джерело');item=(await change(item,'need','4',{},context({sourceId:need}))).item;
 const claim=await reserve(item,'4');item=claim.item;
 await db.tx(sql=>forgetPhrase(sql,'Потрібні чотири незалежне джерело'));
 item=(await list(context({revision:1})))[0];assert.deepEqual([item.stock,item.available,item.need,item.shopping_reserved,item.need_unclaimed],['10','10','0','4','0']);assert.equal(own(item,claim.operation_id).status,'needs_reconcile');
 await assert.rejects(reserve(item,'1',{},context({revision:1})),/insufficient_need/);
});

test('a recount depends on the replied fact as well as the command; a later independent recount survives erasure',async()=>{
 let dependent=await create('Залежний перерахунок'),independent=await create('Незалежний перерахунок');
 const fact=await source('Факт: залишок точно п’ять'),instruction=await source('Запиши це'),later=await source('Новий фізичний перерахунок: чотири');
 const c=context({sourceId:instruction,sourceIds:[fact,instruction,fact]});
 dependent=(await change(dependent,'recount','5',{},c)).item;
 independent=(await change(independent,'recount','5',{},context({sourceId:instruction,sourceIds:[fact,instruction]}))).item;
 independent=(await change(independent,'recount','4',{},context({sourceId:later}))).item;
 assert.equal(dependent.stock,'5');assert.equal(independent.stock,'4');
 assert.equal((await one(db,'SELECT count(*)::int AS n FROM stock_item_sources WHERE item_id=ANY($1::uuid[])',[ [dependent.id,independent.id] ]))!.n,0);
 await db.tx(sql=>forgetPhrase(sql,'Факт: залишок точно п’ять'));
 const items=await list(context({revision:1}));dependent=items.find((i:any)=>i.id===dependent.id);independent=items.find((i:any)=>i.id===independent.id);
 assert.deepEqual([dependent.stock,dependent.stock_status],[null,'needs_reconcile']);assert.deepEqual([independent.stock,independent.stock_status],['4','known']);
 assert.equal((await one(db,'SELECT count(*)::int AS n FROM stock_movement_sources WHERE source_message_id=$1',[fact]))!.n,0);
 assert.equal((await one(db,'SELECT count(*)::int AS n FROM stock_movement_sources WHERE source_message_id=$1',[later]))!.n,1);
 assert.equal((await one(db,"SELECT count(*)::int AS n FROM domain_commands WHERE domain='household'"))!.n,0);
});

for(const erased of ['draft','confirm'] as const)test(`receipt purchases inherit all draft and confirm sources; erasing a secondary ${erased} source removes dependent purchases`,async()=>{
 let a=await create('Чек залежний','0'),b=await create('Чек незалежний','0');
 const ocr=await source('Дані OCR спільного чека'),draft=await source('Збережи розпізнаний чек'),reply=await source('Перевірив обидві кількості'),confirmation=await source('Підтверджую цей чек'),recount=await source('Окремо перерахував сім');
 const receipt=await run({operation:'receipt',lines:[{id:a.id,version:a.version,quantity:'2',unit:'piece'},{id:b.id,version:b.version,quantity:'3',unit:'piece'}]},context({sourceId:draft,sourceIds:[ocr,draft]}));
 const confirmed=await run({operation:'confirm_receipt',receipt_id:receipt.id},context({sourceId:confirmation,sourceIds:[reply,confirmation]}));
 a=confirmed.items.find((i:any)=>i.id===a.id);b=confirmed.items.find((i:any)=>i.id===b.id);assert.deepEqual([a.stock,b.stock],['2','3']);
 const expected=[ocr,draft,reply,confirmation].sort((x,y)=>x-y);
 assert.deepEqual((await db.query('SELECT source_message_id FROM stock_receipt_sources WHERE receipt_id=$1',[receipt.id])).rows.map(r=>Number(r.source_message_id)).sort((x,y)=>x-y),expected);
 for(const movement of (await db.query("SELECT id FROM stock_movements WHERE kind='purchase'")).rows)assert.deepEqual((await db.query('SELECT source_message_id FROM stock_movement_sources WHERE movement_id=$1',[movement.id])).rows.map(r=>Number(r.source_message_id)).sort((x,y)=>x-y),expected);
 b=(await change(b,'recount','7',{},context({sourceId:recount}))).item;
 await db.tx(sql=>forgetPhrase(sql,erased==='draft'?'Дані OCR спільного чека':'Перевірив обидві кількості'));
 const items=await list(context({revision:1}));a=items.find((i:any)=>i.id===a.id);b=items.find((i:any)=>i.id===b.id);
 assert.deepEqual([a.stock,b.stock],['0','7']);assert.equal(await one(db,'SELECT id FROM stock_receipts WHERE id=$1',[receipt.id]),undefined);
 assert.equal((await one(db,"SELECT count(*)::int AS n FROM stock_movements WHERE kind='purchase'"))!.n,0);
 assert.equal((await one(db,'SELECT count(*)::int AS n FROM stock_receipt_sources'))!.n,0);
 assert.equal((await one(db,'SELECT count(*)::int AS n FROM stock_movement_sources WHERE source_message_id=$1',[recount]))!.n,1);
});

test('secondary release erasure retains its closed fence and never renews a shopping claim',async()=>{
 let item=await create('Джерела release','0');item=(await change(item,'need','4')).item;
 const first=await reserve(item,'2');item=first.item;const second=await reserve(item,'2');item=second.item;
 item=(await change(item,'purchase','1')).item;
 const intent=await source('Більше не беру перший claim'),instruction=await source('Запиши звільнення цього claim');
 item=(await run({operation:'release',id:item.id,version:item.version,reservation_id:first.operation_id},context({sourceId:instruction,sourceIds:[intent,instruction]}))).item;
 const fence=(await one(db,'SELECT closed_sequence FROM stock_reservations WHERE id=$1',[first.operation_id]))!.closed_sequence;
 item=(await change(item,'purchase','1')).item;assert.equal(own(item,second.operation_id).quantity,'0.5');
 await db.tx(sql=>forgetPhrase(sql,'Більше не беру перший claim'));
 item=(await list(context({revision:1})))[0];assert.deepEqual([item.stock,item.need,item.shopping_reserved,item.need_unclaimed],['2','2','0.5','1.5']);
 assert.deepEqual([own(item,first.operation_id).status,own(item,first.operation_id).closed,own(item,first.operation_id).quantity],['needs_reconcile',true,'1.5']);assert.equal(own(item,second.operation_id).quantity,'0.5');
 const closed=await one(db,'SELECT closed_sequence,closed_source_id FROM stock_reservations WHERE id=$1',[first.operation_id]);assert.equal(closed!.closed_sequence,fence);assert.equal(closed!.closed_source_id,null);
 assert.equal((await one(db,'SELECT count(*)::int AS n FROM stock_release_sources WHERE reservation_id=$1',[first.operation_id]))!.n,0);
});

test('secondary need, reservation, alias and item metadata dependencies are erased at their own parents',async()=>{
 let item=await create('Повні джерела','10');
 const needFact=await source('Факт потреби з відповіді'),needCommand=await source('Запиши потребу з відповіді');item=(await change(item,'need','4',{},context({sourceId:needCommand,sourceIds:[needFact,needCommand]}))).item;
 const claimFact=await source('Беру купівлю з відповіді'),claimCommand=await source('Запиши доручення з відповіді');const claim=await reserve(item,'2',{},context({sourceId:claimCommand,sourceIds:[claimFact,claimCommand]}));item=claim.item;
 const aliasFact=await source('Назва також є яблучка'),aliasCommand=await source('Запиши псевдонім із відповіді');item=(await run({operation:'alias',id:item.id,version:item.version,alias:'яблучка'},context({sourceId:aliasCommand,sourceIds:[aliasFact,aliasCommand]}))).item;
 await db.tx(sql=>forgetPhrase(sql,'Факт потреби з відповіді'));item=(await list(context({revision:1})))[0];assert.deepEqual([item.stock,item.need,item.shopping_reserved],['10','0','2']);assert.equal(own(item,claim.operation_id).status,'needs_reconcile');
 await db.tx(sql=>forgetPhrase(sql,'Беру купівлю з відповіді'));item=(await list(context({revision:2})))[0];assert.deepEqual([item.stock,item.shopping_reserved,item.own_reservations.length],['10','0',0]);
 await db.tx(sql=>forgetPhrase(sql,'Назва також є яблучка'));item=(await list(context({revision:3})))[0];assert.equal(item.name,'Повні джерела');assert.equal((await one(db,'SELECT count(*)::int AS n FROM stock_aliases WHERE item_id=$1',[item.id]))!.n,0);
 const identity=await source('Нова позиція має ім’я Груші'),createCommand=await source('Збережи позицію з відповіді');
 const named=(await run({operation:'create',item:'Груші',quantity:'2',unit:'piece'},context({revision:3,sourceId:createCommand,sourceIds:[identity,createCommand]}))).item;
 await db.tx(sql=>forgetPhrase(sql,'Нова позиція має ім’я Груші'));
 assert.equal((await list(context({revision:4}))).some((i:any)=>i.id===named.id),false);
 for(const table of ['stock_item_sources','stock_movement_sources','stock_need_sources','stock_reservation_sources','stock_release_sources','stock_receipt_sources','stock_alias_sources'])assert.equal((await one(db,`SELECT count(*)::int AS n FROM ${table}`))!.n,0,table);
});

test('secondary consume and reversal sources rebuild the immutable physical hold',async()=>{
 let item=await create('Залежний physical hold','4');const held=await reserve(item,'2',{purpose:'stock'});item=held.item;
 const used=await source('Факт використання із відповіді'),recordUse=await source('Запиши використання із відповіді'),undo=await source('Факт скасування із відповіді'),recordUndo=await source('Запиши скасування із відповіді');
 const consumed=await change(item,'consume','1',{reservation_id:held.operation_id},context({sourceId:recordUse,sourceIds:[used,recordUse]}));item=consumed.item;
 item=(await run({operation:'reverse',id:item.id,version:item.version,movement_id:consumed.operation_id},context({sourceId:recordUndo,sourceIds:[undo,recordUndo]}))).item;assert.deepEqual([item.stock,item.reserved],['4','2']);
 await db.tx(sql=>forgetPhrase(sql,'Факт скасування із відповіді'));item=(await list(context({revision:1})))[0];assert.deepEqual([item.stock,item.reserved,own(item,held.operation_id).quantity],['3','1','1']);
 await db.tx(sql=>forgetPhrase(sql,'Факт використання із відповіді'));item=(await list(context({revision:2})))[0];assert.deepEqual([item.stock,item.reserved,own(item,held.operation_id).quantity],['4','2','2']);
});

test('eraseAll removes every normalized stock source edge through its parent foreign key',async()=>{
 const s=await source('Джерело повного очищення');let item=(await run({operation:'create',item:'Очистити всі ребра',quantity:'10',unit:'piece'},context({sourceId:s}))).item;
 item=(await change(item,'need','4',{},context({sourceId:s}))).item;const claim=await reserve(item,'2',{},context({sourceId:s}));item=claim.item;
 item=(await run({operation:'alias',id:item.id,version:item.version,alias:'очищення'},context({sourceId:s}))).item;
 item=(await run({operation:'release',id:item.id,version:item.version,reservation_id:claim.operation_id},context({sourceId:s}))).item;
 await run({operation:'receipt',lines:[{id:item.id,version:item.version,quantity:'1',unit:'piece'}]},context({sourceId:s}));
 const tables=['stock_item_sources','stock_movement_sources','stock_need_sources','stock_reservation_sources','stock_release_sources','stock_receipt_sources','stock_alias_sources'];
 for(const table of tables)assert.ok((await one(db,`SELECT count(*)::int AS n FROM ${table}`))!.n>0,table);
 await db.tx(sql=>eraseAll(sql));
 for(const table of tables)assert.equal((await one(db,`SELECT count(*)::int AS n FROM ${table}`))!.n,0,table);
});

test('AgentTools list receipt is forgotten with a read balance source and same-update replay reads the current unknown state',async()=>{
 let item=await create('Баланс із read receipt');const fact=await source('Підтверджений факт п’яти для read'),record=await source('Запиши це для read');
 item=(await change(item,'recount','5',{},context({sourceId:record,sourceIds:[fact,record]}))).item;
 const h=harness(db),tools=new AgentTools(db,h.config,h.brain),c=context(),args={operation:'list'};
 const first=await tools.execute('stock.manage',args,c);assert.equal(first.items[0].stock,'5');assert.ok(first.source_ids.includes(fact));
 const cached=await one(db,"SELECT id,result FROM tool_runs WHERE tool='stock.manage' AND status='succeeded'");assert.equal(cached!.result.items[0].stock,'5');
 assert.ok(await one(db,"SELECT source_message_id FROM provenance_edges WHERE derived_kind='tool_run' AND derived_key=$1 AND source_message_id=$2",[String(cached!.id),fact]));
 await db.tx(sql=>forgetPhrase(sql,'Підтверджений факт п’яти для read'));
 assert.equal((await list(context({revision:1})))[0].stock,null);assert.equal(await one(db,'SELECT id FROM tool_runs WHERE id=$1',[cached!.id]),undefined);
 const replay=await tools.execute('stock.manage',args,{...c,revision:1});assert.equal(replay.items[0].stock,null);assert.equal(replay.items[0].stock_status,'needs_reconcile');assert.equal(replay.source_ids.includes(fact),false);
 assert.equal((await one(db,"SELECT count(*)::int AS n FROM tool_runs WHERE tool='stock.manage' AND status='succeeded'"))!.n,1);
 assert.equal((await one(db,"SELECT count(*)::int AS n FROM tool_runs WHERE result @> $1::jsonb",[JSON.stringify({items:[{stock:'5'}]})]))!.n,0);
});

test('AgentTools mutation snapshot carries prior read sources and cannot replay a forgotten stock value',async()=>{
 let item=await create('Read deps mutation');const fact=await source('Запас п’ять перед зміною потреби'),instruction=await source('Додай потребу у двох');
 item=(await change(item,'recount','5',{},context({sourceId:fact}))).item;
 const h=harness(db),tools=new AgentTools(db,h.config,h.brain),c=context({sourceId:instruction}),args={operation:'need',id:item.id,version:item.version,quantity:'2',unit:'piece'};
 const first=await tools.execute('stock.manage',args,c);assert.equal(first.item.stock,'5');assert.ok(first.source_ids.includes(fact));
 const cached=await one(db,"SELECT id FROM tool_runs WHERE tool='stock.manage' AND status='succeeded'");
 await db.tx(sql=>forgetPhrase(sql,'Запас п’ять перед зміною потреби'));
 assert.equal(await one(db,'SELECT id FROM tool_runs WHERE id=$1',[cached!.id]),undefined);
 await assert.rejects(tools.execute('stock.manage',args,{...c,revision:1}),/version_conflict/);
 item=(await list(context({revision:1})))[0];assert.equal(item.stock,null);
 const refreshed=await tools.execute('stock.manage',{...args,version:item.version},{...c,revision:1});assert.equal(refreshed.item.stock,null);assert.equal(refreshed.item.need,'2');
});

test('snapshot source envelope includes all seven source-edge domains and legacy movement origin refs',async()=>{
 const ids:Record<string,number>={};for(const name of ['item','movement','need','reservation','release','alias','receipt','legacy','origin'])ids[name]=await source('Snapshot source '+name);
 let item=(await run({operation:'create',item:'Усі джерела snapshot',unit:'piece',quantity:'10'},context({sourceIds:[ids.item!]}))).item;
 item=(await change(item,'need','4',{},context({sourceIds:[ids.need!]}))).item;
 const claim=await reserve(item,'2',{},context({sourceIds:[ids.reservation!]}));item=claim.item;
 item=(await run({operation:'alias',id:item.id,version:item.version,alias:'snapshot alias'},context({sourceIds:[ids.alias!]}))).item;
 item=(await run({operation:'release',id:item.id,version:item.version,reservation_id:claim.operation_id},context({sourceIds:[ids.release!]}))).item;
 item=(await change(item,'purchase','1',{},context({sourceIds:[ids.movement!]}))).item;
 const legacy=await change(item,'purchase','1',{},context({sourceId:ids.legacy!}));item=legacy.item;
 await db.query('UPDATE stock_movements SET origin_source_id=$2 WHERE id=$1',[legacy.operation_id,ids.origin!]);await db.query('DELETE FROM stock_movement_sources WHERE movement_id=$1',[legacy.operation_id]);
 const draft=await run({operation:'receipt',lines:[{id:item.id,version:item.version,quantity:'1',unit:'piece'}]},context({sourceIds:[ids.receipt!]}));
 const expected=Object.values(ids).sort((a,b)=>a-b),snapshot=await run({operation:'list'});
 assert.deepEqual(snapshot.source_ids,expected);assert.deepEqual([...draft.source_ids].sort((a,b)=>a-b),expected);
 const changed=await change(item,'need','3');assert.deepEqual(changed.source_ids,expected);
});

test('list source dependencies follow its returned 100 items and exclude a hidden item',async()=>{
 const ids=Array.from({length:101},()=>randomUUID()),names=ids.map((_id,i)=>i<100?'A'+String(i).padStart(3,'0'):'Z поза переліком');
 await db.query("INSERT INTO stock_items(id,name,unit) SELECT x.id,x.name,'piece' FROM unnest($1::uuid[],$2::text[]) AS x(id,name)",[ids,names]);
 const hiddenSource=await source('Джерело тільки прихованої позиції');await db.query('UPDATE stock_items SET name_source_id=$2 WHERE id=$1',[ids[100],hiddenSource]);await db.query('INSERT INTO stock_item_sources(item_id,source_message_id) VALUES($1,$2)',[ids[100],hiddenSource]);
 const h=harness(db),tools=new AgentTools(db,h.config,h.brain),c=context(),args={operation:'list'},first=await tools.execute('stock.manage',args,c);
 assert.equal(first.items.length,100);assert.equal(first.items.some((i:any)=>i.id===ids[100]),false);assert.equal(first.source_ids.includes(hiddenSource),false);
 const cached=await one(db,"SELECT id FROM tool_runs WHERE tool='stock.manage' AND status='succeeded'");
 await db.tx(sql=>forgetPhrase(sql,'Джерело тільки прихованої позиції'));
 assert.ok(await one(db,'SELECT id FROM tool_runs WHERE id=$1',[cached!.id]));
 const replay=await tools.execute('stock.manage',args,{...c,revision:1});assert.deepEqual(replay.items,first.items);
});

test('large snapshot provenance remains complete without enlarging serialized AgentTools output',async()=>{
 const item=await create('Повна велика provenance');
 await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) SELECT 1000000+x,'11','А','user','Джерело великих deps '||x FROM generate_series(1,22000) AS x");
 await db.query('INSERT INTO stock_item_sources(item_id,source_message_id) SELECT $1,id FROM messages',[item.id]);
 const h=harness(db),tools=new AgentTools(db,h.config,h.brain),result=await tools.execute('stock.manage',{operation:'list'},context());
 assert.equal(result.items.length,1);assert.equal(result.source_ids,undefined);assert.equal(result[stockSnapshotSourceSymbol].length,22000);assert.ok(JSON.stringify(result).length<100000);
 const cached=await one(db,"SELECT id,result FROM tool_runs WHERE tool='stock.manage' AND status='succeeded'");assert.equal(cached!.result.items[0].id,item.id);assert.equal(cached!.result.source_ids,undefined);
 assert.equal((await one(db,"SELECT count(*)::int AS n FROM provenance_edges WHERE derived_kind='tool_run' AND derived_key=$1",[String(cached!.id)]))!.n,22000);
});

test('household list checks the bound chat, live membership and current source revision',async()=>{
 await create('Лише наша родина','1');
 await assert.rejects(list(context({chatId:'-200'})),/other_chat/);
 await assert.rejects(list(context({actorId:'404'})),/member_required/);
 await db.query("UPDATE members SET active=false WHERE user_id='22'");await assert.rejects(list(context({actorId:'22'})),/member_required/);
 await assert.rejects(list(context({revision:1})),/task_cancelled/);
 assert.equal((await list()).length,1);
});
