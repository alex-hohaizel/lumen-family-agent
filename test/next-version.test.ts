import {withWorkerSlot} from '../src/work-slots.js';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TestDB, harness, paired, message, FakeTelegram } from './helpers.js';
import { AgentTools, type ToolContext } from '../src/agent-tools.js';
import { one, forgetPhrase } from '../src/db.js';
import { GroupWork, Decisions } from '../src/group-work.js';
import { PrivateInbox } from '../src/private-inbox.js';
import { PrivateResults, projectResult } from '../src/private-results.js';
import { ConnectionChecks } from '../src/connection-checks.js';
import { SessionEngine } from '../src/session-engine.js';
import { ConnectorVault } from '../src/connector-vault.js';
import { Delivery } from '../src/delivery.js';
import { wordDocument, workbook, officeText, unzipFiles } from '../src/office.js';
import { Research, Coordinator, Signals, moneyMinor } from '../src/agent-services.js';
import { verifyTask } from '../src/result-verifier.js';
import { TaskJournal } from '../src/task-journal.js';
import { runOperation, cancelOperations, operationSignal } from '../src/operations.js';
import { OAuthDevices } from '../src/oauth-device.js';
import { TransportQueue } from '../src/transport-queue.js';
import { ChatRegistry } from '../src/registry.js';
import { ChatRouter } from '../src/router.js';
import { MCPClient } from '../src/mcp-client.js';
import { FakeBrain } from './helpers.js';
import { WebMonitors } from '../src/web-monitors.js';
import type { HTTPRequest } from '../src/safe-http.js';
describe('Люмен 1.6: спільна робота, приватність і фактичний результат', () => {
    let db: TestDB, h: ReturnType<typeof harness>, tools: AgentTools, c: ToolContext, dir: string;
    before(async () => { db = new TestDB(); await db.init(); dir = await mkdtemp(join(tmpdir(), 'lumen-16-')); });
    after(async () => { await db.close(); await rm(dir, { recursive: true, force: true }); });
    beforeEach(async () => { await db.reset(); for (const t of ['research_cache', 'proactivity_preferences', 'capability_health', 'oauth_setups', 'private_results'])
        await db.query(`DELETE FROM ${t}`); h = harness(db); h.config.runtimeDir = dir; h.config.quietStart = 0; h.config.quietEnd = 0; await paired(h); await db.query("INSERT INTO members(user_id,name) VALUES('11','А'),('22','Б'),('33','В') ON CONFLICT DO NOTHING"); tools = new AgentTools(db, h.config, h.brain); c = { actorId: '11', chatId: '-100', topicId: '0', revision: 0, updateId: randomUUID(), requested: true }; });
    const call = (name: string, args: any, extra: Partial<ToolContext> = {}) => tools.execute(name, args, { ...c, updateId: randomUUID(), ...extra });
    async function answerRequest(r: any, text: string, sharing = 'reveal') {
        const ref = 'private_' + r.id.replaceAll('-', '');
        await new ConnectorVault(db, dir).put(r.recipient_id, ref, text);
        await db.query("UPDATE private_requests SET status='answering',sharing=$1 WHERE id=$2", [sharing, r.id]);
        const fresh = await one(db, 'SELECT * FROM private_requests WHERE id=$1', [r.id]);
        const inbox = new PrivateInbox(db, dir);
        return inbox.answer(fresh, message(text, Number(r.recipient_id), Number(r.recipient_id), 'private').message!, async (req, value, name) => { if (req.payload.decision_id)
            await new Decisions(db, dir).ballot(req, value, name); if (req.session_id)
            await new SessionEngine(db, dir).privateMove(req, value, name); if (req.payload.coordinator_key)
            await new Coordinator(db, dir).savePreference(req, value); });
    }
    it('дві людини отримують незалежні відповіді, а ходи одного автора зберігають порядок', async () => {
        await h.lumen.receive(message('Люмен, довга задача'));
        let release!: (v: any) => void;
        h.brain.block = async () => h.brain.calls.length === 1 ? new Promise(resolve => { release = resolve; }) : { reply: 'Друга відповідь', actions: [] };
        const first = h.lumen.processNext();
        for (let i = 0; i < 100 && !release; i++)
            await delay(5);
        assert.ok(release);
        await h.lumen.receive(message('Люмен, інше питання', 22));
        assert.equal(await h.lumen.processNext(), true);
        assert.ok((await db.query("SELECT body FROM outbox WHERE body->>'text'='Друга відповідь'")).rows.length);
        await h.lumen.receive(message('Люмен, третє питання'));
        assert.equal(await h.lumen.processNext(), false);
        release({ reply: 'Першу завершено', actions: [] });
        await first;
        assert.equal(await h.lumen.processNext(), true);
    });
    it('запит статусу не чекає на заблоковану модель', async () => {
        await h.lumen.receive(message('Люмен, досліди тему'));
        let release!: (v: any) => void;
        h.brain.block = () => new Promise(resolve => { release = resolve; });
        const work = h.lumen.processNext();
        for (let i = 0; i < 100 && !release; i++)
            await delay(5);
        await h.lumen.receive(message('Люмен, що ти робиш?'));
        assert.equal(h.brain.calls.length, 1);
        assert.ok((await db.query("SELECT id FROM outbox WHERE dedup_key LIKE 'fast-status:%'")).rows.length);
        release({ reply: 'Готово', actions: [] });
        await work;
    });
    it('скасування перериває лише потрібну операцію', async () => {
        let aborted = false;
        const task = runOperation(db, 'task:a', () => new Promise<void>(resolve => { operationSignal()!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }); }));
        cancelOperations(db, 'task:b');
        assert.equal(aborted, false);
        cancelOperations(db, 'task:a');
        await task;
        assert.equal(aborted, true);
    });
    it('забування видаляє похідне джерело та зберігає незалежну пам’ять і підключення', async () => {
        const a = await one(db, "INSERT INTO messages(user_id,author,role,body) VALUES('11','А','user','видалити секрет') RETURNING id");
        const b = await one(db, "INSERT INTO messages(user_id,author,role,body) VALUES('22','Б','user','окремий план') RETURNING id");
        await db.query("INSERT INTO memories(content,author_id,source_message_id) VALUES('похідний секрет','11',$1),('незалежна нотатка','22',$2)", [a!.id, b!.id]);
        await db.query("INSERT INTO tool_connections(id,owner_id,endpoint) VALUES('calendar','11','https://example.com/mcp')");
        await db.tx(sql => forgetPhrase(sql, 'видалити секрет'));
        assert.equal((await db.query('SELECT content FROM memories')).rows[0]?.content, 'незалежна нотатка');
        assert.equal((await db.query('SELECT id FROM tool_connections')).rows[0]?.id, 'calendar');
    });
    it('приватний факт не потрапляє в групову пам’ять навіть своєму автору', async () => { await call('memory.fact_save', { subject: 'бюджет', kind: 'preference', content: 'сума 12345', audience: 'private' }); assert.deepEqual(await call('memory.facts', {}), []); assert.equal((await call('memory.facts', {}, { audience: 'private' })).length, 1); });
    it('виправлення факту залишає лише актуальну версію', async () => { await call('memory.fact_save', { subject: 'харчування', kind: 'preference', content: 'без м’яса' }); const second = await call('memory.fact_save', { subject: 'харчування', kind: 'preference', content: 'їм м’ясо' }); assert.equal(second.version, 2); const facts = await call('memory.facts', {}); assert.equal(facts.length, 1); assert.equal(facts[0].content, 'їм м’ясо'); });
    it('особистий запит прив’язаний до адресата, відповідь зашифрована', async () => { const r = await call('private.ask', { recipient_id: '22', question: 'Який зручний час?', purpose: 'Спільна зустріч' }); const row = await one(db, 'SELECT * FROM private_requests WHERE id=$1', [r.id]); const tg = new FakeTelegram(); const inbox = new PrivateInbox(db, dir); assert.equal(await inbox.open(row!.token, '33', tg as any), false); assert.equal(await inbox.open(row!.token, '22', tg as any), true); await answerRequest(row, 'таємний час 12:34', 'task'); assert.equal(JSON.stringify((await db.query('SELECT * FROM private_requests')).rows).includes('таємний час'), false); assert.equal(JSON.stringify((await db.query('SELECT * FROM tool_credentials')).rows).includes('таємний час'), false); assert.deepEqual((await call('private.summary', { ids: [r.id] })).quotes, []); });
    it('особиста доставка не записується в історію групи', async () => { await call('private.ask', { recipient_id: '22', question: 'Приватне питання?', purpose: 'Перевірка' }); const d = new Delivery(db, h.tg as any, h.config); await d.next(); assert.equal(h.tg.sent.at(-1)?.chatId, '22'); assert.equal((await db.query("SELECT id FROM messages WHERE role='assistant'")).rows.length, 0); });
    it('доручення іншій людині потребує її прийняття, залежності блокують завершення', async () => { const p = await call('project.create', { title: 'Вечір', goal: 'Підготувати зустріч', criteria: 'Все підготовлено' }); const a = await call('project.task_add', { project_id: p.id, title: 'Знайти місце', assignee_id: '22' }); const b = await call('project.task_add', { project_id: p.id, title: 'Підтвердити час', assignee_id: '11', depends_on: [a.id] }); await assert.rejects(() => call('project.task_update', { id: a.id, action: 'complete', result: 'є місце' }), /assignee_has_not_accepted/); await assert.rejects(() => call('project.task_update', { id: b.id, action: 'complete', result: 'готово' }), /dependency_not_completed/); await call('project.task_update', { id: a.id, action: 'accept' }, { actorId: '22' }); await call('project.task_update', { id: a.id, action: 'complete', result: 'Місце обрано' }, { actorId: '22' }); await call('project.task_update', { id: b.id, action: 'complete', result: 'Час підтверджений' }); assert.equal((await call('project.close', { id: p.id })).status, 'completed'); });
    it('перенесення батьківської задачі зміщує залежний строк', async () => { const p = await call('project.create', { title: 'Проєкт', goal: 'Зробити спільне', criteria: 'Обидві задачі готові' }); const a = await call('project.task_add', { project_id: p.id, title: 'Перший крок', due_at: '2027-01-01T10:00:00Z' }); const b = await call('project.task_add', { project_id: p.id, title: 'Другий крок', due_at: '2027-01-02T10:00:00Z', depends_on: [a.id] }); await call('project.task_update', { id: a.id, action: 'reschedule', due_at: '2027-01-03T10:00:00Z' }); assert.equal(new Date((await one(db, 'SELECT due_at FROM project_tasks WHERE id=$1', [b.id]))!.due_at).toISOString(), '2027-01-04T10:00:00.000Z'); });
    it('спільне рішення не розкриває голосів і не рахує мовчання згодою', async () => { const d = await call('decision.create', { question: 'Що обираємо?', options: ['А', 'Б', 'В'], participants: ['11', '22', '33'], deadline: new Date(Date.now() + 3600000).toISOString() }); await call('decision.invite', { id: d.id }); const requests = (await db.query("SELECT * FROM private_requests WHERE payload->>'decision_id'=$1 ORDER BY recipient_id", [d.id])).rows; await answerRequest(requests[0], '{"ranking":[1,2],"excluded":[3]}', 'task'); await answerRequest(requests[1], '{"ranking":[2,1],"excluded":[]}', 'task'); assert.equal((await call('decision.result', { id: d.id })).status, 'collecting'); const result = await call('decision.result', { id: d.id, close: true }); assert.equal(result.tie, true); assert.equal(result.missing_count, 1); assert.deepEqual(result.winners, ['А', 'Б']); assert.equal(JSON.stringify(result).includes('ranking'), false); });
    it('таємні ролі не повертаються в публічний стан і перший хід є текстовою підказкою', async () => { const s = await call('activity.create', { template: 'roles', title: 'Таємний агент' }); await call('activity.join', { id: s.id, name: 'Б' }, { actorId: '22' }); await call('activity.start', { id: s.id }); const view = await call('activity.status', { id: s.id }); assert.equal(JSON.stringify(view).includes('secret_word'), false); assert.equal(JSON.stringify(view).includes('spy'), false); const request = await one(db, "SELECT * FROM private_requests WHERE session_id=$1 AND recipient_id='11'", [s.id]); await answerRequest(request, 'Нічна пригода'); assert.equal((await db.query('SELECT * FROM activity_moves WHERE session_id=$1', [s.id])).rows.length, 1); });
    it('закритий конкурс підписів не розкриває авторів до голосування', async () => { const s = await call('activity.create', { template: 'captions', title: 'Кумедний підпис', rounds: 2 }); await call('activity.join', { id: s.id, name: 'Б' }, { actorId: '22' }); await call('activity.start', { id: s.id }); for (const r of (await db.query('SELECT * FROM private_requests WHERE session_id=$1', [s.id])).rows)
        await answerRequest(r, 'Підпис ' + r.recipient_id); const result = await call('activity.reveal', { id: s.id }); assert.equal(result.phase, 'between_rounds'); assert.deepEqual(result.public_state.entries.map((x: any) => Object.keys(x)), [['text'], ['text']]); assert.deepEqual(result.public_state.last_round.entries.map((x: any) => Object.keys(x)), [['text'], ['text']]); await assert.rejects(() => call('activity.reveal', { id: s.id }), /session_phase_invalid/); });
    it('турнір перевіряє відповідь сервером і не подвоює очки', async () => { const s = await call('activity.create', { template: 'tournament', title: 'Рахуємо', rounds: 1 }); await call('activity.join', { id: s.id, name: 'Б' }, { actorId: '22' }); await call('activity.start', { id: s.id }); const answer = (await one(db, 'SELECT settings FROM activity_sessions WHERE id=$1', [s.id]))!.settings._answer; for (const r of (await db.query('SELECT * FROM private_requests WHERE session_id=$1', [s.id])).rows)
        await answerRequest(r, String(answer)); const result = await call('activity.reveal', { id: s.id }); assert.equal(result.phase, 'completed'); assert.ok(result.players.every((x: any) => x.score === 1)); await assert.rejects(() => call('activity.reveal', { id: s.id }), /session_phase_invalid/); });
    it('DOCX зберігає український текст і XML-символи', () => { const bytes = wordDocument('Документ', ['Текст <важливий> & точний', 'Другий абзац']); assert.ok(unzipFiles(bytes)['word/document.xml']); assert.equal(officeText(bytes, 'test.docx'), 'Документ\nТекст <важливий> & точний\nДругий абзац'); });
    it('XLSX зберігає числа, а формульний текст лишається текстом', () => { const bytes = workbook([['Ціна', 12.5], ['=HYPERLINK("https://bad")', true]]); const part = unzipFiles(bytes)['xl/worksheets/sheet1.xml']!.toString(); assert.ok(part.includes('t="n"><v>12.5')); assert.equal(part.includes('<f>'), false); assert.ok(officeText(bytes, 't.xlsx').includes('12.5')); });
    it('пошкоджений ZIP відхиляється до обробки документа', () => { const bytes = Buffer.from(wordDocument('Тест', ['Значення'])); bytes[50] = bytes[50]! ^ 1; assert.throws(() => unzipFiles(bytes)); });
    it('нові версії навички перевіряються й відкочуються з історією', async () => { const w = await call('workflow.save', { title: 'Плани', steps: JSON.stringify([{ tool: 'event.list', arguments: {} }]), examples: JSON.stringify([{ input: {}, expected: [[]] }]) }); assert.equal((await call('workflow.test', { id: w.id })).passed, true); const revised = await call('workflow.revise', { id: w.id, steps: JSON.stringify([{ tool: 'memory.facts', arguments: {} }]), examples: '[{"input":{}}]' }); assert.equal(revised.version, 2); assert.equal((await call('workflow.test', { id: w.id })).passed, true); const rollback = await call('workflow.rollback', { id: w.id, version: 1 }); assert.equal(rollback.version, 3); assert.equal((await call('workflow.versions', { id: w.id })).length, 3); });
    it('зовнішній результат без підтвердження сервісу не стає готовим', async () => { const t = await call('tasks.create', { title: 'Бронювання', goal: 'Забронювати місце', criteria: ['external'] }); const job = await one(db, 'SELECT * FROM agent_tasks WHERE id=$1', [t.id]); const result = await verifyTask(db, job, 'Усе заброньовано'); assert.equal(result.ok, false); assert.ok(result.missing.includes('provider_confirmation')); });
    it('створений файл перевіряється і задача чекає фактичної доставки', async () => { const t = await call('tasks.create', { title: 'Документ', goal: 'Створити документ', criteria: ['document'] }); await call('document.create', { name: 'Документ', format: 'docx', title: 'Перевірка', paragraphs: ['Дані'] }, { taskId: t.id, goalVersion: 1 }); const job = await one(db, 'SELECT * FROM agent_tasks WHERE id=$1', [t.id]); assert.ok((await verifyTask(db, job, 'Документ готовий')).waiting.includes('document_delivery')); const delivery = new Delivery(db, h.tg as any, h.config); for (let i = 0; i < 5; i++)
        await delivery.next(); assert.equal((await verifyTask(db, job, 'Документ готовий')).ok, true); });
    it('етап не можна завершити без доказу, а бюджет не видається за прогрес', async () => { const t = await call('tasks.create', { title: 'Перевірити', goal: 'Звірити результат' }); await call('tasks.plan', { id: t.id, stages: ['Зібрати дані', 'Звірити висновок'] }); await assert.rejects(() => call('tasks.stage', { id: t.id, position: 0, status: 'done' }), /stage_evidence_required/); const snapshot = await new TaskJournal(db).snapshot(t.id, '11'); assert.equal(snapshot.eta, null); assert.deepEqual(snapshot.done, []); assert.equal(snapshot.remaining.length, 2); });
    it('дослідницький кеш має явний строк і не поширюється між авторами', async () => { let searches = 0; const search: any = async () => { searches++; return { sources: ['https://example.com/'] }; }; const reader: any = async () => ({ url: 'https://example.com/', text: 'Першоджерело з актуальними даними', retrieved_at: new Date().toISOString() }); const research = new Research(db, h.config, h.brain, reader, search); const args = { query: 'Питання', freshness: 'live' }; assert.equal((await research.query(args, c)).from_cache, false); assert.equal((await research.query(args, c)).from_cache, true); await research.query(args, { ...c, actorId: '22' }); assert.equal(searches, 2); });
    it('суми обробляються в мінімальних одиницях без float', () => { assert.equal(moneyMinor('12.30'), '1230'); assert.equal(moneyMinor('0.01'), '1'); assert.throws(() => moneyMinor('1.001')); });
    it('сповіщення поважають відмову та відрізняють чергу від доставки', async () => { await call('signal.preferences', { enabled: false }); await call('signal.create', { title: 'Важлива зміна', body: 'З’явилися місця', reason: 'Ти просив перевірити', due_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(), key: 'available' }); await new Signals(db, h.config).tick(); assert.equal((await one(db, "SELECT status FROM signals WHERE dedup_key='11:available'"))!.status, 'muted'); });
    it('Device Flow тримає device/access токени поза приватними інструкціями й моделлю', async () => { let poll = 0; const request: HTTPRequest = async (url, opts) => { const data = url.includes('.well-known') ? { issuer: 'https://auth.example.com/', device_authorization_endpoint: 'https://auth.example.com/device', token_endpoint: 'https://auth.example.com/token' } : url.endsWith('/device') ? { device_code: 'device-secret', user_code: 'ABCD', verification_uri: 'https://auth.example.com/verify', expires_in: 600, interval: 5 } : url.endsWith('/token') ? (++poll === 1 ? { error: 'authorization_pending' } : { access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'Bearer', expires_in: 3600 }) : JSON.parse(opts?.body || '{}').method === 'initialize' ? { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } } : JSON.parse(opts?.body || '{}').method === 'notifications/initialized' ? {} : { jsonrpc: '2.0', id: 3, result: { tools: [] } }; return { url, status: data.error ? 400 : 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(data)) }; }; const oauth = new OAuthDevices(db, dir, request); const setup = await oauth.setup({ name: 'calendar', endpoint: 'https://api.example.com/mcp', issuer: 'https://auth.example.com/', client_id: 'public-client', scopes: ['calendar.read'] }, c); const row = await one(db, 'SELECT id FROM oauth_setups'); const tg = new FakeTelegram(); assert.equal(await oauth.begin(row!.id, '22', tg as any), false); assert.equal(await oauth.begin(row!.id, '11', tg as any), true); assert.equal(JSON.stringify(tg.sent).includes('device-secret'), false); await db.query("UPDATE oauth_setups SET next_poll=now()-interval '1 second'"); await oauth.tick(); assert.equal((await one(db, 'SELECT status FROM oauth_setups'))!.status, 'pending'); await db.query("UPDATE oauth_setups SET next_poll=now()-interval '1 second'"); await oauth.tick(); assert.equal((await one(db, 'SELECT status FROM oauth_setups'))!.status, 'completed'); assert.equal(JSON.stringify((await db.query('SELECT * FROM oauth_setups')).rows).includes('access-secret'), false); assert.equal(await new ConnectorVault(db, dir).get('11', 'calendar'), 'access-secret'); assert.ok(setup.private_setup_url); });
    it('вхідна черга зберігає лише шифротекст і атомарно просуває offset', async () => { await db.query('CREATE TABLE IF NOT EXISTS public.lumen_transport_state(id integer PRIMARY KEY,poll_offset bigint,last_poll_at timestamptz,owner_user_id text)'); await db.query('INSERT INTO public.lumen_transport_state(id,poll_offset) VALUES(1,0) ON CONFLICT DO NOTHING'); let received = ''; const queue = new TransportQueue(db, dir, async (u) => { received = u.message!.text!; }); await queue.init(); const u = message('secret-credential', 11, 11, 'private'); await queue.enqueue(u); const row = await one(db, 'SELECT * FROM public.lumen_ingress WHERE update_id=$1', [u.update_id]); assert.equal(row!.ciphertext.includes('secret-credential'), false); assert.equal(Number((await one(db, 'SELECT poll_offset FROM public.lumen_transport_state WHERE id=1'))!.poll_offset), u.update_id + 1); assert.equal(await queue.next(), true); assert.equal(received, 'secret-credential'); assert.equal((await one(db, 'SELECT ciphertext FROM public.lumen_ingress WHERE update_id=$1', [u.update_id]))!.ciphertext, null); });
    it('довгий вхідний запит не блокує іншого автора й не міняє порядок свого автора', async () => {
        let release!: () => void;
        const seen: string[] = [];
        const queue = new TransportQueue(db, dir, async (update) => { const text = update.message!.text!; seen.push(text); if (text === 'first')
            await new Promise<void>(resolve => { release = resolve; }); });
        await queue.init();
        for (const u of [message('first', 11, 11, 'private'), message('second', 11, 11, 'private'), message('other', 22, 22, 'private')])
            await queue.enqueue(u);
        const first = queue.next();
        for (let i = 0; i < 100 && !release; i++)
            await delay(5);
        assert.ok(release);
        assert.equal(await queue.next(), true);
        assert.deepEqual(seen, ['first', 'other']);
        release();
        await first;
        await queue.next();
        assert.deepEqual(seen, ['first', 'other', 'second']);
    });
    it('OAuth і bearer-токени не передаються через HTTP', async () => { await assert.rejects(() => new OAuthDevices(db, dir).setup({ name: 'bad', endpoint: 'http://example.com/mcp', issuer: 'https://auth.example.com', client_id: 'client', scopes: ['read'] }, c), /oauth_https_required/); assert.throws(() => new MCPClient('http://example.com/mcp', 'secret'), /connector_https_required/); });
    it('помилка самого MCP-інструмента не позначається успішним результатом', async () => {
        const request: HTTPRequest = async (url, opts) => { const call = JSON.parse(opts?.body || '{}'); return { url, status: call.method === 'notifications/initialized' ? 202 : 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: call.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { isError: true, content: [{ type: 'text', text: 'private provider details' }] } })) }; };
        await assert.rejects(() => new MCPClient('https://example.com/mcp', undefined, request).call('test', {}), error => String(error).includes('connector_tool_error') && !String(error).includes('private provider details'));
    });
    it('приватну відповідь можна відкликати до розкриття раунду', async () => {
        const s = await call('activity.create', { template: 'roles', title: 'Таємний агент' });
        await call('activity.join', { id: s.id, name: 'Б' }, { actorId: '22' });
        await call('activity.start', { id: s.id });
        const req = await one(db, "SELECT * FROM private_requests WHERE session_id=$1 AND recipient_id='11'", [s.id]);
        await answerRequest(req, 'Прихована підказка');
        await new PrivateInbox(db, dir).revoke(req!.id, '11');
        assert.equal((await db.query('SELECT id FROM private_requests WHERE answer IS NOT NULL AND status=\'answered\'')).rows.length, 0);
        assert.equal((await db.query('SELECT * FROM activity_moves WHERE session_id=$1', [s.id])).rows.length, 0);
    });
    it('сесія відновлює відсутні особисті запити без повтору вже створених', async () => {
        const s = await call('activity.create', { template: 'roles', title: 'Відновлення' });
        await call('activity.join', { id: s.id, name: 'Б' }, { actorId: '22' });
        await call('activity.start', { id: s.id });
        const saved = (await db.query('SELECT id FROM private_requests WHERE session_id=$1 ORDER BY id', [s.id])).rows;
        await db.query('DELETE FROM private_requests WHERE id=$1', [saved[0]!.id]);
        await new SessionEngine(db, dir).recover();
        const requests = (await db.query('SELECT * FROM private_requests WHERE session_id=$1', [s.id])).rows;
        assert.equal(requests.length, 2);
        assert.ok(requests.some(x => x.id === saved[1]!.id));
        assert.equal((await call('activity.status', { id: s.id })).round, 1);
    });
    it('власні питання турніру й командний рахунок перевіряє сервер', async () => {
        const s = await call('activity.create', { template: 'tournament', title: 'Власна тема', rounds: 1, quiz: [{ question: 'Яка відповідь?', options: ['Правильна', 'Інша'], correct_index: 0 }] });
        await call('activity.join', { id: s.id, name: 'А', team: 'Сині' });
        await call('activity.join', { id: s.id, name: 'Б', team: 'Сині' }, { actorId: '22' });
        await call('activity.start', { id: s.id });
        for (const r of (await db.query('SELECT * FROM private_requests WHERE session_id=$1', [s.id])).rows)
            await answerRequest(r, '1');
        const result = await call('activity.reveal', { id: s.id });
        assert.equal(result.teams['Сині'], 2);
        assert.equal(result.phase, 'completed');
    });
    it('оцінка часу виникає лише з двох виміряних однотипних етапів', async () => {
        const t = await call('tasks.create', { title: 'Перевірити варіанти', goal: 'Звірити три сторінки' });
        await call('tasks.plan', { id: t.id, stages: ['Перший', 'Другий', 'Третій'], unit_types: ['web_read', 'web_read', 'web_read'] });
        await db.query("UPDATE task_stages SET status='done',started_at=now()-interval '30 seconds',finished_at=now()-interval '10 seconds' WHERE task_id=$1 AND position<2", [t.id]);
        const result = await call('tasks.status', { id: t.id });
        assert.ok(result.eta?.minimum_seconds > 0);
        await db.query("UPDATE task_stages SET unit_type='document' WHERE task_id=$1 AND position=2", [t.id]);
        assert.equal((await call('tasks.status', { id: t.id })).eta, null);
    });
    it('монітор читає потрібне JSON-поле та ігнорує інші числа', async () => {
        const w = await call('watch.create', { url: 'https://example.com/api', label: 'Ціна', condition: 'below', json_path: 'ticket.price', threshold: 50, expires_at: new Date(Date.now() + 86400000).toISOString() });
        const monitor = new WebMonitors(db, h.config, async () => ({ url: 'https://example.com/api', title: '', text: '{"ticket":{"price":42},"other":999}', retrieved_at: new Date().toISOString(), content_is_untrusted: true }));
        await monitor.next();
        const notice = await one(db, "SELECT body FROM outbox WHERE dedup_key LIKE $1", ['watch:' + w.id + ':%']);
        assert.ok(notice?.body.text.includes('42'));
        assert.equal(notice?.body.text.includes('999'), false);
    });
    it('скасоване після постановки в чергу сповіщення не доставляється', async () => {
        const s = await call('signal.create', { title: 'Перевірка', body: 'Змінилися умови', reason: 'Ти просив повідомити', key: 'cancel-after-queue', due_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() });
        await new Signals(db, h.config).tick();
        assert.equal((await one(db, 'SELECT status FROM signals WHERE id=$1', [s.id]))!.status, 'queued');
        await call('signal.cancel', { id: s.id });
        await new Delivery(db, h.tg as any, h.config).next('text');
        assert.equal(h.tg.sent.length, 0);
    });
    it('контракт провайдера перевіряє номер, валюту й суму перед завершенням', async () => {
        const coordinator = new Coordinator(db, dir, async () => ({ url: 'https://tickets.example.com/offer', title: 'Квиток', text: 'Квиток 12.30 EUR, повернення дозволене', retrieved_at: new Date().toISOString(), content_is_untrusted: true }));
        const offer = await coordinator.offer({ url: 'https://tickets.example.com/offer', title: 'Квиток', price: '12.30', currency: 'EUR', source_excerpt: 'Квиток 12.30 EUR', conditions: 'повернення дозволене' }, c);
        const task = await call('tasks.create', { title: 'Квиток', goal: 'Підтвердити квиток', criteria: ['external'] });
        const contract = { provider_origin: 'https://tickets.example.com', status_path: 'status', confirmed_status: 'confirmed', reference_path: 'reference', amount_minor_path: 'amount_minor', currency_path: 'currency' };
        await db.query('INSERT INTO tool_connections(id,owner_id,endpoint,confirmation_contract) VALUES($1,$2,$3,$4)', ['tickets', '11', 'https://api.example.com/mcp', JSON.stringify(contract)]);
        const run = await one(db, "INSERT INTO tool_runs(dedup_key,task_id,actor_id,tool,arguments,status,result,revision) VALUES($1,$2,'11','connector.call',$3,'succeeded',$4,0) RETURNING id", [randomUUID(), task.id, JSON.stringify({ connection: 'tickets' }), JSON.stringify({ structuredContent: { status: 'confirmed', reference: 'ABC123', amount_minor: '1230', currency: 'EUR' } })]);
        const verified = await coordinator.verify({ offer_id: offer.id, source_run_id: Number(run!.id), reference: 'ABC123' }, { ...c, taskId: task.id, goalVersion: 1 });
        assert.equal(verified.status, 'confirmed');
        assert.equal((await verifyTask(db, await one(db, 'SELECT * FROM agent_tasks WHERE id=$1', [task.id]), 'Отримав підтвердження ABC123')).ok, true);
    });
    it('забування прибирає результати, файли, задачі й приватні запити, які використали джерело', async () => {
        const rows = (await db.query("INSERT INTO messages(user_id,author,role,body) VALUES('11','А','user','відомість 913 для забування'),('11','А','user','підготуй підсумок'),('22','Б','user','незалежне доручення') RETURNING id")).rows;
        const source = Number(rows[0]!.id), request = Number(rows[1]!.id);
        await db.query("INSERT INTO memories(content,author_id,source_message_id) VALUES('незалежний факт','22',$1)", [rows[2]!.id]);
        await db.query("INSERT INTO tool_connections(id,owner_id,endpoint) VALUES('calendar','11','https://example.com')");
        await new ConnectorVault(db, dir).put('11', 'calendar', 'independent-account-key');
        await call('memory.search', { terms: ['913'] }, { sourceId: request });
        await call('document.create', { name: 'Переказ', format: 'docx', title: 'Підсумок', paragraphs: ['Похідна інформація'] }, { sourceId: request, sourceIds: [source, request] });
        await call('tasks.create', { title: 'Перевірити переказ', goal: 'Звірити похідний результат' }, { sourceId: request, sourceIds: [source, request] });
        const privateRequest = await call('private.ask', { recipient_id: '22', question: 'Чи підходить запропоноване?', purpose: 'Похідна задача' }, { sourceId: request, sourceIds: [source, request] });
        await answerRequest(await one(db, 'SELECT * FROM private_requests WHERE id=$1', [privateRequest.id]), 'Лише для цієї задачі', 'task');
        await db.tx(sql => forgetPhrase(sql, 'відомість 913'));
        for (const table of ['agent_artifacts', 'agent_tasks', 'private_requests', 'tool_runs'])
            assert.equal((await db.query(`SELECT * FROM ${table}`)).rows.length, 0, table);
        assert.equal((await db.query('SELECT content FROM memories')).rows[0]?.content, 'незалежний факт');
        assert.equal(await new ConnectorVault(db, dir).get('11', 'calendar'), 'independent-account-key');
        assert.equal((await db.query("SELECT name FROM tool_credentials WHERE left(name,8)='private_'")).rows.length, 0);
    });
    it('стоп під час відповіді не дає пізньому результату відновити її', async () => {
        await h.lumen.receive(message('Люмен, довго подумай'));
        let release!: (v: any) => void;
        h.brain.block = () => new Promise(resolve => { release = resolve; });
        const pending = h.lumen.processNext();
        for (let i = 0; i < 100 && !release; i++)
            await delay(5);
        await h.lumen.receive(message('Люмен, стоп'));
        release({ reply: 'Це не має надійти', actions: [] });
        await pending;
        assert.equal((await db.query("SELECT id FROM outbox WHERE body->>'text'='Це не має надійти'")).rows.length, 0);
    });
    it('службові імена секретів не можна підмінити через налаштування підключення', async () => { await assert.rejects(() => call('connector.setup', { name: 'private_123', endpoint: 'https://example.com' }), /invalid_tool_arguments/); await assert.rejects(() => call('connector.oauth_setup', { name: 'refresh_calendar', endpoint: 'https://example.com', issuer: 'https://auth.example.com', client_id: 'client', scopes: ['read'] }), /invalid_tool_arguments/); });
    it('особистий діалог ізольований, а повтор токена після збою не стає розмовою', async () => {
        const registry = new ChatRegistry(db);
        await registry.init();
        const brains = new Map<string, FakeBrain>();
        const router = new ChatRouter(registry, h.config, h.tg as any, { id: 999, username: 'lumen_test_bot', can_read_all_group_messages: true }, (_config, chat) => { const b = new FakeBrain(); brains.set(chat, b); return b; });
        await router.init();
        const group = await router.runtime((await registry.find('-100'))!);
        await group.db.query("INSERT INTO messages(user_id,author,role,body) VALUES('11','А','user','групова фраза 987')");
        await router.receive(message('Люмен, особиста фраза 456', 11, 11, 'private'));
        const personal = await router.runtime((await registry.find('11'))!);
        await personal.engine.processNext();
        assert.equal(brains.get('11')!.calls[0]!.context.includes('групова фраза 987'), false);
        assert.equal((await group.db.query("SELECT id FROM messages WHERE body LIKE '%особиста фраза%'")).rows.length, 0);
        const setup = randomUUID();
        await group.db.query("INSERT INTO connection_setups(id,actor_id,name,endpoint) VALUES($1,'11','calendar','https://example.com/mcp')", [setup]);
        await router.receive(message('/start connect_' + setup, 11, 11, 'private'));
        const input = message('credential-example-1234567890', 11, 11, 'private');
        const originalList = MCPClient.prototype.list;
        const originalText = h.tg.text.bind(h.tg);
        MCPClient.prototype.list = async () => [];
        let failed = false;
        h.tg.text = async (chat, text, options = {}) => { if (!failed && text.includes('Доступ до «calendar» збережено')) {
            failed = true;
            throw new Error('simulated_confirmation_failure');
        } return originalText(chat, text, options); };
        try {
            await assert.rejects(() => router.receive(input), /simulated_confirmation_failure/);
            await router.receive(input);
            assert.equal((await personal.db.query("SELECT id FROM messages WHERE body LIKE '%credential-example%'")).rows.length, 0);
            assert.equal((await group.db.query("SELECT id FROM messages WHERE body LIKE '%credential-example%'")).rows.length, 0);
            assert.equal(await registry.privateConsumed(input.update_id, '11'), true);
        }
        finally {
            MCPClient.prototype.list = originalList;
            h.tg.text = originalText;
        }
    });
    it('особистий результат MCP за замовчуванням зашифрований і доставляється лише власнику', async () => {
        await db.query("INSERT INTO tool_connections(id,owner_id,endpoint,trusted_read_tools) VALUES('calendar','11','https://example.com',$1)", [JSON.stringify(['lookup'])]);
        await db.query("INSERT INTO tool_grants(id,actor_id,connection_id,tool,expires_at,daily_limit,revision) VALUES($1,'11','calendar','lookup',now()+interval '1 day',5,0)", [randomUUID()]);
        (tools as any).connector = async () => ({ list: async () => [{ name: 'lookup', annotations: { readOnlyHint: true } }], call: async () => ({ structuredContent: { email: 'private-928@example.com', available: true } }) });
        const result = await call('connector.call', { connection: 'calendar', tool: 'lookup', arguments: '{}' });
        assert.equal(result.private_data_withheld_from_group, true);
        assert.equal(JSON.stringify(result).includes('private-928'), false);
        assert.equal(JSON.stringify((await db.query('SELECT result FROM tool_runs')).rows).includes('private-928'), false);
        assert.equal(JSON.stringify((await db.query('SELECT * FROM private_results')).rows).includes('private-928'), false);
        const saved = await new PrivateResults(db, h.config).read(result.private_result_id, '11');
        assert.equal(saved.result.structuredContent.email, 'private-928@example.com');
        await assert.rejects(() => new PrivateResults(db, h.config).read(result.private_result_id, '22'), /private_result_unavailable/);
        await new Delivery(db, h.tg as any, h.config).next('media');
        assert.equal(h.tg.sent.at(-1)!.chatId, '11');
        assert.equal((await db.query("SELECT id FROM messages WHERE role='assistant'")).rows.length, 0);
    });
    it('дозволений доступ до групи віддає лише затверджені поля', async () => {
        await db.query("INSERT INTO tool_connections(id,owner_id,endpoint,trusted_read_tools) VALUES('calendar','11','https://example.com',$1)", [JSON.stringify(['lookup'])]);
        await db.query("INSERT INTO tool_grants(id,actor_id,connection_id,tool,expires_at,daily_limit,revision,share_to_group,share_fields) VALUES($1,'11','calendar','lookup',now()+interval '1 day',5,0,true,$2)", [randomUUID(), JSON.stringify(['availability.free'])]);
        (tools as any).connector = async () => ({ list: async () => [{ name: 'lookup', annotations: { readOnlyHint: true } }], call: async () => ({ structuredContent: { availability: { free: true, appointment: 'Лікар 18:00' }, email: 'private@example.com' } }) });
        const result = await call('connector.call', { connection: 'calendar', tool: 'lookup', arguments: '{}', share_result: true });
        assert.equal(JSON.stringify(result), '{"availability":{"free":true}}');
        assert.throws(() => projectResult({ a: 1 }, ['__proto__.polluted']), /confirmation_field_path_invalid/);
    });
    it('забування під час особистого пояснення не відновлює результат чи секрет', async () => {
        const source = await one(db, "INSERT INTO messages(user_id,author,role,body) VALUES('11','А','user','видалити запит 612') RETURNING id");
        let release!: (v: string) => void;
        const brain = { ...h.brain, text: () => new Promise<string>(resolve => { release = resolve; }) };
        const pending = new PrivateResults(db, h.config, brain as any).save({ secret: 'private-612' }, { ...c, sourceId: Number(source!.id) }, 'lookup');
        for (let i = 0; i < 100 && !release; i++)
            await delay(5);
        assert.ok(release);
        await db.tx(sql => forgetPhrase(sql, 'видалити запит 612'));
        release('Особистий підсумок');
        await assert.rejects(() => pending, /task_cancelled/);
        assert.equal((await db.query('SELECT id FROM private_results')).rows.length, 0);
        assert.equal((await db.query("SELECT name FROM tool_credentials WHERE name LIKE 'private_result_%'")).rows.length, 0);
    });
    it('перевірене фонове підключення продовжує саме актуальну задачу', async () => {
        const task = await call('tasks.create', { title: 'Перевірити календар', goal: 'Знайти вільний час' });
        await db.query("UPDATE agent_tasks SET status='needs_input',error_code='connection_pending' WHERE id=$1", [task.id]);
        await db.query("INSERT INTO tool_connections(id,owner_id,endpoint,health,verification_task_id,verification_goal_version) VALUES('calendar','11','https://example.com','check_pending',$1,1)", [task.id]);
        const original = MCPClient.prototype.list;
        MCPClient.prototype.list = async () => [{ name: 'lookup', inputSchema: { type: 'object' } }];
        try {
            assert.equal(await new ConnectionChecks(db, dir).next(), true);
            assert.equal((await one(db, 'SELECT health FROM tool_connections'))!.health, 'ready');
            assert.equal((await one(db, 'SELECT status FROM agent_tasks WHERE id=$1', [task.id]))!.status, 'pending');
            assert.equal((await one(db, "SELECT audience,actor_id FROM outbox WHERE dedup_key LIKE 'connection-check:%'"))!.audience, 'private');
        }
        finally {
            MCPClient.prototype.list = original;
        }
    });
    it('відключення прибирає локально access і refresh токени', async () => {
        const vault = new ConnectorVault(db, dir);
        await vault.put('11', 'calendar', 'access-private');
        await vault.put('11', 'refresh_calendar', 'refresh-private');
        await db.query("INSERT INTO tool_connections(id,owner_id,endpoint,credential_name,auth_metadata) VALUES('calendar','11','https://example.com','calendar',$1)", [JSON.stringify({ refresh_credential: 'refresh_calendar' })]);
        await call('connector.disconnect', { connection: 'calendar' });
        await assert.rejects(() => vault.get('11', 'calendar'), /connection_required/);
        await assert.rejects(() => vault.get('11', 'refresh_calendar'), /connection_required/);
    });
    it('невідомий відвідувач приватного чату не використовує модель власника', async () => {
        const registry = new ChatRegistry(db);
        await registry.init();
        const router = new ChatRouter(registry, h.config, h.tg as any, { id: 999, username: 'lumen_test_bot' }, (_config, chat) => { if (chat === '444')
            throw new Error('unknown_user_must_not_create_model'); return new FakeBrain(); });
        await router.init();
        await router.receive(message('Напиши мені відповідь', 444, 444, 'private'));
        assert.equal(await registry.find('444'), undefined);
        assert.ok(h.tg.sent.at(-1)!.text.includes('учасникам підключених груп'));
    });
    it('важкі процеси виконуються по одному, а очікування можна скасувати',async()=>{
      let release!:()=>void,started=false;
      const first=withWorkerSlot(()=>new Promise<void>(resolve=>{release=resolve;}));
      for(let i=0;i<100&&!release;i++)await delay(2);
      const second=runOperation(db,'queued-worker',()=>withWorkerSlot(async()=>{started=true;}));
      const rejected=assert.rejects(()=>second,/operation_cancelled/);cancelOperations(db,'queued-worker');await rejected;assert.equal(started,false);release();await first;
      await withWorkerSlot(async()=>{started=true;});assert.equal(started,true);
    });

});
