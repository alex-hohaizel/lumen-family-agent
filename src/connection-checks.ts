import { one, state, queueText, type Database } from './db.js';
import { ConnectorVault } from './connector-vault.js';
import { MCPClient } from './mcp-client.js';
import {recordIncident} from './incidents.js';
export class ConnectionChecks {
    constructor(private db: Database, private runtimeDir: string) { }
    async next() {
        const row: any = await this.db.tx(async (sql) => { const s = await state(sql, true); if (s.paused)
            return; const r = await one(sql, "SELECT * FROM tool_connections WHERE enabled=true AND health='check_pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED"); if (!r)
            return; const claimed = await one(sql, "UPDATE tool_connections SET health='checking',checked_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *", [r.id, r.owner_id]); return { ...claimed, revision: s.memory_revision }; });
        if (!row)
            return false;
        let count: number | undefined,failure:unknown;
        try {
            const token = row.credential_name ? await new ConnectorVault(this.db, this.runtimeDir).get(row.owner_id, row.credential_name) : undefined;
            count = (await new MCPClient(row.endpoint, token).list()).length;
        }
        catch(error) { failure=error; }
        await this.db.tx(async (sql) => { const s = await state(sql, true); if (s.paused || s.memory_revision !== row.revision)
            return; const r = await one(sql, "UPDATE tool_connections SET health=$1,checked_at=now() WHERE owner_id=$2 AND id=$3 AND enabled=true AND health='checking' AND checked_at=$4 RETURNING id", [count === undefined ? 'check_failed' : 'ready', row.owner_id, row.id, row.checked_at]); if (!r)
            return; if (count !== undefined && row.verification_task_id)
            await sql.query("UPDATE agent_tasks SET status='pending',error_code=NULL,available_at=now(),updated_at=now() WHERE id=$1 AND goal_version=$2 AND status='needs_input' AND error_code='connection_pending'", [row.verification_task_id, row.verification_goal_version]); const incident=count===undefined?await recordIncident(sql,{operation:'connector',stage:'validation',attemptKey:'connection-check:'+row.owner_id+':'+row.id+':'+new Date(row.created_at).getTime(),actorId:row.owner_id,topicId:'0',audience:'private',revision:s.memory_revision,effectState:'unchanged',taskId:row.verification_task_id},failure):undefined;await queueText(sql, incident ? `Підключення «${row.id}» збережене.\n`+incident.message : `Підключення «${row.id}» готове: ${count} інструментів. Відповіді особистих сервісів за замовчуванням отримуєш у лічці.`, s.memory_revision, 'connection-check:' + row.owner_id + ':' + row.id + ':' + new Date(row.created_at).getTime(), false, { actorId: row.owner_id, audience: 'private' }); });
        return true;
    }
}
