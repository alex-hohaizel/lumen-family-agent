import {lstat, realpath, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const ownedOutputs = new Set(['dist', '.test-build', '.release', '.release-next']);

/** Never follow a checkout's output symlink or accept an arbitrary deletion path. */
export async function cleanOutput(root, name) {
  if (!ownedOutputs.has(name)) throw Error('release_output_not_owned');
  const destination = resolve(await realpath(root), name);
  try {
    const entry = await lstat(destination);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw Error('release_output_not_directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rm(destination, {recursive: true, force: true});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('usage: node tools/release/clean.mjs <owned-output>');
  await cleanOutput(projectRoot, process.argv[2]);
}
