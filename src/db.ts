import pg from 'pg';
import { readFile } from 'node:fs/promises';

export type Row = Record<string, any>;
export interface SQL {
  query<T extends Row = Row>(sql: string, args?: any[]): Promise<{ rows: T[] }>;
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
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}
export async function migrate(db: SQL) {
  const schema = await readFile(new URL('../../src/schema.sql', import.meta.url), 'utf8');
  // A versioned transaction prevents half-applied initial schema.
  await db.query(schema);
}
export async function one(sql: SQL, query: string, args: any[] = []) { return (await sql.query(query, args)).rows[0]; }
export async function state(sql: SQL, lock = false) {
  return (await one(sql, `SELECT * FROM app_state WHERE id=1${lock ? ' FOR UPDATE' : ''}`))!;
}
export async function queueText(sql: SQL, text: string, revision: number, key: string, service = false) {
  // Split by Unicode code point; do not cut a surrogate pair or exceed Telegram's limit.
  const chunks:string[]=[];let chunk='';
  for(const ch of text){if(chunk.length+ch.length>3500){chunks.push(chunk);chunk='';}chunk+=ch;}
  if(chunk)chunks.push(chunk);
  for (let offset = 0; offset < chunks.length; offset++) {
    await sql.query(`INSERT INTO outbox (dedup_key, kind, body, revision, service) VALUES ($1,'text',$2,$3,$4) ON CONFLICT (dedup_key) DO NOTHING`,
      [`${key}:${offset}`, JSON.stringify({ text: chunks[offset] }), revision, service]);
  }
}
export async function queueAnimation(sql:SQL,asset:'waving'|'happy'|'thinking',revision:number,key:string,caption=''){
  await sql.query("INSERT INTO outbox(dedup_key,kind,body,revision) VALUES ($1,'animation',$2,$3) ON CONFLICT DO NOTHING",[key,JSON.stringify({asset,caption}),revision]);
}
export async function eraseAll(sql: SQL) {
  // Remove all derived data, generated drafts, pending deliveries and attachment IDs too.
  for (const table of ['participant_preferences','memories','rules','games','reminders','skills','episodes','messages','outbox','inbox']) await sql.query(`DELETE FROM ${table}`);
  await sql.query(`UPDATE app_state SET memory_revision=memory_revision+1, character='', mode='social', since_bot=0,last_social_at=NULL WHERE id=1`);
  await sql.query('DELETE FROM characters');
}
export async function forgetPhrase(sql: SQL, phrase: string) {
  // SQL parameters plus literal substring matching: '%' and '_' carry no wildcard authority.
  // Clear all derived stories/rules/drafts to avoid retaining paraphrases of the removed source.
  await sql.query(`DELETE FROM messages WHERE strpos(lower(body),lower($1)) > 0`, [phrase]);
  await sql.query("DELETE FROM messages WHERE role='assistant'");
  for (const table of ['participant_preferences','memories','rules','games','reminders','skills','episodes','outbox','inbox','characters']) await sql.query(`DELETE FROM ${table}`);
  await sql.query(`UPDATE app_state SET memory_revision=memory_revision+1, character='' WHERE id=1`);
}
