import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createPhoneCopyServer, phonePage } from '../src/phone-login.js';

async function loadCopyPage(raw: string, writeText: (value: string) => Promise<void>) {
  const fields: Record<string, any> = {};
  for (const id of ['status', 'copy', 'fallback', 'manual']) {
    fields[id] = { disabled: id === 'copy' || id === 'fallback', hidden: id === 'manual', value: '', textContent: '', focus() {}, select() {} };
  }
  const script = phonePage('synthetic_nonce').match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  runInNewContext(script, {
    document: { getElementById: (id: string) => fields[id] },
    location: { hash: '#synthetic_local_key', pathname: '/' },
    history: { replaceState() {} },
    navigator: { clipboard: { writeText } },
    fetch: async () => ({ ok: true, text: async () => raw })
  });
  await new Promise<void>(done => setImmediate(done));
  return fields;
}

describe('Локальне перенесення підключення з телефона', () => {
  it('копіює повний JSON і дозволяє ручне копіювання навіть після успіху Clipboard API', async () => {
    const raw = JSON.stringify({ selected: 'synthetic_client', registrations: [{ client_id: 'synthetic_client', access_token: 'never_real_credentials' }] });
    let clipboard = '';
    const fields = await loadCopyPage(raw, async value => { clipboard = value; });
    assert.equal(fields.copy.disabled, false);
    assert.equal(fields.fallback.disabled, false);
    assert.equal(fields.manual.hidden, true);
    await fields.copy.onclick();
    assert.equal(clipboard, raw);
    fields.fallback.onclick();
    assert.equal(fields.manual.hidden, false);
    assert.equal(fields.manual.value, raw);
  });
  it('показує ручне поле, якщо Clipboard API відмовив, і відхиляє назву файла замість сесії', async () => {
    const raw = JSON.stringify({ selected: 'synthetic_client', registrations: [{ client_id: 'synthetic_client' }] });
    const fields = await loadCopyPage(raw, async () => { throw new Error('clipboard_denied'); });
    await fields.copy.onclick();
    assert.equal(fields.manual.hidden, false);
    assert.equal(fields.manual.value, raw);
    const invalid = await loadCopyPage('chatgpt-accounts.json', async () => { throw new Error('must_not_copy'); });
    assert.equal(invalid.copy.disabled, true);
    assert.equal(invalid.fallback.disabled, true);
    assert.equal(invalid.manual.value, '');
  });
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
