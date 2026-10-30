import {z} from 'zod';
import {one,state,type Database,type SQL} from './db.js';
import {command,digest,requireVersion,sourceIds} from './evolution-core.js';
import {ToolError} from './safe-http.js';
import type {ToolContext} from './agent-tools.js';

const SourceKind=z.enum(['games','activity_sessions']);
export const GameResultCommand=z.object({operation:z.enum(['read','correct']),source_kind:SourceKind,source_key:z.string().min(1).max(100),version:z.number().int().positive().optional(),scores:z.array(z.object({user_id:z.string().min(1).max(30),score:z.number().int().min(-2147483648).max(2147483647)})).min(1).max(100).optional(),reason:z.string().trim().min(1).max(1000).optional()});
type Ref={source_kind:z.infer<typeof SourceKind>;source_key:string};
type Scores=Record<string,number>;
const normalized=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('uk').replace(/\s+/gu,' ').trim();
function reference(ref:Ref){if(ref.source_kind==='games'?!/^[1-9]\d*$/.test(ref.source_key):!/^[a-f0-9-]{36}$/.test(ref.source_key))throw new ToolError('game_result_reference_invalid');return ref;}
async function access(sql:SQL,c:ToolContext){const live=await state(sql);if(live.paused||live.memory_revision!==c.revision)throw new ToolError('context_changed');if(Number(c.chatId)<0&&String(live.chat_id)!==c.chatId)throw new ToolError('other_chat');if(Number(live.chat_id)>0&&String(live.chat_id)!==c.actorId)throw new ToolError('owner_required');const member=await one(sql,'SELECT active FROM members WHERE user_id=$1',[c.actorId]);if(member?.active===false||!member&&live.owner_id!==c.actorId&&!(live.participants||[]).some((p:any)=>String(p.id)===c.actorId))throw new ToolError('member_required');return live;}
async function load(sql:SQL,ref:Ref,topic?:string){reference(ref);const row=await one(sql,`SELECT * FROM ${ref.source_kind} WHERE id::text=$1${topic===undefined?'':' AND topic_id=$2'} FOR UPDATE`,topic===undefined?[ref.source_key]:[ref.source_key,topic]);if(!row)throw new ToolError('game_result_unavailable');const outcome=await one(sql,'SELECT version,status,finished_at,time_precision FROM canonical_outcomes WHERE source_kind=$1 AND source_key=$2 AND topic_id=$3 FOR UPDATE',[ref.source_kind,ref.source_key,row.topic_id]);if(!outcome||outcome.status!==(ref.source_kind==='games'?row.status:row.phase))throw new ToolError('game_result_unavailable');
 const players=ref.source_kind==='games'?(Array.isArray(row.state?.players)?row.state.players:[]).filter((p:any)=>p&&typeof p.id==='string').map((p:any)=>({user_id:p.id,name:typeof p.name==='string'?p.name:p.id,score:row.state.scores?.[p.id]??0})):(await sql.query('SELECT user_id,name,score FROM activity_players WHERE session_id=$1 ORDER BY user_id',[row.id])).rows;
 const scores:Scores={};for(const p of players){if(!Number.isSafeInteger(p.score)||p.score< -2147483648||p.score>2147483647)throw new ToolError('game_score_invalid');scores[p.user_id]=p.score;}
 return {row,outcome,players,scores};
}
export async function gameResultSources(sql:SQL,refs:Ref[],includeCorrections=true){
 if(!refs.length)return [];const games=[...new Set(refs.filter(r=>r.source_kind==='games').map(r=>reference(r).source_key))],sessions=[...new Set(refs.filter(r=>r.source_kind==='activity_sessions').map(r=>reference(r).source_key))];
 const recorded=(await sql.query(`SELECT jsonb_array_elements_text(source_ids) AS source FROM games WHERE id::text=ANY($1::text[])
 UNION ALL SELECT source_message_id::text FROM activity_sessions WHERE id::text=ANY($2::text[])
 UNION ALL SELECT source_message_id::text FROM provenance_edges WHERE derived_kind='game' AND derived_key=ANY($1::text[]) OR derived_kind='session' AND derived_key=ANY($2::text[])
 UNION ALL SELECT source_message_id::text FROM game_segments WHERE game_id::text=ANY($1::text[])
 UNION ALL SELECT source_message_id::text FROM activity_story_segments WHERE session_id::text=ANY($2::text[])
 ${includeCorrections?`UNION ALL SELECT jsonb_array_elements_text(source_ids) FROM game_result_bases WHERE source_kind='games' AND source_key=ANY($1::text[]) OR source_kind='activity_sessions' AND source_key=ANY($2::text[])
 UNION ALL SELECT jsonb_array_elements_text(source_ids) FROM game_result_corrections WHERE source_kind='games' AND source_key=ANY($1::text[]) OR source_kind='activity_sessions' AND source_key=ANY($2::text[])
 UNION ALL SELECT source_message_id::text FROM game_result_corrections WHERE source_kind='games' AND source_key=ANY($1::text[]) OR source_kind='activity_sessions' AND source_key=ANY($2::text[])`:''}`,[games,sessions])).rows;
 const ids=[...new Set(recorded.map(r=>Number(r.source)).filter(id=>Number.isSafeInteger(id)&&id>0))];return ids.length?(await sql.query('SELECT id FROM messages WHERE id=ANY($1::bigint[]) ORDER BY id',[ids])).rows.map(r=>Number(r.id)):[];
}
async function dependencies(sql:SQL,ref:Ref,_row:any){return gameResultSources(sql,[ref],false);}
async function writeScores(sql:SQL,ref:Ref,scores:Scores){
 if(ref.source_kind==='games')await sql.query("UPDATE games SET state=jsonb_set(state,'{scores}',$2::jsonb,true),updated_at=now() WHERE id::text=$1",[ref.source_key,JSON.stringify(scores)]);
 else{await sql.query('UPDATE activity_players p SET score=s.value::integer FROM jsonb_each_text($2::jsonb) s WHERE p.session_id::text=$1 AND p.user_id=s.key',[ref.source_key,JSON.stringify(scores)]);await sql.query('UPDATE activity_sessions SET version=version+1 WHERE id::text=$1',[ref.source_key]);}
 return (await one(sql,'SELECT version FROM canonical_outcomes WHERE source_kind=$1 AND source_key=$2',[ref.source_kind,ref.source_key]))!.version as number;
}
async function history(sql:SQL,ref:Ref){return (await sql.query('SELECT c.id,c.sequence,c.canonical_version,c.actor_id,m.name AS actor_name,c.reason,c.patch,c.before_scores,c.after_scores,c.source_message_id,c.source_ids,c.created_at FROM game_result_corrections c LEFT JOIN members m ON m.user_id=c.actor_id WHERE c.source_kind=$1 AND c.source_key=$2 ORDER BY c.sequence',[ref.source_kind,ref.source_key])).rows;}
function projected(base:Scores,patches:any[],participants:Scores){let scores:Scores=Object.fromEntries(Object.keys(participants).map(id=>[id,base[id]??0]));for(const correction of patches)for(const [id,value] of Object.entries(correction.patch))if(Object.hasOwn(scores,id))scores[id]=value as number;return scores;}
async function result(sql:SQL,ref:Ref,current:Awaited<ReturnType<typeof load>>){const corrections=await history(sql,ref);return {...ref,version:current.outcome.version,status:current.outcome.status,finished_at:current.outcome.finished_at,time_precision:current.outcome.time_precision,participants:current.players.map((p:any)=>({user_id:p.user_id,name:p.name,score:current.scores[p.user_id]})),correction_count:corrections.length,corrections,history_projection:'surviving_patches_replayed_from_base',source_ids:await gameResultSources(sql,[ref]),source_coverage:'recorded_dependencies_only',private_roles_withheld:true};}

