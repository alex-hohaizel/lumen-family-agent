import {AsyncLocalStorage} from 'node:async_hooks';
import {one,type SQL,type Row} from './db.js';
import type {Update} from './telegram.js';

export interface IngressContext {enqueuedAt:string;scopes:readonly string[];stale?:boolean;}
const trusted=new WeakMap<Update,IngressContext>();
const current=new AsyncLocalStorage<IngressContext>();
export function validIngressScopes(value:unknown):string[]{
  if(!Array.isArray(value)||value.length>256||value.some(id=>typeof id!=='string'||!/^[-]?\d{1,24}$/.test(id)))throw Object.assign(Error('ingress_payload_invalid'),{code:'ingress_payload_invalid'});
  return Array.from(new Set(value));
}
export function bindIngress(update:Update,enqueuedAt:string,scopes:unknown){
  if(!Number.isFinite(Date.parse(enqueuedAt)))throw Object.assign(Error('ingress_payload_invalid'),{code:'ingress_payload_invalid'});
  const context:IngressContext={enqueuedAt,scopes:Object.freeze(validIngressScopes(scopes))};
  (update as any).lumen_ingress_at=enqueuedAt;(update as any).lumen_ingress_scopes=[...context.scopes];
  trusted.set(update,context);return update;
}
export function ingressOf(update:Update){return trusted.get(update);}
export function ingressContext(){return current.getStore();}
export function ingressStale(){return Object.assign(Error('ingress_stale'),{code:'ingress_stale'});}
export function isIngressStale(error:any){return error?.code==='ingress_stale';}
export function allowsIngressScope(chatId:string){const context=current.getStore();return !context||context.scopes.includes(chatId);}
export async function withIngress<T>(update:Update,fn:()=>Promise<T>){
  const context=trusted.get(update);
  if(!context)return current.exit(fn);
  return current.run(context,async()=>{const result=await fn();if(context.stale)throw ingressStale();return result;});
}
export function routedUpdate(parent:Update,synthetic:Update){
  const context=trusted.get(parent);
  if(context){bindIngress(synthetic,context.enqueuedAt,context.scopes);trusted.set(synthetic,context);}
  return synthetic;
}
// Called only after the same app_state row has been locked by the privacy fence.
// Compare in PostgreSQL so sub-millisecond enqueue/cutoff ordering is preserved.
export async function assertIngressCurrent(sql:SQL,live:Row){
  const context=current.getStore();
  if(!context)return;
  if(context.stale)throw ingressStale();
  if(!context.scopes.includes(String(live.chat_id))||!live.ingress_after)return;
  const result=await one(sql,'SELECT $1::timestamptz<ingress_after AS stale FROM app_state WHERE id=1',[context.enqueuedAt]);
  if(result?.stale){context.stale=true;throw ingressStale();}
}
