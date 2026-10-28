import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, state, type SQL, type Database } from './db.js';
import { ToolError } from './safe-http.js';
import type { InlineKeyboard, Message } from './telegram.js';
import type { ToolContext } from './agent-tools.js';
import { layoutMessage } from './message-layout.js';
import { recordProvenance } from './provenance.js';
const user = z.string().regex(/^\d+$/);
export const InteractionSpec = z.object({
    title: z.string().min(2).max(160), kind: z.enum(['choice', 'consent', 'activity', 'planning', 'round']).default('choice'),
    scope: z.enum(['personal', 'invited', 'open']).default('invited'), participant_ids: z.array(user).max(30).default([]),
    policy: z.enum(['all', 'majority', 'parallel', 'turn']).default('all'), turn_user_id: user.optional(),
    question: z.string().min(2).max(600), options: z.array(z.string().min(1).max(500)).max(12).default([]),
    min_choices: z.number().int().min(1).max(2).default(1), max_choices: z.number().int().min(1).max(2).default(1),
    roles: z.array(z.object({ user_id: user, role: z.string().min(1).max(100), task: z.string().min(1).max(400), options: z.array(z.string().min(1).max(500)).max(12).default([]) })).max(30).default([]),
    parent_id: z.string().uuid().optional(), goal: z.string().max(350).default(''),
});
export const InteractionAnswer = z.object({ id: z.string().uuid(), version: z.number().int().positive(), choices: z.array(z.number().int().min(0).max(11)).max(2).default([]), content: z.string().max(1500).default(''), decision: z.enum(['answer', 'agree', 'decline', 'not_ready', 'delegate', 'leave']).default('answer'), submit: z.boolean().default(true) });
export type InteractionInput = z.infer<typeof InteractionSpec>;
export type Person = {
    id: string;
    name: string;
};
export interface InteractionView extends Record<string, any> {
    id: string;
    spec: InteractionInput & Record<string, any>;
    participants: Person[];
    responses: any[];
    pending: string[];
    ready: boolean;
    accepted: string[];
    phase: string;
    version: number;
    winning_option: number | null;
}
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])])) : value;
export const launchHash = (value: any) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const responseHash = (row: any) => launchHash([row?.choices || [], row?.content || '', row?.decision, row?.submitted]);
const normalize = (s: string) => s.toLocaleLowerCase().replace(/[«»“”"'’.,!?;:]/g, '').replace(/\s+/g, ' ').trim();
export function isPersonalRequest(text: string) { return /(?:зі мною|для мене|наодинці|я сам(?:а)?(?:\s|$)|я од(?:ин|на)(?:\s|$)|мені (?:одному|одній|нудно)|(?:порадь|підбери|придумай|запропонуй) мені|solo|play with me)/iu.test(text) && !/(?:нам|удвох|разом|для всіх|для нас)/iu.test(text); }
export function isGroupRequest(text: string) { return /(?:^|[^\p{L}])(?:нам|нас|ми|всім)(?=$|[^\p{L}])|удвох|разом|компані|спільн|давайте|пограймо|пограємо|для всіх/iu.test(text); }
export function roster(s: any, actor: string, scope = 'invited', ids: string[] = []): Person[] {
    const people: Person[] = Array.from(new Map<string, Person>((s.participants || []).filter((p: any) => /^\d+$/.test(String(p.id))).map((p: any) => [String(p.id), { id: String(p.id), name: String(p.name || p.id) }])).values());
    if (!people.some(p => p.id === actor))
        people.unshift({ id: actor, name: actor });
    if (scope === 'personal')
        return people.filter(p => p.id === actor);
    if (ids.length) {
        if (ids.some(id => !people.some(p => p.id === id)))
            throw new ToolError('interaction_unknown_participant');
        return people.filter(p => ids.includes(p.id));
    }
    // Large groups use a published opt-in roster; silent group members are never guessed.
    return scope === 'open' || people.length > 8 ? people.filter(p => p.id === actor) : people;
}
export async function interactionView(sql: SQL, id: string): Promise<InteractionView> {
    const r = await one(sql, 'SELECT * FROM interactions WHERE id=$1', [id]);
    if (!r)
        throw new ToolError('interaction_not_found');
    const responses = (await sql.query('SELECT user_id,choices,content,decision,submitted,result FROM interaction_responses WHERE interaction_id=$1 AND version=$2 ORDER BY updated_at', [id, r.version])).rows;
    const required: string[] = r.spec.policy === 'turn' ? [r.spec.turn_user_id] : r.participants.map((p: Person) => p.id);
    const pending = required.filter(id => !responses.some(x => x.user_id === id && x.submitted && ['answer', 'agree', 'delegate'].includes(x.decision)));
    const different = new Set(responses.filter(x => x.submitted && x.decision !== 'delegate' && x.choices.length).map(x => x.choices[0]));
    const conflict = r.spec.policy === 'all' && different.size > 1;
    return { ...r, responses, pending, conflict, ready: r.phase === 'ready', accepted: responses.filter(x => x.submitted && ['answer', 'agree', 'delegate'].includes(x.decision)).map(x => x.user_id) } as unknown as InteractionView;
}
export async function openInteraction(sql: SQL, input: unknown, c: ToolContext, extra: {
    launch?: any;
    autoAccept?: boolean;
} = {}) {
    const a = InteractionSpec.parse(input), s = await state(sql, true);
    if (s.paused || s.memory_revision !== c.revision)
        throw new ToolError('task_cancelled');
    if (a.min_choices > a.max_choices || a.max_choices > 1 && a.policy === 'all')
        throw new ToolError('multiple_choices_require_parallel_or_vote');
    const people = roster(s, c.actorId, a.scope, a.participant_ids);
    if (a.scope === 'invited' && !people.some(p => p.id === c.actorId))
        throw new ToolError('initiator_must_participate');
    if (a.policy === 'turn' && (!a.turn_user_id || !people.some(p => p.id === a.turn_user_id)))
        throw new ToolError('interaction_turn_participant_required');
    if (a.roles.some(r => !people.some(p => p.id === r.user_id)) || new Set(a.roles.map(r => r.user_id)).size !== a.roles.length)
        throw new ToolError('interaction_roles_invalid');
    if (a.parent_id) {
        const parent = await one(sql, "SELECT * FROM interactions WHERE id=$1 AND topic_id=$2 AND phase IN ('active','resolved','ready')", [a.parent_id, c.topicId]);
        if (!parent || parent.actor_id !== c.actorId && !parent.participants.some((p: Person) => p.id === c.actorId) || people.some(p => !parent.participants.some((x: Person) => x.id === p.id)))
            throw new ToolError('interaction_parent_participants_required');
    }
    const previous = await one(sql, "SELECT * FROM interactions WHERE topic_id=$1 AND phase='collecting' AND expires_at>now() AND parent_id IS NOT DISTINCT FROM $2::uuid ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [c.topicId, a.parent_id || null]);
    if (previous)
        return { ...await interactionView(sql, previous.id), reused: true };
    const id = randomUUID(), spec = { ...a, scope: a.scope === 'invited' && (s.participants || []).length > 8 && !a.participant_ids.length ? 'open' : a.scope };
    await sql.query('INSERT INTO interactions(id,actor_id,topic_id,kind,spec,participants,revision,source_message_id,parent_id,launch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, c.actorId, c.topicId, a.kind, JSON.stringify(spec), JSON.stringify(people), c.revision, c.sourceId || null, a.parent_id || null, extra.launch ? JSON.stringify(extra.launch) : null]);
    await recordProvenance(sql, 'interaction', id, [...(c.sourceIds || []), ...(c.sourceId ? [c.sourceId] : [])]);
    if (extra.autoAccept)
        await sql.query("INSERT INTO interaction_responses(interaction_id,version,user_id,decision,submitted) VALUES($1,1,$2,'agree',true)", [id, c.actorId]);
    return interactionView(sql, id);
}
export function choicesFor(view: any, userId: string): string[] { return view.spec.roles.find((r: any) => r.user_id === userId)?.options?.length ? view.spec.roles.find((r: any) => r.user_id === userId).options : view.spec.options; }
export async function answerInteraction(sql: SQL, input: unknown, c: ToolContext) {
    const a = InteractionAnswer.parse(input), s = await state(sql, true);
    const r = await one(sql, "SELECT * FROM interactions WHERE id=$1 FOR UPDATE", [a.id]);
    if (!r || new Date(r.expires_at).getTime() <= Date.now() || r.topic_id !== c.topicId || r.revision !== c.revision || s.paused || s.memory_revision !== c.revision)
        throw new ToolError('interaction_unavailable');
    if (r.version !== a.version || r.phase !== 'collecting' && !(a.decision === 'leave' && r.kind === 'activity' && r.phase === 'active'))
        throw new ToolError('interaction_step_closed');
    let participants: Person[] = r.participants;
    if (!participants.some(p => p.id === c.actorId)) {
        if (r.spec.scope !== 'open' || a.decision === 'leave' || participants.length >= 30)
            throw new ToolError('interaction_not_participant');
        const p = roster(s, c.actorId, 'personal')[0]!;
        participants = [...participants, p];
        await sql.query('UPDATE interactions SET participants=$1 WHERE id=$2', [JSON.stringify(participants), r.id]);
        r.participants = participants;
    }
    if (r.spec.policy === 'turn' && r.spec.turn_user_id !== c.actorId)
        throw new ToolError('interaction_other_turn');
    const options = choicesFor(r, c.actorId), selected = [...new Set(a.choices)];
    if (selected.some(i => i >= options.length) || selected.length > r.spec.max_choices)
        throw new ToolError('interaction_choice_out_of_range');
    if (['activity', 'consent'].includes(r.kind) && !options.length && a.decision === 'answer')
        throw new ToolError('interaction_explicit_consent_required');
    if (a.submit && a.decision === 'answer' && !a.content && selected.length < r.spec.min_choices)
        throw new ToolError('interaction_answer_required');
    await sql.query('INSERT INTO interaction_responses(interaction_id,version,user_id,choices,content,decision,submitted,source_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(interaction_id,version,user_id) DO UPDATE SET choices=excluded.choices,content=excluded.content,decision=excluded.decision,submitted=excluded.submitted,source_message_id=excluded.source_message_id,result=NULL,updated_at=now()', [r.id, r.version, c.actorId, JSON.stringify(selected), a.content, a.decision, a.submit, c.sourceId || null]);
    if (a.decision === 'leave') {
        await sql.query("UPDATE games SET state=jsonb_set(state,'{players}',COALESCE((SELECT jsonb_agg(p) FROM jsonb_array_elements(state->'players') p WHERE p->>'id'<>$1),'[]'::jsonb)) WHERE status='active' AND state->>'interaction_id'=$2", [c.actorId, r.parent_id || r.id]);
        if (r.launch?.session_id) {
            await sql.query("UPDATE activity_players SET status='left' WHERE session_id=$1 AND user_id=$2", [r.launch.session_id, c.actorId]);
            await sql.query("UPDATE private_requests SET status='revoked' WHERE session_id=$1 AND recipient_id=$2 AND status IN ('offered','answering')", [r.launch.session_id, c.actorId]);
        }
    }
    await recordProvenance(sql, 'interaction', r.id, c.sourceId ? [c.sourceId] : []);
    const view = await interactionView(sql, r.id);
    const accepted = view.responses.filter((x: any) => x.submitted && ['answer', 'agree', 'delegate'].includes(x.decision));
    let ready = !view.pending.length && view.spec.scope !== 'open';
    let winner: number | undefined, conflict = false;
    if (r.spec.options.length && r.spec.policy === 'all') {
        const ballots = accepted.filter((x: any) => x.decision !== 'delegate' && x.choices.length);
        const distinct = new Set<number>(ballots.map((x: any) => x.choices[0]));
        conflict = distinct.size > 1;
        if (!conflict && ballots.length)
            winner = ballots[0]!.choices[0];
        if (!ballots.length && accepted.length === view.participants.length && accepted.every((x: any) => x.decision === 'delegate'))
            winner = 0;
        ready = ready && !conflict && winner !== undefined;
    }
    if (r.spec.policy === 'majority') {
        const counts = new Map<number, number>();
        for (const b of accepted)
            for (const i of b.choices)
                counts.set(i, (counts.get(i) || 0) + 1);
        const sorted = [...counts].sort((a, b) => b[1] - a[1]);
        const lead = sorted[0];
        if (lead && lead[1] > view.participants.length / 2 && sorted[1]?.[1] !== lead[1] && r.spec.scope !== 'open') {
            ready = true;
            winner = lead[0];
        }
        else if (ready) {
            conflict = !lead || sorted[1]?.[1] === lead[1];
            ready = !conflict;
            winner = lead?.[0];
        }
    }
    if (ready) {
        const updated = await one(sql, "UPDATE interactions SET phase='ready',winning_option=$1,updated_at=now() WHERE id=$2 AND version=$3 AND phase='collecting' RETURNING id", [winner ?? null, r.id, r.version]);
        return { ...await interactionView(sql, r.id), transition: Boolean(updated), partial: false, conflict: false };
    }
    return { ...view, transition: false, partial: r.spec.policy === 'parallel' && (r.kind === 'round' || r.kind === 'planning' || r.spec.roles.length > 0) && a.submit && ['answer', 'agree'].includes(a.decision), conflict };
}
export async function closeOpenRoster(sql: SQL, id: string, c: ToolContext) {
    const r = await one(sql, "SELECT * FROM interactions WHERE id=$1 AND actor_id=$2 AND phase='collecting' AND topic_id=$3 FOR UPDATE", [id, c.actorId, c.topicId]);
    if (!r || r.spec.scope !== 'open')
        throw new ToolError('open_roster_host_required');
    if (r.participants.length < 2 && !isPersonalRequest(c.requestText || ''))
        throw new ToolError('confirm_solo_or_wait_for_participants');
    await sql.query("UPDATE interactions SET spec=jsonb_set(spec,'{scope}','\"invited\"'::jsonb),updated_at=now() WHERE id=$1", [id]);
    const own = await one(sql, 'SELECT * FROM interaction_responses WHERE interaction_id=$1 AND version=$2 AND user_id=$3', [id, r.version, c.actorId]);
    return answerInteraction(sql, { id, version: r.version, choices: own?.choices || [], content: own?.content || '', decision: own?.decision || 'agree', submit: own?.submitted ?? true }, c);
}
export async function finishInteraction(sql: SQL, id: string, version: number, c: ToolContext, result: string, actorOnly = false) {
    const r = await one(sql, 'SELECT * FROM interactions WHERE id=$1 FOR UPDATE', [id]);
    if (!r || r.topic_id !== c.topicId || r.version !== version || r.revision !== c.revision || !r.participants.some((p: Person) => p.id === c.actorId) && r.actor_id !== c.actorId)
        throw new ToolError('interaction_unavailable');
    if (actorOnly) {
        if (r.spec.policy !== 'parallel' || !['collecting', 'ready'].includes(r.phase))
            throw new ToolError('parallel_result_not_expected');
        const changed = await one(sql, "UPDATE interaction_responses SET result=$1 WHERE interaction_id=$2 AND version=$3 AND user_id=$4 AND submitted=true AND decision IN ('answer','agree') AND result IS NULL RETURNING user_id", [result.slice(0, 1200), id, version, c.actorId]);
        if (!changed)
            throw new ToolError('actor_result_not_ready');
    }
    else {
        if (r.phase !== 'ready')
            throw new ToolError('interaction_waiting_for_participants');
        await sql.query("UPDATE interactions SET phase='resolved',result=$1,updated_at=now() WHERE id=$2", [result.slice(0, 2000), id]);
    }
    return interactionView(sql, id);
}
export function interactionText(v: any) {
    const stateLabel: Record<string, string> = { collecting: 'Збираємо відповіді', ready: 'Відповіді зібрані', active: 'Триває', resolved: 'Завершено', paused: 'Пауза', cancelled: 'Скасовано', expired: 'Строк минув' };
    const card = v.spec.context_card;
    const lines = [card?.title || v.spec.title, card?.summary || v.spec.introduction || v.spec.goal || '', card?.facts?.length ? card.facts.map((x: string) => '• ' + x).join('\n') : '', v.spec.question];
    if (v.spec.options.length)
        lines.push(v.spec.options.map((x: string, i: number) => `${i + 1}. ${x}`).join('\n'));
    for (const role of v.spec.roles)
        lines.push(`Завдання ${v.spec.roles.indexOf(role) + 1}: ${v.participants.find((p: Person) => p.id === role.user_id)?.name || role.user_id} · ${role.role}\n${role.task}${role.options.length ? '\n' + role.options.map((x: string, i: number) => `${i + 1}. ${x}`).join('\n') : ''}`);
    lines.push(v.spec.policy === 'parallel' ? (v.kind === 'choice' ? 'Кожен обирає за себе. Підсумуємо після потрібних відповідей.' : 'Кожен виконує своє завдання. Результати зведемо після потрібних відповідей.') : v.spec.policy === 'turn' ? 'Зараз відповідає ' + (v.participants.find((p: Person) => p.id === v.spec.turn_user_id)?.name || v.spec.turn_user_id) : v.spec.policy === 'majority' ? 'Рішення — більшістю погодженого складу.' : 'Для цього кроку потрібна згода всіх запрошених.');
    if (v.spec.max_choices > 1)
        lines.push(`Можна обрати ${v.spec.min_choices}–${v.spec.max_choices} дії. Після вибору натисни «Готово» або напиши свій план.`);
    for (const p of v.participants) {
        const a = v.responses.find((x: any) => x.user_id === p.id), labels = a?.choices?.map((i: number) => choicesFor(v, p.id)[i]).filter(Boolean) || [];
        const status = !a ? '⏳ очікуємо' : a.decision === 'decline' ? '🙅 пропускає' : a.decision === 'not_ready' ? '⏸ ще не готовий' : a.decision === 'leave' ? '🚶 виходить' : !a.submitted ? '✏️ ' + (labels.join(' + ') || 'обирає') + ' · ще не підтверджено' : a.decision === 'delegate' ? '✅ довіряє вибір' : `✅ ${labels.join(' + ') || a.content || 'згоден'}`;
        lines.push(`${p.name}: ${status}${a?.result ? ' · результат готовий' : ''}`);
    }
    if (v.conflict)
        lines.push('Вибори різні. Можна змінити відповідь або запропонувати спільний варіант.');
    if (v.spec.scope === 'open' && v.phase === 'collecting')
        lines.push('Склад відкритий: охочі долучаються. Ведучий завершує збір учасників.');
    if (v.result)
        lines.push('Підсумок: ' + v.result);
    lines.push(stateLabel[v.phase] || v.phase);
    return lines.filter(Boolean).join('\n\n');
}
export function interactionKeys(v: any): InlineKeyboard {
    if (v.phase !== 'collecting')
        return { inline_keyboard: [] };
    const b = (text: string, action: string) => ({ text, callback_data: `li:${v.id}:${v.version}:${action}` });
    const rows: any[] = [];
    if (v.spec.roles.some((r: any) => r.options.length))
        for (const role of v.spec.roles) {
            const p = v.participants.find((p: Person) => p.id === role.user_id);
            for (const [i, label] of role.options.entries())
                rows.push([b(`Завдання ${v.spec.roles.indexOf(role) + 1} · дія ${i + 1}`, `r${v.spec.roles.indexOf(role)}_${i}`)]);
        }
    else if (v.spec.options.length)
        for (const [i, label] of v.spec.options.entries())
            rows.push([b(label.length <= 22 ? label : `Варіант ${i + 1}`, String(i))]);
    else
        rows.push([b('Долучаюсь', 'yes'), b('Поки не готовий', 'wait')]);
    if (v.spec.max_choices > 1)
        rows.push([b('Готово', 'submit')]);
    rows.push([b('Пропускаю', 'no')]);
    if (v.spec.scope === 'open')
        rows.push([b('Завершити набір', 'close')]);
    return { inline_keyboard: rows };
}
export async function queueInteraction(sql: SQL, id: string) {
    const v = await interactionView(sql, id);
    const card = await layoutMessage(sql, interactionText(v), { formatting: [{ text: v.spec.context_card?.title || v.spec.title, style: 'bold' }] }, { actorId: v.actor_id, topicId: v.topic_id, revision: v.revision, sourceId: v.source_message_id, key: 'interaction:' + id + ':' + v.version, interactive: true, extraDetails: v.spec.context_card?.details }, interactionKeys(v));
    const hash = createHash('sha256').update(JSON.stringify([v.phase, v.responses, v.participants, v.spec])).digest('hex');
    const current = await one(sql, 'SELECT card_hash,card_seq FROM interactions WHERE id=$1 FOR UPDATE', [id]);
    if (current?.card_hash === hash)
        return v;
    const seq = Number(current?.card_seq || 0) + 1;
    await sql.query("UPDATE outbox SET status='cleared' WHERE kind='interaction' AND body->>'id'=$1 AND status='pending'", [id]);
    await sql.query("INSERT INTO outbox(dedup_key,kind,body,revision,actor_id,source_message_id) VALUES($1,'interaction',$2,$3,$4,$5) ON CONFLICT DO NOTHING", [`interaction:${id}:${seq}`, JSON.stringify({ id, version: v.version, hash, seq, text: card.text, entities: card.entities, replyMarkup: card.replyMarkup, threadId: v.topic_id === '0' ? undefined : Number(v.topic_id) }), v.revision, v.actor_id, v.source_message_id]);
    await sql.query('UPDATE interactions SET card_hash=$1,card_seq=$3 WHERE id=$2', [hash, id, seq]);
    await recordProvenance(sql, 'outbox', (await one(sql, 'SELECT id FROM outbox WHERE dedup_key=$1', [`interaction:${id}:${seq}`]))!.id, (await sql.query("SELECT source_message_id FROM provenance_edges WHERE derived_kind='interaction' AND derived_key=$1", [id])).rows.map(x => Number(x.source_message_id)));
    return v;
}
export async function currentInteraction(sql: SQL, topic: string, actor?: string) {
    const rows = (await sql.query("SELECT id FROM interactions WHERE topic_id=$1 AND phase IN ('collecting','ready','active') AND expires_at>now() ORDER BY created_at DESC LIMIT 8", [topic])).rows;
    for (const r of rows) {
        const v = await interactionView(sql, r.id);
        if (!actor || v.participants.some((p: Person) => p.id === actor) || v.spec.scope === 'open')
            return v;
    }
}
export function parseInteractionText(v: any, text: string, actor: string) {
    if (/^\s*[«“"`][\s\S]*[»”"`]\s*$/.test(text))
        return;
    const t = normalize(text.replace(/^(?:люмене?|lumen|@\w+)[,!: ]*/iu, ''));
    const base = { id: v.id, version: v.version, choices: [] as number[], content: '', decision: 'answer', submit: true };
    if (/^(?:не граю|не хочу|пропускаю|пас|ні|сьогодні без мене)$/.test(t))
        return { ...base, decision: 'decline' };
    if (/^(?:не готов[аи]?|поки ні|ще не готов[аи]?|зачекай|хвилинку)$/.test(t))
        return { ...base, decision: 'not_ready' };
    if (/^(?:виходжу|я виходжу|припиняю участь)$/.test(t))
        return { ...base, decision: 'leave' };
    if (/^(?:мені (?:все|усе) одно|на ваш розсуд|довіряю вибір|будь-який варіант)$/.test(t))
        return { ...base, decision: 'delegate' };
    const options = choicesFor(v, actor), exact = options.map((x: string, i: number) => normalize(x) === t || normalize(x) === t.replace(/^(?:я (?:теж )?за|обираю|за|мені|хочу) /, '') ? i : -1).filter((i: number) => i >= 0);
    const nums = /^(?:обираю |я за |варіанти? )?(\d{1,2})(?:\s*(?:і|та|,|\+)\s*(\d{1,2}))?$/.exec(t);
    const picks = exact.length ? exact : nums ? [Number(nums[1]) - 1, ...(nums[2] ? [Number(nums[2]) - 1] : [])] : [];
    if (picks.length && picks.every((i: number) => i >= 0 && i < options.length))
        return { ...base, choices: picks };
    if (/^(?:так|ага|згод(?:ен|на)|я(?: теж)? за|готов(?:ий|а)?|починай|долучаюсь|я теж|давай|граємо)$/.test(t)) {
        if (!options.length)
            return { ...base, decision: 'agree' };
        const other = v.responses.filter((x: any) => x.user_id !== actor && x.submitted && x.choices.length === 1);
        const indices = [...new Set<number>(other.map((x: any) => x.choices[0]))];
        if (indices.length === 1)
            return { ...base, choices: indices };
    }
}
export async function toggleInteraction(sql: SQL, id: string, version: number, action: string, c: ToolContext) {
    const v = await interactionView(sql, id);
    if (v.version !== version || v.phase !== 'collecting')
        throw new ToolError('interaction_step_closed');
    if (action === 'close')
        return closeOpenRoster(sql, id, c);
    const prior = v.responses.find((x: any) => x.user_id === c.actorId), base = { id, version, choices: prior?.choices || [], content: prior?.content || '', decision: 'answer', submit: true };
    if (action === 'yes')
        return answerInteraction(sql, { ...base, decision: 'agree' }, c);
    if (action === 'no')
        return answerInteraction(sql, { ...base, choices: [], content: '', decision: 'decline' }, c);
    if (action === 'wait')
        return answerInteraction(sql, { ...base, decision: 'not_ready' }, c);
    if (action === 'submit')
        return answerInteraction(sql, base, c);
    const role = /^r(\d+)_(\d+)$/.exec(action);
    if (role && v.spec.roles[Number(role[1])]?.user_id !== c.actorId)
        throw new ToolError('interaction_other_role');
    const index = role ? Number(role[2]) : /^\d+$/.test(action) ? Number(action) : NaN;
    if (!Number.isInteger(index))
        throw new ToolError('interaction_action_invalid');
    const multi = v.spec.max_choices > 1;
    let choices = multi ? [...base.choices] : [];
    if (multi && choices.includes(index))
        choices = choices.filter((i: number) => i !== index);
    else
        choices.push(index);
    return answerInteraction(sql, { ...base, choices, submit: !multi }, c);
}
export async function launchConsent(sql: SQL, action: any, c: ToolContext, name: string) {
    const s = await state(sql), request = c.requestText || '';
    const personal = c.personal || isPersonalRequest(request) || Number(c.chatId) > 0;
    const scope = personal ? 'personal' : (s.participants || []).length > 8 || isGroupRequest(request) && (s.participants || []).length < 2 ? 'open' : 'invited';
    const people = roster(s, c.actorId, scope);
    const signature = launchHash(action);
    const approved = c.interactionId ? await one(sql, "SELECT * FROM interactions WHERE id=$1 AND topic_id=$2 AND revision=$3 AND phase IN ('ready','active')", [c.interactionId, c.topicId, c.revision]) : undefined;
    if (approved && approved.participants.some((p: Person) => p.id === c.actorId) && (approved.launch && launchHash(approved.launch) === signature || approved.kind === 'activity' && !approved.launch))
        return { allowed: true, participants: approved.participants, interaction: approved };
    if (people.length === 1 && scope !== 'open')
        return { allowed: true, participants: people };
    const v = await openInteraction(sql, { title: name, kind: 'activity', scope, participant_ids: scope === 'open' ? [] : people.map(p => p.id), policy: 'all', question: 'Долучаємося до цієї активності?', options: [], goal: 'Почнемо після згоди всіх запрошених.' }, c, { launch: action, autoAccept: /^\/game\b|почни|починай|погра|беремося|старт|давай/iu.test(request) });
    await queueInteraction(sql, v.id);
    return { allowed: false, participants: v.participants, interaction: v };
}
export async function enqueueInteraction(sql: SQL, v: any, c: ToolContext) {
    if (!v.transition && !v.partial)
        return;
    const actor = v.partial ? c.actorId : v.actor_id, source = v.partial ? c.sourceId : v.source_message_id;
    if (!source)
        return;
    const people: Person[] = v.participants, p = people.find(p => p.id === actor);
    const row = v.responses.find((r: any) => r.user_id === c.actorId), choices = (row?.choices || []).map((i: number) => choicesFor(v, c.actorId)[i]).filter(Boolean);
    const selected = v.winning_option === null || v.winning_option === undefined ? '' : v.spec.options[v.winning_option];
    const id = -Number.parseInt(createHash('sha256').update(`${v.id}:${v.version}:${v.partial ? c.actorId : 'ready'}:${JSON.stringify(row)}`).digest('hex').slice(0, 12), 16);
    const ownText = row?.content || choices.join(' + ');
    const message: Message = { message_id: id, date: Math.floor(Date.now() / 1000), from: { id: Number(actor), first_name: p?.name || actor }, chat: { id: Number(c.chatId), type: Number(c.chatId) > 0 ? 'private' : 'supergroup' }, text: v.partial ? `Люмен, мій план для власного завдання: ${ownText}` : v.kind === 'activity' ? `Люмен, почнемо погоджену активність. ${selected || v.spec.question}` : `Люмен, потрібні відповіді на етап «${v.spec.title}» зібрані. Підсумуй їх і продовж за правилами етапу. ${selected || v.spec.question}`, message_thread_id: c.topicId === '0' ? undefined : Number(c.topicId), lumen_interaction: { id: v.id, version: v.version, partial: Boolean(v.partial), ready: Boolean(v.ready), ...(v.partial ? { response_hash: responseHash(row) } : {}) } };
    const plan = v.transition && v.spec.resume_plan ? v.spec.resume_plan : v.transition && v.launch?.kind ? { reply: v.spec.launch_reply || '', actions: v.spec.launch_actions || [v.launch], ...(v.spec.launch_presentation ? { presentation: v.spec.launch_presentation } : {}), ...(v.spec.launch_step ? { interaction: v.spec.launch_step } : {}) } : undefined;
    await sql.query("INSERT INTO inbox(update_id,payload,revision,plan) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [id, JSON.stringify({ message, sourceId: source, interactionInternal: true, engagement: { reason: 'addressed' } }), c.revision, plan ? JSON.stringify(plan) : null]);
}
