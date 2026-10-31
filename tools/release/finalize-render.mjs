import {lstat, readFile, readdir, readlink, realpath, rm} from 'node:fs/promises';
import {basename, dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectRoot} from './clean.mjs';
import {verifyInventory} from './package.mjs';
import {verifyProductionDependencies} from './dependencies.mjs';

// Render documents this native Node checkout root. Never infer a deletion root
// from a caller's current directory, environment variable or arbitrary CLI path.
export const nativeRenderRoot = '/opt/render/project/src';
export const renderPrunePaths = [
  'src', 'test', 'docs', 'tools', 'scripts', 'assets', 'dist', '.test-build',
  'node_modules', '.release-next', '.github', 'package.json', 'package-lock.json',
  'tsconfig.json', 'tsconfig.test.json', 'Dockerfile', '.dockerignore', 'compose.yaml',
  'render.yaml', 'start.sh', '.env.example', 'README.md', 'AGENTS.md', 'CHANGELOG.md',
];
const within = (parent, path) => path === parent || path.startsWith(parent + sep);

async function canonicalProtectedPath(path) {
  const suffix = [];
  let existing = resolve(path);
  for (;;) {
    try {
      await lstat(existing);
      // A dangling symlink must fail here; it is not a missing leaf directory.
      const canonical = await realpath(existing);
      if (!(await lstat(canonical)).isDirectory()) throw Error('render_finalize_protected_path_not_directory');
      return resolve(canonical, ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Distinguish a missing path from an existing but dangling alias.
      try {
        const entry = await lstat(existing);
        if (entry.isSymbolicLink()) throw Error('render_finalize_protected_path_ambiguous');
      } catch (check) { if (check.code !== 'ENOENT') throw check; }
      const parent = dirname(existing);
      if (parent === existing) throw Error('render_finalize_protected_path_ambiguous');
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }
}

async function nonsymlinkDirectory(path) {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== path) throw Error('render_finalize_symlink_or_external_directory');
}

async function inspectDeletionTree(root, path) {
  let entry;
  try { entry = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (entry.isSymbolicLink()) {
    // npm creates internal executable links in .bin. Unlink them during rm;
    // never recurse through them. Linked packages or external links fail closed.
    const local = relative(root, path).split(sep).join('/');
    const target = resolve(dirname(path), await readlink(path));
    if (/(?:^|\/)node_modules\/\.bin\/[^/]+$/u.test(local) && within(join(root, 'node_modules'), target)) return;
    throw Error('render_finalize_symlink_refused:' + local);
  }
  if (entry.isDirectory()) {
    for (const child of await readdir(path)) await inspectDeletionTree(root, join(path, child));
  } else if (!entry.isFile()) throw Error('render_finalize_special_file_refused');
}

/**
 * The CLI uses only nativeRenderRoot. expectedRoot/environment injection exists
 * for isolated temporary-fixture tests; the CLI accepts no override arguments.
 */
export async function finalizeRender({root = projectRoot, environment = process.env, expectedRoot = nativeRenderRoot} = {}) {
  if (environment.RENDER !== 'true' || !/^[0-9a-f]{40}$/u.test(environment.RENDER_GIT_COMMIT ?? '')) throw Error('render_finalize_render_build_required');
  root = resolve(root);
  if (root !== resolve(expectedRoot)) throw Error('render_finalize_root_not_supported');
  await nonsymlinkDirectory(root);
  const runtimeRoot = join(root, '.release');
  await nonsymlinkDirectory(runtimeRoot);
  await nonsymlinkDirectory(join(runtimeRoot, 'node_modules'));
  // In particular, refuse the shared dependency symlink used by local worktrees.
  await nonsymlinkDirectory(join(root, 'node_modules'));
  const manifest = await verifyInventory(runtimeRoot);
  if (manifest.source?.revision !== environment.RENDER_GIT_COMMIT || manifest.source?.dirty === true) throw Error('render_finalize_commit_mismatch');
  await verifyProductionDependencies(runtimeRoot);
  const protectedData = await Promise.all([
    resolve(root, environment.RUNTIME_DIR || 'runtime'), join(root, 'runtime'), join(root, 'backups'),
  ].map(canonicalProtectedPath));
  const deletions = renderPrunePaths.map(name => join(root, name));
  if (deletions.some(path => protectedData.some(data => within(path, data) || within(data, path)))) throw Error('render_finalize_runtime_path_overlap');
  // Complete every preflight before the first deletion. No root readdir/walk and
  // no traversal of runtime/backups, provider metadata or external RUNTIME_DIR.
  for (const path of deletions) await inspectDeletionTree(root, path);
  for (const path of deletions) await rm(path, {recursive: true, force: true});
  await verifyInventory(runtimeRoot);
  await verifyProductionDependencies(runtimeRoot);
  const receipt = {
    event: 'render_checkout_finalized', version: manifest.version, revision: manifest.source.revision,
    removed_paths: renderPrunePaths, package_files: manifest.files.length,
    package_bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), dependencies: manifest.dependencies.length,
    stickers: manifest.stickers.count, ordered_fingerprint: manifest.stickers.ordered_fingerprint,
  };
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw Error('render_finalize_does_not_accept_paths');
  console.log(JSON.stringify(await finalizeRender()));
}
