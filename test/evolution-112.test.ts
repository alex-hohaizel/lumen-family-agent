import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {PDFDocument} from 'pdf-lib';
import {TestDB,harness,paired} from './helpers.js';
import {Household,StockCommand,amount} from '../src/household.js';
import {MediaWorkshop,CollectionCommand,StudioCommand} from '../src/media-workshop.js';
import {assetFor} from '../src/media-assets.js';
import {one,forgetPhrase} from '../src/db.js';
import type {ToolContext} from '../src/agent-tools.js';
let db:TestDB,h:ReturnType<typeof harness>,n=10000;const c=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:String(++n),requested:true,...extra});
before(async()=>{db=new TestDB();await db.init();});after(async()=>db.close());
beforeEach(async()=>{await db.reset();for(const table of ['stock_receipts','stock_reservations','stock_movements','stock_aliases','stock_items','domain_commands','resource_views','asset_destination_grants','media_publications','media_job_inputs','media_jobs','archive_items','archive_collections','studio_scenes','studio_projects','media_assets'])await db.query(`DELETE FROM ${table}`);h=harness(db);await paired(h);for(const id of ['22','33','44','55'])await db.query('INSERT INTO members(user_id,name,active) VALUES($1,$2,true) ON CONFLICT(user_id) DO UPDATE SET active=true',[id,'Учасник '+id]);});
test('stock exact arithmetic, unknown distinct from zero, independent need, receipt deduplication',async()=>{
 const stock=new Household(db),run=(a:any,ctx=c())=>stock.run(StockCommand.parse(a),ctx);assert.equal(amount('0.125','kg'),125000n);
 let item=(await run({operation:'create',item:'Молоко',unit:'l'})).item;assert.equal(item.stock,null);item=(await run({operation:'need',id:item.id,version:item.version,quantity:'2',unit:'l'})).item;assert.equal(item.need,'2000');
 item=(await run({operation:'recount',id:item.id,version:item.version,quantity:'0',unit:'l'})).item;const draft=await run({operation:'receipt',lines:[{id:item.id,version:item.version,quantity:'1.5',unit:'l'}]});const command={operation:'confirm_receipt',receipt_id:draft.id},ctx=c();const first=await run(command,ctx);assert.deepEqual(await run(command,ctx),first);assert.equal((await run({operation:'list'})).items[0].stock,'1500');assert.equal((await run(command)).duplicate,true);
});
test('20 competing stock commands cannot oversell; own reservation and version enforced',async()=>{
 const stock=new Household(db),run=(a:any,ctx=c())=>stock.run(StockCommand.parse(a),ctx);let item=(await run({operation:'create',item:'Яблука',unit:'piece',quantity:'2'})).item;
 const results=await Promise.allSettled(Array.from({length:20},()=>run({operation:'reserve',purpose:'stock',id:item.id,version:item.version,quantity:'1',unit:'piece'})));const won=results.filter((r):r is PromiseFulfilledResult<any>=>r.status==='fulfilled');assert.equal(won.length,1);item=won[0]!.value.item;
 await assert.rejects(run({operation:'release',id:item.id,version:item.version,reservation_id:won[0]!.value.operation_id},c({actorId:'22'})),/own_active_reservation/);await assert.rejects(run({operation:'consume',id:item.id,version:item.version,quantity:'2',unit:'piece'}),/reserved_stock/);assert.equal((await run({operation:'list'})).items[0].stock,'2');
});
test('forget purchase removes dependent balance, a newer independent recount survives',async()=>{
 const stock=new Household(db),run=(a:any,ctx=c())=>stock.run(StockCommand.parse(a),ctx);let item=(await run({operation:'create',item:'Банани',unit:'piece',quantity:'0'})).item;
 const source=async(body:string)=>Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES($1,'11','A','user',$2) RETURNING id",[++n,body])).rows[0]!.id);const p=await source('Купив два банани'),consume=await source('З’їв один банан');
 item=(await run({operation:'purchase',id:item.id,version:item.version,quantity:'2',unit:'piece'},c({sourceId:p}))).item;item=(await run({operation:'consume',id:item.id,version:item.version,quantity:'1',unit:'piece'},c({sourceId:consume}))).item;await db.tx(sql=>forgetPhrase(sql,'Купив два банани'));item=(await run({operation:'list'},c({revision:1}))).items[0];assert.equal(item.stock,null);
 const recount=await source('Перерахував: чотири банани');item=(await run({operation:'recount',id:item.id,version:item.version,quantity:'4',unit:'piece'},c({sourceId:recount,revision:1}))).item;await db.tx(sql=>forgetPhrase(sql,'З’їв один банан'));assert.equal((await run({operation:'list'},c({revision:2}))).items[0].stock,'4');
});
test('archive makes actual Unicode PDF and rejects private contribution widening',async()=>{
 const hub=new MediaWorkshop(db,h.config),photo=await sharp({create:{width:40,height:40,channels:3,background:'#123456'}}).png().toBuffer(),asset=await hub.store(photo,'image/png','Сімейне фото',c()),privateAsset=await hub.store(photo,'image/png','Таємне',c({audience:'private'}));const col=await hub.collection(CollectionCommand.parse({operation:'create',title:'Сімейний альбом'}),c());
 await assert.rejects(hub.collection(CollectionCommand.parse({operation:'add',id:col.id,version:1,asset_id:privateAsset.id,asset_version:1}),c({audience:'private'})),/widen_audience/);await hub.collection(CollectionCommand.parse({operation:'add',id:col.id,version:1,asset_id:asset.id,asset_version:1,caption:'Наша осінь у Києві',claim:'fact'}),c());const job=await hub.collection(CollectionCommand.parse({operation:'export',id:col.id,version:2}),c());await hub.next();await hub.idle();const saved=await one(db,'SELECT * FROM media_jobs WHERE id=$1',[job.id]);assert.equal(saved!.status,'ready',saved!.error_code);const output=await hub.bytes(saved!.output_id,1,c());assert.equal((await PDFDocument.load(output.bytes)).getPageCount(),1);
});
test('story exports real H264 MP4 from three authors; revocation stales ready output',async()=>{
 const hub=new MediaWorkshop(db,h.config),project=await hub.studio(StudioCommand.parse({operation:'create',title:'Наша історія'}),c());let version=1,first='';for(const [index,id] of ['11','22','33'].entries()){const photo=await sharp({create:{width:80,height:64,channels:3,background:['#e54','#4a7','#36a'][index]!}}).png().toBuffer(),asset=await hub.store(photo,'image/png','Фото '+id,c({actorId:id}));if(!first)first=asset.id;const changed=await hub.studio(StudioCommand.parse({operation:'add_scene',id:project.id,version,asset_id:asset.id,asset_version:1,duration:1,caption:'Учасник '+id}),c({actorId:id}));version=changed.version;}
 const job=await hub.studio(StudioCommand.parse({operation:'export',id:project.id,version}),c());await hub.next();await hub.idle();const result=await one(db,'SELECT * FROM media_jobs WHERE id=$1',[job.id]);assert.equal(result!.status,'ready',result!.error_code);const output=await hub.bytes(result!.output_id,1,c());assert.equal(output.bytes.subarray(4,8).toString(),'ftyp');assert.ok(output.bytes.length>1000);
 await hub.run({operation:'revoke',id:first,version:1,caption:''},c());await assert.rejects(assetFor(db,result!.output_id,1,c()),/asset_unavailable/);assert.equal((await one(db,'SELECT status FROM media_jobs WHERE id=$1',[job.id]))!.status,'stale');await hub.maintenance();
});
