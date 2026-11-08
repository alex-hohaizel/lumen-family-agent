import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { socialDecision, seriousConversation, type ConversationLine } from '../src/behavior.js';
import { TestDB, harness, paired, message } from './helpers.js';
import { one, state } from '../src/db.js';
import { Lumen } from '../src/engine.js';
import { Telegram } from '../src/telegram.js';

describe('Темп і доречність самостійної участі', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  function lines(count: number, spacing = 1000): ConversationLine[] {
    return Array.from({ length: count }, (_, i) => ({ id: i + 1, user_id: i % 2 ? '22' : '11', body: `Репліка ${i}`, created_at: new Date(now - (count - i - 1) * spacing) }));
  }
  function decide(recent: ConversationLine[], lastSocialAt: Date | null = null) {
    return socialDecision({ now, sourceId: recent.at(-1)!.id, sinceBot: recent.length, lastBotAt: null, lastSocialAt, lines: recent });
  }
  it('підтримує швидку розмову після 16 реплік, але не після восьми', () => {
    assert.equal(decide(lines(16)), true); assert.equal(decide(lines(8)), false);
  });
  it('для спокійнішої розмови достатньо десяти реплік двох за кілька хвилин', () => {
    assert.equal(decide(lines(10, 15000)), true);
  });
  it('не вклинюється у складну тему, але це не забороняє прямої відповіді', () => {
    const recent = lines(16); recent[14]!.body = 'Мені дуже важко, я в лікарні.';
    assert.equal(seriousConversation(recent), true); assert.equal(decide(recent), false);
  });
  it('відмова від самостійної репліки теж дає паузу', () => {
    assert.equal(decide(lines(16), new Date(now - 30000)), false);
    assert.equal(decide(lines(16), new Date(now - 46000)), true);
  });
  it('не відповідає на стару репліку з накопиченої черги', () => {
    const recent = lines(16);
    assert.equal(socialDecision({ now, sourceId: 1, sinceBot: 16, lastBotAt: null, lastSocialAt: null, lines: recent }), false);
  });
});

describe('Контекст тону 1.11',()=>{
  it('не виводить людське горе з метафори про пристрій або з цитати',()=>{
    assert.equal(seriousConversation([{body:'Помер мій телефон'}]),false);
    assert.equal(seriousConversation([{body:'У книжці написано «помер герой»'}]),false);
    assert.equal(seriousConversation([{body:'Мені дуже важко після смерті близької людини'}]),true);
  });
});

describe('Збережена адаптивна поведінка двох учасників', () => {
  const db = new TestDB(); let h: ReturnType<typeof harness>;
  before(async () => { await db.init(); }); after(async () => { await db.close(); });
  beforeEach(async () => { await db.reset(); h = harness(db); await paired(h); });
  it('стилі двох людей незалежні й переживають перезапуск рушія', async () => {
    await h.lumen.receive(message('/style short'));
    await h.lumen.receive(message('/style detailed', 22));
    await h.lumen.receive(message('/humor off'));
    const restarted = new Lumen(db, h.config, h.tg as unknown as Telegram, h.brain, h.lumen.bot);
    await restarted.receive(message('Люмен, допоможи з планом.')); await restarted.processNext();
    await restarted.receive(message('Люмен, поясни тему.', 22)); await restarted.processNext();
    assert.match(h.brain.calls[0]!.instructions!, /1–3 короткі/);
    assert.match(h.brain.calls[0]!.instructions!, /без жартів/);
    assert.match(h.brain.calls[1]!.instructions!, /конкретними прикладами/);
    assert.match(h.brain.calls[1]!.instructions!, /Легкий гумор/);
  });
  it('постійний стиль з природного прохання прив’язує лише до автора', async () => {
    h.brain.replies.push({ reply: '', actions: [{ kind: 'set_preference', length: 'short', humor: 'off' }] });
    await h.lumen.receive(message('Люмен, відтепер відповідай мені коротко і без жартів.'));
    await h.lumen.processNext();
    assert.equal((await one(db, 'SELECT length_mode FROM participant_preferences WHERE user_id=$1', ['11']))!.length_mode, 'short');
    assert.equal(await one(db, 'SELECT * FROM participant_preferences WHERE user_id=$1', ['22']), undefined);
  });
  it('разове прохання короткої відповіді не може створити постійне налаштування', async () => {
    h.brain.replies.push({ reply: '', actions: [{ kind: 'set_preference', length: 'short' }] });
    await h.lumen.receive(message('Люмен, поясни коротко.')); await h.lumen.processNext();
    assert.equal((await db.query('SELECT * FROM participant_preferences')).rows.length, 0);
    assert.equal((await state(db)).last_model_error, 'action_not_explicit');
  });
  it('налаштування не приймаються від стороннього чи до двох згод', async () => {
    await h.lumen.receive(message('/style short', 33));
    await h.lumen.receive(message('/pause')); await h.lumen.receive(message('/style detailed'));
    assert.equal((await db.query('SELECT * FROM participant_preferences')).rows.length, 0);
  });
  it('після рішення промовчати не звертається до моделі на кожну наступну репліку', async () => {
    await db.query('UPDATE app_state SET quiet_start=0,quiet_end=0 WHERE id=1');
    h.brain.replies.push({ reply: '', actions: [] });
    for (let i = 0; i < 16; i++) await h.lumen.receive(message(`Розмова ${i}`, i % 2 ? 22 : 11));
    while (await h.lumen.processNext()) {}
    for (let i = 0; i < 8; i++) { await h.lumen.receive(message(`Продовження ${i}`, i % 2 ? 22 : 11)); await h.lumen.processNext(); }
    assert.equal(h.brain.calls.length, 1); assert.ok((await state(db)).last_social_at);
  });
  it('серйозний контекст вимагає тактовної оцінки й не блокує пряму відповідь', async () => {
    await h.lumen.receive(message('Мені дуже важко сьогодні.')); await h.lumen.processNext();
    await h.lumen.receive(message('Люмен, допоможи розібратися.')); await h.lumen.processNext();
    assert.equal(h.brain.calls.length, 1); assert.match(h.brain.calls[0]!.instructions!, /тактовну подачу/);
  });
  it('повне забування очищає також збережений стиль', async () => {
    await h.lumen.receive(message('/style short')); await h.lumen.receive(message('/forget_all'));
    assert.equal((await db.query('SELECT * FROM participant_preferences')).rows.length, 0);
  });
  it('повторне застосування міграції зберігає налаштування', async () => {
    await h.lumen.receive(message('/style detailed')); await db.init();
    assert.equal((await one(db, 'SELECT length_mode FROM participant_preferences'))!.length_mode, 'detailed');
  });
});
