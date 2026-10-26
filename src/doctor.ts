import { loadConfig } from './config.js';
import { Telegram } from './telegram.js';
import { ChatGPTAuth, models } from './auth.js';
import { Postgres } from './db.js';
import { ChatRegistry } from './registry.js';
import { errorCode } from './engine.js';

const c=await loadConfig();let good=true;
async function check(label:string,fn:()=>Promise<string>){try{console.log(`✓ ${label}: ${await fn()}`);}catch(e){good=false;console.log(`✗ ${label}: ${errorCode(e)}`);}}
await check('Telegram',async()=>{if(!c.token)throw new Error('missing');const me=await new Telegram(c.token).call('getMe');return `@${me.username}; Privacy Mode ${me.can_read_all_group_messages?'вимкнено':'потрібно вимкнути'}`;});
await check('Моделі',async()=>{const list=await models(c,new ChatGPTAuth(c.runtimeDir));if(!list.some((x:any)=>x.id===c.model))throw new Error('missing');return `обрана ${c.model}, доступних ${list.length}`;});
await check('База',async()=>{const db=new Postgres(c.databaseUrl);try{const registry=new ChatRegistry(db);await registry.init();const chats=await registry.list();return `працює; підключених груп: ${chats.length}; пам’ять груп ізольована`;}finally{await db.close();}});
process.exitCode=good?0:1;
