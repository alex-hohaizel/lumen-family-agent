import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { atomicJSON, loadConfig, type Config } from './config.js';

const AUTH = 'https://auth.openai.com';
const TOKEN = `${AUTH}/api/accounts/oauth/token`;
export interface Credential {
  client_id: string; issuer: string; subject: string; email?: string;
  id_token: string; access_token: string; refresh_token: string; scopes: string[];
  expires_at: number; saved_at: string;
}
interface Accounts { selected: string; registrations: Credential[]; }
export class ModelError extends Error { constructor(public code: string) { super(code); } }
export function secureEqual(a: string, b: string) {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function callbackClient(params: URLSearchParams, pending: { state: string; clientId?: string }) {
  if (!secureEqual(params.get('state') || '', pending.state)) throw new ModelError('oauth_state_mismatch');
  if (params.get('error')) throw new ModelError('oauth_declined');
  const issued = params.get('client_id') || pending.clientId;
  if (!issued || issued === 'dynamic_agent_client') throw new ModelError('oauth_missing_client');
  if (pending.clientId && issued !== pending.clientId) throw new ModelError('oauth_client_mismatch');
  if (!params.get('code')) throw new ModelError('oauth_missing_code');
  return issued;
}
export function validateGrant(token: any) {
  const scopes = String(token.scope || '').split(/\s+/).filter(Boolean);
  if (!scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke')) throw new ModelError('chatgpt_plan_permission_missing');
  if (!token.access_token || !token.refresh_token || !token.id_token || !(Number(token.expires_in) > 0)) throw new ModelError('oauth_incomplete_token');
  if (token.token_type && token.token_type.toLowerCase() !== 'bearer') throw new ModelError('oauth_token_type');
  return scopes;
}
export async function verifyIdentity(idToken:string,clientId:string,nonce:string,jwks:JWTVerifyGetKey,previous?:Credential){
  const {payload}=await jwtVerify(idToken,jwks,{issuer:AUTH,audience:clientId,algorithms:['RS256','ES256'],requiredClaims:['sub','exp','iat']});
  if(payload.nonce!==nonce || !payload.sub)throw new ModelError('oauth_nonce_mismatch');
  if(previous && (payload.sub!==previous.subject || clientId!==previous.client_id))throw new ModelError('oauth_identity_mismatch');
  return payload;
}
export async function hostId(runtimeDir: string) {
  const path = resolve(runtimeDir, 'host.json');
  try { return JSON.parse(await readFile(path, 'utf8')).ext_agent_host_id as string; }
  catch (e: any) {
    if (e.code !== 'ENOENT') throw new ModelError('host_file_invalid');
    const value = `urn:uuid:${randomUUID()}`;
    await atomicJSON(path, { ext_agent_host_id: value }); return value;
  }
}
export class ChatGPTAuth {
  private pendingRefresh?: Promise<string>;
  constructor(private dir: string, private fetcher: typeof fetch = fetch) {}
  async accounts(): Promise<Accounts> {
    try { return JSON.parse(await readFile(resolve(this.dir,'accounts.json'),'utf8')); }
    catch (e: any) { if (e.code === 'ENOENT') return { selected:'', registrations:[] }; throw new ModelError('credentials_file_invalid'); }
  }
  async save(record: Credential) {
    const accounts = await this.accounts();
    accounts.registrations = accounts.registrations.filter(x=>x.client_id !== record.client_id);
    accounts.registrations.push(record); accounts.selected = record.client_id;
    await atomicJSON(resolve(this.dir,'accounts.json'), accounts);
  }
  async selected() {
    const data = await this.accounts();
    const selected = data.registrations.find(x=>x.client_id === data.selected);
    if (!selected) throw new ModelError('chatgpt_sign_in_required');
    return selected;
  }
  async select(clientId:string){
    const accounts=await this.accounts();if(!accounts.registrations.some(x=>x.client_id===clientId))throw new ModelError('unknown_account');
    accounts.selected=clientId;await atomicJSON(resolve(this.dir,'accounts.json'),accounts);
  }
  async accessToken() {
    const record = await this.selected();
    if (!record.scopes.includes('chatgpt.tokens.use.direct')) throw new ModelError('chatgpt_plan_permission_missing');
    if (record.expires_at > Date.now()+90000) return record.access_token;
    if (!this.pendingRefresh) this.pendingRefresh = this.refresh().finally(()=>{ this.pendingRefresh=undefined; });
    return this.pendingRefresh;
  }
  private async refresh() {
    await mkdir(this.dir,{recursive:true,mode:0o700});
    const lockPath = resolve(this.dir,'refresh.lock');
    let lock;
    try { lock = await open(lockPath,'wx',0o600); }
    catch { throw new ModelError('credential_refresh_locked'); }
    try {
      const record = await this.selected();
      if (record.expires_at > Date.now()+90000) return record.access_token;
      let response;
      try { response = await this.fetcher(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:record.client_id,refresh_token:record.refresh_token,resource:'https://api.openai.com/v1'}),signal:AbortSignal.timeout(20000)}); }
      catch { throw new ModelError('oauth_refresh_network'); }
      const token: any = await response.json();
      if (!response.ok) throw new ModelError(response.status >= 500 ? 'oauth_refresh_unavailable' : 'chatgpt_reauth_required');
      if (!token.access_token || !token.refresh_token || !(Number(token.expires_in)>0)) throw new ModelError('oauth_refresh_incomplete');
      const scopes = token.scope ? String(token.scope).split(/\s+/) : record.scopes;
      if (!scopes.includes('chatgpt.tokens.use.direct')) throw new ModelError('chatgpt_plan_permission_missing');
      await this.save({...record,access_token:token.access_token,refresh_token:token.refresh_token,scopes,expires_at:Date.now()+Number(token.expires_in)*1000,saved_at:new Date().toISOString()});
      return token.access_token as string;
    } finally { await lock.close(); await unlink(lockPath).catch(()=>{}); }
  }
  async login(newAccount = false, onUrl?: (url:string)=>void) {
    const accounts = await this.accounts();
    const previous = newAccount ? undefined : accounts.registrations.find(x=>x.client_id===accounts.selected);
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const id = await hostId(this.dir);
    let used = false;
    await new Promise<void>((done,reject)=>{
      const server = createServer(async (req,res)=>{
        if (req.method !== 'GET') { res.writeHead(405).end(); return; }
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if(url.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
        if (!secureEqual(url.searchParams.get('state') || '',state)) { res.writeHead(400).end('Invalid state'); return; }
        if(used) { res.writeHead(409).end('Already handled'); return; }
        used=true;
        try {
          const clientId=callbackClient(url.searchParams,{state,clientId:previous?.client_id});
          const response = await this.fetcher(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code:url.searchParams.get('code')!,code_verifier:verifier,redirect_uri:redirect,resource:'https://api.openai.com/v1'}),signal:AbortSignal.timeout(20000)});
          if (!response.ok) throw new ModelError('oauth_exchange_failed');
          const token: any=await response.json(); const scopes=validateGrant(token);
          const discovery=await this.fetcher(`${AUTH}/.well-known/openid-configuration`,{signal:AbortSignal.timeout(15000)});
          if (!discovery.ok) throw new ModelError('oidc_discovery_failed');
          const metadata: any=await discovery.json();
          const jwks=new URL(metadata.jwks_uri);
          if (metadata.issuer!==AUTH || jwks.origin!==AUTH || jwks.protocol!=='https:') throw new ModelError('oidc_discovery_invalid');
          const payload=await verifyIdentity(token.id_token,clientId,nonce,createRemoteJWKSet(jwks),previous);
          await this.save({client_id:clientId,issuer:AUTH,subject:payload.sub!,email:typeof payload.email==='string'?payload.email:undefined,id_token:token.id_token,access_token:token.access_token,refresh_token:token.refresh_token,scopes,expires_at:Date.now()+Number(token.expires_in)*1000,saved_at:new Date().toISOString()});
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).end('<h1>Люмен підключений ✨</h1><p>Можна закрити цю вкладку. Поверніться до налаштування бота.</p>');
          server.close(); clearTimeout(timer); done();
        } catch(e) { res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'}).end('Не вдалося підключити. Повторіть вхід.'); server.close(); clearTimeout(timer); reject(e instanceof ModelError ? e : new ModelError('oauth_validation_failed')); }
      });
      let redirect='';
      const timer=setTimeout(()=>{server.close();reject(new ModelError('oauth_timeout'));},10*60*1000);
      server.once('error',()=>{clearTimeout(timer);reject(new ModelError('oauth_callback_port_busy'));});
      server.listen(1455,process.env.SETUP_CONTAINER==='true'?'0.0.0.0':'127.0.0.1',()=>{
        redirect='http://127.0.0.1:1455/auth/callback';
        const params=new URLSearchParams({client_id:previous?.client_id || 'dynamic_agent_client',ext_agent_host_id:id,response_type:'code',redirect_uri:redirect,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource:'https://api.openai.com/v1',state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')});
        if (!previous) params.set('agent_name_hint','Lumen Telegram');
        // No id_token_hint in a printed URL. The account selector is an acceptable extra step.
        const url=`${AUTH}/api/accounts/authorize?${params}`;
        if(onUrl)onUrl(url);else console.log(`Continue with ChatGPT — відкрийте на цьому комп'ютері:\n${url}`);
      });
    });
  }
  async logout() {
    const record=await this.selected();
    const discovery=await this.fetcher(`${AUTH}/.well-known/openid-configuration`,{signal:AbortSignal.timeout(15000)});
    const meta: any=await discovery.json(); const endpoint=new URL(meta.revocation_endpoint);
    if (endpoint.origin!==AUTH) throw new ModelError('oidc_discovery_invalid');
    const response=await this.fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:record.client_id,token:record.refresh_token,token_type_hint:'refresh_token'}),signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new ModelError('remote_revocation_not_confirmed');
    const accounts=await this.accounts();
    accounts.registrations=accounts.registrations.map(x=>x.client_id===record.client_id?{...x,access_token:'',refresh_token:'',id_token:'',scopes:[],expires_at:0}:x);accounts.selected='';
    await atomicJSON(resolve(this.dir,'accounts.json'),accounts);
  }
}
export async function bearer(config: Config, auth: ChatGPTAuth) {
  if(config.authMode==='api') { if(!config.apiKey) throw new ModelError('api_key_missing'); return config.apiKey; }
  return auth.accessToken();
}
export async function models(config: Config, auth: ChatGPTAuth, fetcher: typeof fetch=fetch) {
  const token=await bearer(config,auth);
  const res=await fetcher('https://api.openai.com/v1/models',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
  if(!res.ok) throw new ModelError(`model_catalog_${res.status}`);
  const json: any=await res.json();
  if(Array.isArray(json.models)) return json.models.filter((x:any)=>x.visibility==='list').map((x:any)=>({id:String(x.slug),name:String(x.display_name)}));
  return (json.data || []).map((x:any)=>({id:String(x.id),name:String(x.id)}));
}
async function runAuthCommand() {
  try {
    const config=await loadConfig(); const auth=new ChatGPTAuth(config.runtimeDir);
    const command=process.argv[2];
    if(command==='login') { await auth.login(process.argv.includes('--new-account')); console.log('Вхід завершено. Далі: npm run models'); }
    else if(command==='models') console.log(JSON.stringify(await models(config,auth),null,2));
    else if(command==='logout') { await auth.logout(); console.log('Підключення відкликано.'); }
    else if(command==='init-host') { await hostId(config.runtimeDir); console.log('Ідентифікатор цього сервера створено.'); }
    else if(command==='probe') {
      const {OpenAIModel}=await import('./model.js');
      const answer=await new OpenAIModel(config,auth).text([{role:'user',content:'Відповідай рівно: Люмен на зв’язку.'}],'Коротка перевірка підключення.');
      console.log(answer);
    } else throw new ModelError('unknown_auth_command');
  } catch(e) { console.error(e instanceof ModelError?e.code:'auth_failed'); process.exitCode=1; }
}
// Finish module evaluation before probe imports model.js, which itself imports auth.js.
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) void runAuthCommand();
