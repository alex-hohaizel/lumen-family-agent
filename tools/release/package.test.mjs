import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {cleanOutput} from './clean.mjs';
import {packageRelease, requiredModules, runtimeAssets, verifyInventory} from './package.mjs';
import {needsRuntimeImage, detectRuntimeImage} from './image-changes.mjs';
import {finalizeRender, renderPrunePaths} from './finalize-render.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lumen-release-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const write = async (path, bytes) => { await mkdir(join(root, path, '..'), {recursive: true}); await writeFile(join(root, path), bytes); };
  const metadata = {name: 'lumen-release-fixture', version: '1.0.0', type: 'module', engines: {node: '>=24'}, dependencies: {runtime: '1.0.0'}, devDependencies: {development: '1.0.0'}};
  const lock = {lockfileVersion: 3, version: metadata.version, packages: {
    '': {...metadata},
    'node_modules/runtime': {version: '1.0.0'},
    'node_modules/development': {version: '1.0.0', dev: true},
    'node_modules/absent-optional': {version: '1.0.0', optional: true},
  }};
  await write('package.json', JSON.stringify(metadata));
  await write('package-lock.json', JSON.stringify(lock));
  await write('LICENSE', 'Fixture license\n');
  for (const name of requiredModules) {
    await write('dist/src/' + name, 'export const fixture = true;\n');
    await write('src/' + name.replace(/\.js$/u, '.ts'), 'export const fixture = true;\n');
  }
  for (const name of ['schema.sql', 'media-inspections-schema.sql']) await write('src/' + name, 'SELECT 1;\n');
  for (const name of runtimeAssets) await write('assets/' + name, name);
  const assets = [];
  for (let index = 0; index < 120; index++) {
    const id = 'lumen_' + index, bytes = Buffer.from('webm fixture ' + index);
    assets.push({id, emoji: String(index), label: id, description: id, scene: id, file: id + '.webm', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), preview: id + '.png', source_keyposes_sha256: 'authoring', origin: 'authoring'});
    await write('assets/stickers/' + id + '.webm', bytes);
    await write('assets/stickers/' + id + '.png', 'preview');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(assets.map(asset => [asset.id, asset.sha256]))).digest('hex');
  await write('dist/src/joint-startup.js', `export const JOINT_STICKER_FINGERPRINT = '${fingerprint}';\n`);
  await write('src/joint-startup.ts', `export const JOINT_STICKER_FINGERPRINT = '${fingerprint}';\n`);
  await write('assets/stickers/manifest.json', JSON.stringify(assets));
  for (const name of ['runtime', 'development']) {
    await write('node_modules/' + name + '/package.json', JSON.stringify({name, version: '1.0.0', type: 'module', exports: './index.js'}));
    await write('node_modules/' + name + '/index.js', 'export const fixture = true;\n');
  }
  // A nested development package must not arrive through its parent's copy.
  await write('node_modules/runtime/node_modules/hidden-dev/index.js', 'development');
  for (const path of ['.env', 'runtime/secrets.json', 'test/functional.test.js', 'docs/authoring.md', 'scripts/probe.js', 'dist/test/functional.test.js']) await write(path, 'must not ship');
  return {root, write, assets, lock};
}

test('runtime package preserves the 120 ordered binaries and excludes authoring, checkout files and dev dependencies', async t => {
  const {root, assets} = await fixture(t);
  const {root: output, manifest} = await packageRelease(root);
  assert.equal(manifest.stickers.count, 120);
  assert.deepEqual(manifest.stickers.ordered_ids, assets.map(asset => asset.id));
  assert.deepEqual(await readdir(output), ['LICENSE', 'assets', 'dist', 'node_modules', 'package.json', 'release-manifest.json', 'src']);
  const shipped = JSON.parse(await readFile(join(output, 'assets/stickers/manifest.json'), 'utf8'));
  assert.deepEqual(shipped.map(asset => [asset.id, asset.sha256]), assets.map(asset => [asset.id, asset.sha256]));
  assert.equal(shipped.some(asset => 'preview' in asset || 'source_keyposes_sha256' in asset || 'origin' in asset), false);
  assert.equal((await readdir(join(output, 'assets/stickers'))).length, 121);
  assert.deepEqual(await readdir(join(output, 'node_modules')), ['runtime']);
  assert.deepEqual(await readdir(join(output, 'node_modules/runtime')), ['index.js', 'package.json']);
  assert.equal(JSON.parse(await readFile(join(output, 'package.json'), 'utf8')).scripts.diagnostics, 'node --env-file-if-exists=.env dist/src/main.js --diagnostics');
  await verifyInventory(output);
  await writeFile(join(output, 'unexpected.txt'), 'extra');
  await assert.rejects(verifyInventory(output), /release_inventory_mismatch/);
});

