import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

it('probe завершується при справжньому запуску CLI без циклу імпортів', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'lumen-auth-cli-'));
  try {
    const preload = resolve(dir, 'synthetic-fetch.mjs');
    await writeFile(preload, `globalThis.fetch = async (url) => {
      if (url !== 'https://api.openai.com/v1/responses') throw new Error('unexpected_network');
      const events = [
        {type:'response.output_text.delta',delta:'synthetic_probe_completed'},
        {type:'response.completed',response:{output:[]}}
      ];
      return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\\n\\n').join(''), {
        status:200,headers:{'Content-Type':'text/event-stream'}
      });
    };`);
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      '--import', preload, resolve('dist/src/auth.js'), 'probe'
    ], { timeout: 5000, env: { ...process.env, RUNTIME_DIR: dir, AUTH_MODE: 'api', OPENAI_MODEL: 'synthetic_model', OPENAI_API_KEY: 'synthetic_not_real' } });
    assert.match(stdout, /synthetic_probe_completed/);
    assert.doesNotMatch(stderr, /unsettled top-level await/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
