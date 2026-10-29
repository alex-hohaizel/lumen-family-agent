import type { SQL } from './db.js';
const tables: Record<string, string> = { schedule:'scheduled_actions', interaction:'interactions',panel:'message_panels', private_result: 'private_results', private_request: 'private_requests', connection_setup: 'connection_setups', oauth_setup: 'oauth_setups', approval: 'tool_approvals', tool_run: 'tool_runs', task: 'agent_tasks', memory: 'memories', rule: 'rules', skill: 'skills', reminder: 'reminders', artifact: 'agent_artifacts', project: 'projects', decision: 'decisions', session: 'activity_sessions', signal: 'signals', event: 'group_events', workflow: 'agent_workflows', message: 'messages', outbox: 'outbox', fact: 'knowledge_facts', image: 'image_jobs', monitor: 'web_monitors' };
export async function recordProvenance(sql: SQL, kind: string, key: string | number, sources: number[]) {
    if (!tables[kind])
        throw new Error('invalid_provenance_kind');
    const ids = [...new Set(sources.filter(x => Number.isSafeInteger(x) && x > 0))];
    if (!ids.length)
        return;
    await sql.query('INSERT INTO provenance_edges(derived_kind,derived_key,source_message_id) SELECT $1,$2,id FROM messages WHERE id=ANY($3::bigint[]) ON CONFLICT DO NOTHING', [kind, String(key), ids]);
}
export function resultSources(tool: string, result: any): number[] {
    if (tool === 'memory.search' || tool === 'history')
        return (Array.isArray(result) ? result : []).map(r => Number(r.id)).filter(Number.isSafeInteger);
    if (tool === 'memory.facts')
        return (Array.isArray(result) ? result : []).map(r => Number(r.source_message_id)).filter(x => Number.isSafeInteger(x) && x > 0);
    return [];
}
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
        await sql.query(`DELETE FROM ${tables[item.kind]} WHERE id=$1`, [item.key]);
        await sql.query('DELETE FROM provenance_edges WHERE derived_kind=$1 AND derived_key=$2', [item.kind, item.key]);
    }
}
export async function transferProvenance(sql: SQL, fromKind: string, fromKey: string | number, toKind: string, toKey: string | number) { await sql.query('INSERT INTO provenance_edges(derived_kind,derived_key,source_message_id) SELECT $1,$2,source_message_id FROM provenance_edges WHERE derived_kind=$3 AND derived_key=$4 ON CONFLICT DO NOTHING', [toKind, String(toKey), fromKind, String(fromKey)]); }
