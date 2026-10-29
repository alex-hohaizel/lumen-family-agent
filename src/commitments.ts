import {createHash, randomUUID} from 'node:crypto';
import {one,state,type SQL,type Database} from './db.js';
import {recordProvenance} from './provenance.js';
import {stableId} from './operations.js';
import {ToolError} from './safe-http.js';

export const ENGINE_VERSION='1.11';
export const terminalPhases=['completed','cancelled','expired','failed'] as const;
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])])):value;
export const specHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export interface ActionScope {actorId:string;topicId:string;revision:number;sourceId?:number;sourceIds?:number[];}

export async function assertActionOwner(sql:SQL,actionId:string|undefined,revision:number) {
  if(!actionId)return;
  const a=await one(sql,'SELECT phase,revision,expires_at FROM commitments WHERE id=$1 FOR UPDATE',[actionId]);
  if(!a||a.revision!==revision||!['runnable','executing','delivering'].includes(a.phase)||new Date(a.expires_at).getTime()<=Date.now())throw new ToolError('action_unavailable');
}

export async function createCommitment(sql:SQL,input:ActionScope&{id?:string;kind:string;spec:unknown;expectedResult:string;phase?:string;expiresAt?:Date;parentId?:string}) {
  const id=input.id||randomUUID(),hash=specHash(input.spec);
  const s=await state(sql);if(s.paused||s.memory_revision!==input.revision)throw new ToolError('task_cancelled');
  await sql.query(`INSERT INTO commitments(id,parent_id,actor_id,topic_id,kind,spec,spec_hash,expected_result,phase,revision,source_message_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,[id,input.parentId||null,input.actorId,input.topicId,input.kind,JSON.stringify(input.spec),hash,input.expectedResult,input.phase||'waiting_acceptance',input.revision,input.sourceId||null,input.expiresAt||new Date(Date.now()+86400000)]);
  const current=await one(sql,'SELECT * FROM commitments WHERE id=$1',[id]);
  if(!current||current.spec_hash!==hash||current.actor_id!==input.actorId||current.topic_id!==input.topicId||current.revision!==input.revision)throw new ToolError('action_spec_changed');
  await recordProvenance(sql,'commitment',id,[...(input.sourceIds||[]),...(input.sourceId?[input.sourceId]:[])]);
  return current;
}

export async function recordConsentGrant(sql:SQL,actionId:string,c:ActionScope,decision:string) {
  const a=await one(sql,'SELECT * FROM commitments WHERE id=$1 FOR UPDATE',[actionId]);
  if(!a||a.topic_id!==c.topicId||a.revision!==c.revision||new Date(a.expires_at).getTime()<=Date.now()||['cancelled','expired','failed','completed'].includes(a.phase))throw new ToolError('action_unavailable');
  await sql.query('INSERT INTO consent_grants(action_id,actor_id,spec_hash,decision,source_message_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(action_id,actor_id) DO UPDATE SET spec_hash=excluded.spec_hash,decision=excluded.decision,source_message_id=excluded.source_message_id,created_at=now()',[actionId,c.actorId,a.spec_hash,decision,c.sourceId||null]);
  await recordProvenance(sql,'commitment',actionId,[...(c.sourceIds||[]),...(c.sourceId?[c.sourceId]:[])]);
}

export async function enqueueActionWork(sql:SQL,actionId:string,payload:unknown,plan:unknown,inboxId:number,revision:number) {
  const a=await one(sql,'SELECT * FROM commitments WHERE id=$1 FOR UPDATE',[actionId]),s=await state(sql);
  if(!a||a.engine_version!==ENGINE_VERSION||s.paused||s.memory_revision!==revision||a.revision!==revision||new Date(a.expires_at).getTime()<=Date.now()||!['waiting_acceptance','runnable'].includes(a.phase))throw new ToolError('action_unavailable');
  const id=stableId(`activation:${a.id}:${a.spec_hash}`);
  await sql.query("INSERT INTO action_work(id,action_id,spec_hash,revision,payload,plan,inbox_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(action_id,spec_hash,kind) DO UPDATE SET status='pending',payload=excluded.payload,plan=excluded.plan WHERE action_work.status='waiting'",[id,a.id,a.spec_hash,revision,JSON.stringify(payload),plan?JSON.stringify(plan):null,inboxId]);
  await sql.query("UPDATE commitments SET phase='runnable',state_version=state_version+1,updated_at=now() WHERE id=$1 AND phase='waiting_acceptance'",[a.id]);
  await sql.query("INSERT INTO inbox(update_id,payload,revision,plan) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[inboxId,JSON.stringify({...payload as any,actionWorkId:id,actionId:a.id}),revision,plan?JSON.stringify(plan):null]);
  return id;
}

export async function claimActionWork(sql:SQL,workId:string,revision:number) {
  const s=await state(sql,true),w=await one(sql,'SELECT * FROM action_work WHERE id=$1 FOR UPDATE',[workId]);
  const a=w?await one(sql,'SELECT * FROM commitments WHERE id=$1 FOR UPDATE',[w.action_id]):undefined;
  if(!w||!a||s.paused||s.memory_revision!==revision||a.revision!==revision||a.spec_hash!==w.spec_hash||new Date(a.expires_at).getTime()<=Date.now()||!['runnable','executing'].includes(a.phase)||!['pending','running'].includes(w.status))throw new ToolError('action_unavailable');
  await sql.query("UPDATE action_work SET status='running',attempts=attempts+1,started_at=now() WHERE id=$1",[workId]);
  await sql.query("UPDATE commitments SET phase='executing',state_version=state_version+1,updated_at=now() WHERE id=$1 AND phase='runnable'",[a.id]);
  return a;
}

export async function finishActionWork(sql:SQL,workId:string,result:unknown,phase='delivering') {
  const w=await one(sql,'SELECT * FROM action_work WHERE id=$1 FOR UPDATE',[workId]);if(!w)return;
  await sql.query("UPDATE action_work SET status='done',error_code=NULL WHERE id=$1",[workId]);
  const owner=await one(sql,'SELECT expected_result FROM commitments WHERE id=$1',[w.action_id]);if(phase==='delivering'&&owner?.expected_result==='activity_completed')phase='executing';
  await sql.query("UPDATE commitments SET phase=$1,result=$2,error_code=NULL,state_version=state_version+1,updated_at=now() WHERE id=$3 AND spec_hash=$4 AND phase='executing'",[phase,JSON.stringify(result),w.action_id,w.spec_hash]);
}

export async function failActionWork(sql:SQL,workId:string,code:string,retry:boolean) {
  const w=await one(sql,'SELECT * FROM action_work WHERE id=$1 FOR UPDATE',[workId]);if(!w)return;
  await sql.query("UPDATE action_work SET status=$1,error_code=$2,available_at=now()+interval '20 seconds' WHERE id=$3",[retry?'pending':'repair',code,workId]);
  await sql.query("UPDATE commitments SET phase=$1,error_code=$2,state_version=state_version+1,updated_at=now() WHERE id=$3 AND phase IN ('runnable','executing')",[retry?'runnable':'blocked',code,w.action_id]);
}

export async function cancelCommitment(sql:SQL,id:string,actor:string,revision:number) {
  const a=await one(sql,'SELECT * FROM commitments WHERE id=$1 FOR UPDATE',[id]);
  if(!a||a.actor_id!==actor||a.revision!==revision)throw new ToolError('action_host_required');
  if(terminalPhases.includes(a.phase as any))return {changed:false,phase:a.phase};
  const dispatch=await one(sql,"SELECT id FROM effect_operations WHERE action_id=$1 AND phase IN ('dispatch_started','uncertain') LIMIT 1",[id]);
  await sql.query("UPDATE commitments SET phase='cancelled',state_version=state_version+1,updated_at=now() WHERE id=$1",[id]);
  await sql.query("UPDATE action_work SET status='cancelled' WHERE action_id=$1 AND status IN ('pending','running','repair')",[id]);
  await sql.query("UPDATE effect_operations SET phase='cancelled',updated_at=now() WHERE action_id=$1 AND phase='reserved'",[id]);
  return {changed:true,phase:dispatch?'cancellation_requested':'cancelled'};
}

export async function reserveEffect(sql:SQL,input:ActionScope&{key:string;arguments:unknown;actionId?:string}) {
  const id=stableId('effect:'+input.key),hash=specHash(input.arguments);
  await sql.query('INSERT INTO effect_operations(id,action_id,operation_key,actor_id,topic_id,arguments_hash,revision,source_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(operation_key) DO NOTHING',[id,input.actionId||null,input.key,input.actorId,input.topicId,hash,input.revision,input.sourceId||null]);
  const op=await one(sql,'SELECT * FROM effect_operations WHERE operation_key=$1',[input.key]);
  if(!op||op.arguments_hash!==hash||op.actor_id!==input.actorId||op.topic_id!==input.topicId||op.revision!==input.revision)throw new ToolError('operation_spec_changed');
  await recordProvenance(sql,'effect',op.id,[...(input.sourceIds||[]),...(input.sourceId?[input.sourceId]:[])]);
  return op;
}

export async function claimEffect(sql:SQL,id:string,revision:number,allowPaused=false) {
  const s=await state(sql,true),op=await one(sql,'SELECT * FROM effect_operations WHERE id=$1 FOR UPDATE',[id]);
  if(!op||s.paused&&!allowPaused||s.memory_revision!==revision||op.revision!==revision)throw new ToolError('task_cancelled');
  if(op.phase==='observed')return {cached:true,result:op.result,operation:op};
  if(op.phase!=='reserved')throw new ToolError(op.phase==='cancelled'?'task_cancelled':'previous_tool_result_uncertain');
  if(op.action_id){
    const a=await one(sql,'SELECT * FROM commitments WHERE id=$1 FOR UPDATE',[op.action_id]);if(!a||a.revision!==revision||new Date(a.expires_at).getTime()<=Date.now()||!['executing','runnable','delivering'].includes(a.phase))throw new ToolError('action_unavailable');
    if(a.kind==='activity_launch'){
      const interaction=await one(sql,"SELECT id,participants FROM interactions WHERE action_id=$1 AND phase IN ('ready','active') AND revision=$2 AND expires_at>now()",[a.id,revision]);
      if(!interaction)throw new ToolError('action_consent_revoked');
      const grants=(await sql.query("SELECT actor_id FROM consent_grants WHERE action_id=$1 AND spec_hash=$2 AND decision IN ('agree','answer')",[a.id,a.spec_hash])).rows;
      if(interaction.participants.some((p:any)=>!grants.some(g=>g.actor_id===p.id)))throw new ToolError('action_consent_revoked');
    }
  }
  const attemptId=randomUUID();
  await sql.query("UPDATE effect_operations SET phase='dispatch_started',attempt_id=$1,dispatch_started_at=now(),updated_at=now() WHERE id=$2",[attemptId,id]);
  return {cached:false,operation:{...op,attempt_id:attemptId}};
}

export async function observeEffect(sql:SQL,id:string,result:unknown,revision:number,allowPaused=false) {
  const s=await state(sql,true),op=await one(sql,'SELECT * FROM effect_operations WHERE id=$1 FOR UPDATE',[id]);
  if(!op||s.memory_revision!==revision||s.paused&&!allowPaused||op.revision!==revision)return false;
  if(op.action_id){const a=await one(sql,'SELECT phase FROM commitments WHERE id=$1',[op.action_id]);if(!a||!['executing','runnable','delivering'].includes(a.phase))return false;}
  await sql.query("UPDATE effect_operations SET phase='observed',result=$1,updated_at=now() WHERE id=$2 AND phase='dispatch_started'",[JSON.stringify(result),id]);return true;
}

export async function recoverActionWork(db:Database) {
  await db.tx(async sql=>{
    const s=await state(sql,true);if(s.paused)return;
    await sql.query("UPDATE commitments SET phase='expired',state_version=state_version+1,updated_at=now() WHERE expires_at<=now() AND phase NOT IN ('completed','cancelled','expired','failed')");
    await sql.query("UPDATE action_work SET status='cancelled',payload='{}',plan=NULL WHERE revision<>$1 OR action_id IN (SELECT id FROM commitments WHERE phase IN ('cancelled','expired','completed','failed'))",[s.memory_revision]);
    const rows=(await sql.query("SELECT w.* FROM action_work w JOIN commitments a ON a.id=w.action_id WHERE w.status='pending' AND w.available_at<=now() AND w.revision=$1 AND a.phase='runnable' AND a.expires_at>now() ORDER BY w.created_at LIMIT 8",[s.memory_revision])).rows;
    for(const w of rows)await sql.query("INSERT INTO inbox(update_id,payload,revision,plan) VALUES($1,$2,$3,$4) ON CONFLICT(update_id) DO UPDATE SET status='pending',payload=excluded.payload,plan=excluded.plan,available_at=now() WHERE inbox.status IN ('failed','done')",[w.inbox_id,JSON.stringify({...w.payload,actionWorkId:w.id,actionId:w.action_id}),w.revision,w.plan?JSON.stringify(w.plan):null]);
  });
}

export async function recoverDispatches(sql:SQL) {
  // Called once after the previous process has relinquished the worker lease.
  await sql.query("UPDATE effect_operations SET phase='uncertain',error_code='process_interrupted_after_dispatch',updated_at=now() WHERE phase='dispatch_started'");
  await sql.query("UPDATE commitments SET phase='uncertain',error_code='process_interrupted_after_dispatch',state_version=state_version+1 WHERE id IN (SELECT action_id FROM effect_operations WHERE phase='uncertain') AND phase NOT IN ('cancelled','expired','completed')");
  await sql.query("UPDATE action_work SET status='pending',started_at=NULL WHERE status='running' AND action_id IN (SELECT id FROM commitments WHERE phase='executing')");
  await sql.query("UPDATE commitments SET phase='runnable' WHERE phase='executing' AND id IN (SELECT action_id FROM action_work WHERE status='pending')");
}
