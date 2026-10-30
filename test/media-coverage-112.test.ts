import {test, before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {TestDB} from './helpers.js';
import {one, type SQL} from '../src/db.js';
import {ConfigSchema} from '../src/config.js';
import {registerAddressedTools, videoSampleTimes} from '../src/media-addressed.js';
import {MediaInspections, pruneMediaInspectionPayloads, type InspectionSpec} from '../src/media-inspections.js';
import type {Definition, ToolContext} from '../src/agent-tools.js';
import type {Brain} from '../src/model.js';
import type {Telegram} from '../src/telegram.js';
import {ToolError} from '../src/safe-http.js';

class CoverageDB extends TestDB {
  transactions = 0;
  override async tx<T>(fn: (sql: SQL) => Promise<T>): Promise<T> {
    return super.tx(async sql => {
      this.transactions++;
      try {return await fn(sql);} finally {this.transactions--;}
    });
  }
}
let db: CoverageDB;
let sequence = 800000;
const c = (extra: Partial<ToolContext> = {}): ToolContext => ({actorId: '11', chatId: '-100', topicId: '0', revision: 0, updateId: String(++sequence), requested: true, ...extra});
const config = () => ConfigSchema.parse({model: 'coverage-model-A'});
const fakeImage = (value: string) => 'data:image/jpeg;base64,' + Buffer.from(value).toString('base64');

before(async () => {
  db = new CoverageDB();
  await db.init();
  // Standalone tests also work before the parent migration is composed.
  await db.pg.exec(await readFile(new URL('../../src/media-inspections-schema.sql', import.meta.url), 'utf8'));
});
after(async () => db.close());
beforeEach(async () => {
  await db.reset();
  await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',paused=false,memory_revision=0 WHERE id=1");
});

async function message(body: string) {
  return Number((await one(db, "INSERT INTO messages(user_id,author,role,body) VALUES('11','Автор','user',$1) RETURNING id", [body]))!.id);
}
async function artifact(source: number, bytes = Buffer.from('same-original'), name = 'source.pdf') {
  const id = randomUUID();
  await db.query("INSERT INTO agent_artifacts(id,actor_id,topic_id,name,mime,content,encoding,revision,source_message_id) VALUES($1,'11','0',$2,$3,$4,'base64',0,$5)", [id, name, name.endsWith('.pdf') ? 'application/pdf' : 'video/mp4', bytes.toString('base64'), source]);
  return id;
}
async function attachment(source: number, kind = 'video') {
  return Number((await one(db, "INSERT INTO attachments(source_message_id,kind,file_id,revision,metadata) VALUES($1,$2,'same-provider-id',0,$3) RETURNING id", [source, kind, JSON.stringify({file_name: kind === 'video' ? 'source.mp4' : 'source.pdf'})]))!.id);
}
function setup(options: {pages?: (bytes: Uint8Array, pages: number[]) => Promise<any>; video?: (bytes: Uint8Array, start: number, end: number) => Promise<any>; inspections?: MediaInspections; file?: () => Uint8Array; text?: () => Promise<string>; cfg?: ReturnType<typeof config>} = {}) {
  const definitions = new Map<string, Definition>();
  let models = 0, downloads = 0;
  const limits: number[] = [];
  const brain = {
    plan: async () => ({reply: '', actions: []}),
    text: async () => {assert.equal(db.transactions, 0, 'model must not run inside a DB transaction'); models++; return options.text ? options.text() : 'видимий текст';}
  } as Brain;
  const telegram = {file: async (_id: string, maxBytes: number) => {
    assert.equal(db.transactions, 0, 'download must not run inside a DB transaction'); downloads++; limits.push(maxBytes);
    return options.file?.() ?? Buffer.from('same-original');
  }} as unknown as Telegram;
  registerAddressedTools(db, options.cfg ?? config(), brain, (name, definition) => definitions.set(name, definition), {
    inspections: options.inspections, telegram,
    readPages: options.pages ?? (async (_bytes, pages) => {
      assert.equal(db.transactions, 0, 'decoder must not run inside a DB transaction');
      return {total: 20, unavailable: [], pages: pages.map(page => ({page, text: 'page ' + page}))};
    }),
    readVideo: options.video ?? (async (bytes, start, end) => {
      assert.equal(db.transactions, 0, 'decoder must not run inside a DB transaction');
      return {frames: videoSampleTimes(start, end).map(time => ({time, url: fakeImage(Buffer.from(bytes).toString() + ':' + time)})), requested: {start, end}, sampling_fps: 2, coverage: 'sampled_requested_window', notice: 'fixture'};
    })
  });
  return {
    run: async (name: string, args: unknown, context = c()): Promise<any> => {
      const definition = definitions.get(name)!;
      return definition.run(definition.schema.parse(args), context);
    },
    models: () => models, downloads: () => downloads, limits
  };
}

function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => {enter = resolve;});
  const released = new Promise<void>(resolve => {release = resolve;});
  return {entered, release, block: async () => {enter(); await released;}};
}

