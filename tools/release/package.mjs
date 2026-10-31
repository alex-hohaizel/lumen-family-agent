import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {constants} from 'node:fs';
import {access, copyFile, lstat, mkdir, readFile, readdir, rename, stat, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {cleanOutput, projectRoot} from './clean.mjs';

export const runtimeAssets = [
  'fonts/DejaVuSans.ttf', 'fonts/DejaVu-LICENSE.txt', 'setup.html', 'lumen.png',
  'lumen-idle.gif', 'lumen-idle.mp4', 'lumen-happy.mp4', 'lumen-thinking.mp4',
  'lumen-waving.mp4', 'lumen-avatar.mp4',
];
export const stickerFields = ['id', 'emoji', 'telegram_emoji', 'label', 'description', 'scene', 'file', 'bytes', 'sha256'];
const runtimeCommands = {
  start: 'main.js', setup: 'setup.js', login: 'auth.js login', models: 'auth.js models',
  probe: 'auth.js probe', logout: 'auth.js logout', doctor: 'doctor.js', smoke: 'smoke.js',
  profile: 'profile.js', ingress: 'transport-repair.js', diagnostics: 'main.js --diagnostics',
};
export const requiredModules = [...new Set(Object.values(runtimeCommands).map(command => command.split(' ')[0]))];

export function safeRelative(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..') || path.startsWith('/')) {
    throw Error('release_path_invalid');
  }
  return path;
}

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inventory(root, skip = new Set()) {
  const files = [];
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = prefix + entry.name;
      if (skip.has(path)) continue;
      if (entry.isSymbolicLink()) throw Error(`release_symlink_forbidden:${path}`);
      if (entry.isDirectory()) await walk(join(directory, entry.name), path + '/');
      else if (entry.isFile()) {
        const absolute = join(directory, entry.name), metadata = await stat(absolute);
        files.push({path, bytes: metadata.size, mode: metadata.mode & 0o777, sha256: await sha256(absolute)});
      } else throw Error(`release_file_type_unsupported:${path}`);
    }
  }
  await walk(root);
  return files;
}

async function copy(source, destination) {
  const metadata = await lstat(source);
  if (!metadata.isFile()) throw Error(`release_source_not_file:${source}`);
  await mkdir(dirname(destination), {recursive: true});
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
}

async function copyDependency(source, destination) {
  const metadata = await lstat(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error('release_linked_dependency_unsupported');
  await mkdir(destination, {recursive: true});
  for (const entry of await readdir(source, {withFileTypes: true})) {
    // The lockfile separately selects nested production dependencies. Copying a
    // whole subtree could accidentally retain a nested dev dependency.
    if (entry.name === 'node_modules') continue;
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) await copyDependency(from, to);
    else await copy(from, to);
  }
}

function sourceRevision(root) {
  const supplied = process.env.RENDER_GIT_COMMIT || process.env.GITHUB_SHA || process.env.LUMEN_BUILD_REVISION;
  if (supplied) return {revision: supplied};
  try {
    return {
      revision: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(),
      dirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim()),
    };
  } catch { return {revision: null}; }
}

export function runtimePackage(metadata) {
  return {
    name: metadata.name, version: metadata.version, private: true, description: metadata.description,
    type: 'module', engines: metadata.engines, dependencies: metadata.dependencies,
    scripts: Object.fromEntries(Object.entries(runtimeCommands).map(([name, command]) => [name, 'node --env-file-if-exists=.env dist/src/' + command])),
  };
}

