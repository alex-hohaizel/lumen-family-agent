import {preferenceDraft,rankingDraft} from './private-drafts.js';
import { recordProvenance, transferProvenance } from './provenance.js';
import { stableId } from './operations.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { one, state, queueText, type Database } from './db.js';
import { ConnectorVault } from './connector-vault.js';
import { ToolError } from './safe-http.js';
import type { Telegram, Message, CallbackQuery } from './telegram.js';
import type { ToolContext } from './agent-tools.js';
export type Sharing = 'task' | 'anonymous' | 'quote' | 'reveal';
export class PrivateInbox {
    private vault: ConnectorVault;
    constructor(private db: Database, private runtimeDir: string) { this.vault = new ConnectorVault(db, runtimeDir); }
    private async showStoryHint(r:any,user:string,telegram:Telegram){
        if(r.recipient_id!==user||!r.session_id||r.payload?.activity_id!==r.session_id)return false;
        const hint=await this.db.tx(async sql=>{
            const session=await one(sql,'SELECT template FROM activity_sessions WHERE id=$1 AND topic_id=$2',[r.session_id,r.topic_id]);
            if(!session)return undefined;if(session.template!=='story')return null;
            const live=await state(sql,true);if(live.paused||live.memory_revision!==r.revision)return undefined;
            const request=await one(sql,"SELECT r.id,r.question,r.purpose FROM private_requests r JOIN activity_sessions s ON s.id=r.session_id AND s.topic_id=r.topic_id JOIN activity_players p ON p.session_id=s.id AND p.user_id=r.recipient_id WHERE r.id=$1 AND r.recipient_id=$2 AND r.session_id=$3 AND r.topic_id=$4 AND r.revision=$5 AND r.status IN ('offered','answering','answered') AND r.expires_at>now() AND s.template='story' AND p.status='joined' AND NOT EXISTS(SELECT 1 FROM members m WHERE m.user_id=$2 AND m.active=false) FOR UPDATE OF r",[r.id,user,r.session_id,r.topic_id,r.revision]);
            if(!request)return undefined;
            await sql.query("UPDATE private_requests SET status='offered' WHERE id=$1 AND status='answering'",[request.id]);
            return request;
        });
        if(hint===null)return false;if(!hint)return true;
        await telegram.text(user,`${hint.question}\n\nМета: ${hint.purpose}\nЦе особиста підказка для твого ходу в групі. Відповідати тут і обирати спосіб використання відповіді не потрібно. Це звичайний чат із ботом, а не Secret Chat.`);
        return true;
    }
    async ask(c: ToolContext, recipient: string, question: string, purpose: string, payload: Record<string, any> = {}, sessionId?: string) {
        if (!/^\d+$/.test(recipient))
            throw new ToolError('participant_required');
        const s = await state(this.db);
        const member = await one(this.db, 'SELECT user_id FROM members WHERE user_id=$1 AND active=true', [recipient]);
        if (!member && recipient !== c.actorId && !(s.participants || []).some((p: any) => p.id === recipient))
            throw new ToolError('known_participant_required');
        const id = stableId((c.operationKey || c.actorId + ':' + c.updateId) + ':' + recipient + ':' + question + ':' + JSON.stringify(payload));
        const existing = await one(this.db, 'SELECT token,status FROM private_requests WHERE id=$1', [id]);
        if (existing)
            return { id, recipient_id: recipient, private_url: 'https://t.me/lumen_family_agent?start=p_' + existing.token, status: existing.status, expires_in_hours: 24 };
        const token = randomBytes(12).toString('hex');
        const expiry = payload.expires_at ? new Date(payload.expires_at) : new Date(Date.now() + 24 * 3600000);
        if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now() || expiry.getTime() > Date.now() + 30 * 86400000)
            throw new ToolError('private_expiry_max_30_days');
        await this.db.query('INSERT INTO private_requests(id,token,recipient_id,requester_id,topic_id,question,purpose,session_id,revision,source_message_id,expires_at,payload,task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$13,$11,$12)', [id, token, recipient, c.actorId, c.topicId, question, purpose, sessionId || null, c.revision, c.sourceId || null, JSON.stringify(payload), c.taskId || null, expiry]);
        await recordProvenance(this.db, 'private_request', id, [...(c.sourceIds || []), ...(c.sourceId ? [c.sourceId] : [])]);
        if (c.taskId)
            await transferProvenance(this.db, 'task', c.taskId, 'private_request', id);
        if (sessionId)
            await transferProvenance(this.db, 'session', sessionId, 'private_request', id);
        if (payload.decision_id)
            await transferProvenance(this.db, 'decision', payload.decision_id, 'private_request', id);
        await queueText(this.db, `Люмен пропонує особисте запитання для «${purpose.slice(0, 120)}». Участь добровільна. Відкрий запит, щоб побачити питання й обрати, як дозволяєш використати відповідь.`, c.revision, 'private-offer:' + id, false, { sourceIds: c.sourceIds, sourceMessageId: c.sourceId, actorId: recipient, audience: 'private', replyMarkup: { inline_keyboard: [[{ text: 'Відкрити особистий запит', url: 'https://t.me/lumen_family_agent?start=p_' + token }]] } });
        return { id, recipient_id: recipient, private_url: 'https://t.me/lumen_family_agent?start=p_' + token, status: 'offered', expires_in_hours: 24 };
    }
    async open(token: string, user: string, telegram: Telegram) {
        const r = await one(this.db, "SELECT * FROM private_requests WHERE token=$1 AND recipient_id=$2 AND status IN ('offered','answering','answered') AND expires_at>now()", [token, user]);
        if (!r)
            return false;
        const s = await state(this.db);
        if (s.paused || s.memory_revision !== r.revision)
            return false;
        if (Number(s.chat_id) < 0) {
            try {
                const member = await telegram.call<any>('getChatMember', { chat_id: s.chat_id, user_id: Number(user) });
                if (!['member', 'administrator', 'creator', 'restricted'].includes(member.status) || member.status === 'restricted' && member.is_member === false)
                    return false;
            }
            catch {
                return false;
            }
        }
        if(await this.showStoryHint(r,user,telegram))return true;
        await telegram.text(user, `${r.question}\n\nМета: ${r.purpose}\nВідповідь зберігатиметься зашифрованою. Обери спосіб використання, потім напиши відповідь. Це звичайний чат із ботом; він не є Secret Chat. /cancel — відмовитися.`, { replyMarkup: { inline_keyboard: [[{ text: 'Лише для цієї задачі', callback_data: 'lumen:pv:' + token + ':task' }], [{ text: 'Узагальнено без імені', callback_data: 'lumen:pv:' + token + ':anonymous' }], [{ text: 'Дозволяю цитувати', callback_data: 'lumen:pv:' + token + ':quote' }], ...(r.session_id ? [[{ text: 'Розкрити після раунду', callback_data: 'lumen:pv:' + token + ':reveal' }]] : [])] } });
        return true;
    }
    async choose(cb: CallbackQuery, telegram: Telegram) {
        const match = /^lumen:pv:([a-f0-9]{24}):(task|anonymous|quote|reveal)$/.exec(cb.data || '');
        if (!match)
            return false;
        const user = String(cb.from.id);
        const r = await one(this.db, "SELECT *,expires_at<=now() AS expired FROM private_requests WHERE token=$1 AND recipient_id=$2 AND status IN ('offered','answering','answered')", [match[1], user]);
        if (!r)
            return false;
        const current = await state(this.db);
        if (current.paused || current.memory_revision !== r.revision)
            return false;
        const known = await one(this.db, 'SELECT active FROM members WHERE user_id=$1', [user]);
        if (known?.active === false)
            return false;
        if (r.expired) {
            await telegram.text(user, 'Час для відповіді на це особисте запитання вже минув. Якщо воно ще актуальне, повернися до розмови, звідки відкрив цей запит, і попроси надіслати нове особисте запитання.');
            return false;
        }
        if (match[2] === 'reveal' && !r.session_id)
            return false;
        if(await this.showStoryHint(r,user,telegram))return true;
        // Only one free-text prompt can own the next DM. Never silently apply it to another group.
        await this.db.query("UPDATE private_requests SET status='offered' WHERE recipient_id=$1 AND status='answering'", [user]);
        await this.db.query("UPDATE private_requests SET status='answering',sharing=$1 WHERE id=$2", [match[2], r.id]);
        await telegram.text(user, `Обрано: ${match[2] === 'task' ? 'використання лише для цієї задачі' : match[2] === 'anonymous' ? 'узагальнення без імені' : match[2] === 'quote' ? 'можна цитувати' : 'розкриття після раунду'}.\n\n${r.question}\n\nНадішли відповідь одним повідомленням. /cancel — відмовитися.`);
        return true;
    }
    async pending(user: string) { return one(this.db, "SELECT id,token,sharing,purpose,payload,session_id,revision FROM private_requests WHERE recipient_id=$1 AND status='answering' AND expires_at>now() ORDER BY created_at DESC LIMIT 1", [user]); }
    async answer(r: any, m: Message, sink: (request: any, text: string, answerRef: string) => Promise<void>) {
        const user = String(m.from!.id), text = m.text || '';
        if (!text || text.length > 6000)
            throw new ToolError('private_answer_text_required');
        const live = await one(this.db, "SELECT * FROM private_requests WHERE id=$1 AND recipient_id=$2 AND status='answering' AND expires_at>now()", [r.id, user]);
        const s = await state(this.db);
        if (!live || s.paused || live.revision !== s.memory_revision)
            throw new ToolError('private_request_expired');
        const known = await one(this.db, 'SELECT active FROM members WHERE user_id=$1', [user]);
        if (known?.active === false)
            throw new ToolError('group_membership_required');
        if (text === '/cancel') {
            await this.revoke(live.id, user);
            return { cancelled: true };
        }
        if (text.startsWith('/'))
            throw new ToolError('private_answer_or_cancel_required');
        const draftKey='private_draft_'+live.id.replaceAll('-','');let normalized=text;
        if(live.payload.coordinator_key||live.payload.decision_id){
            let prior:any={};try{prior=JSON.parse(await this.vault.get(user,draftKey));}catch{}
            if(/^(?:так|да|підтверджую|подтверждаю|зберегти|сохранить|confirm|yes)[.!\s]*$/iu.test(text)&&prior.value)normalized=JSON.stringify(prior.value);
            else{
                let parsed:any;
                try{if(live.payload.coordinator_key)parsed=preferenceDraft(text,live.payload.currency,prior.draft||{});
                else{const decision=await one(this.db,"SELECT options,version FROM decisions WHERE id=$1 AND status='open'",[live.payload.decision_id]);if(!decision||decision.version!==live.payload.decision_version)throw new ToolError('decision_closed_or_changed');parsed=rankingDraft(text,decision.options);}}
                catch(e:any){if(e.publicMessage)return {clarification:e.publicMessage};throw e;}
                await this.vault.put(user,draftKey,JSON.stringify(parsed));
                return {clarification:parsed.missing||parsed.interpretation+'\nЗберегти саме так? Напиши «так» або виправ умови.'};
            }
        }
        const name = 'private_' + live.id.replaceAll('-', '');
        await this.vault.put(user, name, normalized);
        await sink(live, normalized, name);
        await this.vault.remove(user,draftKey);
        await this.db.query("UPDATE private_requests SET status='answered',answer=$1 WHERE id=$2 AND status='answering'", [name, live.id]);
        if (live.task_id)
            await this.db.query("UPDATE agent_tasks SET status='pending',error_code=NULL,available_at=now(),updated_at=now() WHERE id=$1 AND status='needs_input' AND error_code='private_answers_pending' AND NOT EXISTS(SELECT 1 FROM private_requests p WHERE p.task_id=$1 AND p.status IN ('offered','answering') AND p.expires_at>now())", [live.task_id]);
        return { saved: true, sharing: live.sharing };
    }
    async revoke(id: string, user: string) {
        const r = await one(this.db, "UPDATE private_requests SET status='revoked' WHERE id=$1 AND recipient_id=$2 RETURNING answer,session_id,payload", [id, user]);
        if(r)await this.vault.remove(user,'private_draft_'+id.replaceAll('-',''));
        if (r?.answer) {
            await this.vault.remove(user, r.answer);
            await this.db.query('DELETE FROM activity_moves WHERE session_id=$1 AND user_id=$2 AND content=$3', [r.session_id, user, r.answer]);
            await this.db.query("DELETE FROM decision_ballots WHERE user_id=$1 AND ranking->>'private_ref'=$2", [user, r.answer]);
        }
        return { revoked: Boolean(r) };
    }
    async cleanup() {
        for (const r of (await this.db.query("SELECT id,recipient_id,payload,requester_id FROM private_requests WHERE expires_at<=now() OR status='revoked' LIMIT 30")).rows) {
            if (r.payload?.decision_id) {
                const d = await one(this.db, 'SELECT actor_id,topic_id,status FROM decisions WHERE id=$1', [r.payload.decision_id]);
                if (d?.status === 'open') {
                    const { Decisions } = await import('./group-work.js');
                    const s = await state(this.db);
                    await new Decisions(this.db, this.runtimeDir).result(r.payload.decision_id, { actorId: d.actor_id, chatId: s.chat_id, topicId: d.topic_id, revision: s.memory_revision, requested: true, updateId: 'decision-expiry:' + r.payload.decision_id }, true);
                }
            }
            await this.revoke(r.id, r.recipient_id);
            await this.db.query('DELETE FROM private_requests WHERE id=$1', [r.id]);
        }
    }
    async summary(ids: string[], actor: string, summarize?: (texts: string[]) => Promise<string>) {
        const rows = (await this.db.query("SELECT id,recipient_id,answer,sharing,purpose FROM private_requests WHERE id=ANY($1::uuid[]) AND requester_id=$2 AND status='answered' AND sharing IN ('quote','anonymous') AND expires_at>now()", [ids, actor])).rows;
        const quotes = [];
        const anonymous = rows.filter(x => x.sharing === 'anonymous');
        for (const r of rows.filter(x => x.sharing === 'quote'))
            quotes.push({ author_id: r.recipient_id, text: await this.vault.get(r.recipient_id, r.answer), purpose: r.purpose });
        let summary: string | undefined;
        if (summarize && anonymous.length >= 3) {
            const names = (await this.db.query('SELECT name FROM members WHERE user_id=ANY($1::text[])', [anonymous.map(x => x.recipient_id)])).rows.map(x => x.name).filter(x => x.length > 2);
            const mask = (value: string) => {
                let text = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email приховано]').replace(/(?:\+?\d[\d ()-]{7,}\d)/g, '[номер приховано]').replace(/@[a-zA-Z0-9_]+/g, '[ім’я приховано]');
                for (const name of names)
                    text = text.split(name).join('[учасник]');
                return text;
            };
            const texts = [];
            for (const r of anonymous)
                texts.push(mask(await this.vault.get(r.recipient_id, r.answer)).slice(0, 1500));
            summary = mask(await summarize(texts)).slice(0, 2000);
        }
        return { quotes, summary, anonymous_responses: anonymous.length >= 3 ? anonymous.length : undefined, anonymous_text_withheld: true, task_only_and_sealed_answers_withheld: true };
    }
}
