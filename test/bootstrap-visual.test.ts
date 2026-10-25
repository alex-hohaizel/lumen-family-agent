import { describe,it,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCredentials } from '../src/bootstrap.js';
import { ConfigSchema } from '../src/config.js';
import { TestDB,harness,paired,message } from './helpers.js';
import { Delivery } from '../src/delivery.js';
import { Telegram } from '../src/telegram.js';
import { one } from '../src/db.js';
const account={selected:'issued-test',registrations:[{client_id:'issued-test',issuer:'https://auth.openai.com',subject:'test-subject',id_token:'test-id',access_token:'test-access',refresh_token:'test-refresh',scopes:['resource.invoke','chatgpt.tokens.use.direct'],expires_at:1000,saved_at:new Date().toISOString()}]};
describe('Постійні credentials у Render',()=>{
  it('імпортує лише у порожній runtime з правами 0600',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'lumen-seed-'));const env={CHATGPT_ACCOUNTS_B64:Buffer.from(JSON.stringify(account)).toString('base64')};
    assert.equal(await prepareCredentials(ConfigSchema.parse({runtimeDir:dir}),env),true);assert.equal((await stat(join(dir,'accounts.json'))).mode&0o777,0o600);assert.equal(env.CHATGPT_ACCOUNTS_B64,undefined);
  });
  it('повторний deploy не перезаписує вже оновлений refresh token старим seed',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'lumen-seed-'));const current={...account,registrations:[{...account.registrations[0],refresh_token:'new-rotating-token'}]};await writeFile(join(dir,'accounts.json'),JSON.stringify(current),{mode:0o600});
    assert.equal(await prepareCredentials(ConfigSchema.parse({runtimeDir:dir}),{CHATGPT_ACCOUNTS_B64:Buffer.from(JSON.stringify(account)).toString('base64')}),false);assert.equal(JSON.parse(await readFile(join(dir,'accounts.json'),'utf8')).registrations[0].refresh_token,'new-rotating-token');
  });
  it('не імпортує identity без дозволу використання моделей',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'lumen-seed-'));const denied={...account,registrations:[{...account.registrations[0],scopes:['openid']}]};await assert.rejects(()=>prepareCredentials(ConfigSchema.parse({runtimeDir:dir}),{CHATGPT_ACCOUNTS_B64:Buffer.from(JSON.stringify(denied)).toString('base64')}),/credential_seed_invalid/);
  });
});
describe('Оригінальні анімовані реакції',()=>{
  const db=new TestDB();let h:ReturnType<typeof harness>;
  before(async()=>{await db.init();});after(async()=>{await db.close();});beforeEach(async()=>{await db.reset();h=harness(db);await paired(h);});
  it('явна команда ставить лише дозволену анімацію та доставляє файл',async()=>{
    await h.lumen.receive(message('/mood happy'));const row=await one(db,'SELECT * FROM outbox');assert.equal(row!.kind,'animation');assert.equal(row!.body.asset,'happy');await new Delivery(db,h.tg as unknown as Telegram,h.config).next();assert.equal((await one(db,'SELECT status FROM outbox'))!.status,'sent');
  });
  it('не дозволяє читання довільного файлу через ім’я анімації',async()=>{
    await db.query("INSERT INTO outbox(dedup_key,kind,body,revision) VALUES ('bad','animation',$1,0)",[JSON.stringify({asset:'../../runtime/config'})]);await new Delivery(db,h.tg as unknown as Telegram,h.config).next();assert.equal(h.tg.sent.length,0);assert.equal((await one(db,'SELECT status FROM outbox'))!.status,'failed');
  });
  it('пауза прибирає недоставлену візуальну реакцію',async()=>{
    await h.lumen.receive(message('/mood thinking'));await h.lumen.receive(message('/pause'));await new Delivery(db,h.tg as unknown as Telegram,h.config).next();assert.ok(h.tg.sent.every(x=>x.text.includes('Пам’ять на паузі')));
  });
});