test('PDF repeated and overlapping reads reuse persisted pages and OCR; unknown is never read', async () => {
  const source = await message('PDF source'), firstRequest = await message('прочитай 1 2 3'), id = await artifact(source);
  const decoded: number[][] = [];
  const options = {pages: async (_bytes: Uint8Array, pages: number[]) => {
    assert.equal(db.transactions, 0);
    decoded.push([...pages]);
    return {total: 4, unavailable: pages.filter(page => page > 4), pages: pages.filter(page => page <= 4).map(page => page === 2 ? {page, dataUrl: fakeImage('scan')} : page === 3 ? {page} : {page, text: 'page ' + page})};
  }};
  const tools = setup(options);
  const first = await tools.run('document.pages', {artifact_id: id, pages: [1, 2, 3]}, c({sourceId: firstRequest}));
  assert.deepEqual(first.page_coverage.read_pages, [1]);
  assert.deepEqual(first.page_coverage.partial_pages, [2]);
  assert.deepEqual(first.page_coverage.unknown_pages, [3]);
  assert.equal(tools.models(), 1);
  const secondRequest = await message('прочитай 2 3 4 8');
  // A fresh registry simulates a new worker/process: reuse lives in the DB.
  const restarted = setup(options);
  const second = await restarted.run('document.pages', {artifact_id: id, pages: [2, 3, 4, 8]}, c({sourceId: secondRequest}));
  assert.deepEqual(decoded, [[1, 2, 3], [4, 8]]);
  assert.deepEqual(second.cache.reused_pages, [2, 3]);
  assert.deepEqual(second.unavailable, [8]);
  assert.equal(restarted.models(), 0);
  assert.ok(second.source_message_ids.includes(source));
  assert.ok(second.source_message_ids.includes(secondRequest));
  const coverage = await restarted.run('media.coverage', {artifact_id: id});
  assert.ok(coverage.items.some((row: any) => row.kind === 'pdf_page' && row.requested.page === 3 && row.status === 'unknown'));
  assert.equal(coverage.counts.find((row: any) => row.kind === 'pdf_page' && row.status === 'read').count, 2);
  assert.equal(JSON.stringify(coverage).includes('видимий текст'), false, 'coverage does not expose cached response bodies');
});

test('actual SHA and source versions invalidate reuse even with unchanged provider IDs', async () => {
  const source = await message('original source'), id = await attachment(source, 'document');
  let bytes = Buffer.from('original-A'), decodes = 0;
  const tools = setup({file: () => bytes, pages: async (_bytes, pages) => {decodes++; return {total: 2, unavailable: [], pages: pages.map(page => ({page, text: Buffer.from(_bytes).toString()}))};}});
  const first = await tools.run('document.pages', {attachment_id: id, pages: [1]});
  bytes = Buffer.from('original-A');
  const unchanged = await tools.run('document.pages', {attachment_id: id, pages: [1]});
  assert.equal(decodes, 1);
  assert.equal(first.sha256, unchanged.sha256);
  bytes = Buffer.from('original-B');
  const changed = await tools.run('document.pages', {attachment_id: id, pages: [1]});
  assert.equal(decodes, 2);
  assert.notEqual(changed.sha256, first.sha256);
  await db.query("UPDATE messages SET body='edited source',edited_at=now() WHERE id=$1", [source]);
  await tools.run('document.pages', {attachment_id: id, pages: [1]});
  assert.equal(decodes, 3, 'same SHA with a source edit is a different source version');
  await db.query('UPDATE app_state SET memory_revision=1 WHERE id=1');
  await db.query('UPDATE attachments SET revision=1 WHERE id=$1', [id]);
  await tools.run('document.pages', {attachment_id: id, pages: [1]}, c({revision: 1}));
  assert.equal(decodes, 4, 'old revision payloads cannot become current');
  await assert.rejects(tools.run('document.pages', {attachment_id: id, pages: [1]}, c()), /task_cancelled/);
  assert.equal(tools.downloads(), 5, 'all valid cache reads still fetch and hash the real source');
});

