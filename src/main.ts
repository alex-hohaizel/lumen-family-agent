import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, requireRuntime } from './config.js';
import { Postgres } from './db.js';
import { Telegram } from './telegram.js';
import { errorCode } from './engine.js';
import { hostId } from './auth.js';
import {ChatRegistry} from './registry.js';
import {ChatRouter,type ChatRuntime} from './router.js';
import { prepareCredentials } from './bootstrap.js';
import { ensureAvatar,ensureTextProfile } from './profile.js';
import {ensureStickerPack} from './sticker-pack.js';
import {RELEASE} from './release.js';
import {browsers} from './browser.js';
import {runtimeChecks} from './runtime-checks.js';

let startupStage='configuration';
async function main(){
  const config=await loadConfig();requireRuntime(config);await prepareCredentials(config);await hostId(config.runtimeDir);
  startupStage='database_lease';
  const db=new Postgres(config.databaseUrl);
  // One persistent connection owns the bot lifecycle. A second replica exits instead of racing the poller or refresh token.
  const lease=await db.pool.connect();
  const {rows}=await lease.query('SELECT pg_try_advisory_lock(719463201) AS locked');
  if(!rows[0]?.locked)throw new Error('another_instance_running');
  let leaseLost=false;lease.on('error',()=>{leaseLost=true;});
  startupStage='telegram_identity';
  const telegram=new Telegram(config.token);
  const bot=await telegram.call<{id:number;username:string;can_read_all_group_messages?:boolean}>('getMe');
  if(bot.username.toLowerCase()!=='lumen_family_agent')throw new Error('unexpected_telegram_bot');
  const webhook=await telegram.call<{url:string}>('getWebhookInfo');
  if(webhook.url)throw new Error('existing_webhook_remove_explicitly');
  startupStage='telegram_profile';
  try{await ensureTextProfile(telegram,config,bot);}catch(e:any){console.error(JSON.stringify({event:'text_profile_deferred',code:/^[a-z_0-9]+$/.test(e.code||'')?e.code:errorCode(e)}));}
  try{await ensureAvatar(telegram,config,bot);}catch(e){console.error(JSON.stringify({event:'profile_update_failed',code:errorCode(e)}));}
  startupStage='registry_migration';
  const registry=new ChatRegistry(db);await registry.init();
  startupStage='sticker_pack';
  let pack:Awaited<ReturnType<typeof ensureStickerPack>>|undefined;const owner=(await registry.transport()).owner_user_id;
  if(owner)try{pack=await ensureStickerPack(telegram,owner,config.runtimeDir);console.log(JSON.stringify({event:'sticker_pack_ready',name:pack.name,count:pack.stickers.length}));}catch(e){console.error(JSON.stringify({event:'sticker_pack_failed',code:errorCode(e)}));}
  startupStage='group_runtimes';
  const router=new ChatRouter(registry,config,telegram,bot);if(pack)router.setStickerPack(pack);await router.init();
  let running=true;let lastPoll=Date.now();let checks:unknown={status:'pending'};
  const health=createServer(async (req,res)=>{
    if(req.url==='/ready'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({version:RELEASE,checks}));return;}
    if(req.url!=='/health'){res.writeHead(404).end();return;}
    const ok=running&&!leaseLost&&Date.now()-lastPoll<180000;
    res.writeHead(ok?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({status:ok?'ok':'unavailable'}));
  }).listen(config.healthPort,'0.0.0.0');
  const shutdown=()=>{running=false;health.close();};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
  const poll=async()=>{
    while(running&&!leaseLost){
      try{
        const s=await registry.transport();const updates=await telegram.updates(Number(s.poll_offset));
        for(const update of updates){
          if(!running)break;
          await router.receive(update);
          // The Telegram offset advances only after receive's transaction commits.
          await registry.advance(update.update_id+1);
        }
        await registry.polled();lastPoll=Date.now();
      }catch(e){console.error(JSON.stringify({event:'poll_error',code:errorCode(e)}));await delay(3000);}
    }
  };
  // One in-flight answer per group preserves ordering; three groups may think concurrently.
  const busy=new Set<string>();const pending=new Set<Promise<void>>();let workCursor=0;
  const work=async()=>{
    while(running&&!leaseLost){
      const active=await router.active();const order=active.slice(workCursor).concat(active.slice(0,workCursor));
      for(const runtime of order){
        const id=runtime.chat.chat_id;if(busy.has(id)||busy.size>=3)continue;
        busy.add(id);workCursor=(active.indexOf(runtime)+1)%active.length;let task:Promise<void>;
        task=runtime.engine.processNext().then(()=>{}).catch(e=>{console.error(JSON.stringify({event:'worker_error',code:errorCode(e)}));}).finally(()=>{busy.delete(id);pending.delete(task);});pending.add(task);
      }
      await delay(400);
    }
    await Promise.allSettled(pending);
  };
  const each=async(event:string,operation:(runtime:ChatRuntime)=>Promise<unknown>)=>{
    for(const runtime of await router.active())try{await operation(runtime);}catch(e){console.error(JSON.stringify({event,code:errorCode(e)}));}
  };
  const send=async()=>{while(running&&!leaseLost){await each('delivery_error',async r=>{await r.engine.scheduleDue();await r.delivery.next();});await delay(1100);}};
  const activeGroups=await router.active();
  const releaseNotices=await Promise.all(activeGroups.map(async r=>(await r.db.query('SELECT status FROM release_notices WHERE version=$1',[RELEASE])).rows[0]?.status));
  console.log(JSON.stringify({event:'lumen_started',username:bot.username,version:RELEASE,groups:activeGroups.length,release_notices_pending:releaseNotices.filter(s=>s==='pending').length,release_notices_sent:releaseNotices.filter(s=>s==='sent').length}));
  const compact=async()=>{while(running&&!leaseLost){await each('memory_error',r=>r.memory.compact());for(let i=0;i<60&&running&&!leaseLost;i++)await delay(1000);}};
  const mediaBusy=new Set<string>();const mediaPending=new Set<Promise<void>>();let mediaCursor=0;
  const mediaWork=async()=>{while(running&&!leaseLost){const active=await router.active();const order=active.slice(mediaCursor).concat(active.slice(0,mediaCursor));for(const r of order){if(mediaBusy.has(r.chat.chat_id)||mediaBusy.size>=2)continue;mediaBusy.add(r.chat.chat_id);mediaCursor=(active.indexOf(r)+1)%active.length;let task:Promise<void>;task=(async()=>{if(!await r.images.next())await r.visual.next();})().catch(e=>console.error(JSON.stringify({event:'media_error',code:errorCode(e)}))).finally(()=>{mediaBusy.delete(r.chat.chat_id);mediaPending.delete(task);});mediaPending.add(task);}await delay(1500);}await Promise.allSettled(mediaPending);};
  const automationWork=async()=>{while(running&&!leaseLost){await each('agent_error',async r=>{if(!await r.agent.next())await r.monitors.next();});await delay(1500);}};
  const check=runtimeChecks(config.runtimeDir,()=>router.probeNativeSearch()).then(result=>{checks=result;}).catch(()=>{checks={status:'failed'};console.error(JSON.stringify({event:'runtime_checks_failed'}));});
  await Promise.all([poll(),work(),send(),compact(),mediaWork(),automationWork(),check]);await browsers.close();health.close();lease.release();await db.close();
  if(leaseLost)process.exitCode=1;
}
main().catch(e=>{console.error(JSON.stringify({event:'startup_failed',stage:startupStage,native_code:/^[A-Za-z0-9_]{1,60}$/.test(e.code||'')?e.code:undefined,frames:typeof e.stack==='string'?e.stack.split('\n').slice(1,4):undefined,code:/^[a-z_]+$/.test(e.message)?e.message:errorCode(e)}));process.exit(1);});
