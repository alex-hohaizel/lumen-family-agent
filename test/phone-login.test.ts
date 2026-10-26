import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPhoneCopyServer } from '../src/phone-login.js';

describe('Локальне перенесення підключення з телефона', () => {
  it('не включає сесію в HTML і не віддає її без окремого локального ключа', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'lumen-phone-test-'));
    const path = resolve(dir, 'accounts.json');
    const synthetic = '{"synthetic_test_session":"never_real_credentials"}';
    await writeFile(path, synthetic);
    const ui = await createPhoneCopyServer(path);
    try {
      const url = new URL(ui.url);
      const key = url.hash.slice(1);
      assert.equal(url.hostname, '127.0.0.1');
      const html = await fetch(url.origin);
      assert.equal(html.status, 200);
      assert.equal(html.headers.get('cache-control'), 'no-store');
      assert.match(html.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
      assert.ok(!(await html.text()).includes(synthetic));
      assert.equal((await fetch(`${url.origin}/credentials`)).status, 403);
      assert.equal((await fetch(`${url.origin}/credentials`, {headers:{Authorization:'Bearer wrong'}})).status, 403);
      const authorized = await fetch(`${url.origin}/credentials`, {headers:{Authorization:`Bearer ${key}`}});
      assert.equal(authorized.status, 200);
      assert.equal(await authorized.text(), synthetic);
      assert.equal((await fetch(`${url.origin}/credentials`, {headers:{Authorization:`Bearer ${key}`,Origin:'https://other.invalid'}})).status, 403);
      assert.equal((await fetch(`${url.origin}/credentials`, {method:'POST',headers:{Authorization:`Bearer ${key}`}})).status, 405);
    } finally { await ui.close(); await rm(dir,{recursive:true,force:true}); }
  });
  it('не маскує відсутній файл під успішне перенесення', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'lumen-phone-missing-'));
    const ui = await createPhoneCopyServer(resolve(dir, 'missing.json'));
    try {
      const url = new URL(ui.url);
      const res = await fetch(`${url.origin}/credentials`,{headers:{Authorization:`Bearer ${url.hash.slice(1)}`}});
      assert.equal(res.status, 503);
      assert.match(await res.text(), /недоступне/);
    } finally { await ui.close(); await rm(dir,{recursive:true,force:true}); }
  });
});
