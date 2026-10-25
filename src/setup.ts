import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadConfig, atomicJSON, ConfigSchema } from './config.js';
import { ChatGPTAuth, models, secureEqual } from './auth.js';
import { Telegram } from './telegram.js';
import { OpenAIModel } from './model.js';
import { errorCode } from './engine.js';

const port=8787;const origin=`http://127.0.0.1:${port}`;
const secret=randomBytes(32).toString('base64url');
let c=await loadConfig();const auth=new ChatGPTAuth(c.runtimeDir);
let loginPending=false;let loginError='';let savedBot:any;let probeOk=false;
async function save(){await atomicJSON(resolve(c.runtimeDir,'config.json'),c);}
async function body(req:import('node:http').IncomingMessage){
  let text='';for await(const chunk of req){text+=chunk.toString();if(text.length>32000)throw new Error('request_too_large');}return JSON.parse(text || '{}');
}
const server=createServer(async(req,res)=>{
  const path=new URL(req.url || '/',origin).pathname;
  const send=(status:number,data:unknown)=>res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify(data));
  if(req.headers.host!==`127.0.0.1:${port}`){res.writeHead(403).end();return;}
  const publicAssets:Record<string,string>={'/assets/lumen.png':'image/png','/assets/lumen-idle.gif':'image/gif','/assets/lumen-idle.mp4':'video/mp4'};
  if(req.method==='GET' && publicAssets[path]){
    const bytes=await readFile(new URL('../../'+path.slice(1),import.meta.url));
    res.writeHead(200,{'Content-Type':publicAssets[path],'Content-Length':bytes.length,'Cache-Control':'public,max-age=3600','X-Content-Type-Options':'nosniff'}).end(bytes);return;
  }
  if(path==='/'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'"}).end(await readFile(new URL('../../assets/setup.html',import.meta.url),'utf8'));return;
  }
  if(!secureEqual(String(req.headers['x-lumen-setup'] || ''),secret) || (req.method==='POST' && req.headers.origin!==origin)){send(403,{error:'forbidden'});return;}
  try{
    if(path==='/api/status' && req.method==='GET'){
      const accounts=await auth.accounts();const account=accounts.registrations.find(x=>x.client_id===accounts.selected);
      send(200,{telegram:!!c.token,username:savedBot?.username || '',ownerId:c.ownerId,authMode:c.authMode,model:c.model,account:account?.email || (account?'підключено':''),accounts:accounts.registrations.map(x=>({id:x.client_id,label:`${x.email || 'ChatGPT'} · ${x.client_id.slice(-6)}`})),selectedAccount:accounts.selected,loginPending,loginError,probeOk,media:{image:!!c.imageModel,voice:!!c.transcribeModel},webSearch:c.webSearch});return;
    }
    if(path==='/api/save' && req.method==='POST'){
      const data=await body(req);const next=ConfigSchema.parse({...c,...Object.fromEntries(Object.entries({token:data.token || c.token,ownerId:data.ownerId??c.ownerId,authMode:data.authMode??c.authMode,apiKey:data.apiKey || c.apiKey,model:data.model??c.model,imageModel:data.imageModel??c.imageModel,transcribeModel:data.transcribeModel??c.transcribeModel,webSearch:data.webSearch??c.webSearch}).filter(([,v])=>v!==undefined))});
      if(next.token){if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(next.token))throw new Error('token_invalid');savedBot=await new Telegram(next.token).call('getMe');}
      c=next;probeOk=false;await save();send(200,{ok:true,username:savedBot?.username,privacyReady:!!savedBot?.can_read_all_group_messages});return;
    }
    if(path==='/api/login' && req.method==='POST'){
      if(loginPending){send(409,{error:'login_pending'});return;}
      const data=await body(req);
      loginPending=true;loginError='';
      void auth.login(data.newAccount===true,url=>send(200,{url})).then(()=>{loginPending=false;}).catch(e=>{loginPending=false;loginError=errorCode(e);if(!res.headersSent)send(400,{error:loginError});});return;
    }
    if(path==='/api/select-account' && req.method==='POST'){const data=await body(req);await auth.select(String(data.id));probeOk=false;send(200,{ok:true});return;}
    if(path==='/api/models' && req.method==='GET'){send(200,{models:await models(c,auth)});return;}
    if(path==='/api/probe' && req.method==='POST'){
      const text=await new OpenAIModel(c,auth).text([{role:'user',content:'Відповідай коротко українською: Люмен на зв’язку.'}],'Це перевірка підключення. Нічого не зберігай.');
      probeOk=true;send(200,{ok:true,text});return;
    }
    if(path==='/api/finish' && req.method==='POST'){
      if(!c.token || !c.model || !probeOk){send(400,{error:'complete_telegram_model_and_probe'});return;}
      const pin=randomBytes(18).toString('base64url');c.pairCodeHash=createHash('sha256').update(pin).digest('hex');
      if(!c.databaseUrl){
        const dbPass=randomBytes(24).toString('hex');
        await mkdir(c.runtimeDir,{recursive:true,mode:0o700});
        await writeFile(resolve(c.runtimeDir,'postgres.env'),`POSTGRES_USER=lumen\nPOSTGRES_DB=lumen\nPOSTGRES_PASSWORD=${dbPass}\n`,{mode:0o600});
        c.databaseUrl=`postgres://lumen:${dbPass}@db:5432/lumen`;
      }
      await save();savedBot ||= await new Telegram(c.token).call('getMe');
      await writeFile(resolve(c.runtimeDir,'setup-complete'),'1\n',{mode:0o600});
      send(200,{ok:true,command:`/bind ${pin}`,url:`https://t.me/${savedBot.username}?startgroup=true`});
      // Stay open so the human can copy the pairing command. The Done button closes it.
      return;
    }
    if(path==='/api/close' && req.method==='POST'){send(200,{ok:true});server.close();return;}
    send(404,{error:'not_found'});
  }catch(e){send(400,{error:errorCode(e)});}
});
server.listen(port,process.env.SETUP_CONTAINER==='true'?'0.0.0.0':'127.0.0.1',()=>{
  console.log(`Відкрийте майстер Люмена на цьому комп'ютері:\n${origin}/#${secret}`);
});
server.on('error',()=>{console.error('setup_port_busy');process.exitCode=1;});
