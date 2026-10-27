import { randomInt, randomUUID } from 'node:crypto';
import { one, state, queueText, type Database } from './db.js';
import type { ToolContext } from './agent-tools.js';
import { PrivateInbox } from './private-inbox.js';
import { ConnectorVault } from './connector-vault.js';
import { ToolError } from './safe-http.js';
export const ACTIVITY_TEMPLATES = {
    detective: 'Кооперативний детектив: кожному окрема підказка, спільна розгадка', roles: 'Таємний агент: приховане слово, підказки й голосування', quest: 'Квест: спільні рішення, інвентар і наслідки', quotes: 'Хто це сказав: добровільні цитати та прихований автор', ranking: 'Сліпий рейтинг: незалежне ранжування варіантів', prediction: 'Прогнози: закритий вибір і пізніше введений результат', story: 'Історія по черзі: таємна умова для кожного автора', captions: 'Конкурс підписів: закрите подання й голосування', dilemmas: 'Дилеми: приватний вибір, узагальнення й обговорення', tournament: 'Командна вікторина: серверні питання, перевірка й очки',
} as const;
type Template = keyof typeof ACTIVITY_TEMPLATES;
const words = ['ліхтар', 'дракон', 'парасоля', 'компас', 'варення', 'ракета', 'бібліотека', 'пінгвін'];
export class SessionEngine {
    private inbox: PrivateInbox;
    private vault: ConnectorVault;
    constructor(private db: Database, runtimeDir: string) { this.inbox = new PrivateInbox(db, runtimeDir); this.vault = new ConnectorVault(db, runtimeDir); }
    async create(a: any, c: ToolContext) {
        if (await one(this.db, "SELECT id FROM games WHERE status='active' AND topic_id=$1", [c.topicId]))
            throw new ToolError('activity_already_active');
        if (a.quiz?.some((q: any) => q.correct_index >= q.options.length))
            throw new ToolError('quiz_correct_option_invalid');
        const id = randomUUID();
        const settings = { options: a.options || [], prompts: a.prompts || [], seconds: a.seconds || 180, _quiz: a.quiz || [] };
        if (['ranking', 'prediction', 'dilemmas'].includes(a.template) && settings.options.length < 2)
            throw new ToolError('activity_options_required');
        await this.db.query('INSERT INTO activity_sessions(id,actor_id,topic_id,template,title,max_rounds,settings,source_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, c.actorId, c.topicId, a.template, a.title, ['roles', 'quotes', 'captions'].includes(a.template) ? 2 : a.rounds || 3, JSON.stringify(settings), c.sourceId || null]);
        await this.join(id, c.actorId, a.host_name || c.actorId);
        return { id, phase: 'lobby', template: ACTIVITY_TEMPLATES[a.template as Template], next: 'Учасники добровільно приєднуються, потім ведучий починає.' };
    }
    async join(id: string, user: string, name: string, team = '') {
        return this.db.tx(async (sql) => {
            const s = await one(sql, 'SELECT * FROM activity_sessions WHERE id=$1 FOR UPDATE', [id]);
            if (!s || !['lobby', 'collect', 'between_rounds'].includes(s.phase))
                throw new ToolError('session_not_joinable');
            if (s.phase === 'collect' && s.round >= s.max_rounds)
                return { joined: false, reason: 'last_round_already_started', can_spectate: true };
            const prior = await one(sql, 'SELECT status,team FROM activity_players WHERE session_id=$1 AND user_id=$2', [id, user]);
            if (prior?.status === 'joined' && s.phase === 'collect')
                return { joined: true, already_joined: true };
            if (prior && s.phase !== 'lobby' && team && team !== prior.team)
                throw new ToolError('team_change_after_start');
            const n = Number((await one(sql, 'SELECT count(*) n FROM activity_players WHERE session_id=$1', [id]))?.n);
            if (n >= 16 && !prior)
                throw new ToolError('activity_max_16_players');
            await sql.query('INSERT INTO activity_players(session_id,user_id,name,role,status,team) VALUES($1,$2,$3,\'player\',$4,$5) ON CONFLICT(session_id,user_id) DO UPDATE SET name=excluded.name,team=excluded.team,status=excluded.status', [id, user, name.slice(0, 80), s.phase === 'collect' ? 'next_round' : 'joined', team.slice(0, 30)]);
            return { joined: true, starts: s.phase === 'collect' ? 'next_round' : 'now' };
        });
    }
    async view(id: string): Promise<any> {
        const s = await one(this.db, 'SELECT id,title,template,phase,round,max_rounds,public_state,deadline,version FROM activity_sessions WHERE id=$1', [id]);
        if (!s)
            throw new ToolError('session_not_found');
        const players = (await this.db.query('SELECT user_id,name,score,status,team FROM activity_players WHERE session_id=$1 ORDER BY user_id', [id])).rows;
        const moves = await one(this.db, 'SELECT count(*) n FROM activity_moves WHERE session_id=$1 AND round=$2', [id, s.round]);
        const teams: Record<string, number> = {};
        for (const p of players)
            if (p.team)
                teams[p.team] = (teams[p.team] || 0) + p.score;
        return { ...s, players, teams, received: Number(moves?.n || 0), private_roles_withheld: true };
    }
    async start(id: string, c: ToolContext) {
        const existing = await one(this.db, 'SELECT * FROM activity_sessions WHERE id=$1 AND actor_id=$2', [id, c.actorId]);
        if (existing?.phase === 'collect')
            return this.issuePrompts(existing, c);
        await this.db.tx(async (sql) => {
            const session = await one(sql, "SELECT * FROM activity_sessions WHERE id=$1 AND actor_id=$2 AND phase='lobby' FOR UPDATE", [id, c.actorId]);
            if (!session)
                throw new ToolError('session_host_required');
            const players = (await sql.query("SELECT user_id FROM activity_players WHERE session_id=$1 AND status='joined' ORDER BY user_id", [id])).rows;
            if (players.length < 2)
                throw new ToolError('activity_min_two_players');
            const spy = randomInt(players.length), word = words[randomInt(words.length)]!;
            for (const [i, x] of players.entries())
                await sql.query('UPDATE activity_players SET role=$1,private_state=$2 WHERE session_id=$3 AND user_id=$4', [session.template === 'roles' && i === spy ? 'spy' : 'player', JSON.stringify({ word: session.template === 'roles' && i === spy ? null : word, secret_word: words[randomInt(words.length)], clue: i }), id, x.user_id]);
            await sql.query("UPDATE activity_sessions SET phase='starting',version=version+1 WHERE id=$1", [id]);
        });
        return this.beginRound(id, c);
    }
    private async beginRound(id: string, c: ToolContext) {
        const s: any = await this.db.tx(async (sql) => {
            const r = await one(sql, 'SELECT * FROM activity_sessions WHERE id=$1 FOR UPDATE', [id]);
            if (!r || ['cancelled', 'completed', 'collect', 'awaiting_outcome'].includes(r.phase))
                throw new ToolError('session_phase_invalid');
            await sql.query("UPDATE activity_players SET status='joined' WHERE session_id=$1 AND status='next_round'", [id]);
            const round = r.round + 1;
            const a = randomInt(2, 18), b = randomInt(2, 18);
            const quiz = r.settings._quiz?.[(round - 1) % Math.max(1, r.settings._quiz?.length || 0)];
            const settings = { ...r.settings, _answer: quiz ? quiz.correct_index + 1 : a + b, _question: quiz ? quiz.question + '\n' + quiz.options.map((x: string, i: number) => `${i + 1}. ${x}`).join('\n') : `Скільки буде ${a} + ${b}?` };
            await sql.query("UPDATE activity_sessions SET round=$1,phase='collect',settings=$2,deadline=now()+($3*interval '1 second'),version=version+1 WHERE id=$4", [round, JSON.stringify(settings), r.settings.seconds, id]);
            return { ...r, round, settings, version: r.version + 1 };
        });
        return this.issuePrompts(s, c);
    }
    private async issuePrompts(s: any, c: ToolContext) {
        const id = s.id;
        const players = (await this.db.query("SELECT * FROM activity_players WHERE session_id=$1 AND status='joined' ORDER BY user_id", [id])).rows;
        for (const [index, p] of players.entries()) {
            let question = s.settings.prompts[(s.round - 1) % Math.max(1, s.settings.prompts.length)] || s.title;
            if (s.template === 'tournament')
                question = s.settings._question + ' Відповідь числом.';
            else if (s.template === 'roles')
                question = s.round === 1 ? (p.role === 'spy' ? 'Ти таємний агент. Слово невідоме. Напиши коротку підказку так, щоб тебе не викрили.' : `Твоє слово: ${p.private_state.word}. Напиши коротку підказку, не називаючи слово.`) : 'Хто таємний агент? Напиши номер:\n' + players.map((x, i) => `${i + 1}. ${x.name}`).join('\n');
            else if (s.template === 'detective') {
                const clues = ['Ключ був у людини в синьому.', 'Свідок у червоному не виходив із кімнати.', 'Лише Олена була в синьому.', 'Ключ потрібен, щоб відчинити скриню.'];
                question = `Підказка лише для тебе: ${clues[index % clues.length]}\nОбговоріть доступні підказки. Хто міг відчинити скриню? Надішли версію особисто.`;
            }
            else if (s.template === 'quest')
                question = `${question}\nШлях: ${(s.public_state.path || []).join(' → ') || 'початок'}. Інвентар: ${(s.public_state.inventory || []).join(', ') || 'порожній'}. Обери: 1 — міст; 2 — печера; 3 — вежа.`;
            else if (s.template === 'story') {
                question = `Твоя прихована умова: використай слово «${p.private_state.secret_word}». Додай речення до спільної історії публічним ходом activity.turn, коли буде твоя черга. Умову не потрібно розкривати.`;
            }
            else if (s.template === 'ranking')
                question += `\n${s.settings.options.map((x: string, i: number) => `${i + 1}. ${x}`).join('\n')}\nНомери від найкращого до найгіршого, через кому.`;
            else if (['prediction', 'dilemmas'].includes(s.template))
                question += `\n${s.settings.options.map((x: string, i: number) => `${i + 1}. ${x}`).join('\n')}\nВідповідь — номер варіанта.`;
            else if (s.template === 'captions')
                question = s.round === 1 ? question + '\nНадішли свій підпис. Для участі у голосуванні дозволь розкрити його після раунду.' : 'Обери номер найкращого підпису:\n' + (s.public_state.entries || []).map((x: any, i: number) => `${i + 1}. ${x.text}`).join('\n');
            else if (s.template === 'quotes')
                question = s.round === 1 ? 'Надішли власну коротку фразу для гри «Хто це сказав?». Для включення в раунд обери розкриття після раунду.' : (s.public_state.entries || []).map((x: any, i: number) => `${i + 1}. ${x.text}`).join('\n') + '\nВгадай авторів: JSON {"1":1,"2":2}, де значення — номер гравця:\n' + players.map((x, i) => `${i + 1}. ${x.name}`).join('\n');
            const prior = await one(this.db, "SELECT id FROM private_requests WHERE session_id=$1 AND recipient_id=$2 AND payload->>'round'=$3 AND status<>'revoked'", [id, p.user_id, String(s.round)]);
            if (!prior)
                await this.inbox.ask(c, p.user_id, question, `Гра «${s.title}», раунд ${s.round}`, { activity_id: id, round: s.round, version: s.version }, id);
        }
        if (s.template === 'story')
            await this.db.query("UPDATE activity_sessions SET public_state=$1 WHERE id=$2", [JSON.stringify({ ...s.public_state, turn_index: 0, story: s.public_state.story || [] }), id]);
        return this.view(id);
    }
    async privateMove(r: any, text: string, ref: string) {
        const s = await one(this.db, "SELECT * FROM activity_sessions WHERE id=$1 AND phase='collect' AND deadline>now()", [r.session_id]);
        if (!s || s.round !== r.payload.round || !await one(this.db, "SELECT user_id FROM activity_players WHERE session_id=$1 AND user_id=$2 AND status='joined'", [s.id, r.recipient_id]))
            throw new ToolError('activity_round_closed');
        if (s.template === 'story')
            return;
        const options = (['quest', 'prediction', 'dilemmas'].includes(s.template) || s.template === 'roles' && s.round === 2) ? (s.template === 'roles' ? Number((await one(this.db, 'SELECT count(*) n FROM activity_players WHERE session_id=$1', [s.id]))?.n) : s.template === 'quest' ? 3 : s.settings.options.length) : s.template === 'captions' && s.round === 2 ? s.public_state.entries?.length : 0;
        if (options && (!/^\d+$/.test(text.trim()) || Number(text) < 1 || Number(text) > options))
            throw new ToolError('activity_option_number_required');
        if (s.template === 'tournament' && !/^\d{1,6}$/.test(text.trim()))
            throw new ToolError('activity_number_required');
        if (s.template === 'ranking') {
            const ranks = text.split(',').map(x => Number(x.trim()));
            if (ranks.length !== s.settings.options.length || new Set(ranks).size !== ranks.length || ranks.some(x => !Number.isInteger(x) || x < 1 || x > s.settings.options.length))
                throw new ToolError('activity_ranking_all_options_required');
        }
        if (s.template === 'quotes' && s.round === 2) {
            try {
                const x = JSON.parse(text);
                if (Object.keys(x).length !== (s.public_state.entries || []).length || Object.values(x).some(v => !Number.isInteger(v) || Number(v) < 1 || Number(v) > options + 16))
                    throw new Error();
            }
            catch {
                throw new ToolError('activity_author_map_json_required');
            }
        }
        await this.db.query('INSERT INTO activity_moves(session_id,round,user_id,content,sharing) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [s.id, s.round, r.recipient_id, ref, r.sharing]);
    }
    async turn(id: string, text: string, c: ToolContext) {
        return this.db.tx(async (sql) => {
            const s = await one(sql, "SELECT * FROM activity_sessions WHERE id=$1 AND phase='collect' AND deadline>now() FOR UPDATE", [id]);
            if (!s)
                throw new ToolError('activity_round_closed');
            const players = (await sql.query("SELECT user_id FROM activity_players WHERE session_id=$1 AND status='joined' ORDER BY user_id", [id])).rows;
            if (!players.some(x => x.user_id === c.actorId))
                throw new ToolError('activity_join_first');
            if (s.template !== 'story')
                return { private_answer_required: true, instruction: 'Відкрий особистий запит Люмена для цього раунду.' };
            if (players[s.public_state.turn_index || 0]?.user_id !== c.actorId)
                throw new ToolError('activity_wait_your_turn');
            const publicState = { ...s.public_state, turn_index: (s.public_state.turn_index || 0) + 1, story: [...(s.public_state.story || []), { user_id: c.actorId, text: text.slice(0, 1000) }] };
            await sql.query('UPDATE activity_sessions SET public_state=$1 WHERE id=$2', [JSON.stringify(publicState), id]);
            await sql.query("INSERT INTO activity_moves(session_id,round,user_id,content,sharing) VALUES($1,$2,$3,$4,'public') ON CONFLICT DO NOTHING", [id, s.round, c.actorId, 'public:' + text.slice(0, 1000)]);
            return { accepted: true, next_player: players[publicState.turn_index]?.user_id || null };
        });
    }
    async reveal(id: string, c: ToolContext, outcome?: number): Promise<any> {
        const s = await one(this.db, 'SELECT * FROM activity_sessions WHERE id=$1', [id]);
        if (!s || s.actor_id !== c.actorId)
            throw new ToolError('session_host_required');
        if (!['collect', 'awaiting_outcome'].includes(s.phase))
            throw new ToolError('session_phase_invalid');
        const players = (await this.db.query("SELECT * FROM activity_players WHERE session_id=$1 AND status='joined' ORDER BY user_id", [id])).rows;
        const moves = (await this.db.query('SELECT * FROM activity_moves WHERE session_id=$1 AND round=$2 ORDER BY user_id', [id, s.round])).rows;
        if (s.phase === 'collect' && moves.length < players.length && s.deadline && new Date(s.deadline).getTime() > Date.now())
            return { status: 'collecting', received: moves.length, expected: players.length };
        if (s.template === 'prediction' && outcome === undefined) {
            await this.db.query("UPDATE activity_sessions SET phase='awaiting_outcome',deadline=NULL WHERE id=$1", [id]);
            return { status: 'awaiting_outcome', instruction: 'Ведучий вводить фактичний результат; прогнози закриті.' };
        }
        if (outcome !== undefined && (s.template !== 'prediction' || outcome < 1 || outcome > s.settings.options.length))
            throw new ToolError('activity_outcome_invalid');
        const values: any[] = [];
        for (const m of moves)
            values.push({ ...m, text: m.sharing === 'public' ? m.content.slice(7) : await this.vault.get(m.user_id, m.content) });
        const revealed = values.filter(x => ['reveal', 'quote', 'public'].includes(x.sharing)).map(x => ({ user_id: x.user_id, text: x.text }));
        const scores = new Map<string, number>();
        const counts: Record<string, number> = {};
        let publicState = { ...s.public_state };
        for (const m of values) {
            let points = 0;
            if (s.template === 'tournament')
                points = Number(m.text) === s.settings._answer ? 1 : 0;
            else if (s.template === 'detective')
                points = /олен/iu.test(m.text) ? 1 : 0;
            else if (s.template === 'prediction')
                points = Number(m.text) === outcome ? 1 : 0;
            else if (s.template === 'story')
                points = m.text.toLowerCase().includes(players.find(p => p.user_id === m.user_id)?.private_state.secret_word?.toLowerCase()) ? 1 : 0;
            else if (s.template === 'roles' && s.round === 2)
                points = players[Number(m.text) - 1]?.role === 'spy' ? 1 : 0;
            else if (s.template === 'quotes' && s.round === 2) {
                const guesses = JSON.parse(m.text);
                points = (s.public_state.entries || []).reduce((n: number, x: any, i: number) => n + (players[Number(guesses[String(i + 1)]) - 1]?.user_id === s.settings._entry_authors?.[i] ? 1 : 0), 0);
            }
            scores.set(m.user_id, points);
            if (['quest', 'prediction', 'dilemmas'].includes(s.template) || s.template === 'captions' && s.round === 2)
                counts[m.text] = (counts[m.text] || 0) + 1;
        }
        if (s.template === 'ranking') {
            const totals = s.settings.options.map(() => 0);
            for (const m of values)
                m.text.split(',').map(Number).forEach((v: number, i: number) => totals[v - 1] += totals.length - i);
            publicState.ranking = s.settings.options.map((label: string, i: number) => ({ label, points: totals[i] })).sort((a: any, b: any) => b.points - a.points);
        }
        if (s.template === 'quest') {
            const pick = Object.keys(counts).sort((a, b) => counts[b]! - counts[a]! || Number(a) - Number(b))[0];
            publicState.path = [...(publicState.path || []), pick ? ['міст', 'печера', 'вежа'][Number(pick) - 1] : 'очікування'];
            publicState.inventory = [...new Set([...(publicState.inventory || []), ...(pick === '2' ? ['ключ'] : pick === '3' ? ['мапа'] : [])])];
        }
        if (['quotes', 'captions'].includes(s.template) && s.round === 1) {
            publicState.entries = revealed.map(x => ({ text: x.text }));
            s.settings._entry_authors = revealed.map(x => x.user_id);
        }
        if (s.template === 'captions' && s.round === 2)
            for (const [option, n] of Object.entries(counts)) {
                const author = s.settings._entry_authors?.[Number(option) - 1];
                if (author)
                    scores.set(author, (scores.get(author) || 0) + n);
            }
        publicState.last_round = { round: s.round, received: moves.length, expected: players.length, entries: ['roles', 'story'].includes(s.template) ? revealed : ['captions', 'quotes'].includes(s.template) && s.round === 1 ? revealed.map(x => ({ text: x.text })) : [], counts: ['quest', 'dilemmas'].includes(s.template) ? counts : undefined, outcome: s.template === 'prediction' ? { option: s.settings.options[outcome! - 1], provided_by_host: true } : undefined };
        const final = s.round >= s.max_rounds || s.template === 'prediction';
        if (final && s.template === 'roles')
            publicState.spy = players.find(p => p.role === 'spy')?.user_id;
        await this.db.tx(async (sql) => {
            const locked = await one(sql, 'SELECT phase,version FROM activity_sessions WHERE id=$1 FOR UPDATE', [id]);
            if (!locked || locked.version !== s.version || locked.phase !== s.phase)
                throw new ToolError('activity_state_changed');
            for (const [user, n] of scores)
                await sql.query('UPDATE activity_players SET score=score+$1 WHERE session_id=$2 AND user_id=$3', [n, id, user]);
            await sql.query('UPDATE activity_sessions SET phase=$1,public_state=$2,deadline=NULL,version=version+1,settings=$4 WHERE id=$3', [final ? 'completed' : 'between_rounds', JSON.stringify(publicState), id, JSON.stringify(s.settings)]);
        });
        return this.view(id);
    }
    async nextRound(id: string, c: ToolContext) {
        const r = await one(this.db, "SELECT id FROM activity_sessions WHERE id=$1 AND actor_id=$2 AND phase='between_rounds'", [id, c.actorId]);
        if (!r)
            throw new ToolError('session_host_required');
        return this.beginRound(id, c);
    }
    async recover() {
        const stateValue = await state(this.db);
        if (stateValue.paused)
            return;
        for (const r of (await this.db.query("SELECT * FROM activity_sessions WHERE phase IN ('starting','collect') ORDER BY created_at LIMIT 10")).rows) {
            const c: ToolContext = { actorId: r.actor_id, chatId: stateValue.chat_id, topicId: r.topic_id, revision: stateValue.memory_revision, sourceId: r.source_message_id ? Number(r.source_message_id) : undefined, updateId: 'session-recover:' + r.id + ':' + r.round, requested: true };
            if (r.phase === 'starting')
                await this.beginRound(r.id, c);
            else if (new Date(r.deadline).getTime() > Date.now())
                await this.issuePrompts(r, c);
        }
    }
    async leave(id: string, c: ToolContext) {
        return this.db.tx(async (sql) => {
            const s = await one(sql, 'SELECT * FROM activity_sessions WHERE id=$1 FOR UPDATE', [id]);
            if (!s || ['completed', 'cancelled'].includes(s.phase))
                throw new ToolError('session_not_active');
            const players = (await sql.query("SELECT user_id FROM activity_players WHERE session_id=$1 AND status='joined' ORDER BY user_id", [id])).rows;
            const index = players.findIndex(x => x.user_id === c.actorId);
            await sql.query("UPDATE activity_players SET status='left' WHERE session_id=$1 AND user_id=$2", [id, c.actorId]);
            await sql.query("UPDATE private_requests SET status='revoked' WHERE session_id=$1 AND recipient_id=$2 AND status IN ('offered','answering')", [id, c.actorId]);
            await sql.query('DELETE FROM activity_moves WHERE session_id=$1 AND round=$2 AND user_id=$3', [id, s.round, c.actorId]);
            if (s.template === 'story' && index >= 0 && index < (s.public_state.turn_index || 0)) {
                s.public_state.turn_index--;
                await sql.query('UPDATE activity_sessions SET public_state=$1 WHERE id=$2', [JSON.stringify(s.public_state), id]);
            }
            return { left: true };
        });
    }
    async tick() {
        const s = await state(this.db);
        if (s.paused)
            return;
        for (const r of (await this.db.query("SELECT * FROM activity_sessions WHERE phase='collect' AND deadline<=now() LIMIT 3")).rows) {
            const c: ToolContext = { actorId: r.actor_id, chatId: s.chat_id, topicId: r.topic_id, revision: s.memory_revision, updateId: 'session-timeout:' + r.id + ':' + r.round, sourceId: r.source_message_id ? Number(r.source_message_id) : undefined, requested: true };
            try {
                const result = await this.reveal(r.id, c);
                await queueText(this.db, `«${r.title}»: час раунду минув.\n${JSON.stringify(result.public_state?.last_round || { status: result.status, received: result.received }).slice(0, 2200)}`, s.memory_revision, c.updateId, false, { threadId: r.topic_id === '0' ? undefined : Number(r.topic_id), sourceMessageId: r.source_message_id ? Number(r.source_message_id) : undefined });
            }
            catch { }
        }
    }
}