test('coverage and reuse are isolated by actor, audience and chat namespace; warm hits retain artifact ACL', async () => {
  const source = await message('shared source'), id = await attachment(source, 'document');
  let decodes = 0;
  const tools = setup({pages: async (_bytes, pages) => {decodes++; return {total: 2, unavailable: [], pages: pages.map(page => ({page, text: 'private observation'}))};}});
  await tools.run('document.pages', {attachment_id: id, pages: [1]}, c({audience: 'private'}));
  const other = await tools.run('media.coverage', {attachment_id: id}, c({actorId: '22', audience: 'private'}));
  const publicView = await tools.run('media.coverage', {attachment_id: id}, c({audience: 'group'}));
  assert.deepEqual(other.counts, []);
  assert.deepEqual(other.items, []);
  assert.deepEqual(publicView.counts, []);
  await tools.run('document.pages', {attachment_id: id, pages: [1]}, c({actorId: '22', audience: 'private'}));
  assert.equal(decodes, 2);
  await assert.rejects(tools.run('media.coverage', {attachment_id: id}, c({chatId: '-200'})), /other_chat/);
  const own = await artifact(source);
  await tools.run('document.pages', {artifact_id: own, pages: [1]});
  await assert.rejects(tools.run('document.pages', {artifact_id: own, pages: [1]}, c({actorId: '22'})), /own_current_artifact_required/);
  await db.query("INSERT INTO outbox(dedup_key,kind,body,revision,audience) VALUES('private-delivery','artifact',$1,0,'private')", [JSON.stringify({id: own})]);
  await assert.rejects(tools.run('document.pages', {artifact_id: own, pages: [1]}), /private_input_cannot_widen_audience/);
  await assert.rejects(tools.run('media.coverage', {artifact_id: own}), /private_input_cannot_widen_audience/);
});

test('video overlap reuses decoded frames while question/model changes only regenerate the answer', async () => {
  const source = await message('video source'), id = await attachment(source);
  const windows: number[][] = [], cfg = config();
  const tools = setup({cfg, video: async (bytes, start, end) => {
    assert.equal(db.transactions, 0);
    windows.push([start, end]);
    return {frames: videoSampleTimes(start, end).map(time => ({time, url: fakeImage(Buffer.from(bytes).toString() + ':' + time)})), requested: {start, end}, sampling_fps: 2, coverage: 'sampled_requested_window', notice: 'fixture'};
  }});
  const first = await tools.run('media.segment', {attachment_id: id, start: 43, end: 48, question: 'Що видно?'});
  const repeat = await tools.run('media.segment', {attachment_id: id, start: 43, end: 48, question: 'Що видно?'});
  assert.deepEqual(first.frames, videoSampleTimes(43, 48));
  assert.equal(repeat.cache.reused_answer, true);
  assert.equal(tools.models(), 1);
  await tools.run('media.segment', {attachment_id: id, start: 43, end: 48, question: 'Який колір?'});
  assert.equal(tools.models(), 2);
  const overlap = await tools.run('media.segment', {attachment_id: id, start: 45, end: 49, question: 'Що видно?'});
  assert.deepEqual(windows, [[43, 48], [48, 49]]);
  assert.deepEqual(overlap.cache.reused_frames, [45, 45.5, 46, 46.5, 47, 47.5]);
  cfg.model = 'coverage-model-B';
  const newModel = await tools.run('media.segment', {attachment_id: id, start: 43, end: 48, question: 'Що видно?'});
  assert.equal(newModel.cache.reused_answer, false);
  assert.equal(tools.models(), 4);
  assert.equal(windows.length, 2);
  assert.ok(tools.limits.every(limit => limit === 24 * 1024 * 1024));
  const coverage = await tools.run('media.coverage', {attachment_id: id});
  assert.ok(coverage.items.some((row: any) => row.kind === 'video_request' && row.status === 'partial'));
  assert.ok(coverage.items.some((row: any) => row.kind === 'video_answer' && row.model_version === 'coverage-model-B'));
});

