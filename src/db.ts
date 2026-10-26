import pg from 'pg';
import { readFile } from 'node:fs/promises';
import type { TextOptions } from './telegram.js';

export type Row = Record<string, any>;
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
    await sql.query(`INSERT INTO outbox (dedup_key, kind, body, revision, service,source_message_id,actor_id,audience) VALUES ($1,'text',$2,$3,$4,$5,$6,$7) ON CONFLICT (dedup_key) DO NOTHING`,
      [`${key}:${offset}`, JSON.stringify({ text: chunks[offset], ...(offset===0&&options.replyMarkup?{replyMarkup:options.replyMarkup}:{}),
        ...(options.replyToMessageId?{replyToMessageId:options.replyToMessageId}:{}), ...(options.threadId?{threadId:options.threadId}:{}), ...(entities.length?{entities}:{}), ...(service&&options.targetChatId?{targetChatId:options.targetChatId}:{}) }), revision, service,options.sourceMessageId || null,options.actorId || null,options.audience || 'group']);
    start+=length;
  }
}
export async function queueAnimation(sql:SQL,asset:'waving'|'happy'|'thinking',revision:number,key:string,caption='',threadId?:number){
  await sql.query("INSERT INTO outbox(dedup_key,kind,body,revision) VALUES ($1,'animation',$2,$3) ON CONFLICT DO NOTHING",[key,JSON.stringify({asset,caption,...(threadId?{threadId}:{})}),revision]);
}
export async function pauseMemory(sql:SQL){
  await sql.query("UPDATE app_state SET paused=true,consent='[]',memory_revision=memory_revision+1 WHERE id=1");
  await sql.query("UPDATE reminders SET status='pending' WHERE status='queued'");
  for(const table of ['inbox','outbox','choices','choice_votes','pending_intents','dialogues'])await sql.query(`DELETE FROM ${table}`);
  await sql.query("UPDATE image_jobs SET cancelled=true,status='cancelled',updated_at=now() WHERE status IN ('pending','processing','ready')");
  const s=await state(sql);
  await sql.query("UPDATE attachments SET revision=$1,status=CASE WHEN status='processing' THEN 'pending' ELSE status END",[s.memory_revision]);
}
export async function eraseAll(sql: SQL) {
  // Remove all derived data, generated drafts, pending deliveries and attachment IDs too.
  for (const table of ['image_jobs','poll_votes','polls','avatars','attachments','dialogues','choice_votes','participant_preferences','memories','rules','games','reminders','skills','episodes','stickers','choices','pending_intents','messages','outbox','inbox','topics','members']) await sql.query(`DELETE FROM ${table}`);
  await sql.query(`UPDATE app_state SET memory_revision=memory_revision+1, character='', mode=CASE WHEN mention_only THEN 'quiet' ELSE 'social' END, since_bot=0,last_social_at=NULL,participants=CASE WHEN open_group THEN '[]'::jsonb ELSE participants END WHERE id=1`);
  await sql.query('DELETE FROM characters');
}
export async function forgetPhrase(sql: SQL, phrase: string) {
  // SQL parameters plus literal substring matching: '%' and '_' carry no wildcard authority.
  // Clear all derived stories/rules/drafts to avoid retaining paraphrases of the removed source.
  await sql.query(`DELETE FROM messages WHERE strpos(lower(body),lower($1)) > 0`, [phrase]);
  await sql.query("DELETE FROM messages WHERE role='assistant'");
  for (const table of ['image_jobs','poll_votes','polls','avatars','attachments','dialogues','choice_votes','participant_preferences','memories','rules','games','reminders','skills','episodes','outbox','inbox','characters','choices','pending_intents']) await sql.query(`DELETE FROM ${table}`);
  await sql.query(`UPDATE app_state SET memory_revision=memory_revision+1, character='' WHERE id=1`);
}
export async function reviseSource(sql:SQL,sourceId:number,text:string){
  const original=await one(sql,'SELECT body FROM messages WHERE id=$1',[sourceId]);
  // Older releases did not record reminder provenance. Match only a complete,
  // sufficiently specific title present in this exact original source.
  if(original)await sql.query('DELETE FROM reminders WHERE source_message_id IS NULL AND length(title)>=8 AND strpos(lower($1),lower(title))>0',[original.body]);
  await sql.query('UPDATE messages SET body=$1,edited_at=now() WHERE id=$2',[text,sourceId]);
  for(const table of ['participant_preferences','memories','rules','skills','reminders','attachments','dialogues','image_jobs','polls'])await sql.query(`DELETE FROM ${table} WHERE source_message_id=$1`,[sourceId]);
  await sql.query('DELETE FROM episodes WHERE source_ids @> $1::jsonb',[JSON.stringify([sourceId])]);
  await sql.query('DELETE FROM games WHERE source_ids @> $1::jsonb',[JSON.stringify([sourceId])]);
  await sql.query('DELETE FROM choice_votes WHERE menu_id IN (SELECT menu_id FROM choices WHERE source_message_id=$1)',[sourceId]);
  await sql.query('DELETE FROM choices WHERE source_message_id=$1',[sourceId]);
  await sql.query('DELETE FROM outbox WHERE source_message_id=$1',[sourceId]);
  await sql.query("DELETE FROM messages WHERE role='assistant' AND source_message_id=$1",[sourceId]);
  await sql.query('DELETE FROM inbox');await sql.query('DELETE FROM pending_intents');
  await sql.query('UPDATE app_state SET memory_revision=memory_revision+1 WHERE id=1');
  const s=await state(sql);
  await sql.query('UPDATE outbox SET revision=$1 WHERE source_message_id IS DISTINCT FROM $2',[s.memory_revision,sourceId]);
  for(const table of ['choices','dialogues','attachments','polls'])await sql.query(`UPDATE ${table} SET revision=$1`,[s.memory_revision]);
  await sql.query("UPDATE image_jobs SET status=CASE WHEN status='processing' THEN 'uncertain' ELSE status END,revision=$1 WHERE status IN ('pending','ready','processing')",[s.memory_revision]);
}
