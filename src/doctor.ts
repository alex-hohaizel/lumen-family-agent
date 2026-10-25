import { loadConfig } from './config.js';
import { Telegram } from './telegram.js';
import { ChatGPTAuth, models } from './auth.js';
import { Postgres, migrate, state } from './db.js';
import { errorCode } from './engine.js';

const c=await loadConfig();let good=true;
async function check(label:string,fn:()=>Promise<string>){try{console.log(`✓ ${label}: ${await fn()}`);}catch(e){good=false;console.log(`✗ ${label}: ${errorCode(e)}`);}}
await check('Telegram',async()=>{if(!c.token)throw new Error('missing');const me=await new Telegram(c.token).call('getMe');return `@${me.username}; Privacy Mode ${me.can_read_all_group_messages?'вимкнено':'потрібно вимкнути'}`;});
await check('Моделі',async()=>{const list=await models(c,new ChatGPTAuth(c.runtimeDir));if(!list.some((x:any)=>x.id===c.model))throw new Error('missing');return `обрана ${c.model}, доступних ${list.length}`;});
await check('База',async()=>{const db=new Postgres(c.databaseUrl);try{await migrate(db);const s=await state(db);return s.chat_id?`група підключена; згоди ${s.consent.length}/2`:'працює, групу ще не підключено';}finally{await db.close();}});
process.exitCode=good?0:1;
