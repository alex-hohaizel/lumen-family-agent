import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {one,state,type Database,type SQL,type Row} from './db.js';
import {command,requireVersion,sourceIds} from './evolution-core.js';
import {ToolError} from './safe-http.js';
import type {ToolContext} from './agent-tools.js';

const units={g:['g',1],kg:['g',1000],ml:['ml',1],l:['ml',1000],piece:['piece',1]} as const;
const quantity=z.string().regex(/^-?\d{1,9}(\.\d{1,3})?$/),unit=z.enum(['g','kg','ml','l','piece']);
export const StockCommand=z.object({operation:z.enum(['list','create','alias','need','purchase','consume','adjust','recount','reserve','release','reverse','receipt','confirm_receipt']),item:z.string().min(1).max(120).optional(),id:z.string().uuid().optional(),version:z.number().int().positive().optional(),quantity:quantity.optional(),unit:unit.optional(),alias:z.string().max(120).optional(),purpose:z.enum(['shopping','stock']).optional(),reservation_id:z.string().uuid().optional(),movement_id:z.string().uuid().optional(),receipt_id:z.string().uuid().optional(),ttl_minutes:z.number().int().min(1).max(1440).default(60),lines:z.array(z.object({id:z.string().uuid(),version:z.number().int().positive(),quantity,unit})).min(1).max(50).optional()});
type StockInput=z.infer<typeof StockCommand>;
const sourceTables={item:['stock_item_sources','item_id'],movement:['stock_movement_sources','movement_id'],need:['stock_need_sources','need_id'],reservation:['stock_reservation_sources','reservation_id'],release:['stock_release_sources','reservation_id'],receipt:['stock_receipt_sources','receipt_id']} as const;
const dependencies=(...groups:number[][])=>[...new Set(groups.flat())].filter(id=>Number.isSafeInteger(id)&&id>0);
async function recordStockSources(sql:SQL,kind:keyof typeof sourceTables,id:string,sources:number[]){
 const [table,key]=sourceTables[kind],ids=dependencies(sources);if(ids.length)await sql.query(`INSERT INTO ${table}(${key},source_message_id) SELECT $1,unnest($2::bigint[]) ON CONFLICT DO NOTHING`,[id,ids]);
}
// This metadata follows the snapshot that was returned, including a cached
// command result. It never pulls in items outside that snapshot's item IDs.
export async function stockSnapshotSources(sql:SQL,ids:string[]){
 if(!ids.length)return [];
 const rows=(await sql.query(`WITH
  items AS (SELECT * FROM stock_items WHERE id=ANY($1::uuid[])),
  movements AS (SELECT * FROM stock_movements WHERE item_id=ANY($1::uuid[])),
  needs AS (SELECT * FROM stock_needs WHERE item_id=ANY($1::uuid[])),
  reservations AS (SELECT * FROM stock_reservations WHERE item_id=ANY($1::uuid[])),
  aliases AS (SELECT * FROM stock_aliases WHERE item_id=ANY($1::uuid[])),
  receipts AS (SELECT * FROM stock_receipts r WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(r.lines) line WHERE (line->>'id')::uuid=ANY($1::uuid[]))),
  sources AS (
   SELECT name_source_id AS source_message_id FROM items
   UNION SELECT s.source_message_id FROM stock_item_sources s JOIN items i ON i.id=s.item_id
   UNION SELECT source_message_id FROM movements
   UNION SELECT origin_source_id FROM movements
   UNION SELECT s.source_message_id FROM stock_movement_sources s JOIN movements m ON m.id=s.movement_id
   UNION SELECT source_message_id FROM needs
   UNION SELECT s.source_message_id FROM stock_need_sources s JOIN needs n ON n.id=s.need_id
   UNION SELECT source_message_id FROM reservations
   UNION SELECT closed_source_id FROM reservations
   UNION SELECT s.source_message_id FROM stock_reservation_sources s JOIN reservations r ON r.id=s.reservation_id
   UNION SELECT s.source_message_id FROM stock_release_sources s JOIN reservations r ON r.id=s.reservation_id
   UNION SELECT source_message_id FROM aliases
   UNION SELECT s.source_message_id FROM stock_alias_sources s JOIN aliases a ON a.item_id=s.item_id AND a.alias=s.alias
   UNION SELECT source_message_id FROM receipts
   UNION SELECT s.source_message_id FROM stock_receipt_sources s JOIN receipts r ON r.id=s.receipt_id
  ) SELECT source_message_id FROM sources WHERE source_message_id IS NOT NULL ORDER BY source_message_id`,[ids])).rows;
 return dependencies(rows.map(r=>Number(r.source_message_id)));
}
async function stockReceiptSources(sql:SQL,id:string){
 return dependencies((await sql.query('SELECT source_message_id FROM stock_receipt_sources WHERE receipt_id=$1 UNION SELECT source_message_id FROM stock_receipts WHERE id=$1 AND source_message_id IS NOT NULL ORDER BY source_message_id',[id])).rows.map(r=>Number(r.source_message_id)));
}
export const stockSnapshotSourceSymbol=Symbol.for('lumen.stock.snapshotSources');
function compactSnapshotSources(result:any){
 if(Array.isArray(result?.source_ids)&&JSON.stringify(result).length>100000){const sources=result.source_ids;delete result.source_ids;Object.defineProperty(result,stockSnapshotSourceSymbol,{value:sources,enumerable:false});}
 return result;
}
export function amount(value:string,u:keyof typeof units){const [whole,fraction='']=value.replace('-','').split('.');const n=(BigInt(whole!)*1000n+BigInt(fraction.padEnd(3,'0')))*BigInt(units[u][1])*(value.startsWith('-')?-1n:1n);if(n>9000000000000000n||n< -9000000000000000n)throw new ToolError('quantity_limit');return n;}
export function displayAmount(value:string|bigint){const n=BigInt(value),v=n<0n?-n:n;return (n<0n?'-':'')+String(v/1000n)+(v%1000n?'.'+String(v%1000n).padStart(3,'0').replace(/0+$/,''):'');}
async function itemFor(sql:SQL,a:StockInput){
 if(a.id)return one(sql,'SELECT * FROM stock_items WHERE id=$1 FOR UPDATE',[a.id]);
 if(!a.item)throw new ToolError('item_required');const rows=(await sql.query('SELECT DISTINCT i.* FROM stock_items i LEFT JOIN stock_aliases a ON a.item_id=i.id WHERE lower(i.name)=lower($1) OR lower(a.alias)=lower($1)',[a.item])).rows;if(rows.length>1)throw new ToolError('ambiguous_item');return rows[0];
}
type Reservation=Row & {remaining:bigint;initial_quantity:bigint|null;sequence:bigint;closed_sequence:bigint|null;expires_us:bigint;live:boolean;status:string};
const compareSequence=(a:Reservation,b:Reservation)=>a.sequence<b.sequence?-1:a.sequence>b.sequence?1:0;
const sum=(rows:Reservation[])=>rows.reduce((n,r)=>n+r.remaining,0n);
const liveReservation=(r:Reservation)=>r.status==='active'||r.status==='needs_reconcile';

