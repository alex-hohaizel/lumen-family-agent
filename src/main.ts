import {logIncident,recordIncident} from './incidents.js';
import {ConnectionChecks} from './connection-checks.js';
import {PrivateResults} from './private-results.js';
import {PrivateInbox} from './private-inbox.js';
import {OAuthDevices} from './oauth-device.js';
import {SessionEngine} from './session-engine.js';
import {Signals} from './agent-services.js';
import {TransportQueue} from './transport-queue.js';
import {TaskJournal} from './task-journal.js';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, requireRuntime } from './config.js';
import { Postgres,type Database } from './db.js';
import { Telegram } from './telegram.js';
import { errorCode } from './engine.js';
import { hostId } from './auth.js';
import {ChatRegistry} from './registry.js';
import {ChatRouter} from './router.js';
import { prepareCredentials } from './bootstrap.js';
import { ensureAvatar,ensureTextProfile } from './profile.js';
import {activateWithStickerPack} from './joint-startup.js';
import {RELEASE} from './release.js';
import {browsers} from './browser.js';
import {startWorkerTelemetry} from './work-slots.js';
import {publicRuntimeProbes,runtimeChecks,runtimeDiagnosticsRequested,unrunRuntimeChecks} from './runtime-checks.js';
import {cancelOperations,runOperation} from './operations.js';

