import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile, realpath} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from './clean.mjs';
import {verifyInventory} from './package.mjs';
import {verifyProductionDependencies} from './dependencies.mjs';

// This process is evaluated from the runtime root. It never imports modules from
// the checkout's dist, assets or node_modules. Assert resolution before imports
// so a missing dependency cannot be hidden by Node's ancestor-directory search.
const runtimeSmoke = String.raw`
import assert from 'node:assert/strict';
import {readFile, realpath} from 'node:fs/promises';
import {dirname, join, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const root = await realpath(process.cwd());
const manifest = JSON.parse(await readFile('release-manifest.json', 'utf8'));
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const assertLocal = async path => assert.ok((await realpath(path)).startsWith(root + sep + 'node_modules' + sep), 'dependency escaped runtime package: ' + path);
for (const name of Object.keys(metadata.dependencies)) await assertLocal(fileURLToPath(import.meta.resolve(name)));
async function localDependency(directory, name) {
  // Some valid dependencies export only subpaths or type definitions. Resolve
  // their package root rather than inventing a root JavaScript entry point.
  while (directory === root || directory.startsWith(root + sep)) {
    try { await assertLocal(join(directory, 'node_modules', name, 'package.json')); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    directory = dirname(directory);
  }
  throw Error('dependency missing from runtime package: ' + name);
}
for (const dependency of manifest.dependencies) {
  const packagePath = join(root, dependency.path, 'package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  assert.equal(pkg.version, dependency.version);
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (Object.hasOwn(pkg.optionalDependencies ?? {}, name)) continue;
    await localDependency(dirname(packagePath), name);
  }
}
for (const name of Object.keys(metadata.dependencies)) await import(name);
const module = name => import(pathToFileURL(join(root, 'dist/src', name)));
const {RELEASE} = await module('release.js');
assert.equal(RELEASE, metadata.version, 'compiled release version differs from package metadata');
const {stickerAssets} = await module('sticker-pack.js');
const {assertJointStickerAssets} = await module('joint-startup.js');
const assets = await stickerAssets();
assertJointStickerAssets(assets);
assert.equal(assets.length, 120);
const {default: sharp} = await import('sharp');
const png = await sharp({create: {width: 4, height: 4, channels: 4, background: '#3388cc'}}).png().toBuffer();
assert.equal((await sharp(png).metadata()).width, 4);
const {default: ffmpeg} = await import('ffmpeg-static');
const ffmpegVersion = spawnSync(ffmpeg, ['-version'], {timeout: 10000, encoding: 'utf8'});
assert.equal(ffmpegVersion.status, 0, String(ffmpegVersion.error ?? ffmpegVersion.stderr));
const {wordDocument} = await module('office.js');
const {browsers} = await module('browser.js');
const {sampleMemory} = await module('resource-memory.js');
const constrained = process.env.LUMEN_VERIFY_RESOURCE_LIMITS === 'true';
let beforeMemory, cpuRatio;
if (constrained) {
  beforeMemory = await sampleMemory();
  assert.equal(beforeMemory.source, 'cgroup_v2', 'resource smoke needs actual cgroup accounting');
  assert.equal(beforeMemory.limit_bytes, 512 * 1024 * 1024, 'resource smoke must enforce512MiB');
  const [quota, period] = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(/\s+/).map(Number);
  cpuRatio = quota / period;
  assert.ok(Number.isFinite(cpuRatio) && Math.abs(cpuRatio - 0.5) < 0.000001, 'resource smoke must enforce0.5CPU');
  assert.notEqual(beforeMemory.oom_kill_count, null, 'OOM observation must be available');
}
try {
  const bytes = await browsers.docxPDF(wordDocument('Перевірка пакета', ['Файл 31415 — українською.']));
  const {PDFDocument} = await import('pdf-lib');
  assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 1);
  console.log(JSON.stringify({event: 'runtime_package_smoke_passed', version: metadata.version, stickers: assets.length, png_bytes: png.length, docx_pdf_bytes: bytes.length, ffmpeg: true}));
  if (constrained) {
    const afterMemory = await sampleMemory();
    assert.equal(afterMemory.oom_kill_count, beforeMemory.oom_kill_count, 'resource smoke caused OOM kill');
    assert.ok(afterMemory.current_bytes < afterMemory.limit_bytes, 'resource smoke exceeded memory budget');
    const peak = Number((await readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim());
    assert.ok(Number.isSafeInteger(peak) && peak > 0 && peak <= afterMemory.limit_bytes, 'invalid container peak');
    console.log(JSON.stringify({event:'runtime_resource_smoke_passed', memory_limit_bytes:afterMemory.limit_bytes, cpu_quota:cpuRatio, peak_bytes:peak, oom_kill_delta:afterMemory.oom_kill_count-beforeMemory.oom_kill_count, scope:'bounded standalone package DOCX/PDF/PNG smoke; no database, real chats or capacity certification'}));
  }

} finally { await browsers.close(); }
`;

export async function verifyRuntime(root = join(projectRoot, '.release')) {
  root = await realpath(root);
  const manifest = await verifyInventory(root);
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.version, manifest.version);
  const expectedRevision = process.env.RENDER_GIT_COMMIT || process.env.GITHUB_SHA;
  if (expectedRevision) assert.equal(manifest.source.revision, expectedRevision, 'runtime package belongs to another commit');
  await verifyProductionDependencies(root);
  const smoke = spawnSync(process.execPath, ['--input-type=module', '-e', runtimeSmoke], {cwd: root, timeout: 120000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
  if (smoke.status !== 0) throw Error('runtime_package_smoke_failed:' + String(smoke.error ?? smoke.stderr).slice(-5000));
  console.log(smoke.stdout.trim());
  console.log(JSON.stringify({event: 'runtime_package_verified', version: manifest.version, files: manifest.files.length, dependencies: manifest.dependencies.length, ordered_fingerprint: manifest.stickers.ordered_fingerprint}));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyRuntime(process.argv[2]);
}