test('a corrupt approved binary fails packaging before replacing a previous valid runtime', async t => {
  const {root, write, assets} = await fixture(t);
  await packageRelease(root);
  const previous = await readFile(join(root, '.release/release-manifest.json'), 'utf8');
  await write('assets/stickers/' + assets[119].file, 'corrupted');
  await assert.rejects(packageRelease(root), /release_sticker_integrity/);
  assert.equal(await readFile(join(root, '.release/release-manifest.json'), 'utf8'), previous);
  await assert.rejects(readFile(join(root, '.release-next/package.json')), {code: 'ENOENT'});
});

test('a missing required production dependency fails instead of relying on ancestor modules', async t => {
  const {root} = await fixture(t);
  await rm(join(root, 'node_modules/runtime'), {recursive: true});
  await assert.rejects(packageRelease(root), /release_dependency_missing:node_modules\/runtime/);
});

test('owned-output cleanup rejects arbitrary paths and symlinks', async t => {
  const {root} = await fixture(t);
  await mkdir(join(root, 'protected'));
  await writeFile(join(root, 'protected/keep'), 'safe');
  await symlink('protected', join(root, '.release'), 'dir');
  await assert.rejects(cleanOutput(root, 'node_modules'), /release_output_not_owned/);
  await assert.rejects(cleanOutput(root, '../protected'), /release_output_not_owned/);
  await assert.rejects(cleanOutput(root, '.release'), /release_output_not_directory/);
  assert.equal(await readFile(join(root, 'protected/keep'), 'utf8'), 'safe');
});

test('container gate skips a sticker/version-only patch and retains dependency or build changes', () => {
  const before = {name: 'fixture', version: '1.0.0', scripts: {build: 'tsc'}, dependencies: {runtime: '1.0.0'}};
  const after = {...before, version: '1.0.1'};
  const lockBefore = {version: '1.0.0', packages: {'': {...before}, 'node_modules/runtime': {version: '1.0.0'}}};
  const lockAfter = {version: '1.0.1', packages: {'': {...after}, 'node_modules/runtime': {version: '1.0.0'}}};
  const packages = {'package.json': {before, after}, 'package-lock.json': {before: lockBefore, after: lockAfter}};
  assert.equal(needsRuntimeImage(['assets/stickers/lumen_01.webm', 'src/release.ts', 'package.json', 'package-lock.json'], packages), false);
  assert.equal(needsRuntimeImage(['package.json'], {'package.json': {before, after: {...after, dependencies: {runtime: '2.0.0'}}}}), true);
  assert.equal(needsRuntimeImage(['package-lock.json'], {'package-lock.json': {before: lockBefore, after: {...lockAfter, packages: {...lockAfter.packages, 'node_modules/runtime': {version: '2.0.0'}}}}}), true);
  for (const file of ['Dockerfile', '.dockerignore', 'compose.yaml', 'tools/release/package.mjs', 'tsconfig.json', 'package-lock.json', 'src/browser.ts', 'src/chromium-runtime.ts', 'src/document-worker.ts', 'assets/fonts/DejaVuSans.ttf']) assert.equal(needsRuntimeImage([file]), true, file);
  assert.equal(needsRuntimeImage(['README.md', 'docs/operations.md', 'src/personality.ts']), false);
});

async function renderFixture(t) {
  const state = await fixture(t);
  await packageRelease(state.root);
  const path = join(state.root, '.release/release-manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const revision = 'a'.repeat(40);
  manifest.source = {revision};
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
  const environment = {RENDER: 'true', RENDER_GIT_COMMIT: revision, RUNTIME_DIR: join(state.root, 'runtime')};
  return {...state, environment, expectedRoot: state.root, manifest};
}

test('Render finalization removes only checkout/build inputs and retains an intact standalone runtime', async t => {
  const state = await renderFixture(t);
  await state.write('.git/provider-marker', 'preserved');
  await state.write('backups/keep', 'backup');
  const before = await readFile(join(state.root, '.release/release-manifest.json'), 'utf8');
  const receipt = await finalizeRender(state);
  assert.deepEqual(receipt.removed_paths, renderPrunePaths);
  assert.equal(receipt.revision, state.environment.RENDER_GIT_COMMIT);
  for (const path of renderPrunePaths) await assert.rejects(readFile(join(state.root, path)), {code: 'ENOENT'});
  assert.equal(await readFile(join(state.root, 'runtime/secrets.json'), 'utf8'), 'must not ship');
  assert.equal(await readFile(join(state.root, '.env'), 'utf8'), 'must not ship');
  assert.equal(await readFile(join(state.root, 'backups/keep'), 'utf8'), 'backup');
  assert.equal(await readFile(join(state.root, '.git/provider-marker'), 'utf8'), 'preserved');
  assert.equal(await readFile(join(state.root, '.release/release-manifest.json'), 'utf8'), before);
  await verifyInventory(join(state.root, '.release'));
});

test('Render finalization refuses local roots, missing authorization and mismatched commits before deletion', async t => {
  const state = await renderFixture(t);
  await assert.rejects(finalizeRender({...state, environment: {}}), /render_finalize_render_build_required/);
  await assert.rejects(finalizeRender({root: state.root, environment: state.environment}), /render_finalize_root_not_supported/);
  await assert.rejects(finalizeRender({...state, environment: {...state.environment, RENDER_GIT_COMMIT: 'b'.repeat(40)}}), /render_finalize_commit_mismatch/);
  assert.equal(await readFile(join(state.root, 'src/schema.sql'), 'utf8'), 'SELECT 1;\n');
});

test('Render finalization refuses symlinked dependencies and protected-runtime overlap', async t => {
  const state = await renderFixture(t);
  await assert.rejects(finalizeRender({...state, environment: {...state.environment, RUNTIME_DIR: join(state.root, 'assets')}}), /render_finalize_runtime_path_overlap/);
  const external = await mkdtemp(join(tmpdir(), 'lumen-render-external-'));
  t.after(() => rm(external, {recursive: true, force: true}));
  await writeFile(join(external, 'keep'), 'external');
  await rm(join(state.root, 'node_modules'), {recursive: true});
  await symlink(external, join(state.root, 'node_modules'), 'dir');
  await assert.rejects(finalizeRender(state), /render_finalize_symlink_or_external_directory/);
  assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'external');
  assert.equal(await readFile(join(state.root, 'src/schema.sql'), 'utf8'), 'SELECT 1;\n');
});

