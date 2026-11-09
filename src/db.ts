import {forgetGameResultSource,purgeGameResultPhrase} from './game-results.js';
import {transportThread} from './topic-scope.js';
import {forgetCalendarProposal} from './calendar-groups.js';
import {forgetLearningSource} from './learning.js';
import {forgetMediaSource,purgeMediaPhrase} from './media-assets.js';
import {forgetStockSource} from './household.js';
import {forgetListSource,purgeListPhrase} from './simple-lists.js';
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
  const exists=await one(sql,"SELECT to_regclass('schema_version') AS existing");if(exists?.existing){
    const row=await one(sql,'SELECT count(*) AS n FROM schema_version WHERE version BETWEEN 1 AND 22');
    if(Number(row?.n)===22){
      const shape=await one(sql,"SELECT count(*)=26 AS complete FROM information_schema.columns WHERE table_schema=current_schema() AND (table_name,column_name) IN (('agent_tasks','audience'),('media_jobs','verification'),('media_jobs','task_id'),('media_jobs','goal_version'),('media_jobs','action_id'),('simple_list_events','revision'),('studio_soundtracks','asset_id'),('messages','request_context'),('recurring_series','shared'),('recurring_series','manager_ids'),('scheduled_actions','shared'),('scheduled_actions','manager_ids'),('scheduled_actions','audience'),('reminders','shared'),('reminders','manager_ids'),('reminders','audience'),('topic_attention','silenced_source_id'),('topic_attention','silenced_revision'),('topic_attention','silenced_body_sha256'),('reminder_clarifications','actor_id'),('reminder_clarifications','topic_id'),('reminder_clarifications','revision'),('reminder_clarifications','source_message_id'),('reminder_clarifications','candidates'),('reminder_clarifications','purpose'),('reminder_clarifications','expires_at'))");
      const incidents=await one(sql,"SELECT count(*)=21 AS complete FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='diagnostic_incidents' AND column_name IN ('code','dedup_key','operation','stage','reason_code','reason_detail','actor_id','topic_id','audience','source_message_id','revision','action_id','task_id','tool_run_id','outbox_id','effect_state','facts','app_version','created_at','last_seen_at','occurrences')");
      if(shape?.complete===true&&incidents?.complete===true)return;
    }
  }
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
  options={...options,threadId:transportThread(options.threadId)};
  // Split by Unicode code point; do not cut a surrogate pair or exceed Telegram's limit.
  const chunks:string[]=[];let chunk='';
  for(const {segment:ch} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)){if(ch.length>3500)throw new Error('text_grapheme_too_large');if(chunk.length+ch.length>3500){chunks.push(chunk);chunk='';}chunk+=ch;}
  if(chunk)chunks.push(chunk);
  let start=0;
  for (let offset = 0; offset < chunks.length; offset++) {
    const length=chunks[offset]!.length;
    const entities=(options.entities || []).filter(e=>e.offset<start+length&&e.offset+e.length>start).map(e=>({...e,offset:Math.max(start,e.offset)-start,length:Math.min(start+length,e.offset+e.length)-Math.max(start,e.offset)}));
    const inserted=await sql.query(`INSERT INTO outbox (dedup_key, kind, body, revision, service,source_message_id,actor_id,audience) VALUES ($1,'text',$2,$3,$4,$5,$6,$7) ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
      [`${key}:${offset}`, JSON.stringify({ text: chunks[offset], ...(options.actionId?{actionId:options.actionId}:{}),...(options.compositionId?{compositionId:options.compositionId}:{}),...(options.optionalContribution?{ambient:true}:{}), ...(options.outputLanguage?{outputLanguage:options.outputLanguage}:{}), ...(options.taskId?{taskId:options.taskId,goalVersion:options.goalVersion}:{}), ...(offset===chunks.length-1&&options.replyMarkup?{replyMarkup:options.replyMarkup}:{}),
        ...(options.replyToMessageId?{replyToMessageId:options.replyToMessageId}:{}), ...(options.threadId?{threadId:options.threadId}:{}), ...(entities.length?{entities}:{}), ...((service||options.audience==='private')&&options.targetChatId?{targetChatId:options.targetChatId}:{}) }), revision, service,options.sourceMessageId || null,options.actorId || null,options.audience || 'group']);
    if(inserted.rows[0])await recordProvenance(sql,'outbox',inserted.rows[0].id,[...(options.sourceIds||[]),...(options.sourceMessageId?[options.sourceMessageId]:[])]);
    start+=length;
  }
}
export async function queueAnimation(sql:SQL,asset:'waving'|'happy'|'thinking',revision:number,key:string,caption='',threadId?:number){
  await sql.query("INSERT INTO outbox(dedup_key,kind,body,revision) VALUES ($1,'animation',$2,$3) ON CONFLICT DO NOTHING",[key,JSON.stringify({asset,caption,...(threadId?{threadId}:{})}),revision]);
}
export async function pauseMemory(sql:SQL){
  await sql.query('UPDATE app_state SET ingress_after=clock_timestamp() WHERE id=1');
  await sql.query('DELETE FROM media_inspections');
  await sql.query("UPDATE scheduled_actions SET status='paused' WHERE status IN ('pending','awaiting_confirmation')");
  await sql.query("UPDATE commitments SET phase='cancelled',state_version=state_version+1 WHERE phase NOT IN ('completed','cancelled','expired','failed')");
  await sql.query("UPDATE action_work SET status='cancelled',payload='{}',plan=NULL WHERE status IN ('pending','running','repair')");
  await sql.query("DELETE FROM conversation_goals");
  await sql.query("DELETE FROM reminder_clarifications");
  await sql.query('DELETE FROM diagnostic_incidents');
  await sql.query("DELETE FROM style_episodes");
  await sql.query("UPDATE app_state SET paused=true,consent='[]',memory_revision=memory_revision+1 WHERE id=1");
  await sql.query("UPDATE reminders SET status='pending' WHERE status='queued'");
  for(const table of ['inbox','outbox','choices','choice_votes','pending_intents','dialogues','topic_attention'])await sql.query(`DELETE FROM ${table}`);
  await sql.query("UPDATE media_jobs SET status='cancelled',manifest='{}',error_code='memory_paused' WHERE status IN ('queued','running')");await sql.query("UPDATE image_designs SET status='cancelled' WHERE status IN ('draft','rendering')");
  await sql.query("UPDATE image_jobs SET cancelled=true,status='cancelled',updated_at=now() WHERE status IN ('pending','processing','ready')");
  await sql.query("UPDATE agent_tasks SET status='cancelled',updated_at=now() WHERE status IN ('pending','running','waiting')");
  await sql.query("UPDATE interactions SET phase='paused',version=version+1 WHERE phase IN ('collecting','ready','active')");
  await sql.query("UPDATE web_monitors SET status='paused' WHERE status='active'");
  await sql.query("UPDATE tool_approvals SET status='cancelled' WHERE status IN ('pending','approved')");
  const s=await state(sql);
  await sql.query("UPDATE attachments SET revision=$1,status=CASE WHEN status='processing' THEN 'pending' ELSE status END",[s.memory_revision]);
}
export async function eraseAll(sql: SQL) {
  await sql.query('UPDATE app_state SET ingress_after=clock_timestamp() WHERE id=1');
  await forgetCalendarProposal(sql);
  await sql.query('DELETE FROM diagnostic_incidents');
  // Remove all derived data, generated drafts, pending deliveries and attachment IDs too.
  for (const table of ['media_inspections','image_designs','media_derivations','statistics_preferences','canonical_outcomes','recurring_occurrences','recurring_series','calendar_shares','calendar_proposals','calendar_operations','calendar_occurrences','calendar_mirrors','calendar_connections','calendar_setups','learning_progress','learning_attempts','learning_exercises','learning_goals','resource_views','asset_destination_grants','media_publications','media_job_inputs','media_jobs','resource_links','archive_items','archive_collections','studio_scenes','studio_projects','media_assets','media_destinations','stock_needs','stock_receipts','stock_reservations','stock_movements','stock_aliases','stock_items','simple_list_events','domain_commands','composition_runs','action_work','effect_operations','consent_grants','commitments','style_episodes','behavior_contributions','conversation_goals','alias_observations','chat_preferences','scheduled_actions','interaction_responses','interactions','message_panels','result_receipts','signals','proactivity_preferences','skill_versions','research_cache','activity_moves','activity_players','activity_sessions','decision_ballots','decisions','project_tasks','projects','knowledge_facts','private_requests','task_events','task_stages','capability_health','private_results','provenance_edges','coordination_offers','oauth_setups',...AGENT_TABLES,'topic_attention','image_jobs','poll_votes','polls','avatars','attachments','dialogues','choice_votes','participant_preferences','memories','rules','games','reminders','skills','episodes','stickers','choices','pending_intents','messages','outbox','inbox','topics','members']) await sql.query(`DELETE FROM ${table}`);
  await sql.query(`UPDATE app_state SET memory_revision=memory_revision+1, character='', mode=CASE WHEN mention_only THEN 'quiet' ELSE 'social' END, since_bot=0,last_social_at=NULL,participants=CASE WHEN open_group THEN '[]'::jsonb ELSE participants END WHERE id=1`);
  await sql.query('DELETE FROM characters');
}
const SOURCE_TABLES=['media_inspections','image_designs','recurring_series','composition_runs','conversation_goals','style_episodes','behavior_contributions','effect_operations','commitments','scheduled_actions','tool_grants','tool_runs','tool_approvals','agent_tasks','web_monitors','agent_workflows','agent_artifacts','group_events','agent_feedback','memory_terms','private_requests','knowledge_facts','projects','decisions','activity_sessions','signals','result_receipts','coordination_offers','interactions','message_panels'];
async function invalidateSource(sql:SQL,sourceId:number){
  await sql.query('DELETE FROM diagnostic_incidents WHERE source_message_id=$1',[sourceId]);
  await forgetGameResultSource(sql,sourceId);
  await forgetCalendarProposal(sql,sourceId);
  await forgetStockSource(sql,sourceId);
  await forgetListSource(sql,sourceId);
  await forgetLearningSource(sql,sourceId);
  await sql.query("UPDATE project_tasks SET status='needs_review',completion_evidence='{}' WHERE completion_source_ids @> $1::jsonb",[JSON.stringify([sourceId])]);
  await forgetMediaSource(sql,sourceId);
  await sql.query("DELETE FROM domain_commands WHERE source_ids @> $1::jsonb",[JSON.stringify([sourceId])]);
  for(const table of ['participant_preferences','chat_preferences'])for(const field of ['language','length_mode','humor_mode','formality','emoji_mode',...(table==='participant_preferences'?['preferred_name']:[])])await sql.query(`UPDATE ${table} SET ${field}='',field_sources=field_sources-$1 WHERE field_sources->>$1=$2`,[field,String(sourceId)]);

  // Legacy panels did not retain complete source edges. They cannot survive a source edit/forget.
  await sql.query('DELETE FROM message_panels WHERE provenance_version<2');
  await sql.query('DELETE FROM research_cache');
  await sql.query('DELETE FROM memory_terms WHERE source_message_id IS NULL');
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
  await sql.query("UPDATE tool_runs SET status='invalidated',result=NULL,arguments='{}',error_code='source_context_changed' WHERE status='succeeded' AND provenance_version=0 AND effectful IS NOT TRUE");
  const s=await state(sql);
  // Source invalidation has already removed dependent schedules. Carry only
  // surviving live work across this revision; a pause or cancellation is final.
  await sql.query("UPDATE scheduled_actions SET revision=$1 WHERE status IN ('pending','awaiting_confirmation','queued','dispatched','needs_input')",[s.memory_revision]);
  // Preserve a recent list continuation across erasure, without reviving an
  // admission context that was already cut off by a memory pause.
  await sql.query('UPDATE simple_list_events SET revision=$1 WHERE revision=$2',[s.memory_revision,s.memory_revision-1]);
  await sql.query("UPDATE media_jobs SET status='stale',manifest='{}',error_code='context_changed' WHERE status='running'");
  for(const table of ['image_designs','media_jobs','recurring_series','calendar_proposals','resource_views','calendar_setups'])await sql.query(`UPDATE ${table} SET revision=$1`,[s.memory_revision]);
  await sql.query('DELETE FROM topic_attention');
  await sql.query('DELETE FROM pending_intents');
  await sql.query("UPDATE inbox SET status=CASE WHEN status='processing' THEN 'pending' ELSE status END,revision=$1,plan=NULL WHERE status IN ('pending','processing')",[s.memory_revision]);
  await sql.query("UPDATE outbox SET revision=$1,status=CASE WHEN status='sending' THEN 'uncertain' ELSE status END",[s.memory_revision]);
  for(const table of ['choices','dialogues','attachments','polls','agent_tasks','web_monitors','tool_grants','private_requests','agent_artifacts','interactions','message_panels','composition_runs','conversation_goals','behavior_contributions','style_episodes','commitments','action_work'])await sql.query(`UPDATE ${table} SET revision=$1`,[s.memory_revision]);
  await sql.query("UPDATE effect_operations SET revision=$1 WHERE phase='reserved'",[s.memory_revision]);
  await sql.query("UPDATE effect_operations SET phase='uncertain',error_code='context_changed_during_dispatch' WHERE phase='dispatch_started'");
  await sql.query("UPDATE commitments SET phase='uncertain',error_code='context_changed_during_dispatch' WHERE id IN (SELECT action_id FROM effect_operations WHERE phase='uncertain') AND phase NOT IN ('completed','cancelled','expired','failed')");
  await sql.query("UPDATE tool_approvals SET status='cancelled' WHERE status IN ('pending','approved')");
  await sql.query("UPDATE agent_tasks SET status='needs_input',error_code='context_changed' WHERE status IN ('running','waiting')");
  await sql.query("UPDATE image_jobs SET status=CASE WHEN status='processing' THEN 'uncertain' ELSE status END,revision=$1 WHERE status IN ('pending','ready','processing')",[s.memory_revision]);
}
async function purgeMatchingDerived(sql:SQL,phrase:string){
  await purgeGameResultPhrase(sql,phrase);
  await purgeListPhrase(sql,phrase);
  await sql.query('DELETE FROM media_inspections WHERE id IN (SELECT inspection_id FROM media_inspection_payloads WHERE strpos(lower(payload::text),lower($1))>0)',[phrase]);
  await purgeMediaPhrase(sql,phrase);
  for(const g of (await sql.query("SELECT id FROM learning_goals WHERE strpos(lower(title),lower($1))>0 UNION SELECT goal_id AS id FROM learning_exercises WHERE strpos(lower(spec::text),lower($1))>0 UNION SELECT goal_id AS id FROM learning_attempts WHERE strpos(lower(answer||' '||feedback||' '||COALESCE(appeal,'')),lower($1))>0",[phrase])).rows)await sql.query('DELETE FROM learning_goals WHERE id=$1',[g.id]);
  // A generated detail can contain the requested fragment even when its original prompt did not.
  // Source edges remain primary; literal erasure also covers generated/cache payloads.
  const fields:Record<string,string>={
    stock_items:'name',stock_aliases:'alias',image_designs:'spec::text',recurring_series:'rule::text',domain_commands:'result::text',
    composition_runs:"plan::text||' '||outputs::text",message_panels:'pages::text',conversation_goals:"goal||' '||question||' '||why",behavior_contributions:'summary',style_episodes:'fields::text',
    commitments:"spec::text||' '||COALESCE(result::text,'')",effect_operations:"COALESCE(result::text,'')",outbox:'body::text',inbox:"payload::text||' '||COALESCE(plan::text,'')",
    agent_tasks:"goal||' '||result",agent_artifacts:'content',tool_runs:"arguments::text||' '||COALESCE(result::text,'')",result_receipts:'proof::text',
    memories:'content',rules:'content',skills:'instructions',episodes:'body',games:'state::text',knowledge_facts:'content',group_events:'details::text',signals:"title||' '||body",activity_sessions:"settings::text||' '||public_state::text",attachments:"description||' '||metadata::text",agent_feedback:'content',memory_terms:"term||' '||alternatives::text",
  };
  await sql.query('DELETE FROM research_cache');
  const affected=(await sql.query("SELECT id FROM interactions WHERE strpos(lower(spec::text||' '||COALESCE(result,'')),lower($1))>0",[phrase])).rows.map(r=>String(r.id));
  if(affected.length){await sql.query("DELETE FROM games WHERE state->>'interaction_id'=ANY($1::text[])",[affected]);await sql.query('DELETE FROM interactions WHERE id=ANY($1::uuid[])',[affected]);await sql.query('DELETE FROM commitments WHERE id=ANY($1::uuid[])',[affected]);}
  for(const [table,expression] of Object.entries(fields))await sql.query(`DELETE FROM ${table} WHERE strpos(lower(${expression}),lower($1))>0`,[phrase]);
}
export async function forgetPhrase(sql:SQL,phrase:string){
  if(phrase.trim().length<2)throw new Error('forget_fragment_required');
  await sql.query('UPDATE app_state SET ingress_after=clock_timestamp() WHERE id=1');
  const sources=(await sql.query("SELECT id FROM messages WHERE strpos(lower(body),lower($1))>0",[phrase])).rows;
  for(const row of sources)await invalidateSource(sql,Number(row.id));
  await purgeMatchingDerived(sql,phrase);
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
  const original=await one(sql,'SELECT body,role,telegram_id FROM messages WHERE id=$1',[sourceId]);
  if(original?.role==='assistant')await import('./storage-lifecycle.js').then(m=>m.detachDeliveredText(sql,original.telegram_id));
  if(original)await sql.query('DELETE FROM reminders WHERE source_message_id IS NULL AND length(title)>=8 AND strpos(lower($1),lower(title))>0',[original.body]);
  await invalidateSource(sql,sourceId);
  // Entity-only edits keep the same body hash but replace the original envelope.
  // Actual authorized ingress may recapture it after this invalidation.
  await sql.query('UPDATE messages SET body=$1,edited_at=now(),request_context=NULL WHERE id=$2',[text,sourceId]);
  await refreshRevision(sql);
}