/** Copies only a runtime dependency closure; never installs/prunes the checkout. */
export async function packageRelease(root = projectRoot) {
  root = resolve(root);
  const output = join(root, '.release'), staging = join(root, '.release-next');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  if (lock.lockfileVersion !== 3 || lock.version !== metadata.version || lock.packages?.['']?.version !== metadata.version || JSON.stringify(lock.packages[''].dependencies) !== JSON.stringify(metadata.dependencies)) throw Error('release_lockfile_mismatch');
  await cleanOutput(root, '.release-next');
  await mkdir(staging);
  try {
    const modules = await inventory(join(root, 'dist/src'));
    if (modules.some(file => !file.path.endsWith('.js'))) throw Error('release_build_contains_non_javascript');
    const sources = await inventory(join(root, 'src'));
    const applicationModules = sources.filter(file => file.path.endsWith('.ts') && !file.path.endsWith('.d.ts')).map(file => file.path.slice(0, -3) + '.js');
    if (JSON.stringify(modules.map(file => file.path)) !== JSON.stringify(applicationModules)) throw Error('release_build_source_mismatch');
    const schemas = sources.filter(file => file.path.endsWith('.sql')).map(file => file.path);
    if (!schemas.includes('schema.sql')) throw Error('release_schema_missing');
    for (const entry of requiredModules) if (!modules.some(file => file.path === entry)) throw Error(`release_module_missing:${entry}`);
    for (const file of modules) await copy(join(root, 'dist/src', file.path), join(staging, 'dist/src', file.path));
    for (const name of schemas) await copy(join(root, 'src', name), join(staging, 'src', name));
    for (const name of runtimeAssets) await copy(join(root, 'assets', name), join(staging, 'assets', name));
    await copy(join(root, 'LICENSE'), join(staging, 'LICENSE'));

    const assets = JSON.parse(await readFile(join(root, 'assets/stickers/manifest.json'), 'utf8'));
    if (!Array.isArray(assets) || assets.length !== 120 || new Set(assets.map(asset => asset.id)).size !== 120 || new Set(assets.map(asset => asset.sha256)).size !== 120) throw Error('release_sticker_set_incomplete');
    const orderedFingerprint = createHash('sha256').update(JSON.stringify(assets.map(asset => [asset.id, asset.sha256]))).digest('hex');
    const startup = await readFile(join(root, 'dist/src/joint-startup.js'), 'utf8');
    const approvedFingerprint = startup.match(/JOINT_STICKER_FINGERPRINT\s*=\s*['"]([0-9a-f]{64})['"]/u)?.[1];
    if (orderedFingerprint !== approvedFingerprint) throw Error('release_sticker_set_unapproved');
    const stickers = [];
    for (const asset of assets) {
      if (!/^lumen_\d+\.webm$/u.test(asset.file) || asset.id !== asset.file.slice(0, -5) || !/^[0-9a-f]{64}$/u.test(asset.sha256) || !Number.isInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 256 * 1024) throw Error('release_sticker_entry_invalid');
      const source = join(root, 'assets/stickers', asset.file);
      if ((await stat(source)).size !== asset.bytes || await sha256(source) !== asset.sha256) throw Error(`release_sticker_integrity:${asset.id}`);
      await copy(source, join(staging, 'assets/stickers', asset.file));
      stickers.push(Object.fromEntries(stickerFields.filter(key => Object.hasOwn(asset, key)).map(key => [key, asset[key]])));
    }
    await writeFile(join(staging, 'assets/stickers/manifest.json'), JSON.stringify(stickers, null, 2) + '\n');
    await writeFile(join(staging, 'package.json'), JSON.stringify(runtimePackage(metadata), null, 2) + '\n');

    const dependencies = [];
    for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      if (!path || entry.dev === true) continue;
      safeRelative(path);
      if (!path.startsWith('node_modules/') || entry.link) throw Error('release_lockfile_path_unsupported');
      try { await access(join(root, path, 'package.json')); }
      catch (error) {
        if (entry.optional && error.code === 'ENOENT') continue;
        throw Error(`release_dependency_missing:${path}`, {cause: error});
      }
      const installed = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'));
      if (installed.version !== entry.version) throw Error(`release_dependency_version:${path}`);
      await copyDependency(join(root, path), join(staging, path));
      dependencies.push({path, version: entry.version, integrity: entry.integrity ?? null});
    }
    const files = await inventory(staging);
    const manifest = {
      schema_version: 'lumen.runtime-package/1', version: metadata.version, source: sourceRevision(root),
      platform: {os: process.platform, arch: process.arch, node: process.versions.node},
      package_lock_sha256: await sha256(join(root, 'package-lock.json')),
      application_modules: applicationModules, schemas,
      stickers: {count: stickers.length, ordered_fingerprint: orderedFingerprint, ordered_ids: stickers.map(asset => asset.id)},
      dependencies, files,
    };
    await writeFile(join(staging, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    // Validate the candidate before replacing the previous owned output.
    await verifyInventory(staging);
    await cleanOutput(root, '.release');
    await rename(staging, output);
    return {root: output, manifest};
  } catch (error) {
    await cleanOutput(root, '.release-next');
    throw error;
  }
}

export async function verifyInventory(root) {
  const manifest = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8'));
  if (manifest.schema_version !== 'lumen.runtime-package/1') throw Error('release_manifest_invalid');
  const actual = await inventory(root, new Set(['release-manifest.json']));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw Error('release_inventory_mismatch');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (metadata.version !== manifest.version || metadata.devDependencies || Object.keys(metadata.scripts).some(name => /test|build|verify|package/u.test(name))) throw Error('release_package_invalid');
  const moduleFiles = manifest.application_modules.map(path => 'dist/src/' + safeRelative(path));
  const schemas = manifest.schemas.map(path => 'src/' + safeRelative(path));
  if (!schemas.includes('src/schema.sql') || moduleFiles.some(path => !path.endsWith('.js')) || schemas.some(path => !path.endsWith('.sql'))) throw Error('release_application_paths_invalid');
  const allowed = new Set(['package.json', 'LICENSE', ...schemas, ...moduleFiles, ...runtimeAssets.map(name => 'assets/' + name), 'assets/stickers/manifest.json']);
  const assets = JSON.parse(await readFile(join(root, 'assets/stickers/manifest.json'), 'utf8'));
  const fingerprint = createHash('sha256').update(JSON.stringify(assets.map(asset => [asset.id, asset.sha256]))).digest('hex');
  if (assets.length !== 120 || fingerprint !== manifest.stickers.ordered_fingerprint || JSON.stringify(assets.map(asset => asset.id)) !== JSON.stringify(manifest.stickers.ordered_ids)) throw Error('release_sticker_manifest_invalid');
  for (const asset of assets) {
    if (!/^lumen_\d+\.webm$/u.test(asset.file) || Object.keys(asset).some(key => !stickerFields.includes(key))) throw Error('release_sticker_metadata_invalid');
    const path = 'assets/stickers/' + asset.file, file = actual.find(entry => entry.path === path);
    if (!file || file.sha256 !== asset.sha256 || file.bytes !== asset.bytes) throw Error(`release_sticker_integrity:${asset.id}`);
    allowed.add(path);
  }
  const dependencyRoots = new Set(manifest.dependencies.map(entry => safeRelative(entry.path)));
  for (const file of actual) {
    const dependencyRoot = file.path.match(/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*/u)?.[0];
    if (!allowed.has(file.path) && (!dependencyRoot || !dependencyRoots.has(dependencyRoot))) throw Error(`release_unapproved_file:${file.path}`);
  }
  for (const required of allowed) if (!actual.some(file => file.path === required)) throw Error(`release_required_file_missing:${required}`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {manifest} = await packageRelease();
  console.log(JSON.stringify({event: 'runtime_package_created', version: manifest.version, files: manifest.files.length, bytes: manifest.files.reduce((sum, entry) => sum + entry.bytes, 0), stickers: manifest.stickers.count, dependencies: manifest.dependencies.length}));
}
