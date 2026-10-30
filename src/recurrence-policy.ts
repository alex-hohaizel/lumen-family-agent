import {one,queueText,type SQL,type Row} from './db.js';
import {transferProvenance} from './provenance.js';
import {requestAuthorityView} from './outcomes.js';
import {loadOriginalRequestContext,type ValidatedOriginalRequest} from './request-context.js';

type Rule={mode:string;catch_up?:'latest'|'ask'|'skip'};
export type RecurringSeries<R extends Rule=Rule>=Row&{id:string;actor_id:string;topic_id:string;revision:number;status:string;rule:R;audience:'group'|'private';source_message_id?:number;occurrence_key?:string;occurrence_status?:string;occurrence_version?:number};

// Tasks keep the existing review requirement; "latest" only coalesces reminders.
export const catchUp=(rule:Rule)=>rule.catch_up==='skip'?'skip':rule.mode==='task'?'ask':rule.catch_up||'latest';
export async function missedNotice(sql:SQL,row:RecurringSeries,revision:number,key:string,count:number,version:number){
 await queueText(sql,`Після перерви ${count} пропущених ${row.rule.mode==='task'?'запусків задачі':'нагадувань'} чекають перегляду. Відкрий серію та перенеси потрібний запуск на майбутній час або пропусти його.`,revision,reviewKey(row.id,key,version),false,{actorId:row.actor_id,audience:row.audience,threadId:row.topic_id==='0'?undefined:Number(row.topic_id),sourceMessageId:row.source_message_id});
}
const reviewKey=(id:string,key:string,version:number)=>`series-review:${id}:${key}:v${version}`;

// A pending row is only a queue entry. Once execution, a tool run or an approval
// has begun, catch-up must not retroactively cancel or replay its effects.
const unstartedTask=`t.status='pending' AND t.step=0
 AND NOT EXISTS(SELECT 1 FROM task_events e WHERE e.task_id=t.id AND e.kind IN ('running','recurring_catch_up_resumed'))
 AND NOT EXISTS(SELECT 1 FROM tool_runs r WHERE r.task_id=t.id)
 AND NOT EXISTS(SELECT 1 FROM tool_approvals p WHERE p.task_id=t.id)`;

/** Call in a transaction holding app_state FOR UPDATE, before dispatch or claim. */
export async function settleScheduledCatchUp(sql:SQL,row:RecurringSeries,revision:number){
 const waiting=(await sql.query(`SELECT a.id,a.task_id,o.occurrence_key,o.coalesced_count,o.version
  FROM scheduled_actions a JOIN recurring_occurrences o ON o.schedule_id=a.id
  WHERE o.series_id=$1 AND o.status='scheduled' AND a.revision=$2
   AND a.author_id=$3 AND a.topic_id=$4 AND a.due_at<now()-interval '1 hour'
   AND (a.status='pending' OR (a.status='dispatched' AND EXISTS(
    SELECT 1 FROM agent_tasks t WHERE t.id=a.task_id AND t.revision=$2
     AND t.actor_id=$3 AND t.topic_id=$4 AND ${unstartedTask})))
  ORDER BY a.due_at,a.id FOR UPDATE OF a,o`,[row.id,revision,row.actor_id,row.topic_id])).rows;
 if(!waiting.length)return;
 const policy=catchUp(row.rule),last=waiting.at(-1)!,older=waiting.slice(0,-1);
 const count=waiting.reduce((n,x)=>n+Number(x.coalesced_count||1),0);
 const cancel=async(items:typeof waiting,occurrenceStatus:string)=>{
  if(!items.length)return;
  const ids=items.map(x=>x.id),tasks=items.flatMap(x=>x.task_id?[x.task_id]:[]);
  await sql.query("UPDATE scheduled_actions SET status='cancelled' WHERE id=ANY($1::uuid[])",[ids]);
  await sql.query('UPDATE recurring_occurrences SET status=$2 WHERE schedule_id=ANY($1::uuid[])',[ids,occurrenceStatus]);
  if(tasks.length)await sql.query("UPDATE agent_tasks SET status='cancelled',error_code='series_catch_up_skipped',updated_at=now() WHERE id=ANY($1::uuid[]) AND status='pending' AND step=0",[tasks]);
 };
 await cancel(older,'missed');
 if(policy==='skip')await cancel([last],'missed');
 else if(policy==='ask'){
  await sql.query("UPDATE scheduled_actions SET status='needs_input' WHERE id=$1",[last.id]);
  await sql.query("UPDATE recurring_occurrences SET status='needs_input' WHERE schedule_id=$1",[last.id]);
  if(last.task_id)await sql.query("UPDATE agent_tasks SET status='needs_input',error_code='series_catch_up_review',result='Цей запуск пропущено під час перерви. Перенеси його на майбутній час або пропусти у серії.',updated_at=now() WHERE id=$1 AND status='pending' AND step=0",[last.task_id]);
  await missedNotice(sql,row,revision,last.occurrence_key,count,last.version);
 }else if(older.length)await sql.query('UPDATE scheduled_actions SET instruction=instruction||$2 WHERE id=$1',[last.id,` (після перерви: ${count} повторів об’єднано)`]);
}