// Shopping quantity is the original claim. Replaying confirmed purchases retains
// enough evidence to undo a purchase or erase its source without inventing a claim.
async function reservations(sql:SQL,items:Row[]){
 const grouped=new Map<string,Reservation[]>(items.map(i=>[i.id,[]]));if(!items.length)return grouped;
 const ids=items.map(i=>i.id),rows=(await sql.query(`SELECT r.*,(EXTRACT(epoch FROM expires_at)*1000000)::bigint::text AS expires_us,expires_at>now() AS live FROM stock_reservations r WHERE item_id=ANY($1::uuid[]) ORDER BY sequence`,[ids])).rows;
 for(const row of rows){const initial=row.initial_quantity===null?null:BigInt(row.initial_quantity);grouped.get(row.item_id)!.push({...row,initial_quantity:initial,sequence:BigInt(row.sequence),closed_sequence:row.closed_sequence===null?null:BigInt(row.closed_sequence),expires_us:BigInt(row.expires_us),remaining:row.purpose==='stock'&&initial!==null?initial:BigInt(row.quantity)} as Reservation);}
 const movements=(await sql.query(`SELECT m.*,(EXTRACT(epoch FROM m.created_at)*1000000)::bigint::text AS created_us FROM stock_movements m WHERE m.item_id=ANY($1::uuid[]) AND m.kind IN ('purchase','consume') AND NOT EXISTS(SELECT 1 FROM stock_movements undo WHERE undo.reverses=m.id) ORDER BY m.sequence`,[ids])).rows;
 for(const purchase of movements){
  if(purchase.kind==='consume'){
   const held=grouped.get(purchase.item_id)!.find(r=>r.id===purchase.reservation_id&&r.purpose==='stock'&&r.initial_quantity!==null);
   if(held)held.remaining+=BigInt(purchase.quantity);continue;
  }
  const sequence=BigInt(purchase.sequence),created=BigInt(purchase.created_us),eligible=grouped.get(purchase.item_id)!.filter(r=>r.purpose==='shopping'&&r.actor_id===purchase.actor_id&&r.remaining>0n&&r.sequence<sequence&&created<r.expires_us&&(r.closed_sequence===null?r.status!=='released':sequence<r.closed_sequence));
  const total=sum(eligible),bought=BigInt(purchase.quantity),allocated=bought<total?bought:total;if(!allocated)continue;
  // Largest remainders distribute the final milli-units deterministically. No
  // float or another member's claim participates in an author's purchase.
  const shares=eligible.map(r=>({r,quantity:allocated*r.remaining/total,remainder:allocated*r.remaining%total}));
  let remainder=allocated-shares.reduce((n,s)=>n+s.quantity,0n);shares.sort((a,b)=>a.remainder>b.remainder?-1:a.remainder<b.remainder?1:compareSequence(a.r,b.r));
  for(const share of shares){share.r.remaining-=share.quantity+(remainder>0n?1n:0n);if(remainder>0n)remainder--;}
 }
 for(const item of items){
  const current=grouped.get(item.id)!,shopping=current.filter(r=>r.purpose==='shopping'&&r.live&&r.status!=='released'&&r.closed_sequence===null),overclaimed=sum(shopping)>BigInt(item.need);
  for(const r of current)if(r.purpose==='stock'&&r.initial_quantity!==null&&r.closed_sequence===null&&r.live){if(r.remaining===0n)r.status='consumed';else if(r.status==='consumed')r.status='active';}
  const stock=current.filter(r=>r.purpose==='stock'&&r.live&&r.status==='active'),stockInvalid=!item.known||sum(stock)>BigInt(item.quantity);
  for(const r of current){
   if(r.closed_sequence!==null){r.status=r.status==='needs_reconcile'?'needs_reconcile':'released';continue;}
   if(r.status==='released')continue;
   if(!r.live){r.status='expired';continue;}
   if(r.purpose==='shopping')r.status=r.remaining===0n?'fulfilled':overclaimed?'needs_reconcile':'active';
   else if(r.status==='active'&&stockInvalid)r.status='needs_reconcile';
  }
 }
 return grouped;
}
async function refreshReservations(sql:SQL,id:string){
 const item=await one(sql,'SELECT * FROM stock_items WHERE id=$1',[id]);if(!item)return [];
 const rows=(await reservations(sql,[item])).get(id)!;
 for(const row of rows){
  if(row.purpose==='stock'&&row.initial_quantity!==null)await sql.query('UPDATE stock_reservations SET status=$2,quantity=$3 WHERE id=$1 AND (status<>$2 OR quantity<>$3)',[row.id,row.status,String(row.remaining)]);
  else await sql.query('UPDATE stock_reservations SET status=$2 WHERE id=$1 AND status<>$2',[row.id,row.status]);
 }
 return rows;
}
async function view(sql:SQL,id:string|undefined,actorId:string){
 const items=(await sql.query(`SELECT * FROM stock_items ${id?'WHERE id=$1':''} ORDER BY name LIMIT 100`,id?[id]:[])).rows,all=await reservations(sql,items);
 return items.map(i=>{
  const rows=all.get(i.id)!,current=rows.filter(liveReservation),reserved=sum(current.filter(r=>r.purpose==='stock'&&r.status==='active')),shopping=sum(current.filter(r=>r.purpose==='shopping'&&r.closed_sequence===null)),unclaimed=BigInt(i.need)-shopping;
  const reservation=(r:Reservation)=>({id:r.id,actor_id:r.actor_id,purpose:r.purpose,quantity:displayAmount(r.remaining),status:r.status,expires_at:r.expires_at,...(r.closed_sequence!==null?{closed:true}:{})});
  return {id:i.id,name:i.name,unit:i.unit,version:i.version,stock:i.known?displayAmount(i.quantity):null,stock_status:i.known?'known':'needs_reconcile',need:displayAmount(i.need),reserved:displayAmount(reserved),available:i.known?displayAmount(BigInt(i.quantity)-reserved):null,shopping_reserved:displayAmount(shopping),need_unclaimed:displayAmount(unclaimed>0n?unclaimed:0n),own_reservations:current.filter(r=>r.actor_id===actorId).map(reservation),reservations_needing_reconcile:current.filter(r=>r.status==='needs_reconcile').map(reservation),...(!i.known?{notice:'Залишок потребує уточнення. Невідомо не означає нуль.'}:{})};
 });
}
async function snapshot(sql:SQL,id:string|undefined,actorId:string){
 const items=await view(sql,id,actorId);return {items,source_ids:await stockSnapshotSources(sql,items.map(i=>i.id))};
}
async function itemSnapshot(sql:SQL,id:string,actorId:string){
 const result=await snapshot(sql,id,actorId);return {item:result.items[0],source_ids:result.source_ids};
}
async function rebuild(sql:SQL,id:string){
 const rows=(await sql.query('SELECT * FROM stock_movements WHERE item_id=$1 ORDER BY sequence',[id])).rows,reversed=new Set(rows.filter(r=>r.kind==='reverse').map(r=>r.reverses));let known=false,q=0n;
 for(const row of rows){if(row.kind==='reverse'||reversed.has(row.id))continue;if(row.kind==='recount'){known=true;q=BigInt(row.quantity);continue;}if(known){q+=BigInt(row.quantity);if(q<0n){known=false;q=0n;}}}
 const need=(await sql.query('SELECT quantity,sequence FROM stock_needs WHERE item_id=$1 ORDER BY sequence DESC LIMIT 1',[id])).rows[0];let required=BigInt(need?.quantity||0);for(const row of rows)if(row.kind==='purchase'&&!reversed.has(row.id)&&BigInt(row.sequence)>BigInt(need?.sequence||0))required=required>BigInt(row.quantity)?required-BigInt(row.quantity):0n;await sql.query('UPDATE stock_items SET need=$2 WHERE id=$1',[id,String(required)]);
 await sql.query('UPDATE stock_items SET quantity=$2,known=$3,version=version+1 WHERE id=$1',[id,String(q),known]);await refreshReservations(sql,id);
}
export async function forgetStockSource(sql:SQL,source:number){
 const affected=(await sql.query(`
  SELECT m.item_id FROM stock_movements m WHERE m.source_message_id=$1 OR m.origin_source_id=$1 OR EXISTS(SELECT 1 FROM stock_movement_sources s WHERE s.movement_id=m.id AND s.source_message_id=$1)
  UNION SELECT r.item_id FROM stock_reservations r WHERE r.source_message_id=$1 OR r.closed_source_id=$1 OR EXISTS(SELECT 1 FROM stock_reservation_sources s WHERE s.reservation_id=r.id AND s.source_message_id=$1) OR EXISTS(SELECT 1 FROM stock_release_sources s WHERE s.reservation_id=r.id AND s.source_message_id=$1)
  UNION SELECT n.item_id FROM stock_needs n WHERE n.source_message_id=$1 OR EXISTS(SELECT 1 FROM stock_need_sources s WHERE s.need_id=n.id AND s.source_message_id=$1)
  UNION SELECT i.id AS item_id FROM stock_items i WHERE i.name_source_id=$1 OR EXISTS(SELECT 1 FROM stock_item_sources s WHERE s.item_id=i.id AND s.source_message_id=$1)
  UNION SELECT a.item_id FROM stock_aliases a WHERE a.source_message_id=$1 OR EXISTS(SELECT 1 FROM stock_alias_sources s WHERE s.item_id=a.item_id AND s.alias=a.alias AND s.source_message_id=$1)
  UNION SELECT (line->>'id')::uuid AS item_id FROM stock_receipts r CROSS JOIN LATERAL jsonb_array_elements(r.lines) AS line WHERE r.source_message_id=$1 OR EXISTS(SELECT 1 FROM stock_receipt_sources s WHERE s.receipt_id=r.id AND s.source_message_id=$1)
 `,[source])).rows;
 // Erasing a release removes its provenance, not its historical cutoff. An
 // unresolved closed claim never becomes a new instruction to buy or use stock.
 const closed=(await sql.query("UPDATE stock_reservations r SET status='needs_reconcile',closed_source_id=NULL WHERE r.closed_source_id=$1 OR EXISTS(SELECT 1 FROM stock_release_sources s WHERE s.reservation_id=r.id AND s.source_message_id=$1) RETURNING r.id",[source])).rows;
 if(closed.length)await sql.query('DELETE FROM stock_release_sources WHERE reservation_id=ANY($1::uuid[])',[closed.map(r=>r.id)]);
 await sql.query('DELETE FROM stock_needs n WHERE n.source_message_id=$1 OR EXISTS(SELECT 1 FROM stock_need_sources s WHERE s.need_id=n.id AND s.source_message_id=$1)',[source]);
 await sql.query('DELETE FROM stock_movements m WHERE m.source_message_id=$1 OR m.origin_source_id=$1 OR EXISTS(SELECT 1 FROM stock_movement_sources s WHERE s.movement_id=m.id AND s.source_message_id=$1)',[source]);
 await sql.query('DELETE FROM stock_reservations r WHERE r.source_message_id=$1 OR EXISTS(SELECT 1 FROM stock_reservation_sources s WHERE s.reservation_id=r.id AND s.source_message_id=$1)',[source]);
 await sql.query('DELETE FROM stock_receipts r WHERE r.source_message_id=$1 OR EXISTS(SELECT 1 FROM stock_receipt_sources s WHERE s.receipt_id=r.id AND s.source_message_id=$1)',[source]);
 await sql.query('DELETE FROM stock_aliases a WHERE a.source_message_id=$1 OR EXISTS(SELECT 1 FROM stock_alias_sources s WHERE s.item_id=a.item_id AND s.alias=a.alias AND s.source_message_id=$1)',[source]);
 await sql.query('DELETE FROM stock_items i WHERE i.name_source_id=$1 OR EXISTS(SELECT 1 FROM stock_item_sources s WHERE s.item_id=i.id AND s.source_message_id=$1)',[source]);
 for(const row of affected)await rebuild(sql,row.item_id);
 // No old command receipt may retain an erased balance or receipt line.
 if(affected.length)await sql.query("DELETE FROM domain_commands WHERE domain='household'");
 else await sql.query("DELETE FROM domain_commands WHERE domain='household' AND result->'source_ids' @> $1::jsonb",[JSON.stringify([source])]);
}
export class Household {
 constructor(private db:Database){}
 async run(a:StockInput,c:ToolContext):Promise<any>{
  // command() JSON-round-trips its stored receipt. Compact only afterwards so
  // replay keeps the complete dependency set even when public JSON would exceed
  // the tool result bound. AgentTools reads the symbol before serializing.
  return compactSnapshotSources(await this.execute(a,c));
 }
 private async execute(a:StockInput,c:ToolContext):Promise<any>{
  if(a.operation==='list')return this.db.tx(async sql=>{
   const live=await state(sql);if(live.paused||live.memory_revision!==c.revision)throw new ToolError('task_cancelled');
   if(Number(c.chatId)<0&&String(live.chat_id)!==c.chatId)throw new ToolError('other_chat');
   const member=await one(sql,'SELECT active FROM members WHERE user_id=$1',[c.actorId]);
   if(member?.active===false||!member&&live.owner_id!==c.actorId&&!(live.participants||[]).some((p:any)=>String(p.id)===c.actorId))throw new ToolError('member_required');
   return {...await snapshot(sql,undefined,c.actorId),limit:100};
  });
  return command(this.db,c,'household',a,async(sql,id)=>{
   await sql.query("UPDATE stock_reservations SET status='expired' WHERE closed_sequence IS NULL AND status IN ('active','needs_reconcile','fulfilled') AND expires_at<=now()");
   if(a.operation==='receipt'){
    if(!a.lines?.length)throw new ToolError('receipt_lines_required');const seen=new Set<string>();for(const line of a.lines){if(seen.has(line.id))throw new ToolError('receipt_duplicate_item_merge_lines');seen.add(line.id);const item=await itemFor(sql,{...a,id:line.id});if(!item)throw new ToolError('item_not_found');requireVersion(item.version,line.version);if(units[line.unit][0]!==item.unit||amount(line.quantity,line.unit)<=0n)throw new ToolError('receipt_unit_or_quantity_invalid');}
    await sql.query('INSERT INTO stock_receipts(id,actor_id,lines,source_message_id) VALUES($1,$2,$3,$4)',[id,c.actorId,JSON.stringify(a.lines),c.sourceId||null]);await recordStockSources(sql,'receipt',id,sourceIds(c));return {id,status:'draft',lines:a.lines,source_ids:dependencies(sourceIds(c),await stockSnapshotSources(sql,a.lines.map(line=>line.id))),notice:'Чернетка чека: запаси ще не змінено. Перевір кількості перед підтвердженням.'};
   }
   if(a.operation==='confirm_receipt'){
    const receipt=await one(sql,'SELECT * FROM stock_receipts WHERE id=$1 AND actor_id=$2 FOR UPDATE',[a.receipt_id,c.actorId]);if(!receipt)throw new ToolError('own_receipt_required');if(receipt.status==='confirmed')return {id:receipt.id,status:'confirmed',duplicate:true,source_ids:await stockReceiptSources(sql,receipt.id)};
    const draftSources=await stockReceiptSources(sql,receipt.id);
    const sources=dependencies(sourceIds(c),draftSources,receipt.source_message_id?[Number(receipt.source_message_id)]:[]),receiptContext={...c,sourceIds:sources};
    for(const line of receipt.lines)await this.mutate(sql,{...a,...line,operation:'purchase'},receiptContext,randomUUID(),receipt.source_message_id);await recordStockSources(sql,'receipt',receipt.id,sources);await sql.query("UPDATE stock_receipts SET status='confirmed' WHERE id=$1",[receipt.id]);const result=await snapshot(sql,undefined,c.actorId);return {id:receipt.id,status:'confirmed',...result,source_ids:dependencies(result.source_ids,sources)};
   }
   return this.mutate(sql,a,c,id);
  });
 }
 private async mutate(sql:SQL,a:StockInput,c:ToolContext,id:string,originSource?:number):Promise<any>{
  let item=await itemFor(sql,a);const sources=dependencies(sourceIds(c),originSource?[Number(originSource)]:[]);
  if(a.operation==='create'){
   if(item)throw new ToolError('item_already_exists');if(!a.item||!a.unit)throw new ToolError('name_and_unit_required');await sql.query('INSERT INTO stock_items(id,name,unit,name_source_id) VALUES($1,$2,$3,$4)',[id,a.item.trim(),units[a.unit][0],c.sourceId||null]);await recordStockSources(sql,'item',id,sources);item=await itemFor(sql,{...a,id});
   if(a.quantity!==undefined){const q=amount(a.quantity,a.unit);if(q<0n)throw new ToolError('positive_quantity_required');await sql.query("INSERT INTO stock_movements(id,item_id,kind,quantity,actor_id,source_message_id) VALUES($1,$1,'recount',$2,$3,$4)",[id,String(q),c.actorId,c.sourceId||null]);await recordStockSources(sql,'movement',id,sources);await sql.query('UPDATE stock_items SET known=true,quantity=$2 WHERE id=$1',[id,String(q)]);}return itemSnapshot(sql,id,c.actorId);
  }
  if(!item)throw new ToolError('item_not_found');requireVersion(item.version,a.version);
  const current=await refreshReservations(sql,item.id);
  if(a.operation==='alias'){
   if(!a.alias?.trim())throw new ToolError('alias_required');if(await one(sql,'SELECT item_id FROM stock_aliases WHERE lower(alias)=lower($1) AND item_id<>$2',[a.alias,item.id]))throw new ToolError('alias_conflict');const inserted=await one(sql,'INSERT INTO stock_aliases(item_id,alias,source_message_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING item_id',[item.id,a.alias,c.sourceId||null]);if(inserted&&sources.length)await sql.query('INSERT INTO stock_alias_sources(item_id,alias,source_message_id) SELECT $1,$2,unnest($3::bigint[]) ON CONFLICT DO NOTHING',[item.id,a.alias,sources]);
  }else if(a.operation==='release'){
   if(!await one(sql,"UPDATE stock_reservations SET status='released',closed_sequence=COALESCE(closed_sequence,nextval('stock_movements_sequence_seq')),closed_source_id=$4 WHERE id=$1 AND item_id=$2 AND actor_id=$3 AND status IN ('active','needs_reconcile') RETURNING id",[a.reservation_id,item.id,c.actorId,c.sourceId||null]))throw new ToolError('own_active_reservation_required');
   await sql.query('DELETE FROM stock_release_sources WHERE reservation_id=$1',[a.reservation_id]);await recordStockSources(sql,'release',a.reservation_id!,sources);
  }else if(a.operation==='reverse'){
   const move=await one(sql,"SELECT * FROM stock_movements WHERE id=$1 AND item_id=$2 AND kind<>'reverse'",[a.movement_id,item.id]);if(!move)throw new ToolError('movement_not_found');if(await one(sql,'SELECT id FROM stock_movements WHERE reverses=$1',[move.id]))throw new ToolError('already_reversed');await sql.query("INSERT INTO stock_movements(id,item_id,kind,quantity,actor_id,reverses,source_message_id) VALUES($1,$2,'reverse',0,$3,$4,$5)",[id,item.id,c.actorId,move.id,c.sourceId||null]);await recordStockSources(sql,'movement',id,sources);await rebuild(sql,item.id);return {operation_id:id,...await itemSnapshot(sql,item.id,c.actorId)};
  }else{
   if(a.quantity===undefined||!a.unit||units[a.unit][0]!==item.unit)throw new ToolError('quantity_and_compatible_unit_required');let q=amount(a.quantity,a.unit);if(q<0n&&a.operation!=='adjust')throw new ToolError('positive_quantity_required');
   const total=async()=>BigInt((await one(sql,"SELECT COALESCE(sum(quantity),0)::text AS q FROM stock_reservations WHERE item_id=$1 AND purpose='stock' AND status='active' AND expires_at>now()",[item.id]))!.q);
   if(a.operation==='need'){await sql.query('INSERT INTO stock_needs(id,item_id,quantity,source_message_id) VALUES($1,$2,$3,$4)',[id,item.id,String(q),c.sourceId||null]);await recordStockSources(sql,'need',id,sources);await sql.query('UPDATE stock_items SET need=$2 WHERE id=$1',[item.id,String(q)]);}
   else if(a.operation==='reserve'){
    if(q<=0n)throw new ToolError('positive_quantity_required');const purpose=a.purpose??'shopping';
    if(purpose==='stock'){
     if(!item.known)throw new ToolError('stock_needs_recount');if(BigInt(item.quantity)-await total()<q)throw new ToolError('insufficient_stock');
    }else if(BigInt(item.need)-sum(current.filter(r=>r.purpose==='shopping'&&r.closed_sequence===null&&liveReservation(r)))<q)throw new ToolError('insufficient_need');
    await sql.query("INSERT INTO stock_reservations(id,item_id,actor_id,quantity,expires_at,source_message_id,purpose,initial_quantity) VALUES($1,$2,$3,$4,now()+($5::int*interval '1 minute'),$6,$7,$8)",[id,item.id,c.actorId,String(q),a.ttl_minutes,c.sourceId||null,purpose,purpose==='stock'?String(q):null]);
    await recordStockSources(sql,'reservation',id,sources);
   }else{
    let reservationId:string|null=null;
    if(a.operation==='consume'){q=-q;if(a.reservation_id){const own=await one(sql,"SELECT * FROM stock_reservations WHERE id=$1 AND item_id=$2 AND actor_id=$3 AND purpose='stock' AND status='active' AND expires_at>now()",[a.reservation_id,item.id,c.actorId]);if(!own||BigInt(own.quantity)<-q)throw new ToolError('own_reservation_insufficient');reservationId=own.id;await sql.query("UPDATE stock_reservations SET quantity=quantity+$2,status=CASE WHEN quantity+$2=0 THEN 'consumed' ELSE 'active' END WHERE id=$1",[own.id,String(q)]);}}
    if(!item.known&&!['purchase','recount'].includes(a.operation))throw new ToolError('stock_needs_recount');const next=a.operation==='recount'?q:BigInt(item.quantity)+q,reserved=await total();if(next<0n||item.known&&next<reserved||a.operation==='recount'&&next<reserved)throw new ToolError('negative_or_reserved_stock');
    await sql.query('INSERT INTO stock_movements(id,item_id,kind,quantity,actor_id,source_message_id,origin_source_id,reservation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,item.id,a.operation,String(q),c.actorId,c.sourceId||null,originSource||null,reservationId]);await recordStockSources(sql,'movement',id,sources);await sql.query('UPDATE stock_items SET quantity=$2,known=CASE WHEN $3 THEN true ELSE known END,need=CASE WHEN $4 THEN GREATEST(0,need-$5) ELSE need END WHERE id=$1',[item.id,String(next),a.operation==='recount',a.operation==='purchase',String(q)]);
   }
  }
  await sql.query('UPDATE stock_items SET version=version+1 WHERE id=$1',[item.id]);await refreshReservations(sql,item.id);return {operation:a.operation,operation_id:id,...await itemSnapshot(sql,item.id,c.actorId)};
 }
}
