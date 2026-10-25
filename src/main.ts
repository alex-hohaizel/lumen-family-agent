import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, requireRuntime } from './config.js';
import { Postgres, migrate, state,queueText } from './db.js';
import { Telegram } from './telegram.js';
import { OpenAIModel } from './model.js';
import { Lumen, errorCode } from './engine.js';
import { Delivery } from './delivery.js';
import { hostId } from './auth.js';
import { Memory } from './memory.js';
import { prepareCredentials } from './bootstrap.js';
import { ensureAvatar } from './profile.js';

async function main(){
  const config=await loadConfig();requireRuntime(config);await prepareCredentials(config);await hostId(config.runtimeDir);
  const db=new Postgres(config.databaseUrl);await migrate(db);
  // One persistent connection owns the bot lifecycle. A second replica exits instead of racing the poller or refresh token.
  const lease=await db.pool.connect();
  const {rows}=await lease.query('SELECT pg_try_advisory_lock(719463201) AS locked');
  if(!rows[0]?.locked)throw new Error('another_instance_running');
  let leaseLost=false;lease.on('error',()=>{leaseLost=true;});
  await db.query("UPDATE inbox SET status='pending' WHERE status='processing'");
  await db.query("UPDATE outbox SET status='uncertain',error_code='restart_during_delivery' WHERE status='sending'");
  const initial=await state(db);
  if(initial.chat_id && !initial.paused && initial.last_poll_at && Date.now()-new Date(initial.last_poll_at).getTime()>86400000){
    await queueText(db,'Був тривалий період без зв’язку з Telegram. Частина повідомлень могла не дійти до мене. Якщо за цей час були важливі домовленості, перекажіть їх.',initial.memory_revision,`gap:${new Date(initial.last_poll_at).toISOString()}`,true);
  }
  const telegram=new Telegram(config.token);
  const bot=await telegram.call<{id:number;username:string;can_read_all_group_messages?:boolean}>('getMe');
  if(bot.username.toLowerCase()!=='lumen_family_agent')throw new Error('unexpected_telegram_bot');
  const webhook=await telegram.call<{url:string}>('getWebhookInfo');
  if(webhook.url)throw new Error('existing_webhook_remove_explicitly');
  await telegram.call('setMyName',{name:'Люмен'});
  await telegram.call('setMyDescription',{description:'Люмен — співрозмовник для вашої приватної групи: ігри, спільна пам’ять, нотатки та нагадування.'});
  await telegram.call('setMyCommands',{commands:[
    {command:'help',description:'Можливості Люмена'},{command:'consent',description:'Почати або відновити спільну пам’ять'},
    {command:'games',description:'П’ять ігор на двох'},{command:'notes',description:'Спільні нотатки'},
    {command:'reminders',description:'Заплановані нагадування'},{command:'pause',description:'Пауза пам’яті'},
    {command:'forget_all',description:'Очистити спільну пам’ять'},{command:'status',description:'Стан підключення'}
  ]});
  try{await ensureAvatar(telegram,config,bot);}catch(e){console.error(JSON.stringify({event:'profile_update_failed',code:errorCode(e)}));}
  const brain=new OpenAIModel(config);const engine=new Lumen(db,config,telegram,brain,bot);const delivery=new Delivery(db,telegram,config);const memory=new Memory(db,brain);
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
        const s=await state(db);const updates=await telegram.updates(Number(s.poll_offset));
        for(const update of updates){
          if(!running)break;
          await engine.receive(update);
          // The Telegram offset advances only after receive's transaction commits.
          await db.query('UPDATE app_state SET poll_offset=$1,last_poll_at=now() WHERE id=1',[update.update_id+1]);
        }
        await db.query('UPDATE app_state SET last_poll_at=now() WHERE id=1');lastPoll=Date.now();
      }catch(e){console.error(JSON.stringify({event:'poll_error',code:errorCode(e)}));await delay(3000);}
    }
  };
  const work=async()=>{while(running&&!leaseLost){try{if(!await engine.processNext())await delay(500);}catch(e){console.error(JSON.stringify({event:'worker_error',code:errorCode(e)}));await delay(2000);}}};
  const send=async()=>{while(running&&!leaseLost){try{await engine.scheduleDue();await delivery.next();}catch(e){console.error(JSON.stringify({event:'delivery_error',code:errorCode(e)}));}await delay(1100);}};
  console.log(JSON.stringify({event:'lumen_started',username:bot.username}));
  const compact=async()=>{while(running&&!leaseLost){try{await memory.compact();}catch(e){console.error(JSON.stringify({event:'memory_error',code:errorCode(e)}));}for(let i=0;i<60&&running&&!leaseLost;i++)await delay(1000);}};
  await Promise.all([poll(),work(),send(),compact()]);health.close();lease.release();await db.close();
  if(leaseLost)process.exitCode=1;
}
main().catch(e=>{console.error(JSON.stringify({event:'startup_failed',code:/^[a-z_]+$/.test(e.message)?e.message:errorCode(e)}));process.exit(1);});
