import { z } from 'zod';
import { InteractionSpec, InteractionAnswer, openInteraction, answerInteraction, interactionView, queueInteraction, enqueueInteraction, finishInteraction } from './interactions.js';
import { one, state, type Database } from './db.js';
import type { Definition, ToolContext } from './agent-tools.js';
import { ToolError } from './safe-http.js';
const id = z.string().uuid();
export function registerInteractionTools(db: Database, add: (name: string, d: Definition) => void) {
    const context = async (c: ToolContext) => { const s = await state(db); if (s.paused || s.memory_revision !== c.revision)
        throw new ToolError('task_cancelled'); return s; };
    add('interaction.open', { description: 'Відкрити один зрозумілий етап будь-якої взаємодії. Явний склад учасників; policy all/majority/turn/parallel. Для паралельних завдань можна різні ролі й 1–2 дії кожному. Важливі факти мають бути у компактній картці; варіанти показуються повністю. Не замінює дозволів на зовнішні дії.', background: false, schema: InteractionSpec, run: (a, c) => db.tx(async (sql) => { const v = await openInteraction(sql, a, c); await queueInteraction(sql, v.id); return { id: v.id, version: v.version, phase: v.phase, participants: v.participants, pending: v.pending, policy: v.spec.policy, interaction_card_queued: true }; }) });
    add('interaction.respond', { description: 'Врахувати відповідь лише поточного автора на актуальний етап. choices — індекси з 0, до двох; content — власна дія. Зміна відповіді можлива до завершення; у parallel люди можуть обрати різне. На відмову/не готовий не записуй згоду.', background: false, schema: InteractionAnswer, run: (a, c) => db.tx(async (sql) => { if (c.interactionId === a.id)
            throw new ToolError('interaction_answer_already_recorded'); const v = await answerInteraction(sql, a, c); await queueInteraction(sql, v.id); await enqueueInteraction(sql, v, c); return v; }) });
    add('interaction.status', { description: 'Фактичний склад, правило, власні/спільні відповіді, ролі та ті, кого чекаємо. Дані публічної взаємодії; таємні ролі та відповіді використовують private.ask/activity.', schema: z.object({ id }), run: async (a, c) => { await context(c); const v = await interactionView(db, a.id); if (v.topic_id !== c.topicId)
            throw new ToolError('interaction_other_topic'); return v; } });
    add('interaction.finish', { description: 'Зафіксувати перевірений результат етапу. actor_only=true для власної готової гілки parallel: вона не чекає чужої гілки й не завершує весь етап. Спільний результат дозволений лише коли сервер зібрав потрібні відповіді.', background: false, schema: z.object({ id, version: z.number().int().positive(), result: z.string().min(2).max(2000), actor_only: z.boolean().default(false) }), run: (a, c) => db.tx(async (sql) => { await contextIn(sql, c); const v = await finishInteraction(sql, a.id, a.version, c, a.result, a.actor_only); await queueInteraction(sql, v.id); return v; }) });
    add('interaction.cancel', { description: 'Ініціатору скасувати або призупинити етап. Для виходу з власної участі interaction.respond decision=leave; це не записує згоду інших.', background: false, schema: z.object({ id, pause: z.boolean().default(false) }), run: (a, c) => db.tx(async (sql) => { await contextIn(sql, c); const r = await one(sql, "UPDATE interactions SET phase=$1,version=version+1,updated_at=now() WHERE id=$2 AND actor_id=$3 AND topic_id=$4 AND phase IN ('collecting','ready','active') RETURNING id", [a.pause ? 'paused' : 'cancelled', a.id, c.actorId, c.topicId]); if (r)
            await queueInteraction(sql, r.id); return { changed: Boolean(r) }; }) });
    add('interaction.revise', { description: 'Ініціатору явно змінити склад, варіанти чи правило етапу. Старі кнопки й голоси закриваються; новий склад погоджує нову версію. Не виключай мовчазного учасника самовільно.', background: false, schema: z.object({ id, spec: InteractionSpec }), run: (a, c) => db.tx(async (sql) => { await contextIn(sql, c); const old = await one(sql, "UPDATE interactions SET phase='cancelled',version=version+1 WHERE id=$1 AND actor_id=$2 AND topic_id=$3 RETURNING parent_id", [a.id, c.actorId, c.topicId]); if (!old)
            throw new ToolError('interaction_host_required'); const v = await openInteraction(sql, { ...a.spec, parent_id: old.parent_id || undefined }, c); await queueInteraction(sql, v.id); return v; }) });
    add('interaction.join', { description: 'Поточному автору добровільно долучитися до відкритого набору або активної спільної активності. При активному етапі новий учасник входить із наступного кроку; поточний склад очікування не змінюється.', background: false, schema: z.object({ id }), run: (a, c) => db.tx(async (sql) => { const s = await contextIn(sql, c), v = await interactionView(sql, a.id); if (v.topic_id !== c.topicId)
            throw new ToolError('interaction_other_topic'); if (v.phase === 'collecting' && v.spec.scope === 'open') {
            const r = await answerInteraction(sql, { id: v.id, version: v.version, decision: 'agree' }, c);
            await queueInteraction(sql, r.id);
            return r;
        } if (v.kind !== 'activity' || !['active', 'ready', 'resolved'].includes(v.phase))
            throw new ToolError('interaction_not_joinable'); if (v.participants.some(p => p.id === c.actorId))
            return { joined: true, already_joined: true }; const person = (s.participants || []).find((p: any) => p.id === c.actorId); if (!person)
            throw new ToolError('interaction_unknown_participant'); await sql.query('UPDATE interactions SET participants=participants||$1::jsonb WHERE id=$2', [JSON.stringify([person]), v.id]); await sql.query("UPDATE games SET state=jsonb_set(state,'{players}',(state->'players')||$1::jsonb) WHERE status='active' AND state->>'interaction_id'=$2", [JSON.stringify([person]), v.id]); return { joined: true, starts: 'next_step' }; }) });
}
async function contextIn(sql: any, c: ToolContext) { const s = await state(sql, true); if (s.paused || s.memory_revision !== c.revision)
    throw new ToolError('task_cancelled'); return s; }
