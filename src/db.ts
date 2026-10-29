import {recordProvenance,invalidateProvenance} from './provenance.js';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import type { TextOptions } from './telegram.js';

export type Row = Record<string, any>;
export const AGENT_TABLES=['tool_grants','tool_runs','tool_approvals','agent_tasks','web_monitors','agent_workflows','agent_artifacts','group_events','agent_feedback','memory_terms','connection_setups','tool_connections','tool_credentials'];
export interface SQL {
  query<T extends Row = Row>(sql: string, args?: any[]): Promise<{ rows: T[] }>;
  script?(sql:string):Promise<void>;
}
export interface Database extends SQL {
  tx<T>(fn: (sql: SQL) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export class Postgres implements Database {
  pool: pg.Pool;
  constructor(url: string) { this.pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 10000 }); }
  async query<T extends Row = Row>(sql: string, args: any[] = []) {
    return await this.pool.query(sql, args) as unknown as { rows: T[] };
  }
  async tx<T>(fn: (sql: SQL) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await fn({query:async <R extends Row=Row>(q:string,a:any[]=[])=>await client.query(q,a) as unknown as {rows:R[]},script:async q=>{await client.query(q);}}); await client.query('COMMIT'); return result; }
    catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}
export async function applySchema(sql: SQL) {
  const schema = await readFile(new URL('../../src/schema.sql', import.meta.url), 'utf8');
  const body=schema.replace(/^\s*BEGIN;\s*/,'').replace(/\s*COMMIT;\s*$/,'');
  if(sql.script)await sql.script(body);else await sql.query(body);
}
export async function migrate(db: Database) { await db.tx(applySchema); }
export async function one(sql: SQL, query: string, args: any[] = []) { return (await sql.query(query, args)).rows[0]; }
export async function state(sql: SQL, lock = false) {
  return (await one(sql, `SELECT * FROM app_state WHERE id=1${lock ? ' FOR UPDATE' : ''}`))!;
}
export async function queueText(sql: SQL, text: string, revision: number, key: string, service = false, options: TextOptions = {}) {
  // Split by Unicode code point; do not cut a surrogate pair or exceed Telegram's limit.
  const chunks:string[]=[];let chunk='';
  for(const ch of text){if(chunk.length+ch.length>3500){chunks.push(chunk);chunk='';}chunk+=ch;}
  if(chunk)chunks.push(chunk);
  let start=0;
  for (let offset = 0; offset < chunks.length; offset++) {
    const length=chunks[offset]!.length;
    const entities=(options.entities || []).filter(e=>e.offset<start+length&&e.offset+e.length>start).map(e=>({...e,offset:Math.max(start,e.offset)-start,length:Math.min(start+length,e.offset+e.length)-Math.max(start,e.offset)}));
    const inserted=await sql.query(`INSERT INTO outbox (dedup_key, kind, body, revision, service,source_message_id,actor_id,audience) VALUES ($1,'text',$2,$3,$4,$5,$6,$7) ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
      [`${key}:${offset}`, JSON.stringify({ text: chunks[offset], ...(options.outputLanguage?{outputLanguage:options.outputLanguage}:{}), ...(options.taskId?{taskId:options.taskId,goalVersion:options.goalVersion}:{}), ...(offset===0&&options.replyMarkup?{replyMarkup:options.replyMarkup}:{}),
        ...(options.replyToMessageId?{replyToMessageId:options.replyToMessageId}:{}), ...(options.threadId?{threadId:options.threadId}:{}), ...(entities.length?{entities}:{}), ...((service||options.audience==='private')&&options.targetChatId?{targetChatId:options.targetChatId}:{}) }), revision, service,options.sourceMessageId || null,options.actorId || null,options.audience || 'group']);
    if(inserted.rows[0])await recordProvenance(sql,'outbox',inserted.rows[0].id,[...(options.sourceIds||[]),...(options.sourceMessageId?[options.sourceMessageId]:[])]);
    start+=length;
  }
}
export async function queueAnimation(sql:SQL,asset:'waving'|'happy'|'thinking',revision:number,key:string,caption='',threadId?:number){
  await sql.query("INSERT INTO outbox(dedup_key,kind,body,revision) VALUES ($1,'animation',$2,$3) ON CONFLICT DO NOTHING",[key,JSON.stringify({asset,caption,...(threadId?{threadId}:{})}),revision]);
}
export async function pauseMemory(sql:SQL){
  await sql.query("UPDATE scheduled_actions SET status='paused' WHERE status IN ('pending','awaiting_confirmation')");
  await sql.query("UPDATE app_state SET paused=true,consent='[]',memory_revision=memory_revision+1 WHERE id=1");
  await sql.query("UPDATE reminders SET status='pending' WHERE status='queued'");
  for(const table of ['inbox','outbox','choices','choice_votes','pending_intents','dialogues','topic_attention'])await sql.query(`DELETE FROM ${table}`);
  await sql.query("UPDATE image_jobs SET cancelled=true,status='cancelled',updated_at=now() WHERE status IN ('pending','processing','ready')");
  await sql.query("UPDATE agent_tasks SET status='cancelled',updated_at=now() WHERE status IN ('pending','running','waiting')");
  await sql.query("UPDATE interactions SET phase='paused',version=version+1 WHERE phase IN ('collecting','ready','active')");
  await sql.query("UPDATE web_monitors SET status='paused' WHERE status='active'");
  await sql.query("UPDATE tool_approvals SET status='cancelled' WHERE status IN ('pending','approved')");
  const s=await state(sql);
  await sql.query("UPDATE attachments SET revision=$1,status=CASE WHEN status='processing' THEN 'pending' ELSE status END",[s.memory_revision]);
}
export async function eraseAll(sql: SQL) {
  // Remove all derived data, generated drafts, pending deliveries and attachment IDs too.
  for (const table of ['alias_observations','chat_preferences','scheduled_actions','interaction_responses','interactions','message_panels','result_receipts','signals','proactivity_preferences','skill_versions','research_cache','activity_moves','activity_players','activity_sessions','decision_ballots','decisions','project_tasks','projects','knowledge_facts','private_requests','task_events','task_stages','capability_health','private_results','provenance_edges','coordination_offers','oauth_setups',...AGENT_TABLES,'topic_attention','image_jobs','poll_votes','polls','avatars','attachments','dialogues','choice_votes','participant_preferences','memories','rules','games','reminders','skills','episodes','stickers','choices','pending_intents','messages','outbox','inbox','topics','members']) await sql.query(`DELETE FROM ${table}`);
  await sql.query(`UPDATE app_state SET memory_revision=memory_revision+1, character='', mode=CASE WHEN mention_only THEN 'quiet' ELSE 'social' END, since_bot=0,last_social_at=NULL,participants=CASE WHEN open_group THEN '[]'::jsonb ELSE participants END WHERE id=1`);
  await sql.query('DELETE FROM characters');
}
const SOURCE_TABLES=['scheduled_actions','tool_grants','tool_runs','tool_approvals','agent_tasks','web_monitors','agent_workflows','agent_artifacts','group_events','agent_feedback','memory_terms','private_requests','knowledge_facts','projects','decisions','activity_sessions','signals','result_receipts','coordination_offers','interactions','message_panels'];
async function invalidateSource(sql:SQL,sourceId:number){
  await sql.query("UPDATE participant_preferences SET inferred_name='' WHERE user_id IN (SELECT user_id FROM alias_observations WHERE source_message_id=$1)",[sourceId]);
  await invalidateProvenance(sql,sourceId);
  await sql.query("DELETE FROM tool_credentials WHERE name IN (SELECT answer FROM private_requests WHERE source_message_id=$1 AND answer IS NOT NULL)",[sourceId]);
  for(const table of SOURCE_TABLES)await sql.query(`DELETE FROM ${table} WHERE source_message_id=$1`,[sourceId]);
  for(const table of ['participant_preferences','memories','rules','skills','reminders','attachments','dialogues','image_jobs','polls'])await sql.query(`DELETE FROM ${table} WHERE source_message_id=$1`,[sourceId]);
  await sql.query('DELETE FROM episodes WHERE source_ids @> $1::jsonb',[JSON.stringify([sourceId])]);
  await sql.query('DELETE FROM games WHERE source_ids @> $1::jsonb',[JSON.stringify([sourceId])]);
  await sql.query('DELETE FROM choice_votes WHERE menu_id IN (SELECT menu_id FROM choices WHERE source_message_id=$1)',[sourceId]);
  await sql.query('DELETE FROM choices WHERE source_message_id=$1',[sourceId]);
  await sql.query('DELETE FROM outbox WHERE source_message_id=$1',[sourceId]);
  await sql.query("DELETE FROM messages WHERE role='assistant' AND source_message_id=$1",[sourceId]);
  await sql.query("DELETE FROM inbox WHERE (payload->>'sourceId')::bigint=$1",[sourceId]);
}
async function refreshRevision(sql:SQL){
  await sql.query('UPDATE app_state SET memory_revision=memory_revision+1 WHERE id=1');
  const s=await state(sql);
  await sql.query('DELETE FROM topic_attention');
  await sql.query('DELETE FROM pending_intents');
  await sql.query("UPDATE inbox SET status=CASE WHEN status='processing' THEN 'pending' ELSE status END,revision=$1,plan=NULL WHERE status IN ('pending','processing')",[s.memory_revision]);
  await sql.query("UPDATE outbox SET revision=$1,status=CASE WHEN status='sending' THEN 'uncertain' ELSE status END",[s.memory_revision]);
  for(const table of ['choices','dialogues','attachments','polls','agent_tasks','web_monitors','tool_grants','private_requests','agent_artifacts','interactions','message_panels'])await sql.query(`UPDATE ${table} SET revision=$1`,[s.memory_revision]);
  await sql.query("UPDATE tool_approvals SET status='cancelled' WHERE status IN ('pending','approved')");
  await sql.query("UPDATE agent_tasks SET status='needs_input',error_code='context_changed' WHERE status IN ('running','waiting')");
  await sql.query("UPDATE image_jobs SET status=CASE WHEN status='processing' THEN 'uncertain' ELSE status END,revision=$1 WHERE status IN ('pending','ready','processing')",[s.memory_revision]);
}
export async function forgetPhrase(sql:SQL,phrase:string){
  if(phrase.trim().length<2)throw new Error('forget_fragment_required');
  const sources=(await sql.query("SELECT id FROM messages WHERE strpos(lower(body),lower($1))>0",[phrase])).rows;
  for(const row of sources)await invalidateSource(sql,Number(row.id));
  await sql.query('DELETE FROM messages WHERE strpos(lower(body),lower($1))>0',[phrase]);
  // Old summaries without recorded provenance cannot safely be attributed to a source.
  await sql.query("DELETE FROM episodes WHERE source_ids='[]'::jsonb");
  await sql.query("DELETE FROM messages WHERE role='assistant' AND source_message_id IS NULL");
  for(const table of ['memories','rules','skills','reminders'])await sql.query(`DELETE FROM ${table} WHERE source_message_id IS NULL`);
  await sql.query("UPDATE app_state SET character='' WHERE strpos(lower(character),lower($1))>0",[phrase]);
  await sql.query('DELETE FROM characters WHERE strpos(lower(content),lower($1))>0',[phrase]);
  await refreshRevision(sql);
  return sources.length;
}
export async function reviseSource(sql:SQL,sourceId:number,text:string){
  const original=await one(sql,'SELECT body FROM messages WHERE id=$1',[sourceId]);
  if(original)await sql.query('DELETE FROM reminders WHERE source_message_id IS NULL AND length(title)>=8 AND strpos(lower($1),lower(title))>0',[original.body]);
  await invalidateSource(sql,sourceId);
  await sql.query('UPDATE messages SET body=$1,edited_at=now() WHERE id=$2',[text,sourceId]);
  await refreshRevision(sql);
}