export class GameResults{
 constructor(private db:Database){}
 async run(input:z.infer<typeof GameResultCommand>,c:ToolContext){const a=GameResultCommand.parse(input),ref=reference(a);
  if(a.operation==='read')return this.db.tx(async sql=>{await access(sql,c);return result(sql,ref,await load(sql,ref,c.topicId));});
  return command(this.db,c,'game_result',a,async(sql,id)=>{
   const live=await access(sql,c),current=await load(sql,ref,c.topicId);requireVersion(current.outcome.version,a.version);if(current.outcome.status!=='completed')throw new ToolError('completed_game_result_required');
   let host=current.row.actor_id;if(ref.source_kind==='games'&&current.row.state?.interaction_id)host=(await one(sql,'SELECT actor_id FROM interactions WHERE id=$1 AND topic_id=$2',[current.row.state.interaction_id,c.topicId]))?.actor_id;
   if(live.owner_id!==c.actorId&&host!==c.actorId)throw new ToolError('game_result_owner_or_host_required');
   if(!a.reason||!a.scores?.length)throw new ToolError('game_result_reason_and_scores_required');const patch:Scores={};for(const p of a.scores){if(!Object.hasOwn(current.scores,p.user_id))throw new ToolError('game_result_participant_required');if(Object.hasOwn(patch,p.user_id))throw new ToolError('game_result_duplicate_participant');patch[p.user_id]=p.score;}
   const ids=sourceIds(c).filter(id=>id>0);if(!c.sourceId||!ids.includes(c.sourceId))throw new ToolError('game_result_correction_source_required');const sources=(await sql.query('SELECT id,user_id,role,topic_id,body FROM messages WHERE id=ANY($1::bigint[])',[ids])).rows,request=sources.find(s=>Number(s.id)===c.sourceId);
   if(sources.length!==ids.length||!request||request.role!=='user'||request.user_id!==c.actorId||request.topic_id!==c.topicId)throw new ToolError('game_result_correction_source_required');
   if(!sources.some(s=>s.role==='user'&&s.topic_id===c.topicId&&normalized(s.body).includes(normalized(a.reason!))))throw new ToolError('game_result_reason_source_required');
   let base=await one(sql,'SELECT base_scores FROM game_result_bases WHERE source_kind=$1 AND source_key=$2 FOR UPDATE',[ref.source_kind,ref.source_key]);if(!base){await sql.query('INSERT INTO game_result_bases(source_kind,source_key,base_scores,source_ids) VALUES($1,$2,$3,$4)',[ref.source_kind,ref.source_key,JSON.stringify(current.scores),JSON.stringify(await dependencies(sql,ref,current.row))]);base={base_scores:current.scores};}
   const previous=await history(sql,ref),before=projected(base.base_scores,previous,current.scores);if(digest(before)!==digest(current.scores))throw new ToolError('game_result_projection_changed');const after={...before,...patch};if(digest(before)===digest(after))throw new ToolError('game_result_score_change_required');
   const version=await writeScores(sql,ref,after);await sql.query('INSERT INTO game_result_corrections(id,source_kind,source_key,canonical_version,actor_id,reason,patch,before_scores,after_scores,source_message_id,source_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,ref.source_kind,ref.source_key,version,c.actorId,a.reason,JSON.stringify(patch),JSON.stringify(before),JSON.stringify(after),c.sourceId,JSON.stringify(ids)]);
   return result(sql,ref,await load(sql,ref,c.topicId));
  });
 }
}

async function removeCorrections(sql:SQL,ids:string[]){if(!ids.length)return;const refs=(await sql.query('SELECT DISTINCT source_kind,source_key FROM game_result_corrections WHERE id=ANY($1::uuid[]) ORDER BY source_kind,source_key',[ids])).rows as Ref[];
 for(const ref of refs){let current:Awaited<ReturnType<typeof load>>;try{current=await load(sql,ref);}catch{continue;}const base=await one(sql,'SELECT base_scores FROM game_result_bases WHERE source_kind=$1 AND source_key=$2 FOR UPDATE',[ref.source_kind,ref.source_key]);await sql.query('DELETE FROM game_result_corrections WHERE source_kind=$1 AND source_key=$2 AND id=ANY($3::uuid[])',[ref.source_kind,ref.source_key,ids]);if(!base)throw new ToolError('game_result_base_unavailable');let scores=projected(base.base_scores,[],current.scores);for(const correction of await history(sql,ref)){const before={...scores};scores=projected(scores,[correction],current.scores);await sql.query('UPDATE game_result_corrections SET before_scores=$2,after_scores=$3 WHERE id=$1',[correction.id,JSON.stringify(before),JSON.stringify(scores)]);}await writeScores(sql,ref,scores);const refreshed=await result(sql,ref,await load(sql,ref));await sql.query("UPDATE domain_commands SET result=$3 WHERE domain='game_result' AND result->>'source_kind'=$1 AND result->>'source_key'=$2",[ref.source_kind,ref.source_key,JSON.stringify(refreshed)]);}
 await sql.query('DELETE FROM domain_commands WHERE id=ANY($1::uuid[])',[ids]);
}
export async function forgetGameResultSource(sql:SQL,source:number){
 // Original result dependencies invalidate the source itself. Correction sources
 // only remove their immutable patches; they never become base dependencies.
 for(const ref of (await sql.query('SELECT source_kind,source_key FROM game_result_bases WHERE source_ids @> $1::jsonb',[JSON.stringify([source])])).rows as Ref[]){reference(ref);await sql.query("DELETE FROM domain_commands WHERE domain='game_result' AND result->>'source_kind'=$1 AND result->>'source_key'=$2",[ref.source_kind,ref.source_key]);await sql.query(`DELETE FROM ${ref.source_kind} WHERE id::text=$1`,[ref.source_key]);}
 const ids=(await sql.query('SELECT id FROM game_result_corrections WHERE source_message_id=$1 OR source_ids @> $2::jsonb',[source,JSON.stringify([source])])).rows.map(r=>r.id);await removeCorrections(sql,ids);
}
export async function purgeGameResultPhrase(sql:SQL,phrase:string){const ids=(await sql.query("SELECT id FROM game_result_corrections WHERE strpos(lower(reason||' '||patch::text),lower($1))>0",[phrase])).rows.map(r=>r.id);await removeCorrections(sql,ids);}
