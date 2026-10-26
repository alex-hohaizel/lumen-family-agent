import { createServer } from 'node:http';
import { readFile, mkdir, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ChatGPTAuth, ModelError, secureEqual } from './auth.js';

export const RENDER_ENV = 'https://dashboard.render.com/worker/srv-dbfl0je7bikc73dvg0qg/env';

export function phonePage(nonce: string) {
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Підключення Люмена</title><style nonce="${nonce}">
  *{box-sizing:border-box}body{margin:0;background:#f2f7f5;color:#173c37;font:17px/1.6 system-ui,sans-serif}main{max-width:600px;margin:32px auto;padding:24px}article{padding:28px;background:white;border:1px solid #d9e9e2;border-radius:24px}h1{font-size:29px;line-height:1.2;margin-top:0}button,a.button{display:block;width:100%;padding:16px;margin:14px 0;border:0;border-radius:14px;background:#126d5e;color:white;font:700 17px system-ui;text-align:center;text-decoration:none;cursor:pointer}button:disabled{opacity:.5}a.button{background:#e5f1ec;color:#194e44}code{font-size:15px;overflow-wrap:anywhere}textarea{width:100%;height:200px;font-size:14px}li{margin:12px 0}.small{font-size:14px;color:#526e64}[hidden]{display:none!important}@media(max-width:420px){main{padding:14px;margin:12px auto}article{padding:20px}}
  </style></head><body><main><article><h1>Люмен підключений до ChatGPT</h1><p id="status">Готую захищене підключення…</p><button id="copy" disabled>1. Копіювати підключення</button><a class="button" href="${RENDER_ENV}" target="_blank" rel="noopener noreferrer">2. Відкрити Render</a><ol><li>У Render знайди <b>Secret Files → Add file</b>.</li><li>Назва файла: <code>chatgpt-accounts.json</code>.</li><li>Відкрий <b>View secret file</b>, у <b>Contents</b> встав скопійоване підключення. Натисни <b>Done</b>, потім <b>Save and deploy</b>.</li></ol><p>Після цього напиши в нашому чаті лише: <b>«Сесію додано в Render»</b>.</p><p class="small">Саме підключення не надсилай у чат чи групу. Телефон потрібний лише для цього одноразового входу. Залиш Termux працювати, доки не вставиш підключення в Render.</p><button id="fallback" hidden>Показати поле для ручного копіювання</button><textarea id="manual" readonly hidden aria-label="Підключення для Render"></textarea></article></main><script nonce="${nonce}">
  let session='';const key=location.hash.slice(1);history.replaceState(null,'',location.pathname);const status=document.getElementById('status');const copy=document.getElementById('copy');const fallback=document.getElementById('fallback');const manual=document.getElementById('manual');
  fetch('/credentials',{headers:{Authorization:'Bearer '+key},cache:'no-store'}).then(async r=>{if(!r.ok)throw new Error('unavailable');session=await r.text();copy.disabled=false;status.textContent='Вхід успішний. Перенеси підключення безпосередньо у свій Render.';}).catch(()=>{status.textContent='Сторінка втратила доступ. Повернись у Termux і відкрий повне видане локальне посилання ще раз.';});
  copy.onclick=async()=>{try{await navigator.clipboard.writeText(session);copy.textContent='Скопійовано ✓';status.textContent='Тепер відкрий Render і встав підключення у Secret File.';}catch{fallback.hidden=false;status.textContent='Браузер не дозволив автоматичне копіювання. Відкрий поле нижче й скопіюй текст вручну.';}};
  fallback.onclick=()=>{manual.value=session;manual.hidden=false;manual.focus();manual.select();};
  </script></body></html>`;
}

export async function createPhoneCopyServer(accountsPath: string) {
  const key = randomBytes(32).toString('base64url');
  let origin = '';
  const server = createServer(async (req, res) => {
    const nonce = randomBytes(18).toString('base64url');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    if (!origin || req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (req.url === '/') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}).end(phonePage(nonce)); return; }
    if (req.url !== '/credentials') { res.writeHead(404).end(); return; }
    if (!secureEqual(req.headers.authorization || '', `Bearer ${key}`)) { res.writeHead(403).end(); return; }
    try {
      const raw = await readFile(accountsPath, 'utf8');
      if (raw.length > 100000) throw new Error('too_large');
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'}).end(raw);
    } catch { res.writeHead(503).end('Підключення недоступне. Поверніться до Termux.'); }
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('phone_ui_unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  return { url: `${origin}/#${key}`, close: () => new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done())) };
}

function openPhoneBrowser(url: string) {
  execFile('termux-open-url', [url], {timeout:15000}, error => {
    if (error) console.log('Якщо браузер не відкрився, відкрийте повне посилання з термінала на цьому самому телефоні.');
  });
}

export async function runPhoneLogin() {
  const dir = resolve(homedir(), 'lumen-phone-login', 'runtime');
  await mkdir(dir, {recursive:true, mode:0o700});
  const auth = new ChatGPTAuth(dir);
  const exists = await access(resolve(dir, 'accounts.json')).then(() => true, () => false);
  if (!exists) {
    console.log('Відкриваю особистий вхід ChatGPT. Залиште Termux працювати.');
    await auth.login(false, url => { console.log(`Відкрийте на цьому телефоні:\n${url}`); openPhoneBrowser(url); });
  }
  const selected = await auth.selected();
  if (!selected.scopes.includes('chatgpt.tokens.use.direct') || !selected.scopes.includes('resource.invoke')) throw new ModelError('chatgpt_plan_permission_missing');
  const ui = await createPhoneCopyServer(resolve(dir, 'accounts.json'));
  console.log(`Вхід завершено. Відкриваю кнопки перенесення в Render:\n${ui.url}`);
  openPhoneBrowser(ui.url);
  const timer = setTimeout(() => { void ui.close(); }, 30 * 60 * 1000);
  const stop = () => { clearTimeout(timer); void ui.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhoneLogin().catch(e => {
    console.error('Вхід не завершений:', e instanceof ModelError ? e.code : 'phone_login_failed');
    console.error('Не надсилайте повні посилання, паролі чи файл підключення у чат. Для діагностики достатньо коду помилки.');
    process.exitCode = 1;
  });
}