async function seriesForSchedule(sql:SQL,id:string){
 return (await sql.query<RecurringSeries>(`SELECT s.*,o.occurrence_key,o.status AS occurrence_status,o.version AS occurrence_version
  FROM recurring_occurrences o JOIN recurring_series s ON s.id=o.series_id
  WHERE o.schedule_id=$1 FOR UPDATE OF s,o`,[id])).rows[0];
}
function currentSeries(row:RecurringSeries,schedule:any,revision:number){
 return row.status==='active'&&row.revision===revision&&schedule.revision===revision
  &&row.actor_id===schedule.author_id&&row.topic_id===schedule.topic_id;
}
async function cancelUnstartedSchedule(sql:SQL,id:string){
 await sql.query("UPDATE scheduled_actions SET status='cancelled' WHERE id=$1 AND status IN ('pending','dispatched')",[id]);
 await sql.query("UPDATE recurring_occurrences SET status='cancelled' WHERE schedule_id=$1 AND status IN ('pending','scheduled')",[id]);
}
export const TASK_RESUME_HISTORY_LIMIT=64;
export async function taskResumeHistory(sql:SQL,task:any){
 return (await sql.query(`SELECT id,status,actor_id,arguments,result,revision,source_message_id,created_at,finished_at,provenance_version
  FROM tool_runs WHERE tool='tasks.resume' AND task_id IS NULL AND actor_id=$2
   AND lower(arguments->>'id')=lower($1) ORDER BY id DESC LIMIT ${TASK_RESUME_HISTORY_LIMIT+1}`,[String(task.id),task.actor_id])).rows;
}
/** A historical successful receipt may survive an unrelated revision; its live
 * source, target, returned goal version and canonical dependency edges may not. */
