import { one, type Database } from './db.js';
export async function verifyTask(db: Database, job: any, text: string) {
    const runs = (await db.query("SELECT id,tool,result FROM tool_runs WHERE task_id=$1 AND status='succeeded' AND goal_version=$2", [job.id, job.goal_version || 1])).rows;
    const receipts = (await db.query('SELECT kind,proof FROM result_receipts WHERE task_id=$1 AND actor_id=$2 AND goal_version=$3', [job.id, job.actor_id, job.goal_version || 1])).rows;
    const required = new Set<string>(job.criteria || ['response']);
    if (runs.some(r => ['artifact.create', 'document.create', 'media.speak'].includes(r.tool)))
        required.add('document');
    if (runs.some(r => r.tool === 'browser.commit') || /забронював|заброньовано|оплатив|оплачено|лист надіслав|надіслав лист/iu.test(text))
        required.add('external');
    const missing: string[] = [], waiting: string[] = [];
    for (const kind of required) {
        if (kind === 'response') {
            if (!text.trim())
                missing.push('response');
        }
        else if (kind === 'research') {
            if (!runs.some(r => ['web.read', 'web.search', 'research.query'].includes(r.tool) && (r.result?.url || r.result?.sources?.length || r.result?.results?.length)))
                missing.push('research_sources');
        }
        else if (kind === 'calculation') {
            if (!runs.some(r => r.tool === 'code.run' && r.result !== null))
                missing.push('calculation_result');
        }
        else if (kind === 'document') {
            const artifacts = runs.filter(r => ['artifact.create', 'document.create', 'media.speak'].includes(r.tool));
            if (!artifacts.length)
                missing.push('document');
            for (const r of artifacts) {
                const a = await one(db, 'SELECT a.id,o.status FROM agent_artifacts a LEFT JOIN outbox o ON o.dedup_key=\'artifact:\'||a.id::text WHERE a.id=$1 AND a.actor_id=$2', [r.result?.id, job.actor_id]);
                if (!a || ['failed', 'uncertain'].includes(a.status))
                    missing.push('document_delivery');
                else if (a.status !== 'sent')
                    waiting.push('document_delivery');
            }
        }
        else if (kind === 'external') {
            if (!receipts.some(r => r.kind === 'external' && r.proof?.service_status === 'confirmed' && r.proof?.reference && r.proof?.source_run_id))
                missing.push('provider_confirmation');
        }
    }
    return { ok: missing.length === 0 && waiting.length === 0, missing, waiting, verified_tools: runs.map(r => ({ id: r.id, tool: r.tool })), checked_at: new Date().toISOString() };
}