test('negative video samples stay unknown, are reusable, and failed requests retain truthful coverage', async () => {
  const source = await message('partial video'), id = await attachment(source);
  let decodes = 0;
  const tools = setup({video: async (_bytes, start, end) => {
    decodes++;
    return {frames: [{time: start, url: fakeImage('one actual frame')}], requested: {start, end}, sampling_fps: 2, coverage: 'partial_or_unavailable', notice: 'fixture'};
  }});
  const first = await tools.run('media.segment', {attachment_id: id, start: 2, end: 4, question: 'Що видно?'});
  assert.deepEqual(first.frames, [2]);
  assert.equal(first.coverage, 'partial_or_unavailable');
  await tools.run('media.segment', {attachment_id: id, start: 2, end: 4, question: 'Що видно?'});
  assert.equal(decodes, 1);
  const broken = setup({video: async () => {throw new ToolError('fixture_decoder_failed');}});
  await assert.rejects(broken.run('media.segment', {attachment_id: id, start: 10, end: 11, question: 'Що видно?'}), /fixture_decoder_failed/);
  const coverage = await tools.run('media.coverage', {attachment_id: id});
  assert.equal(coverage.counts.find((row: any) => row.kind === 'video_frame' && row.status === 'read').count, 1);
  assert.equal(coverage.counts.find((row: any) => row.kind === 'video_frame' && row.status === 'unknown').count, 3);
  assert.ok(coverage.items.some((row: any) => row.kind === 'video_request' && row.status === 'failed' && row.error_code === 'fixture_decoder_failed'));
});

test('source/request deletion cascades and late decoder completion cannot recreate an inspection', async () => {
  const source = await message('source to forget'), request = await message('request to forget'), id = await artifact(source);
  const wait = gate();
  const tools = setup({pages: async (_bytes, pages) => {await wait.block(); return {total: 1, unavailable: [], pages: pages.map(page => ({page, text: 'late text'}))};}});
  const running = tools.run('document.pages', {artifact_id: id, pages: [1]}, c({sourceId: request}));
  const rejected = assert.rejects(running, /media_source_unavailable/);
  await wait.entered;
  await db.query('DELETE FROM messages WHERE id=$1', [request]);
  assert.equal(Number((await one(db, 'SELECT count(*) AS n FROM media_inspections'))!.n), 0);
  wait.release();
  await rejected;
  assert.equal(Number((await one(db, 'SELECT count(*) AS n FROM media_inspection_payloads'))!.n), 0);
  const fresh = setup();
  await fresh.run('document.pages', {artifact_id: id, pages: [1]});
  await db.query('DELETE FROM messages WHERE id=$1', [source]);
  assert.equal(Number((await one(db, 'SELECT count(*) AS n FROM media_inspections'))!.n), 0);
  assert.equal(Number((await one(db, 'SELECT count(*) AS n FROM media_inspection_payloads'))!.n), 0);
  await assert.rejects(fresh.run('document.pages', {artifact_id: id, pages: [1]}), /own_current_artifact_required/);
});

test('pause/revision changes while OCR runs do not hold a DB fence or resurrect results', async () => {
  const source = await message('scan source'), id = await artifact(source), wait = gate();
  const tools = setup({pages: async (_bytes, pages) => ({total: 1, unavailable: [], pages: pages.map(page => ({page, dataUrl: fakeImage('scan')}))}), text: async () => {await wait.block(); return 'late OCR';}});
  const running = tools.run('document.pages', {artifact_id: id, pages: [1]});
  const rejected = assert.rejects(running, /task_cancelled/);
  await wait.entered;
  await db.query('UPDATE app_state SET paused=true,memory_revision=1 WHERE id=1');
  await db.query('DELETE FROM media_inspections');
  wait.release();
  await rejected;
  assert.equal(Number((await one(db, 'SELECT count(*) AS n FROM media_inspections'))!.n), 0);
  assert.equal(Number((await one(db, 'SELECT count(*) AS n FROM media_inspection_payloads'))!.n), 0);
});

test('an artifact access restriction added during decoding blocks the pending result', async () => {
  const source = await message('access source'), id = await artifact(source), wait = gate();
  const tools = setup({pages: async (_bytes, pages) => {await wait.block(); return {total: 1, unavailable: [], pages: pages.map(page => ({page, text: 'late private page'}))};}});
  const running = tools.run('document.pages', {artifact_id: id, pages: [1]});
  const rejected = assert.rejects(running, /private_input_cannot_widen_audience/);
  await wait.entered;
  await db.query("INSERT INTO outbox(dedup_key,kind,body,revision,audience) VALUES('late-private','artifact',$1,0,'private')", [JSON.stringify({id})]);
  wait.release();
  await rejected;
  assert.equal(Number((await one(db, 'SELECT count(*) AS n FROM media_inspection_payloads'))!.n), 0);
});

