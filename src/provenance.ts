import type { SQL } from './db.js';
const tables: Record<string, string> = { media_inspection:'media_inspections',image_design:'image_designs',game:'games',series:'recurring_series',calendar_proposal:'calendar_proposals',media_asset:'media_assets',media_job:'media_jobs',collection:'archive_collections',archive_item:'archive_items',archive_caption:'archive_items',studio:'studio_projects',scene:'studio_scenes', composition:'composition_runs', goal:'conversation_goals',contribution:'behavior_contributions',style:'style_episodes',commitment:'commitments',effect:'effect_operations',receipt:'result_receipts', schedule:'scheduled_actions', interaction:'interactions',panel:'message_panels', private_result: 'private_results', private_request: 'private_requests', connection_setup: 'connection_setups', oauth_setup: 'oauth_setups', approval: 'tool_approvals', tool_run: 'tool_runs', task: 'agent_tasks', memory: 'memories', rule: 'rules', skill: 'skills', reminder: 'reminders', artifact: 'agent_artifacts', project: 'projects', decision: 'decisions', session: 'activity_sessions', signal: 'signals', event: 'group_events', workflow: 'agent_workflows', message: 'messages', outbox: 'outbox', fact: 'knowledge_facts', image: 'image_jobs', monitor: 'web_monitors' };
export async function recordProvenance(sql: SQL, kind: string, key: string | number, sources: number[]) {
    if (!tables[kind])
        throw new Error('invalid_provenance_kind');
    const ids = [...new Set(sources.filter(x => Number.isSafeInteger(x) && x > 0))];
    if (!ids.length)
        return;
    await sql.query('INSERT INTO provenance_edges(derived_kind,derived_key,source_message_id) SELECT $1,$2,id FROM messages WHERE id=ANY($3::bigint[]) ON CONFLICT DO NOTHING', [kind, String(key), ids]);
}
export const RESULT_SOURCE_IDS=Symbol.for('lumen.result.sourceIds');
export function withResultSources<T>(result:T,ids:number[]):T{if(result&&typeof result==='object')Object.defineProperty(result,RESULT_SOURCE_IDS,{value:[...new Set(ids)],configurable:true,enumerable:false});return result;}
export function resultSources(tool:string,result:any):number[]{
 const ids:number[]=[...(Array.isArray(result?.[RESULT_SOURCE_IDS])?result[RESULT_SOURCE_IDS]:[]),...(Array.isArray(result?.[Symbol.for('lumen.stock.snapshotSources')])?result[Symbol.for('lumen.stock.snapshotSources')]:[])];
 const seen=new Set<object>();
 const visit=(value:any)=>{
  if(!value||typeof value!=='object'||seen.has(value))return;
  seen.add(value);
  for(const [key,item] of Object.entries(value)){
   if(['source_message_id','answer_source_id','grading_source_id','review_source_id','question_source_id','caption_source_id','audience_source_id'].includes(key))ids.push(Number(item));
   else if(['source_ids','source_message_ids'].includes(key)&&Array.isArray(item)){for(const id of item)ids.push(Number(id));}
   else if(key==='field_sources'&&item&&typeof item==='object'){for(const id of Object.values(item))ids.push(Number(id));}
   else if(item&&typeof item==='object')visit(item);
  }
 };
 visit(result);
 if(['memory.search','history','memory.original'].includes(tool))ids.push(...(Array.isArray(result)?result:Array.isArray(result?.items)?result.items:result?.id?[result]:[]).map((r:any)=>Number(r.source_message_id||r.id)));
 if(tool==='memory.facts')ids.push(...(Array.isArray(result)?result:[]).map((r:any)=>Number(r.source_message_id)));
 return [...new Set(ids.map(Number).filter(x=>Number.isSafeInteger(x)&&x>0))];
}
export function completeResultSources(tool:string,result:any,knownIds?:number[]){const metadata=Array.isArray(result?.source_ids)||Array.isArray(result?.source_message_ids)||Array.isArray(result?.[RESULT_SOURCE_IDS])||Array.isArray(result?.[Symbol.for('lumen.stock.snapshotSources')]);return metadata&&(knownIds||resultSources(tool,result)).length>0||['memory.original','history','code.run','web.read','web.search','research.query','tools.describe'].includes(tool);}
export function compactResultSources(tool:string,result:any,knownIds?:number[]){const ids=knownIds||resultSources(tool,result);if(result&&typeof result==='object'&&Array.isArray(result.source_ids)&&result.source_ids.length>1000){delete result.source_ids;withResultSources(result,ids);}return result;}
export async function invalidateProvenance(sql: SQL, source: number) {
    const queue = [source], seen = new Set<number>(), derived = new Map<string, {
        kind: string;
        key: string;
    }>();
    for (let i = 0; i < queue.length; i++) {
        const id = queue[i]!;
        if (seen.has(id))
            continue;
        seen.add(id);
        const edges = (await sql.query('SELECT derived_kind,derived_key FROM provenance_edges WHERE source_message_id=$1', [id])).rows;
        for (const e of edges) {
            if (!tables[e.derived_kind])
                continue;
            derived.set(e.derived_kind + ':' + e.derived_key, { kind: e.derived_kind, key: e.derived_key });
            if (e.derived_kind === 'message')
                queue.push(Number(e.derived_key));
        }
        for (const r of (await sql.query("SELECT id FROM messages WHERE source_message_id=$1 AND role='assistant'", [id])).rows)
            queue.push(Number(r.id));
    }
    for (const id of seen) {
        await sql.query('DELETE FROM episodes WHERE source_ids @> $1::jsonb', [JSON.stringify([id])]);
        await sql.query('DELETE FROM games WHERE source_ids @> $1::jsonb', [JSON.stringify([id])]);
    }
    const interactions=[...derived.values()].filter(x=>x.kind==='interaction').map(x=>x.key);if(interactions.length)await sql.query("DELETE FROM games WHERE state->>'interaction_id'=ANY($1::text[])",[interactions]);
    const tasks = [...derived.values()].filter(x => x.kind === 'task').map(x => x.key);
    if (tasks.length)
        await sql.query('DELETE FROM tool_credentials WHERE name IN (SELECT answer FROM private_requests WHERE task_id=ANY($1::uuid[]) AND answer IS NOT NULL)', [tasks]);
    const privateIds = [...derived.values()].filter(x => x.kind === 'private_request').map(x => x.key);
    if (privateIds.length)
        await sql.query('DELETE FROM tool_credentials WHERE name IN (SELECT answer FROM private_requests WHERE id=ANY($1::uuid[]) AND answer IS NOT NULL)', [privateIds]);
    const oauthIds = [...derived.values()].filter(x => x.kind === 'oauth_setup').map(x => x.key);
    if (oauthIds.length)
        await sql.query('DELETE FROM tool_credentials WHERE name IN (SELECT device_credential FROM oauth_setups WHERE id=ANY($1::uuid[]) AND device_credential IS NOT NULL)', [oauthIds]);
    const resultIds = [...derived.values()].filter(x => x.kind === 'private_result').map(x => x.key);
    if (resultIds.length)
        await sql.query('DELETE FROM tool_credentials WHERE name IN (SELECT credential_name FROM private_results WHERE id=ANY($1::uuid[]))', [resultIds]);
    for (const item of derived.values()) {
        if(item.kind==='archive_caption'){await sql.query("UPDATE archive_items SET caption='',claim='uncertain',claimed_date=NULL WHERE id=$1",[item.key]);await sql.query('DELETE FROM provenance_edges WHERE derived_kind=$1 AND derived_key=$2',[item.kind,item.key]);continue;}

        await sql.query(`DELETE FROM ${tables[item.kind]} WHERE id=$1`, [item.key]);
        await sql.query('DELETE FROM provenance_edges WHERE derived_kind=$1 AND derived_key=$2', [item.kind, item.key]);
    }
}
export async function transferProvenance(sql: SQL, fromKind: string, fromKey: string | number, toKind: string, toKey: string | number) { await sql.query('INSERT INTO provenance_edges(derived_kind,derived_key,source_message_id) SELECT $1,$2,source_message_id FROM provenance_edges WHERE derived_kind=$3 AND derived_key=$4 ON CONFLICT DO NOTHING', [toKind, String(toKey), fromKind, String(fromKey)]); }
