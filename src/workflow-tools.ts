import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { one, type Database } from './db.js';
import type { Definition, ToolContext } from './agent-tools.js';
import { ToolError } from './safe-http.js';
type Add = (name: string, d: Definition) => void;
const uuid = z.string().uuid();
const parseJSON = (s: string, code: string) => {
    try {
        return JSON.parse(s);
    }
    catch {
        throw new ToolError(code);
    }
};
const bind = (value: any, input: any): any => {
    if (typeof value === 'string') {
        const whole = /^\{\{([a-zA-Z0-9_]+)\}\}$/.exec(value);
        if (whole) {
            if (!Object.hasOwn(input, whole[1]!))
                throw new ToolError('workflow_input_required');
            return input[whole[1]!];
        }
        return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, k) => {
            if (!Object.hasOwn(input, k))
                throw new ToolError('workflow_input_required');
            return String(input[k]);
        });
    }
    if (Array.isArray(value))
        return value.map(x => bind(x, input));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bind(v, input)]));
    return value;
};
export function registerWorkflowTools(db: Database, add: Add, execute: (name: string, args: any, c: ToolContext) => Promise<any>, catalog: () => any[]) {
    const validate = (steps: any) => {
        if (!Array.isArray(steps) || !steps.length || steps.length > 12)
            throw new ToolError('workflow_steps_required');
        for (const s of steps) {
            const t = catalog().find(x => x.name === s.tool);
            if (!t || t.effect || !['web.read', 'web.search', 'research.query', 'code.run', 'artifact.create', 'document.create', 'memory.search', 'memory.facts', 'event.list', 'artifact.list', 'artifact.read', 'project.status'].includes(s.tool) || !s.arguments || typeof s.arguments !== 'object' || Array.isArray(s.arguments))
                throw new ToolError('workflow_read_or_artifact_steps_required');
        }
        return steps;
    };
    const run = async (w: any, input: any, c: ToolContext, suffix: string) => {
        const results = [];
        for (const [i, step] of validate(w.steps).entries()) {
            const result = await execute(step.tool, bind(step.arguments, input), { ...c, updateId: c.updateId + ':' + suffix + ':' + i });
            if (result?.needs_approval || result?.error)
                throw new ToolError('workflow_step_failed');
            results.push({ tool: step.tool, result });
        }
        return results;
    };
    add('workflow.save', { description: 'Зберегти версійну процедуру з дозволених інструментів читання/обчислень/файлів. examples — JSON-масив {input,expected?}; draft до фактичної перевірки.', background: false, schema: z.object({ title: z.string().min(2).max(150), steps: z.string().max(16000), examples: z.string().max(8000).default('[]') }), run: async (a, c) => {
            const steps = validate(parseJSON(a.steps, 'workflow_steps_required')), examples = parseJSON(a.examples, 'workflow_examples_json_required');
            if (!Array.isArray(examples) || examples.length > 8)
                throw new ToolError('workflow_examples_invalid');
            const id = randomUUID();
            await db.tx(async (sql) => { await sql.query('INSERT INTO agent_workflows(id,title,actor_id,steps,source_message_id) VALUES($1,$2,$3,$4,$5)', [id, a.title, c.actorId, JSON.stringify(steps), c.sourceId || null]); await sql.query('INSERT INTO skill_versions(workflow_id,version,steps,examples) VALUES($1,1,$2,$3)', [id, JSON.stringify(steps), JSON.stringify(examples)]); });
            return { id, status: 'draft', version: 1 };
        } });
    add('workflow.revise', { description: 'Створити нову чернетку версії своєї навички, зберігши попередні кроки й перевірки для відкату.', background: false, schema: z.object({ id: uuid, steps: z.string().max(16000), examples: z.string().max(8000).default('[]') }), run: async (a, c) => {
            const steps = validate(parseJSON(a.steps, 'workflow_steps_required')), examples = parseJSON(a.examples, 'workflow_examples_json_required');
            if (!Array.isArray(examples) || examples.length > 8)
                throw new ToolError('workflow_examples_invalid');
            return db.tx(async (sql) => {
                const w = await one(sql, 'SELECT * FROM agent_workflows WHERE id=$1 AND actor_id=$2 FOR UPDATE', [a.id, c.actorId]);
                if (!w)
                    throw new ToolError('workflow_not_found');
                await sql.query('INSERT INTO skill_versions(workflow_id,version,steps,status) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [w.id, w.version, JSON.stringify(w.steps), w.status]);
                const n = Number((await one(sql, 'SELECT max(version) n FROM skill_versions WHERE workflow_id=$1', [w.id]))?.n || 0) + 1;
                await sql.query('INSERT INTO skill_versions(workflow_id,version,steps,examples) VALUES($1,$2,$3,$4)', [w.id, n, JSON.stringify(steps), JSON.stringify(examples)]);
                await sql.query("UPDATE agent_workflows SET steps=$1,version=$2,status='draft',verified_runs=0,last_error=NULL WHERE id=$3", [JSON.stringify(steps), n, w.id]);
                return { id: w.id, version: n, status: 'draft' };
            });
        } });
    add('workflow.run', { description: 'Виконати власну навичку з JSON inputs, із поточними дозволами. Реальний успіх фіксується для конкретної версії.', schema: z.object({ id: uuid, inputs: z.string().max(4000).default('{}') }), run: async (a, c) => {
            const w = await one(db, 'SELECT * FROM agent_workflows WHERE id=$1 AND actor_id=$2', [a.id, c.actorId]);
            if (!w)
                throw new ToolError('workflow_not_found');
            try {
                const results = await run(w, parseJSON(a.inputs, 'workflow_inputs_invalid'), c, 'workflow:' + w.version);
                await db.query("UPDATE agent_workflows SET status='verified',verified_runs=verified_runs+1,last_error=NULL WHERE id=$1 AND version=$2", [w.id, w.version]);
                await db.query("INSERT INTO skill_versions(workflow_id,version,steps,status,test_results) VALUES($1,$2,$3,'verified',$4) ON CONFLICT(workflow_id,version) DO UPDATE SET status='verified',test_results=excluded.test_results", [w.id, w.version, JSON.stringify(w.steps), JSON.stringify([{ kind: 'real_run', at: new Date().toISOString(), passed: true }])]);
                return { id: w.id, version: w.version, status: 'verified', results };
            }
            catch (e) {
                await db.query('UPDATE agent_workflows SET last_error=$1 WHERE id=$2', [e instanceof ToolError ? e.code : 'workflow_failed', w.id]);
                throw e;
            }
        } });
    add('workflow.test', { description: 'Виконати збережені контрольні приклади власної версії; expected порівнюється з масивом результатів. Помилка не підтверджує навичку.', schema: z.object({ id: uuid }), run: async (a, c) => {
            const w = await one(db, 'SELECT * FROM agent_workflows WHERE id=$1 AND actor_id=$2', [a.id, c.actorId]);
            if (!w)
                throw new ToolError('workflow_not_found');
            const v = await one(db, 'SELECT * FROM skill_versions WHERE workflow_id=$1 AND version=$2', [w.id, w.version]);
            if (!v?.examples?.length)
                throw new ToolError('workflow_test_examples_required');
            const checks = [];
            for (const [i, example] of v.examples.entries()) {
                try {
                    const results = await run(w, example.input || {}, c, 'test:' + w.version + ':' + i);
                    checks.push({ example: i, passed: example.expected === undefined || JSON.stringify(results.map(x => x.result)) === JSON.stringify(example.expected) });
                }
                catch (e) {
                    checks.push({ example: i, passed: false, error: e instanceof ToolError ? e.code : 'test_failed' });
                }
            }
            const passed = checks.every(x => x.passed);
            await db.query('UPDATE skill_versions SET status=$1,test_results=$2 WHERE workflow_id=$3 AND version=$4', [passed ? 'verified' : 'failed', JSON.stringify(checks), w.id, w.version]);
            await db.query('UPDATE agent_workflows SET status=$1,last_error=$2 WHERE id=$3 AND version=$4', [passed ? 'verified' : 'draft', passed ? null : 'test_example_failed', w.id, w.version]);
            return { id: w.id, version: w.version, passed, checks };
        } });
    add('workflow.versions', { description: 'Історія власної навички: версії, приклади й фактичні перевірки. Нових прав не надає.', schema: z.object({ id: uuid }), run: async (a, c) => (await db.query('SELECT v.version,v.status,v.examples,v.test_results,v.created_at FROM skill_versions v JOIN agent_workflows w ON w.id=v.workflow_id WHERE w.id=$1 AND w.actor_id=$2 ORDER BY v.version DESC', [a.id, c.actorId])).rows });
    add('workflow.rollback', { description: 'Відновити раніше перевірену версію як нову версію з історією відкату; права перевіряються при кожному запуску.', background: false, schema: z.object({ id: uuid, version: z.number().int().positive() }), run: async (a, c) => db.tx(async (sql) => {
            const w = await one(sql, 'SELECT * FROM agent_workflows WHERE id=$1 AND actor_id=$2 FOR UPDATE', [a.id, c.actorId]);
            if (!w)
                throw new ToolError('workflow_not_found');
            const old = await one(sql, "SELECT * FROM skill_versions WHERE workflow_id=$1 AND version=$2 AND status='verified'", [w.id, a.version]);
            if (!old)
                throw new ToolError('verified_workflow_version_required');
            const n = Number((await one(sql, 'SELECT max(version) n FROM skill_versions WHERE workflow_id=$1', [w.id]))?.n || 0) + 1;
            await sql.query("INSERT INTO skill_versions(workflow_id,version,steps,examples,status,test_results) VALUES($1,$2,$3,$4,'verified',$5)", [w.id, n, JSON.stringify(old.steps), JSON.stringify(old.examples), JSON.stringify([{ rollback_from: a.version, verified: true }])]);
            await sql.query("UPDATE agent_workflows SET steps=$1,version=$2,status='verified',last_error=NULL WHERE id=$3", [JSON.stringify(old.steps), n, w.id]);
            return { id: w.id, version: n, restored_from: a.version };
        }) });
}
