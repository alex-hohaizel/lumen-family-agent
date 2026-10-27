import { transferProvenance } from './provenance.js';
import { one, state, type Database } from './db.js';
import { createHash } from 'node:crypto';
import { ToolError } from './safe-http.js';
export function estimateStages(stages: any[], status: string) { const done = stages.filter(x => x.status === 'done'), remaining = stages.filter(x => ['pending', 'running'].includes(x.status)).length; const comparable = stages.length > 0 && stages.every(x => x.unit_type !== 'unknown' && x.unit_type === stages[0]?.unit_type); const times = done.filter(x => comparable && x.started_at && x.finished_at).map(x => new Date(x.finished_at).getTime() - new Date(x.started_at).getTime()).filter(x => x > 1000).sort((a, b) => a - b); const median = times[Math.floor(times.length / 2)]; return times.length >= 2 && remaining && ['pending', 'running'].includes(status) && median ? { minimum_seconds: Math.ceil(median * remaining * .6 / 1000), maximum_seconds: Math.ceil(median * remaining * 1.8 / 1000), basis: 'measured_same_type_stages' } : null; }
export function etaText(eta: ReturnType<typeof estimateStages>) {
    if (!eta)
        return 'Час завершення поки не можу надійно оцінити.';
    return eta.maximum_seconds < 60 ? 'Орієнтовно менше хвилини — за тривалістю подібних завершених етапів.' : `Орієнтовно ${Math.max(1, Math.ceil(eta.minimum_seconds / 60))}–${Math.ceil(eta.maximum_seconds / 60)} хв — за тривалістю подібних завершених етапів.`;
}
export class TaskJournal {
    constructor(private db: Database) { }
    async event(id: string, kind: string, detail: unknown = {}) { await this.db.query('INSERT INTO task_events(task_id,goal_version,kind,detail) SELECT id,goal_version,$2,$3 FROM agent_tasks WHERE id=$1', [id, kind, JSON.stringify(detail)]); }
    async snapshot(id: string, actor: string) {
        const job = await one(this.db, 'SELECT id,actor_id,title,status,result,error_code,goal_version,verified_at,updated_at FROM agent_tasks WHERE id=$1 AND actor_id=$2', [id, actor]);
        if (!job)
            throw new ToolError('task_not_found');
        const stages = (await this.db.query('SELECT position,title,status,started_at,finished_at,unit_type FROM task_stages WHERE task_id=$1 ORDER BY position', [id])).rows;
        const done = stages.filter(x => x.status === 'done'), pending = stages.filter(x => x.status === 'pending'), active = stages.find(x => x.status === 'running');
        const eta = estimateStages(stages, job.status);
        return { ...job, stages, done: done.map(x => x.title), current: active?.title || null, remaining: pending.map(x => x.title), eta };
    }
    async publish(id: string, force = false) {
        await this.db.tx(async (sql) => {
            const s = await state(sql, true);
            const job = await one(sql, 'SELECT * FROM agent_tasks WHERE id=$1 FOR UPDATE', [id]);
            if (!job || s.paused || job.revision !== s.memory_revision)
                return;
            if (!force && job.progress_at && Date.now() - new Date(job.progress_at).getTime() < 40000)
                return;
            const stages = (await sql.query('SELECT title,status,unit_type,started_at,finished_at FROM task_stages WHERE task_id=$1 ORDER BY position', [id])).rows;
            const done = stages.filter(x => x.status === 'done').map(x => x.title), active = stages.find(x => x.status === 'running'), left = stages.filter(x => x.status === 'pending').map(x => x.title);
            const labels: Record<string, string> = { pending: 'У черзі', running: 'Працюю', waiting: 'Очікую підтвердження', needs_input: 'Потрібне уточнення', paused: 'Призупинено', verifying: 'Перевіряю результат і доставку', delivering: 'Результат перевірено, доставляю', completed: 'Завершено', failed: 'Зупинено через помилку', cancelled: 'Скасовано' };
            const text = [job.title, labels[job.status] || job.status, done.length ? 'Зроблено: ' + done.join('; ') : '', active ? 'Зараз: ' + active.title : '', left.length ? 'Залишилося: ' + left.join('; ') : '', job.status === 'needs_input' ? job.result : '', ['running', 'pending'].includes(job.status) ? etaText(estimateStages(stages, job.status)) : ''].filter(Boolean).join('\n').slice(0, 3200);
            const hash = createHash('sha256').update(text).digest('hex');
            if (hash !== job.progress_hash) {
                const inserted = await sql.query("INSERT INTO outbox(dedup_key,kind,body,revision,actor_id,source_message_id) VALUES($1,'task_status',$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id", ['task-progress:' + id + ':' + job.goal_version + ':' + hash, JSON.stringify({ taskId: id, goalVersion: job.goal_version, status: job.status, hash, text, threadId: job.topic_id === '0' ? undefined : Number(job.topic_id) }), s.memory_revision, job.actor_id, job.source_message_id]);
                if (inserted.rows[0])
                    await transferProvenance(sql, 'task', id, 'outbox', inserted.rows[0].id);
            }
            await sql.query('UPDATE agent_tasks SET progress_at=now(),progress_hash=$2 WHERE id=$1', [id, hash]);
        });
    }
    async tick() {
        for (const r of (await this.db.query("SELECT id FROM agent_tasks WHERE status IN ('pending','running','waiting','needs_input','delivering','verifying') AND (progress_at IS NULL OR progress_at<now()-interval '45 seconds') ORDER BY updated_at LIMIT 3")).rows)
            await this.publish(r.id);
    }
}
