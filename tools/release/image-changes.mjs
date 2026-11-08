import {appendFile, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageFiles = new Set(['package.json', 'package-lock.json']);
const nativeRuntimeSources = new Set([
  'src/chromium-runtime.ts', 'src/browser.ts', 'src/visual.ts', 'src/image-design.ts',
  'src/documents.ts', 'src/document-worker.ts', 'src/document-workshop.ts',
  'src/media-workshop.ts', 'src/media-addressed.ts', 'src/media-pdf.ts',
  'src/office.ts', 'src/compute.ts', 'src/compute-worker.ts',
]);
function withoutReleaseVersion(value) {
  const copy = structuredClone(value);
  delete copy.version;
  if (copy.packages?.['']) delete copy.packages[''].version;
  return copy;
}

/** A sticker-only release/version bump does not change the container contract. */
export function needsRuntimeImage(files, packages = {}) {
  return files.some(file => {
    if (packageFiles.has(file)) {
      const versions = packages[file];
      return !versions || JSON.stringify(withoutReleaseVersion(versions.before)) !== JSON.stringify(withoutReleaseVersion(versions.after));
    }
    return /^(?:Dockerfile|\.dockerignore|compose\.ya?ml|tsconfig(?:\.[^/]+)?\.json|\.github\/workflows\/verify\.yml)$/u.test(file) || file.startsWith('tools/release/') || file.startsWith('assets/fonts/') || nativeRuntimeSources.has(file);
  });
}

async function githubJSON(path, raw = false) {
  const response = await fetch((process.env.GITHUB_API_URL || 'https://api.github.com') + path, {
    headers: {authorization: 'Bearer ' + process.env.GITHUB_TOKEN, accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'x-github-api-version': '2022-11-28'},
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error('github_change_metadata_unavailable');
  return response.json();
}

export async function detectRuntimeImage() {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') return true;
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const before = event.pull_request?.base?.sha || event.before;
  const after = event.pull_request?.head?.sha || event.after;
  if (!before || !after || /^0+$/u.test(before)) return true;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? '') || !/^[0-9a-f]{40}$/u.test(before) || !/^[0-9a-f]{40}$/u.test(after)) return true;
  const comparison = await githubJSON(`/repos/${repository}/compare/${before}...${after}`);
  // GitHub limits comparison file lists to 300. A truncated list must not skip
  // the image gate, and a missing file list is not evidence of no changes.
  if (!Array.isArray(comparison.files) || comparison.files.length >= 300) return true;
  const files = comparison.files.flatMap(file => file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]);
  const packages = {};
  for (const file of files.filter(file => packageFiles.has(file))) {
    packages[file] = {
      before: await githubJSON(`/repos/${repository}/contents/${file}?ref=${before}`, true),
      after: await githubJSON(`/repos/${repository}/contents/${file}?ref=${after}`, true),
    };
  }
  if (needsRuntimeImage(files, packages)) return true;
  // A fixture-only follow-up can sit on an unverified runtime change. Skip
  // container checks only when the exact parent has a successful required gate.
  const checks = await githubJSON(`/repos/${repository}/commits/${before}/check-runs?check_name=verify&filter=latest&per_page=100`);
  const latest = Array.isArray(checks.check_runs) ? checks.check_runs
    .filter(run => run.name === 'verify' && run.app?.slug === 'github-actions' && run.head_sha === before && Number.isSafeInteger(run.id))
    .sort((left, right) => right.id - left.id)[0] : undefined;
  return latest?.status !== 'completed' || latest.conclusion !== 'success';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let required = true;
  try { required = await detectRuntimeImage(); }
  catch { console.log('Change metadata unavailable; retaining the container gate.'); }
  await appendFile(process.env.GITHUB_OUTPUT, 'required=' + required + '\n');
  console.log('Container verification required: ' + required);
}
