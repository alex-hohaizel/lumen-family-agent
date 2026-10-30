import {Acceptance,verifyProjectEvidence} from './project-evidence.js';
import {requireVersion} from './evolution-core.js';
import { randomUUID } from 'node:crypto';
import { one, type Database } from './db.js';
import type { ToolContext } from './agent-tools.js';
import { ToolError } from './safe-http.js';
import { PrivateInbox } from './private-inbox.js';
import { ConnectorVault } from './connector-vault.js';
export class GroupWork {
    constructor(private db: Database) { }
    async saveFact(a: any, c: ToolContext) {
        return this.db.tx(async (sql) => {
            const previous = await one(sql, "SELECT id,version FROM knowledge_facts WHERE actor_id=$1 AND lower(subject)=lower($2) AND kind=$3 AND audience=$4 AND status='active' ORDER BY version DESC LIMIT 1 FOR UPDATE", [c.actorId, a.subject, a.kind, a.audience]);
            if (previous)
                await sql.query("UPDATE knowledge_facts SET status='superseded',updated_at=now() WHERE id=$1", [previous.id]);
            const id = randomUUID();
            await sql.query('INSERT INTO knowledge_facts(id,actor_id,subject,kind,content,audience,version,valid_until,source_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, c.actorId, a.subject, a.kind, a.content, a.audience, (previous?.version || 0) + 1, a.valid_until || null, c.sourceId || null]);
            return { id, version: (previous?.version || 0) + 1, saved: true, audience: a.audience };
        });
    }
    async facts(c: ToolContext, query = '') {
        return (await this.db.query("SELECT id,actor_id,subject,kind,content,audience,version,valid_until,source_message_id,updated_at FROM knowledge_facts WHERE status='active' AND (valid_until IS NULL OR valid_until>now()) AND (audience='group' OR ($1='private' AND actor_id=$2)) AND ($3='' OR strpos(lower(subject||' '||content),lower($3))>0) ORDER BY updated_at DESC LIMIT 30", [c.audience || 'group', c.actorId, query])).rows;
    }
    async createProject(a: any, c: ToolContext) { const id = randomUUID(); await this.db.query('INSERT INTO projects(id,actor_id,topic_id,title,goal,criteria,source_message_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, c.actorId, c.topicId, a.title, a.goal, a.criteria, c.sourceId || null]); return { id, status: 'active' }; }
    async project(id: string): Promise<any> {
        const p = await one(this.db, 'SELECT * FROM projects WHERE id=$1', [id]);
        if (!p)
            throw new ToolError('project_not_found');
        const tasks = (await this.db.query('SELECT * FROM project_tasks WHERE project_id=$1 ORDER BY due_at NULLS LAST,id', [id])).rows;
        return { ...p, tasks, completed: tasks.filter(x => x.status === 'done').length, blocked: tasks.filter(x => x.depends_on.some((d: string) => tasks.find(t => t.id === d)?.status !== 'done')).map(x => x.id) };
    }
    async addTask(a: any, c: ToolContext) {
        return this.db.tx(async (sql) => {
            const p = await one(sql, "SELECT * FROM projects WHERE id=$1 AND actor_id=$2 AND status='active' FOR UPDATE", [a.project_id, c.actorId]);
            if (!p)
                throw new ToolError('project_owner_required');
            if (a.assignee_id && a.assignee_id !== c.actorId && !await one(sql, 'SELECT user_id FROM members WHERE user_id=$1 AND active=true', [a.assignee_id]))
                throw new ToolError('known_assignee_required');
            for (const dep of a.depends_on || [])
                if (!await one(sql, 'SELECT id FROM project_tasks WHERE id=$1 AND project_id=$2', [dep, a.project_id]))
                    throw new ToolError('dependency_same_project_required');
            const acceptance=Acceptance.parse(a.acceptance||[{id:'c1',text:p.criteria,kind:'owner_confirmation'}]);if(new Set(acceptance.map(x=>x.id)).size!==acceptance.length)throw new ToolError('unique_criterion_ids_required');
            const id = randomUUID();
            await sql.query('INSERT INTO project_tasks(id,project_id,title,assignee_id,due_at,depends_on,accepted,acceptance) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, a.project_id, a.title, a.assignee_id || null, a.due_at || null, JSON.stringify(a.depends_on || []), a.assignee_id === c.actorId,JSON.stringify(acceptance)]);
            await sql.query('UPDATE projects SET version=version+1 WHERE id=$1', [p.id]);
            return { id, status: a.assignee_id && a.assignee_id !== c.actorId ? 'awaiting_assignee_acceptance' : 'open' };
        });
    }
    async updateTask(a: any, c: ToolContext) {
        return this.db.tx(async (sql) => {
            const t = await one(sql, 'SELECT t.*,p.actor_id AS owner FROM project_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 FOR UPDATE', [a.id]);
            if (!t)
                throw new ToolError('project_task_not_found');
            if(a.version!==undefined)requireVersion(t.version,a.version);
            if (a.action === 'accept' || a.action === 'decline') {
                if (t.assignee_id !== c.actorId)
                    throw new ToolError('assignee_required');
                await sql.query('UPDATE project_tasks SET accepted=$1,status=$2,updated_at=now() WHERE id=$3', [a.action === 'accept', a.action === 'accept' ? 'open' : 'declined', t.id]);
            }
            else if (a.action === 'complete') {
                if (t.assignee_id !== c.actorId && t.owner !== c.actorId)
                    throw new ToolError('task_owner_required');
                if (t.assignee_id && !t.accepted)
                    throw new ToolError('assignee_has_not_accepted');
                if (!a.result?.trim())
                    throw new ToolError('task_result_required');
                for (const dep of t.depends_on)
                    if (!(await one(sql, "SELECT id FROM project_tasks WHERE id=$1 AND status='done'", [dep])))
                        throw new ToolError('dependency_not_completed');
                const proof=await verifyProjectEvidence(sql,t,a.evidence,c);
                await sql.query('UPDATE project_tasks SET completion_evidence=$2,completion_source_ids=$3 WHERE id=$1',[t.id,JSON.stringify(proof),JSON.stringify([...(c.sourceIds||[]),...(c.sourceId?[c.sourceId]:[])])]);
                await sql.query("UPDATE project_tasks SET status='done',result=$1,updated_at=now() WHERE id=$2", [a.result, t.id]);
            }
            else if(a.action==='criteria'||a.action==='reassign'){
                if(t.owner!==c.actorId)throw new ToolError('project_owner_required');requireVersion(t.version,a.version);
                if(a.action==='criteria'){const acceptance=Acceptance.parse(a.acceptance);if(new Set(acceptance.map(x=>x.id)).size!==acceptance.length)throw new ToolError('unique_criterion_ids_required');await sql.query("UPDATE project_tasks SET acceptance=$2,criteria_version=criteria_version+1,status=CASE WHEN status='done' THEN 'needs_review' ELSE status END,completion_evidence='{}' WHERE id=$1",[t.id,JSON.stringify(acceptance)]);}
                else{if(!a.assignee_id||!await one(sql,'SELECT user_id FROM members WHERE user_id=$1 AND active=true',[a.assignee_id]))throw new ToolError('known_assignee_required');await sql.query("UPDATE project_tasks SET assignee_id=$2,accepted=false,status='awaiting_acceptance',completion_evidence='{}' WHERE id=$1",[t.id,a.assignee_id]);}
                const all=(await sql.query('SELECT id,depends_on FROM project_tasks WHERE project_id=$1',[t.project_id])).rows,invalid=new Set([t.id]);for(let i=0;i<all.length;i++)for(const x of all)if(x.depends_on.some((id:string)=>invalid.has(id)))invalid.add(x.id);await sql.query("UPDATE project_tasks SET status='needs_review',completion_evidence='{}' WHERE id=ANY($1::uuid[]) AND status='done'",[[...invalid]]);
            }
            else if (a.action === 'reschedule') {
                if (t.owner !== c.actorId)
                    throw new ToolError('project_owner_required');
                if (!a.due_at)
                    throw new ToolError('due_at_required');
                const delta = t.due_at ? Date.parse(a.due_at) - new Date(t.due_at).getTime() : 0;
                await sql.query('UPDATE project_tasks SET due_at=$1,updated_at=now() WHERE id=$2', [a.due_at, t.id]);
                const all = (await sql.query('SELECT id,depends_on FROM project_tasks WHERE project_id=$1', [t.project_id])).rows;
                const shifted = new Set([t.id]);
                for (let i = 0; i < all.length; i++)
                    for (const x of all)
                        if (!shifted.has(x.id) && x.depends_on.some((d: string) => shifted.has(d))) {
                            shifted.add(x.id);
                            await sql.query("UPDATE project_tasks SET due_at=due_at+($1*interval '1 millisecond'),updated_at=now() WHERE id=$2 AND due_at IS NOT NULL", [delta, x.id]);
                        }
            }
            await sql.query('UPDATE project_tasks SET version=version+1,updated_at=now() WHERE id=$1',[t.id]);
            await sql.query('UPDATE projects SET version=version+1 WHERE id=$1', [t.project_id]);
            return { id: t.id, action: a.action };
        });
    }
    async closeProject(id: string, c: ToolContext) {
        const p = await this.project(id);
        if (p.actor_id !== c.actorId)
            throw new ToolError('project_owner_required');
        if (!p.tasks.length || p.tasks.some((t: any) => t.status !== 'done'||!t.completion_evidence?.proofs?.length))
            throw new ToolError('project_tasks_incomplete');
        await this.db.query("UPDATE projects SET status='completed',version=version+1 WHERE id=$1", [id]);
        return { id, status: 'completed', criteria: p.criteria, results: p.tasks.map((t: any) => ({ title: t.title, result: t.result })) };
    }
}
export class Decisions {
    private vault: ConnectorVault;
    private inbox: PrivateInbox;
    constructor(private db: Database, runtimeDir: string) { this.vault = new ConnectorVault(db, runtimeDir); this.inbox = new PrivateInbox(db, runtimeDir); }
    async create(a: any, c: ToolContext) {
        if (new Set(a.options).size !== a.options.length || new Set(a.participants).size !== a.participants.length)
            throw new ToolError('decision_unique_options_and_people');
        if (Date.parse(a.deadline) <= Date.now() || Date.parse(a.deadline) > Date.now() + 30 * 86400000)
            throw new ToolError('decision_future_deadline_required');
        const id = randomUUID();
        await this.db.query('INSERT INTO decisions(id,actor_id,topic_id,question,options,participants,method,deadline,source_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, c.actorId, c.topicId, a.question, JSON.stringify(a.options), JSON.stringify(a.participants), a.method, a.deadline, c.sourceId || null]);
        return { id, status: 'open', next: 'decision.invite' };
    }
    async invite(id: string, c: ToolContext) {
        const d = await one(this.db, "SELECT * FROM decisions WHERE id=$1 AND actor_id=$2 AND status='open' AND deadline>now()", [id, c.actorId]);
        if (!d)
            throw new ToolError('decision_owner_required');
        const requests = [];
        for (const user of d.participants) {
            const prior = await one(this.db, "SELECT id FROM private_requests WHERE payload->>'decision_id'=$1 AND recipient_id=$2 AND status<>'revoked' AND expires_at>now()", [id, user]);
            if (prior) {
                requests.push({ id: prior.id, existing: true });
                continue;
            }
            requests.push(await this.inbox.ask(c, user, `${d.question}\n${d.options.map((x: string, i: number) => `${i + 1}. ${x}`).join('\n')}\n\nНапиши назви або номери від найкращого, наприклад «2, 1; вето: 3». Я покажу, як зрозумів, і попрошу підтвердити. Неприйнятні варіанти можна позначити словом «вето». Індивідуальні голоси в групу не показую.`, d.question, { decision_id: id, decision_version: d.version, expires_at: d.deadline }));
        }
        return { id, requests };
    }
    async ballot(r: any, text: string, answerRef: string) {
        const d = await one(this.db, "SELECT * FROM decisions WHERE id=$1 AND status='open' AND deadline>now()", [r.payload.decision_id]);
        if (!d || d.version !== r.payload.decision_version || !d.participants.includes(r.recipient_id))
            throw new ToolError('decision_closed_or_changed');
        let input: any;
        try {
            input = JSON.parse(text);
        }
        catch {
            throw new ToolError('ballot_json_required');
        }
        const ranking = input.ranking, excluded = input.excluded || [];
        if (!Array.isArray(ranking) || !ranking.length || !Array.isArray(excluded) || [...ranking, ...excluded].some(x => !Number.isInteger(x) || x < 1 || x > d.options.length) || new Set(ranking).size !== ranking.length || new Set(excluded).size !== excluded.length || ranking.some(x => excluded.includes(x)))
            throw new ToolError('ballot_options_invalid');
        await this.vault.put(r.recipient_id, answerRef, JSON.stringify({ ranking, excluded }));
        await this.db.query('INSERT INTO decision_ballots(decision_id,user_id,ranking) VALUES($1,$2,$3) ON CONFLICT(decision_id,user_id) DO UPDATE SET ranking=excluded.ranking,updated_at=now()', [d.id, r.recipient_id, JSON.stringify({ private_ref: answerRef })]);
    }
    async result(id: string, c: ToolContext, close = false) {
        const d = await one(this.db, 'SELECT * FROM decisions WHERE id=$1', [id]);
        if (!d)
            throw new ToolError('decision_not_found');
        if (d.status === 'closed')
            return d.result;
        const ballots = (await this.db.query('SELECT user_id,ranking FROM decision_ballots WHERE decision_id=$1', [id])).rows;
        const missing = d.participants.filter((u: string) => !ballots.some(x => x.user_id === u));
        if (!close && missing.length && Date.parse(d.deadline) > Date.now())
            return { id, status: 'collecting', received: ballots.length, expected: d.participants.length };
        if (close && d.actor_id !== c.actorId)
            throw new ToolError('decision_owner_required');
        const scores = d.options.map(() => 0), excluded = new Set<number>();
        for (const b of ballots) {
            const v = JSON.parse(await this.vault.get(b.user_id, b.ranking.private_ref));
            for (const x of v.excluded)
                excluded.add(x - 1);
            v.ranking.forEach((x: number, i: number) => { scores[x - 1] += d.method === 'approval' ? 1 : d.options.length - i; });
        }
        const candidates = d.options.map((label: string, i: number) => ({ label, index: i, score: scores[i] })).filter((x: any) => !excluded.has(x.index));
        const max = Math.max(...candidates.map((x: any) => x.score));
        const result = { id, status: ballots.length ? 'resolved' : 'no_responses', question: d.question, method: d.method, winners: ballots.length ? candidates.filter((x: any) => x.score === max).map((x: any) => x.label) : [], tie: ballots.length > 0 && candidates.filter((x: any) => x.score === max).length > 1, received: ballots.length, expected: d.participants.length, missing_count: missing.length, individual_votes_withheld: true, limitations: missing.length ? 'Рішення враховує лише тих, хто відповів; інші не вважаються згодними.' : undefined };
        if (close)
            await this.db.query("UPDATE decisions SET status='closed',result=$1,version=version+1 WHERE id=$2 AND status='open'", [JSON.stringify(result), id]);
        return result;
    }
}
