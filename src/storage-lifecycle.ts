import {createHash} from 'node:crypto';
import {one,state,type Database,type SQL} from './db.js';
import {pruneMediaInspectionPayloads} from './media-inspections.js';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
// Terminal duplicate transport text may reference an original; receipts and dedup survive.
export async function deliveredPayload(sql:SQL,row:any){
 if(!row.canonical_message_id)return row.body;
 const message=await one(sql,'SELECT body FROM messages WHERE id=$1',[row.canonical_message_id]);
 if(!message||sha(message.body)!==row.body.text_sha256)throw Error('delivery_original_changed');
 return {...row.body,text:message.body};
}
export async function detachDeliveredText(sql:SQL,telegramId:number|string){
 await sql.query("UPDATE outbox o SET body=(o.body-'text_sha256')||jsonb_build_object('text',m.body),canonical_message_id=NULL FROM messages m WHERE o.canonical_message_id=m.id AND m.telegram_id=$1 AND m.role='assistant'",[telegramId]);
}
export class StorageLifecycle {
 constructor(private db:Database){}
 async cleanup(){return this.db.tx(async sql=>{
  const live=await state(sql,true);if(live.paused)return {paused:true};
  const compacted=await sql.query("UPDATE inbox SET payload=jsonb_build_object('sourceId',payload->'sourceId'),plan=NULL WHERE update_id IN (SELECT update_id FROM inbox WHERE status='done' AND created_at<now()-interval '1 day' AND (plan IS NOT NULL OR payload ? 'message') ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING update_id");
  const rows=(await sql.query("SELECT o.id,o.body,m.id AS message_id,m.body AS original FROM outbox o JOIN messages m ON m.telegram_id=o.telegram_id AND m.role='assistant' WHERE o.status='sent' AND o.canonical_message_id IS NULL AND o.body->>'text'=m.body AND m.edited_at IS NULL AND o.created_at<now()-interval '1 day' ORDER BY o.id LIMIT 100 FOR UPDATE OF o SKIP LOCKED")).rows;
  let textBytes=0;for(const row of rows){await sql.query("UPDATE outbox SET body=(body-'text')||jsonb_build_object('text_sha256',$2::text),canonical_message_id=$3 WHERE id=$1",[row.id,sha(row.original),row.message_id]);textBytes+=Buffer.byteLength(row.original);}
  const expired:Record<string,number>={};for(const table of ['resource_views','message_panels','research_cache','style_episodes','behavior_contributions']){const key=table==='research_cache'?'cache_key':'id';expired[table]=(await sql.query(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE expires_at<now() ORDER BY expires_at LIMIT 500) RETURNING 1`)).rows.length;}
  await pruneMediaInspectionPayloads(sql);
  const orphans=await sql.query("DELETE FROM provenance_edges e WHERE (derived_kind='outbox' AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.id::text=e.derived_key)) OR (derived_kind='panel' AND NOT EXISTS(SELECT 1 FROM message_panels p WHERE p.id::text=e.derived_key)) OR (derived_kind='tool_run' AND NOT EXISTS(SELECT 1 FROM tool_runs r WHERE r.id::text=e.derived_key)) OR (derived_kind='media_inspection' AND NOT EXISTS(SELECT 1 FROM media_inspections i WHERE i.id::text=e.derived_key)) RETURNING 1");
  return {terminal_inbox_compacted:compacted.rows.length,sent_text_referenced:rows.length,duplicate_text_bytes:textBytes,expired,orphan_edges:orphans.rows.length,originals_removed:0,receipts_and_dedup_retained:true};
 });}
 async status(){const tables=(await this.db.query("SELECT c.relname AS name,pg_total_relation_size(c.oid)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15")).rows;return {tables,policy:{original_messages:'retained',original_files:'retained_until_explicit_removal',tool_results:'canonical_evidence_retained',sent_outbox:'receipt_and_dedup_retained_duplicate_text_references_original',terminal_inbox:'duplicate_payload_compacted_after_24h',reproducible_media_cache:'24h_or_48MiB_LRU',ui_and_research_cache:'expire_at_declared_deadline'},notice:'Обсяг оригіналів зростає з новими даними. Очищення прибирає дублікати й відтворювані кеші; для файлів діють квоти та явне керування матеріалами.'};}
}
