import { describe,it,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,stat,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn,type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPair,exportJWK,SignJWT,createLocalJWKSet } from 'jose';
import { ChatGPTAuth,hostId,verifyIdentity,type Credential } from '../src/auth.js';

describe('Захищені облікові дані',()=>{
  let dir:string;before(async()=>{dir=await mkdtemp(join(tmpdir(),'lumen-credentials-test-'));});
  const record:Credential={client_id:'test-client',issuer:'https://auth.openai.com',subject:'test-sub',id_token:'test-id',access_token:'expired-access',refresh_token:'old-refresh',scopes:['resource.invoke','chatgpt.tokens.use.direct','offline_access'],expires_at:1,saved_at:new Date().toISOString()};
  it('ідентифікатор хоста стабільний у межах хоста й різний на іншому',async()=>{const first=await hostId(dir);assert.equal(await hostId(dir),first);assert.match(first,/^urn:uuid:/);assert.notEqual(await hostId(await mkdtemp(join(tmpdir(),'lumen-other-host-'))),first);});
  it('записує credentials атомарно з правами лише власнику',async()=>{const auth=new ChatGPTAuth(dir);await auth.save(record);assert.equal((await stat(join(dir,'accounts.json'))).mode & 0o777,0o600);assert.equal((await auth.selected()).subject,'test-sub');});
  it('одночасні запити запускають лише одну ротацію refresh_token',async()=>{
    let calls=0;const auth=new ChatGPTAuth(dir,(async(_url:any,init:any)=>{calls++;assert.equal(new URLSearchParams(init.body).get('client_id'),'test-client');return Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});}) as typeof fetch);await auth.save(record);
    const tokens=await Promise.all([auth.accessToken(),auth.accessToken(),auth.accessToken()]);assert.deepEqual(tokens,['new-access','new-access','new-access']);assert.equal(calls,1);assert.equal((await auth.selected()).refresh_token,'new-refresh');
  });
  it('invalid_grant потребує повторного входу, а не прихованого API fallback',async()=>{const auth=new ChatGPTAuth(dir,(async()=>Response.json({error:'invalid_grant'},{status:400})) as typeof fetch);await auth.save(record);await assert.rejects(()=>auth.accessToken(),/reauth_required/);});
  it('перемикання акаунта не змішує токени й видані client_id',async()=>{const auth=new ChatGPTAuth(dir);await auth.save(record);await auth.save({...record,client_id:'second-client',subject:'second-sub',access_token:'second-token'});await auth.select(record.client_id);assert.equal((await auth.selected()).access_token,record.access_token);await assert.rejects(()=>auth.select('unknown'),/unknown_account/);assert.equal((await auth.selected()).client_id,record.client_id);});
  it('вихід відкликає session і стирає токени, зберігаючи client mapping для повторного входу',async()=>{
    const auth=new ChatGPTAuth(dir,(async(url:any)=>String(url).includes('openid-configuration')?Response.json({revocation_endpoint:'https://auth.openai.com/revoke'}):new Response(null,{status:200})) as typeof fetch);await auth.save(record);await auth.logout();const data=await auth.accounts();assert.equal(data.selected,'');const saved=data.registrations.find(x=>x.client_id===record.client_id)!;assert.equal(saved.access_token,'');assert.equal(saved.refresh_token,'');assert.equal(saved.id_token,'');assert.equal(saved.subject,record.subject);
  });
  it('перевіряє підпис, issuer, audience, nonce та незмінність identity',async()=>{
    const {privateKey,publicKey}=await generateKeyPair('RS256');const jwk=await exportJWK(publicKey);jwk.kid='test-key';const jwks=createLocalJWKSet({keys:[jwk]});
    const sign=(overrides:any={})=>new SignJWT({nonce:'right',...overrides}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer('https://auth.openai.com').setAudience('test-client').setSubject('test-sub').setIssuedAt().setExpirationTime('2m').sign(privateKey);
    const good=await sign();assert.equal((await verifyIdentity(good,'test-client','right',jwks)).sub,'test-sub');await assert.rejects(()=>verifyIdentity(good,'wrong-client','right',jwks));await assert.rejects(()=>verifyIdentity(good,'test-client','wrong',jwks),/nonce_mismatch/);
    await assert.rejects(()=>verifyIdentity(good,'test-client','right',jwks,{...record,subject:'different'}),/identity_mismatch/);
    const wrongIssuer=await new SignJWT({nonce:'right'}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer('https://other.invalid').setAudience('test-client').setSubject('test-sub').setIssuedAt().setExpirationTime('2m').sign(privateKey);await assert.rejects(()=>verifyIdentity(wrongIssuer,'test-client','right',jwks));
    const attacker=await generateKeyPair('RS256');const forged=await new SignJWT({nonce:'right'}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer('https://auth.openai.com').setAudience('test-client').setSubject('test-sub').setIssuedAt().setExpirationTime('2m').sign(attacker.privateKey);await assert.rejects(()=>verifyIdentity(forged,'test-client','right',jwks));
  });
});
describe('Справжній локальний майстер підключення',()=>{
  let child:ChildProcess;let secret:string;let runtime:string;
  before(async()=>{
    runtime=await mkdtemp(join(tmpdir(),'lumen-setup-test-'));
    child=spawn(process.execPath,['dist/src/setup.js'],{cwd:process.cwd(),env:{...process.env,RUNTIME_DIR:runtime,TELEGRAM_BOT_TOKEN:'',OPENAI_API_KEY:'',DATABASE_URL:'',OWNER_TELEGRAM_ID:'',AUTH_MODE:'chatgpt',OPENAI_MODEL:''},stdio:['ignore','pipe','pipe']});
    secret=await new Promise<string>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('setup startup timeout')),10000);child.stdout!.on('data',data=>{output+=data;const match=/http:\/\/127\.0\.0\.1:8787\/#([\w-]+)/.exec(output);if(match){clearTimeout(timer);resolve(match[1]!);}});child.once('exit',()=>{clearTimeout(timer);reject(Error('setup exited'));});});
  });
  after(async()=>{if(child && child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}});
  const api=(method:string,path:string,key=secret,origin='http://127.0.0.1:8787',body?:unknown)=>fetch(`http://127.0.0.1:8787${path}`,{method,headers:{'X-Lumen-Setup':key,Origin:origin,'Content-Type':'application/json'},body:method==='POST'?JSON.stringify(body || {}):undefined});
  it('віддає справжню сторінку без зовнішніх скриптів і без секретів',async()=>{const res=await fetch('http://127.0.0.1:8787/');const html=await res.text();assert.equal(res.status,200);assert.match(html,/Це <span>Люмен/);assert.ok(!html.includes(secret));assert.match(res.headers.get('content-security-policy')!,/frame-ancestors 'none'/);});
  it('віддає плавне відео майстра як MP4 з правильними заголовками',async()=>{const res=await fetch('http://127.0.0.1:8787/assets/lumen-idle.mp4');const bytes=Buffer.from(await res.arrayBuffer());assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'video/mp4');assert.equal(Number(res.headers.get('content-length')),bytes.length);assert.equal(bytes.subarray(4,8).toString(),'ftyp');});
  it('не віддає налаштування без одноразового локального ключа',async()=>{assert.equal((await api('GET','/api/status','wrong')).status,403);assert.equal((await api('GET','/api/status')).status,200);});
  it('блокує POST з іншого Origin навіть зі справжнім локальним ключем',async()=>{assert.equal((await api('POST','/api/save',secret,'https://other.invalid')).status,403);});
  it('зберігає налаштування з обмеженими правами й не повертає секрет',async()=>{const res=await api('POST','/api/save',secret,undefined,{authMode:'api',apiKey:'FAKE_TEST_ONLY',ownerId:'11'});assert.equal(res.status,200);const status=JSON.stringify(await (await api('GET','/api/status')).json());assert.ok(!status.includes('FAKE_TEST_ONLY'));assert.equal((await stat(join(runtime,'config.json'))).mode & 0o777,0o600);assert.match(await readFile(join(runtime,'config.json'),'utf8'),/FAKE_TEST_ONLY/);});
  it('не позначає запуск готовим без Telegram і успішної відповіді моделі',async()=>{const res=await api('POST','/api/finish');assert.equal(res.status,400);await assert.rejects(()=>stat(join(runtime,'setup-complete')));});
});
