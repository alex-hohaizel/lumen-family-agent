import {spawnSync} from 'node:child_process';
import {readFile, realpath} from 'node:fs/promises';
import {basename, dirname, join, sep} from 'node:path';

async function localPackage(root, directory, name) {
  if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu.test(name)) throw Error('runtime_dependency_name_invalid');
  while (directory === root || directory.startsWith(root + sep)) {
    if (basename(directory) !== 'node_modules') {
      try {
        const path = await realpath(join(directory, 'node_modules', name, 'package.json'));
        if (!path.startsWith(root + sep + 'node_modules' + sep)) throw Error('runtime_dependency_escaped_package');
        return path;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    directory = dirname(directory);
  }
  throw Error('runtime_dependency_missing:' + name);
}

/** Read-only metadata/version/closure checks, without browser work or tests. */
export async function verifyProductionDependencies(root) {
  root = await realpath(root);
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8'));
  for (const name of Object.keys(metadata.dependencies)) await localPackage(root, root, name);
  for (const dependency of manifest.dependencies) {
    const path = join(root, dependency.path, 'package.json');
    const pkg = JSON.parse(await readFile(path, 'utf8'));
    if (pkg.version !== dependency.version) throw Error('runtime_dependency_version_invalid:' + dependency.path);
    const required = new Set([
      ...Object.keys(pkg.dependencies ?? {}).filter(name => !Object.hasOwn(pkg.optionalDependencies ?? {}, name)),
      ...Object.keys(pkg.peerDependencies ?? {}).filter(name => pkg.peerDependenciesMeta?.[name]?.optional !== true),
    ]);
    for (const name of required) await localPackage(root, dirname(path), name);
  }
  const tree = spawnSync('npm', ['ls', '--omit=dev', '--all', '--json'], {cwd: root, timeout: 30000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
  if (tree.status !== 0) throw Error('runtime_dependency_tree_invalid:' + String(tree.error ?? (tree.stdout || tree.stderr)).slice(-3000));
  return {dependencies: manifest.dependencies.length};
}