test('Render finalization validates production closure even when an incomplete package has a matching file inventory', async t => {
  const state = await renderFixture(t);
  await rm(join(state.root, '.release/node_modules/runtime'), {recursive: true});
  state.manifest.files = state.manifest.files.filter(file => !file.path.startsWith('node_modules/runtime/'));
  await writeFile(join(state.root, '.release/release-manifest.json'), JSON.stringify(state.manifest, null, 2) + '\n');
  await verifyInventory(join(state.root, '.release'));
  await assert.rejects(finalizeRender(state), /runtime_dependency_missing:runtime/);
  assert.equal(await readFile(join(state.root, 'src/schema.sql'), 'utf8'), 'SELECT 1;\n');
});

test('Render finalization preserves protected data reached through runtime/backups aliases', async t => {
  for (const kind of ['runtime', 'missing-descendant', 'backups', 'dangling']) {
    const state = await renderFixture(t);
    const alias = kind === 'backups' ? 'backups' : 'runtime';
    await rm(join(state.root, alias), {recursive: true, force: true});
    await symlink(kind === 'dangling' ? 'absent-data' : 'assets', join(state.root, alias), 'dir');
    if (kind === 'missing-descendant') state.environment.RUNTIME_DIR = join(state.root, 'runtime/not-created-yet');
    await assert.rejects(finalizeRender(state), kind === 'dangling' ? /render_finalize_protected_path_ambiguous/ : /render_finalize_runtime_path_overlap/, kind);
    assert.equal(await readFile(join(state.root, 'src/schema.sql'), 'utf8'), 'SELECT 1;\n');
    assert.equal(await readFile(join(state.root, 'assets/setup.html'), 'utf8'), 'setup.html');
  }
});


test('a fixture-only follow-up retains container checks until its exact parent verify succeeded', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-image-gate-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const before = 'a'.repeat(40), after = 'b'.repeat(40), path = join(directory, 'event.json');
  await writeFile(path, JSON.stringify({before, after}));
  const values = {GITHUB_EVENT_NAME:'push', GITHUB_EVENT_PATH:path, GITHUB_REPOSITORY:'fixture/lumen', GITHUB_API_URL:'https://github.invalid.test', GITHUB_TOKEN:'synthetic-only'};
  const original = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const key of Object.keys(values)) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } });
  const success = {id:2,name:'verify',app:{slug:'github-actions'},head_sha:before,status:'completed',conclusion:'success'};
  let checkRuns = [];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url));
    if (String(url).includes('/compare/')) return new Response(JSON.stringify({files:[{filename:'test/reminder-journey.test.ts'}]}));
    assert.ok(String(url).includes('/commits/'+before+'/check-runs?check_name=verify&filter=latest'));
    return new Response(JSON.stringify({check_runs:checkRuns}));
  });
  for (const runs of [[], [{...success,conclusion:'failure'}], [{...success,status:'in_progress',conclusion:null}], [{...success,head_sha:after}], [{...success,app:{slug:'other'}}], [success,{...success,id:3,conclusion:'failure'}]]) {
    checkRuns = runs;assert.equal(await detectRuntimeImage(), true, 'unverified latest exact-parent gate cannot inherit a container PASS');
  }
  checkRuns = [success];assert.equal(await detectRuntimeImage(), false, 'verified parent permits a fixture-only container skip');
  assert.equal(requests.length,14);
});
