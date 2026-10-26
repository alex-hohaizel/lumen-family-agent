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
import { ensureAvatar } from './profile.js';

async function main(){
  const config=await loadConfig();requireRuntime(config);await prepareCredentials(config);await hostId(config.runtimeDir);
  const db=new Postgres(config.databaseUrl);
  // One persistent connection owns the bot lifecycle. A second replica exits instead of racing the poller or refresh token.
  const lease=await db.pool.connect();
  const {rows}=await lease.query('SELECT pg_try_advisory_lock(719463201) AS locked');
  if(!rows[0]?.locked)throw new Error('another_instance_running');
  let leaseLost=false;lease.on('error',()=>{leaseLost=true;});
  const telegram=new Telegram(config.token);
  const bot=await telegram.call<{id:number;username:string;can_read_all_group_messages?:boolean}>('getMe');
  if(bot.username.toLowerCase()!=='lumen_family_agent')throw new Error('unexpected_telegram_bot');
  const webhook=await telegram.call<{url:string}>('getWebhookInfo');
  if(webhook.url)throw new Error('existing_webhook_remove_explicitly');
  await telegram.call('setMyName',{name:'Люмен'});
  await telegram.call('setMyDescription',{description:'Люмен — співрозмовник для ваших груп: допомога, ігри, опитування, нотатки й нагадування. Звертайтеся на ім’я або через @згадку. У кожної групи окрема пам’ять.'});
  await telegram.call('setMyCommands',{commands:[
    {command:'menu',description:'Можливості та кнопки'},{command:'help',description:'Як спілкуватися з Люменом'},
    {command:'games',description:'Ігри для компанії'},{command:'notes',description:'Нотатки цієї групи'},
    {command:'reminders',description:'Заплановані нагадування'},{command:'pause',description:'Пауза пам’яті'},
    {command:'privacy',description:'Пам’ять і приватність'},{command:'status',description:'Стан підключення'}
  ]});
  try{await ensureAvatar(telegram,config,bot);}catch(e){console.error(JSON.stringify({event:'profile_update_failed',code:errorCode(e)}));}
  const registry=new ChatRegistry(db);const router=new ChatRouter(registry,config,telegram,bot);await router.init();
  let running=true;let lastPoll=Date.now();
  const health=createServer(async (req,res)=>{
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
  console.log(JSON.stringify({event:'lumen_started',username:bot.username}));
  const compact=async()=>{while(running&&!leaseLost){await each('memory_error',r=>r.memory.compact());for(let i=0;i<60&&running&&!leaseLost;i++)await delay(1000);}};
  await Promise.all([poll(),work(),send(),compact()]);health.close();lease.release();await db.close();
  if(leaseLost)process.exitCode=1;
}
main().catch(e=>{console.error(JSON.stringify({event:'startup_failed',code:/^[a-z_]+$/.test(e.message)?e.message:errorCode(e)}));process.exit(1);});