test('a model switch during OCR cannot cache an answer under the previous model version', async () => {
  const source = await message('model switch source'), id = await artifact(source), wait = gate(), cfg = config();
  const tools = setup({cfg, pages: async (_bytes, pages) => ({total: 1, unavailable: [], pages: pages.map(page => ({page, dataUrl: fakeImage('scan')}))}), text: async () => {await wait.block(); return 'late model response';}});
  const running = tools.run('document.pages', {artifact_id: id, pages: [1]});
  const rejected = assert.rejects(running, /media_model_changed/);
  await wait.entered;
  cfg.model = 'coverage-model-B';
  wait.release();
  await rejected;
  assert.equal(Number((await one(db, 'SELECT count(*) AS n FROM media_inspection_payloads'))!.n), 0);
});

test('bounded LRU and cold expiry discard derived payloads while preserving coverage and original bytes', async () => {
  const source = await message('bounded source'), original = Buffer.from('immutable-original'), id = await artifact(source, original);
  let clock = Date.now(), decodes = 0;
  const inspections = new MediaInspections(db, {payloadLimitBytes: 420, payloadTtlMs: 1000, now: () => clock});
  const tools = setup({inspections, pages: async (_bytes, pages) => {decodes++; return {total: 3, unavailable: [], pages: pages.map(page => ({page, text: String(page).repeat(180)}))};}});
  await tools.run('document.pages', {artifact_id: id, pages: [1]});
  clock += 10;
  await tools.run('document.pages', {artifact_id: id, pages: [2]});
  const bounded = await one(db, 'SELECT count(*) AS n,COALESCE(sum(payload_bytes),0) AS bytes FROM media_inspection_payloads');
  assert.ok(Number(bounded!.bytes) <= 420);
  assert.equal(Number(bounded!.n), 1);
  let coverage = await tools.run('media.coverage', {artifact_id: id});
  assert.equal(coverage.counts.find((row: any) => row.kind === 'pdf_page' && row.status === 'read').count, 2);
  assert.equal(coverage.items.filter((row: any) => row.kind === 'pdf_page' && row.payload_cached).length, 1);
  const metadataBefore = Number((await one(db, 'SELECT count(*) AS n FROM media_inspections'))!.n);
  clock += 2000;
  // Background housekeeping works without opening any source or decoder.
  await pruneMediaInspectionPayloads(db, undefined, 420, new Date(clock));
  assert.equal(Number((await one(db, 'SELECT count(*) AS n FROM media_inspection_payloads'))!.n), 0);
  assert.equal(Number((await one(db, 'SELECT count(*) AS n FROM media_inspections'))!.n), metadataBefore);
  assert.deepEqual(Buffer.from((await one(db, 'SELECT content FROM agent_artifacts WHERE id=$1', [id]))!.content, 'base64'), original);
  coverage = await tools.run('media.coverage', {artifact_id: id});
  assert.ok(coverage.items.every((row: any) => row.payload_cached === false));
  await tools.run('document.pages', {artifact_id: id, pages: [2]});
  assert.equal(decodes, 3, 'an evicted payload is reconstructed from the original');
});

test('decoder, prompt, model and question versions are independent cache identity fields', async () => {
  const source = await message('versioned source'), id = await artifact(source);
  const inspections = new MediaInspections(db), pending = await inspections.begin({artifact_id: id}, c());
  const lease = await inspections.bind(pending, Buffer.from('same-original'), [source]);
  const spec: InspectionSpec = {kind: 'video_answer', address: 'window:0:1', requested: {start: 0, end: 1}, decoderVersion: 'decoder-A', modelVersion: 'model-A', promptVersion: 'prompt-A', questionHash: 'question-A'};
  await inspections.store(lease, [{spec, status: 'partial', coverage: {sampled_frames: [0]}, payload: {description: 'observed'}}]);
  const hit = await inspections.lookup(lease, [spec]);
  assert.ok(inspections.hit(hit, lease, spec));
  for (const change of [{decoderVersion: 'decoder-B'}, {modelVersion: 'model-B'}, {promptVersion: 'prompt-B'}, {questionHash: 'question-B'}]) {
    const changed = {...spec, ...change};
    assert.equal(inspections.hit(await inspections.lookup(lease, [changed]), lease, changed), undefined);
  }
});