async function runtimeFailure(db:Database|undefined,error:unknown,operation:string,stage=operation):Promise<void>{const context={operation,stage,attemptKey:operation+':'+Date.now()};try{if(db){const receipt=await db.tx(sql=>recordIncident(sql,context,error));console.error(JSON.stringify({event:'diagnostic_incident',code:receipt.code,reason:receipt.reason,operation,stage,persisted:true}));return;}}catch{}logIncident(context,error);}
let startupStage='configuration';
async function main(){
  const config=await loadConfig();requireRuntime(config);await prepareCredentials(config);await hostId(config.runtimeDir);
  startupStage='database_lease';
  const db=new Postgres(config.databaseUrl);
  // One persistent connection owns the bot lifecycle. A second replica exits instead of racing the poller or refresh token.
  const lease=await db.pool.connect();
  const {rows}=await lease.query('SELECT pg_try_advisory_lock(719463201) AS locked');
  if(!rows[0]?.locked)throw new Error('another_instance_running');
  let leaseLost=false;lease.on('error',()=>{leaseLost=true;cancelOperations(db,'runtime_diagnostics');});
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
  const owner=(await registry.transport()).owner_user_id;
  const router=await activateWithStickerPack({telegram,ownerId:owner,runtimeDir:config.runtimeDir,requireVerified:config.requireVerifiedStickerPack,
    ready:pack=>console.log(JSON.stringify({event:'sticker_pack_ready',name:pack.name,title:pack.title,count:pack.stickers.length})),
    failed:(e:any)=>console.error(JSON.stringify({event:'sticker_pack_failed',code:/^[a-z_0-9]+$/.test(e.code||'')?e.code:errorCode(e),detail:/^[a-z_0-9]+$/.test(e.message||'')?e.message:undefined})),
  },async pack=>{
    startupStage='group_runtimes';
    const router=new ChatRouter(registry,config,telegram,bot);if(pack)router.setStickerPack(pack);await router.init();return router;
  });
  const ingress=new TransportQueue(db,config.runtimeDir,update=>router.receive(update),(update,sql)=>router.ingressScopes(update,sql));await ingress.init();
  const stopMemoryTelemetry=startWorkerTelemetry();
  let running=true;let lastPoll=Date.now();let checks=unrunRuntimeChecks();
  const health=createServer(async (req,res)=>{
    const ok=running&&!leaseLost&&Date.now()-lastPoll<180000;
    if(req.url==='/ready'){res.writeHead(ok?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({status:ok?'ready':'unavailable',version:RELEASE,checks}));return;}
    if(req.url!=='/health'){res.writeHead(404).end();return;}
    res.writeHead(ok?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({status:ok?'ok':'unavailable'}));
  }).listen(config.healthPort,'0.0.0.0');
  const shutdown=()=>{stopMemoryTelemetry();running=false;cancelOperations(db,'runtime_diagnostics');void router.cancelAll();health.close();};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
  const poll=async()=>{
    while(running&&!leaseLost){
      try{
        const s=await registry.transport();const updates=await telegram.updates(Number(s.poll_offset));
        for(const update of updates){
          if(!running)break;
          await ingress.enqueue(update); // Durable encrypted receipt and offset commit atomically.
        }
        await registry.polled();lastPoll=Date.now();
      }catch(e){await runtimeFailure(db,e,'ingress','poll');await delay(3000);}
    }
  };
  // Two authors per chat and three answers globally; one author/topic keeps causal order.
  const busy=new Map<string,number>();const pending=new Set<Promise<void>>();let workCursor=0;
  const work=async()=>{
    while(running&&!leaseLost){
      const active=await router.ready('conversation',Math.max(0,3-pending.size),new Set(Array.from(busy).filter(([,n])=>n>=2).map(([id])=>id)));const order=active.slice(workCursor).concat(active.slice(0,workCursor));
      for(const runtime of order){
        const id=runtime.chat.chat_id;if((busy.get(id)||0)>=2||pending.size>=3)continue;
        busy.set(id,(busy.get(id)||0)+1);workCursor=(active.indexOf(runtime)+1)%active.length;let task:Promise<void>;
        task=router.operate(runtime,'conversation',()=>runtime.engine.processNext()).then(()=>{}).catch(async e=>{await runtimeFailure(runtime.db,e,'conversation','worker');}).finally(()=>{busy.set(id,Math.max(0,(busy.get(id)||1)-1));pending.delete(task);});pending.add(task);
      }
      await delay(400);
    }
    await Promise.allSettled(pending);
  };
  const send=async()=>{const busy=new Set<string>(),jobs=new Set<Promise<void>>();let cursor=0;while(running&&!leaseLost){const active=await router.ready('delivery',Math.max(0,3-jobs.size),busy),order=active.slice(cursor).concat(active.slice(0,cursor));for(const r of order){if(busy.has(r.chat.chat_id)||jobs.size>=3)continue;busy.add(r.chat.chat_id);cursor=(active.indexOf(r)+1)%active.length;let job:Promise<void>;job=router.operate(r,'delivery',async()=>{await r.engine.scheduleDue();await new TaskJournal(r.db).tick();await new SessionEngine(r.db,config.runtimeDir).tick();await new Signals(r.db,config).tick();await r.delivery.next('text');}).then(()=>{}).catch(e=>runtimeFailure(r.db,e,'delivery','delivery')).finally(()=>{busy.delete(r.chat.chat_id);jobs.delete(job);});jobs.add(job);}await delay(1100);}await Promise.allSettled(jobs);};
  const registeredGroups=(await registry.list()).filter(chat=>Number(chat.chat_id)<0);
  console.log(JSON.stringify({event:'lumen_started',username:bot.username,version:RELEASE,groups:registeredGroups.length,runtime_cache_warm:router.all().length}));
  const compact=async()=>{while(running&&!leaseLost){for(const r of await router.ready('maintenance',2))try{await router.operate(r,'memory',async()=>{await r.memory.compact();await r.engine.cleanupStorage();await new PrivateInbox(r.db,config.runtimeDir).cleanup();await new PrivateResults(r.db,config).cleanup();});}catch(e){await runtimeFailure(r.db,e,'memory','memory');}await router.evictIdle();await delay(1000);}};
  const mediaBusy=new Set<string>();const mediaPending=new Set<Promise<void>>();let mediaCursor=0;
  const mediaWork=async()=>{while(running&&!leaseLost){const active=await router.ready('media',Math.max(0,2-mediaPending.size),mediaBusy);const order=active.slice(mediaCursor).concat(active.slice(0,mediaCursor));for(const r of order){if(mediaBusy.has(r.chat.chat_id)||mediaBusy.size>=2)continue;mediaBusy.add(r.chat.chat_id);mediaCursor=(active.indexOf(r)+1)%active.length;let task:Promise<void>;task=router.operate(r,'media',async()=>{if(!await r.delivery.next('media')&&!await r.images.next())await r.visual.next();}).then(()=>{}).catch(e=>runtimeFailure(r.db,e,'media','media')).finally(()=>{mediaBusy.delete(r.chat.chat_id);mediaPending.delete(task);});mediaPending.add(task);}await delay(1500);}await Promise.allSettled(mediaPending);};
  const automationWork=async()=>{const busy=new Set<string>(),jobs=new Set<Promise<void>>();let cursor=0;while(running&&!leaseLost){const active=await router.ready('automation',Math.max(0,2-jobs.size),busy),order=active.slice(cursor).concat(active.slice(0,cursor));for(const r of order){if(busy.has(r.chat.chat_id)||jobs.size>=2)continue;busy.add(r.chat.chat_id);cursor=(active.indexOf(r)+1)%active.length;let job:Promise<void>;job=router.operate(r,'automation',async()=>{await r.engine.syncCalendar();if(!await new ConnectionChecks(r.db,config.runtimeDir).next()&&!await new OAuthDevices(r.db,config.runtimeDir).tick()&&!await r.agent.next())await r.monitors.next();}).then(()=>{}).catch(e=>runtimeFailure(r.db,e,'task','agent')).finally(()=>{busy.delete(r.chat.chat_id);jobs.delete(job);});jobs.add(job);}await delay(900);}await Promise.allSettled(jobs);};
  const routeWork=async()=>{while(running&&!leaseLost){const received=await ingress.next();await delay(received?10:400);}};
  const check=runOperation(db,'runtime_diagnostics',()=>runtimeChecks(config.runtimeDir,runtimeDiagnosticsRequested(process.argv.slice(2)),()=>publicRuntimeProbes(()=>router.probeNativeSearch(),()=>router.probeFreshnessChoice(),{documents:()=>router.probeDocuments(),interactions:()=>router.probeInteractions(),personalization_scheduling_190:()=>router.probePersonalizationScheduling(),behavior_111_r2:()=>router.probeBehavior111(),companion_113:()=>router.probeCompanion113()}),report=>{checks=report;})).catch(()=>{checks={...checks,status:'failed',code:'diagnostic_report_failed'};console.error(JSON.stringify({event:'runtime_checks_failed'}));});
  await Promise.all([poll(),work(),send(),compact(),mediaWork(),automationWork(),routeWork(),routeWork(),check]);stopMemoryTelemetry();await router.drainAll();await browsers.close();health.close();lease.release();await db.close();
  if(leaseLost)process.exitCode=1;
}
main().catch(e=>{logIncident({operation:'startup',stage:'startup',attemptKey:'startup:'+Date.now(),facts:{contract:startupStage}},e);process.exit(1);});