export async function actualTaskResumeContext(sql:SQL,task:any,run:Row,namespaceChatId:string,revision:number,audience:'group'|'private'):Promise<ValidatedOriginalRequest|undefined>{
 const version=run.result?.goal_version;
 if(run.status!=='succeeded'||run.actor_id!==task.actor_id||run.result?.id!==task.id||run.result?.status!=='pending'
  ||!Number.isSafeInteger(version)||version<1||version>Number(task.goal_version||1)
  ||!Number.isSafeInteger(Number(run.revision))||Number(run.revision)<0||Number(run.revision)>revision||Number(run.provenance_version)!==1
  ||!run.source_message_id||Number(run.source_message_id)===Number(task.source_message_id))return;
 const proof=await one(sql,`SELECT EXISTS(SELECT 1 FROM provenance_edges WHERE derived_kind='task' AND derived_key=$1 AND source_message_id=$2)
  AND EXISTS(SELECT 1 FROM provenance_edges WHERE derived_kind='tool_run' AND derived_key=$3 AND source_message_id=$2) AS complete`,[task.id,run.source_message_id,String(run.id)]);
 if(!proof?.complete)return;
 const source=await loadOriginalRequestContext(sql,{sourceId:Number(run.source_message_id),actorId:task.actor_id,topicId:task.topic_id,namespaceChatId,audience,revision});
 if(!source||source.forwarded||source.viaBot)return;
 const created=new Date(run.created_at).getTime(),finished=new Date(run.finished_at).getTime();
 if(!Number.isFinite(created)||!Number.isFinite(finished)||finished<created||created<source.receivedAt.getTime()||source.receivedAt.getTime()<new Date(task.created_at).getTime())return;
 return source;
}
function explicitResume(source:ValidatedOriginalRequest,id:string,boundReview:boolean){
 const {body,entities}=source,view=requestAuthorityView(body,entities);if(!view)return false;
 const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',ranges=[...view.quotedDataRanges,...view.codeDataRanges];
 let plain=view.commandText;
 // The common view removes every quoted imperative. Only a standalone UUID can
 // be restored as target DATA after a real outside imperative.
 for(const range of ranges){
  const data=body.slice(range.offset,range.offset+range.length);if(!new RegExp('^'+uuid+'$','iu').test(data))continue;
  if(ranges.some(other=>(other.offset!==range.offset||other.length!==range.length)&&other.offset<range.offset+range.length&&other.offset+other.length>range.offset))continue;
  plain=plain.slice(0,range.offset)+data+plain.slice(range.offset+range.length);
 }
 if(/[?？]/u.test(plain)||/(?:^|[\s,])(?:не|ні|нет|no|not|don['’]t)(?:[\s,.!?]|$)|переклад|перевед|перевод|translate|процит|якщо|если|\bif\b/iu.test(plain))return false;
 const imperative=/^(?:(?:люмене?|lumen|@\w+)[,!: ]*)?(?:(?:так|да|yes)[,!:\s]+)?(?:(?:будь ласка|пожалуйста|please)[,!:\s]+)?(?:продовжуй(?:те)?|виконай(?:те)?|запусти|запустіть|продолжай(?:те)?|выполни(?:те)?|resume|continue|run|execute)(?:[\s,!:]|$)\s*/iu;
 const target=new RegExp('^(?:(?:цю|це|цей|пропущену|пропущене|прострочену|прострочене|задачу|завдання|запуск|эту|это|этот|пропущенную|задание|task|job|the|this|missed|overdue)\\s+){0,8}(?:id[:#]?\\s*)?('+uuid+')(?=$|[^\\p{L}\\p{N}_-])','iu');
 for(const clause of plain.split(/[.!;\n]+/u)){
  const command=imperative.exec(clause.trim());if(!command)continue;
  const rest=clause.trim().slice(command[0].length),explicit=target.exec(rest)?.[1]?.toLowerCase();
  const ids=[...clause.matchAll(new RegExp(uuid,'giu'))].map(match=>match[0].toLowerCase());
  if(explicit){if(explicit===id.toLowerCase()&&ids.every(value=>value===id.toLowerCase()))return true;continue;}
  // An implicit current-review reference cannot override a different ID, even
  // when formatting masks that ID out of the authored instruction text.
  const currentObject=/^(?:(?:(?:цю|це|цей|this|the)\s+)?(?:задачу|завдання|запуск|task|job)|це|її|його|it)?(?:\s*(?:зараз|тепер|now))?$/iu.test(rest);
  if(boundReview&&currentObject&&![...body.matchAll(new RegExp(uuid,'giu'))].some(match=>match[0].toLowerCase()!==id.toLowerCase()))return true;
 }
 return false;
}

export async function prepareRecurringSchedule(sql:SQL,schedule:any,revision:number){
 const series=await seriesForSchedule(sql,schedule.id);
 if(!series){
  if(!String(schedule.dedup_key).startsWith('series:'))return {allowed:true,audience:undefined};
  await cancelUnstartedSchedule(sql,schedule.id);return {allowed:false,audience:undefined};
 }
 if(!currentSeries(series,schedule,revision)||series.occurrence_status!=='scheduled'){
  await cancelUnstartedSchedule(sql,schedule.id);return {allowed:false,audience:series.audience};
 }
 await settleScheduledCatchUp(sql,series,revision);
 const current=await one(sql,'SELECT status FROM scheduled_actions WHERE id=$1',[schedule.id]);
 return {allowed:current?.status==='pending',audience:series.audience};
}

export async function allowRecurringTaskClaim(sql:SQL,task:any,revision:number){
 const unstarted=await one(sql,`SELECT t.id FROM agent_tasks t WHERE t.id=$1 AND ${unstartedTask}`,[task.id]);
 if(!unstarted)return true;
 const schedule=await one(sql,'SELECT * FROM scheduled_actions WHERE task_id=$1 FOR UPDATE',[task.id]);
 if(!schedule)return true;
 const series=await seriesForSchedule(sql,schedule.id);
 if(!series){
  if(!String(schedule.dedup_key).startsWith('series:'))return true;
  await cancelUnstartedSchedule(sql,schedule.id);
  await sql.query("UPDATE agent_tasks SET status='cancelled',updated_at=now() WHERE id=$1 AND status='pending' AND step=0",[task.id]);
  return false;
 }
 // A new, successful foreground resume of this exact reviewed task is a new
 // instruction from its author. Tool approval for an external effect is not.
 if(currentSeries(series,schedule,revision)&&['needs_input','dispatched'].includes(schedule.status)&&series.occurrence_status==='needs_input'){
  const live=await one(sql,'SELECT chat_id FROM app_state WHERE id=1'),namespace=String(live!.chat_id),history=await taskResumeHistory(sql,task),resumed=history[0];
  const source=resumed&&resumed.result?.goal_version===Number(task.goal_version||1)?await actualTaskResumeContext(sql,task,resumed,namespace,revision,series.audience):undefined;
  const review=await one(sql,"SELECT * FROM outbox WHERE dedup_key=$1 AND actor_id=$2 AND revision=$3",[reviewKey(series.id,series.occurrence_key!,series.occurrence_version!)+':0',task.actor_id,revision]);
  const receipt=review?.body?.deliveryReceipt,reviewTime=review?new Date(review.created_at).getTime():NaN;
  const audience=series.audience==='private'||Number(namespace)>0?'private':'group',destination=audience==='private'?task.actor_id:namespace;
  const currentReview=Boolean(review&&review.kind==='text'&&review.audience===audience
   &&String(review.body?.scopeTopicId??review.body?.threadId??receipt?.scope_topic_id??'0')===task.topic_id
   &&Number(review.source_message_id)===Number(series.source_message_id));
  const deliveredReview=Boolean(review&&currentReview&&review.status==='sent'&&review.telegram_id&&receipt?.provider==='telegram'&&Number(receipt.message_id)===Number(review.telegram_id)
   &&receipt.actor_id===task.actor_id&&review.audience===audience&&receipt.audience===audience
   &&String(receipt.scope_topic_id)===task.topic_id&&String(receipt.source_chat_id)===namespace&&String(receipt.destination_chat_id)===destination
   &&Number(review.source_message_id)===Number(series.source_message_id)&&Number(receipt.source_message_id)===Number(series.source_message_id));
  const fresh=Boolean(source&&currentReview&&source.receivedAt.getTime()>=reviewTime&&source.createdAt.getTime()>=Math.floor(reviewTime/1000)*1000&&new Date(resumed!.created_at).getTime()>=reviewTime);
  const reply=source?.replyRef,boundReview=Boolean(fresh&&deliveredReview&&reply?.from_is_bot&&reply.from_id&&reply.message_id===Number(review!.telegram_id)&&reply.chat_id===source!.transportChatId&&reply.chat_id===String(receipt.destination_chat_id));
  if(resumed&&source&&fresh&&explicitResume(source,task.id,boundReview)){
   await sql.query("UPDATE scheduled_actions SET status='dispatched' WHERE id=$1",[schedule.id]);
   await sql.query("UPDATE recurring_occurrences SET status='scheduled' WHERE schedule_id=$1",[schedule.id]);
   if(series.audience==='private')await sql.query("UPDATE agent_tasks SET audience='private' WHERE id=$1",[task.id]);
   await transferProvenance(sql,'tool_run',resumed.id,'task',task.id);
   await sql.query("INSERT INTO task_events(task_id,goal_version,kind,detail) VALUES($1,$2,'recurring_catch_up_resumed',$3)",[task.id,task.goal_version,JSON.stringify({tool_run_id:resumed.id,series_id:series.id,occurrence_key:series.occurrence_key})]);
   return true;
  }
  await sql.query("UPDATE scheduled_actions SET status='needs_input' WHERE id=$1 AND status='dispatched'",[schedule.id]);
  await sql.query("UPDATE agent_tasks SET status='needs_input',error_code='series_catch_up_review',result='Цей пропущений запуск поки не виконував. Можеш прямо попросити виконати його зараз, перенести або пропустити.',updated_at=now() WHERE id=$1 AND status='pending' AND step=0",[task.id]);
  return false;
 }
 if(!currentSeries(series,schedule,revision)||schedule.status!=='dispatched'||series.occurrence_status!=='scheduled'){
  await cancelUnstartedSchedule(sql,schedule.id);
  await sql.query("UPDATE agent_tasks SET status='cancelled',updated_at=now() WHERE id=$1 AND status='pending' AND step=0",[task.id]);
  return false;
 }
 if(series.audience==='private')await sql.query("UPDATE agent_tasks SET audience='private' WHERE id=$1",[task.id]);
 await settleScheduledCatchUp(sql,series,revision);
 const current=await one(sql,'SELECT status FROM agent_tasks WHERE id=$1',[task.id]);
 return current?.status==='pending';
}
