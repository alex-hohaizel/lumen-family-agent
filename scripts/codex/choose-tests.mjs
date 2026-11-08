#!/usr/bin/env node
// Advisory only: recommends suites from changed paths. Not dependency coverage proof.
import {execFileSync} from 'node:child_process';
const git=(...args)=>{try{return execFileSync('git',args,{encoding:'utf8'}).trim().split('\n').filter(Boolean)}catch{return []}};
const base=git('merge-base','origin/main','HEAD')[0];
const changed=new Set([
  ...(base?git('diff','--name-only',base,'HEAD'):[]),
  ...git('diff','--name-only'),
  ...git('diff','--cached','--name-only'),
  ...git('ls-files','--others','--exclude-standard'),
]);
let full=false;const suites=new Set();
for(const p of changed){
  if(/^(package(-lock)?\.json|tsconfig(?:\.test)?\.json|render\.yaml|tools\/(release|diagnostics)\/|src\/(db|schema|main|engine|registry|privacy-fence|model)\.ts|src\/schema\.sql)/.test(p)) full=true;
  else if(/^src\/(behavior|attention|conversation|personality|personalization)/.test(p)) suites.add('behavior');
  else if(/^src\/(interactions|actions|commitments|outcomes|offers|delivery|scheduling)/.test(p)) suites.add('actions');
  else if(/^src\/(media|visual|image|video|audio)/.test(p)) suites.add('media');
  else if(/^(runtime\/stickers|sticker-lab|src\/sticker)/.test(p)) suites.add('stickers');
  else if(/^src\//.test(p)||/^test\//.test(p)) full=true;
  else if(/^\.github\/workflows/.test(p)) suites.add('core');
}
console.log(`Changed paths: ${changed.size}`);
if(!changed.size) console.log('No changes detected; run core as baseline if needed.');
else if(full) console.log('High/shared/unknown impact -> npm test (full suite).');
else if(suites.size){
  console.log('Advisory targeted suites:');
  for(const s of [...suites].sort()) console.log(`  bash scripts/codex/quick-check.sh ${s}`);
  console.log('For T2/T3 run npm test; release requires the exact-SHA CI verify gate (npm run verify).');
}else console.log('Documentation/config only -> python3 scripts/codex/verify_pack.py; CI may still run core.');
console.log('This heuristic is NOT a proof of dependency coverage.');
