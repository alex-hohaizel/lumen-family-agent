import {createHash} from 'node:crypto';
import {one,state,type Database,type SQL} from './db.js';
import {checkOperation,stableId} from './operations.js';
import {assertActionOwner} from './commitments.js';
import {ToolError} from './safe-http.js';
import type {ToolContext} from './agent-tools.js';

export const digest=(v:unknown)=>createHash('sha256').update(v instanceof Uint8Array?v:typeof v==='string'?v:JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value)).digest('hex');
export const sourceIds=(c:ToolContext)=>[...new Set([...(c.sourceIds||[]),...(c.sourceId?[c.sourceId]:[])])].filter(Number.isSafeInteger);
export function requirePrivate(c:ToolContext){if(c.audience!=='private'&&Number(c.chatId)<0)throw new ToolError('private_conversation_required');}
export function requireVersion(actual:number,expected?:number){if(expected===undefined||actual!==expected)throw new ToolError('version_conflict_read_current');}
export async function command<T>(db:Database,c:ToolContext,domain:string,args:unknown,fn:(sql:SQL,id:string)=>Promise<T>):Promise<T>{
 checkOperation();const id=stableId(c.operationKey||`${domain}:${c.actorId}:${c.updateId}:${digest(args)}`),hash=digest(args);
 return db.tx(async sql=>{
  const live=await state(sql,true);if(live.paused||live.memory_revision!==c.revision)throw new ToolError('task_cancelled');
  if(Number(c.chatId)<0&&String(live.chat_id)!==c.chatId)throw new ToolError('other_chat');
  await assertActionOwner(sql,c.actionId,c.revision);
  const member=await one(sql,'SELECT active FROM members WHERE user_id=$1',[c.actorId]);
  if(member?.active===false||!member&&live.owner_id!==c.actorId&&!(live.participants||[]).some((p:any)=>String(p.id)===c.actorId))throw new ToolError('member_required');
  const previous=await one(sql,'SELECT arguments_hash,result FROM domain_commands WHERE id=$1',[id]);if(previous){if(previous.arguments_hash!==hash)throw new ToolError('operation_key_conflict');return previous.result;}
  const result=await fn(sql,id);checkOperation();const serialized=JSON.stringify(result);
  await sql.query('INSERT INTO domain_commands(id,domain,actor_id,arguments_hash,result,source_message_id,source_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,domain,c.actorId,hash,serialized,c.sourceId||null,JSON.stringify(sourceIds(c))]);return JSON.parse(serialized) as T;
 });
}
