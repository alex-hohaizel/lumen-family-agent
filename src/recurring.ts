import {Temporal} from '@js-temporal/polyfill';
import {z} from 'zod';
import {one,state,type Database,type SQL} from './db.js';
import {command,digest,requireVersion,sourceIds} from './evolution-core.js';
import {recordProvenance,transferProvenance} from './provenance.js';
import {stableId} from './operations.js';
import {ToolError} from './safe-http.js';
import type {ToolContext} from './agent-tools.js';
import {catchUp,missedNotice,settleScheduledCatchUp,type RecurringSeries} from './recurrence-policy.js';
import {reminderMetadata,reminderRequestSource,canManageReminder,stopSeries,cancelReminderRequest,type ReminderContext} from './reminder-control.js';
import {provesCommand} from './personalization.js';
import {requestAuthorityView} from './outcomes.js';
export const SeriesRule=z.object({title:z.string().min(2).max(160),instruction:z.string().min(3).max(4000),mode:z.enum(['reminder','task']).default('reminder'),timezone:z.string().min(3).max(80),start_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),frequency:z.enum(['daily','weekly','monthly']),interval:z.number().int().min(1).max(12).default(1),weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),until:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),count:z.number().int().min(1).max(3660).optional(),dst:z.enum(['reject','earlier','later','skip']).default('reject'),catch_up:z.enum(['latest','ask','skip']).optional()});
export const SeriesCommand=z.object({operation:z.enum(['create','preview','confirm','list','read','skip','move','revise','end']),id:z.string().uuid().optional(),version:z.number().int().positive().optional(),rule:SeriesRule.optional(),occurrence_key:z.string().max(80).optional(),move_to:z.string().datetime({offset:true}).optional(),quote:z.string().min(2).max(2500).optional(),shared:z.boolean().optional()});
type Rule=z.infer<typeof SeriesRule>;
function* occurrenceStream(rule:Rule,after:string){
 const start=Temporal.PlainDate.from(rule.start_date),cut=Date.parse(after);let date=start,n=0;
 for(let steps=0;steps<37000;steps++,date=date.add({days:1})){
  if(rule.until&&Temporal.PlainDate.compare(date,rule.until)>0)break;const days=start.until(date).days,monthDiff=(date.year-start.year)*12+date.month-start.month;
  const valid=rule.frequency==='daily'?days%rule.interval===0:rule.frequency==='weekly'?Math.floor(days/7)%rule.interval===0&&(rule.weekdays||[start.dayOfWeek]).includes(date.dayOfWeek):monthDiff%rule.interval===0&&date.day===start.day;
  if(!valid)continue;if(rule.count!==undefined&&n>=rule.count)break;n++;const local=date.toString()+'T'+rule.time;let due:string,skipped=false;
  try{due=date.toPlainDateTime(rule.time).toZonedDateTime(rule.timezone,{disambiguation:'reject'}).toInstant().toString();}
  catch{if(rule.dst==='reject')throw new ToolError('series_dst_choice_required');if(rule.dst==='skip'){due=date.toPlainDateTime('12:00').toZonedDateTime(rule.timezone).toInstant().toString();skipped=true;}else due=date.toPlainDateTime(rule.time).toZonedDateTime(rule.timezone,{disambiguation:rule.dst}).toInstant().toString();}
  if(Date.parse(due)>cut)yield {key:local,local,due,skipped};
 }
}
export function occurrences(rule:Rule,after:string,count=3){const result=[];for(const item of occurrenceStream(rule,after)){result.push(item);if(result.length>=count)break;}return result;}
export function nextUnreservedOccurrence(rule:Rule,after:string,reserved:ReadonlySet<string>){for(const item of occurrenceStream(rule,after))if(!reserved.has(item.key))return item;}
function window(rule:Rule,after:string,now:number,count:number){const future=[],missed=[];for(const item of occurrenceStream(rule,after)){if(Date.parse(item.due)<now-3600000)missed.push(item);else{future.push(item);if(future.length>=count)break;}}return [...(missed.length?[{...missed.at(-1)!,coalesced_count:missed.length}]:[]),...future.map(x=>({...x,coalesced_count:1}))];}
/** SQL-native entry for a clear requested reminder; caller owns the transaction. */
export async function createReminderSeries(sql:SQL,input:Rule,c:ToolContext,options:{quote:string;shared?:boolean}){
 const rule=SeriesRule.parse(input);if(rule.mode!=='reminder')throw new ToolError('series_task_requires_confirmation');
 const live=await state(sql,true);if(live.paused||live.memory_revision!==c.revision)throw new ToolError('task_cancelled');
 const source=await reminderRequestSource(sql,c),text=source?.body||'';
 const authored=requestAuthorityView(text,source?.entities||[])?.commandText||'';
 if(!source||!provesCommand(text,options.quote)||!/(?:нагад|напом(?:н|ин)|remind)/iu.test(authored)||/(?<![\p{L}\p{N}])(?:не|don't|do\s+not)\s+(?:нагад|напом(?:н|ин)|remind)/iu.test(authored))throw new ToolError('series_request_unconfirmed');
 const repeat=rule.frequency==='daily'?/щодн|щоден|кожн[\p{L}]*\s+(?:\d+\s+)?дн|ежеднев|кажд[\p{L}]*\s+(?:\d+\s+)?д[её]н|every\s+(?:\d+\s+)?day|daily/iu:rule.frequency==='weekly'?/щотиж|кожн[\p{L}]*\s+(?:\d+\s+)?тиж|еженедел|кажд[\p{L}]*\s+(?:\d+\s+)?недел|every\s+(?:\d+\s+)?week|weekly/iu:/щоміс|кожн[\p{L}]*\s+(?:\d+\s+)?міс|ежемесяч|кажд[\p{L}]*\s+(?:\d+\s+)?месяц|every\s+(?:\d+\s+)?month|monthly/iu;
 if(!repeat.test(authored))throw new ToolError('series_repeat_request_required');
 const metadata=await reminderMetadata(sql,c,options),dates=occurrences(rule,new Date(Date.now()-1).toISOString(),3);
 if(!dates.length)throw new ToolError('series_no_future_occurrences');
 // A model may revisit the same operation under a different tool-step key.
 // The original request/interaction owns the reminder, not that transport step.
 const origin=c.interactionId?`interaction:${c.interactionId}:${c.interactionVersion||1}`:`source:${c.actorId}:${c.sourceId}`;
 const key=`reminder-series:${origin}:${digest(rule)}`;
 const id=stableId(key),previous=await one(sql,'SELECT * FROM recurring_series WHERE id=$1 FOR UPDATE',[id]);
 if(previous){
  if(previous.actor_id!==c.actorId||previous.topic_id!==c.topicId||previous.revision!==c.revision||digest(previous.rule)!==digest(rule)||previous.audience!==metadata.audience||previous.shared!==metadata.shared||digest(previous.manager_ids)!==digest(metadata.manager_ids))throw new ToolError('operation_key_conflict');
  return {id,version:previous.version,status:previous.status,shared:previous.shared,manager_ids:previous.manager_ids,next_three:dates};
 }
 await sql.query("INSERT INTO recurring_series(id,actor_id,topic_id,rule,revision,source_message_id,audience,shared,manager_ids,status,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',now())",[id,c.actorId,c.topicId,JSON.stringify(rule),c.revision,c.sourceId,metadata.audience,metadata.shared,JSON.stringify(metadata.manager_ids)]);
 await recordProvenance(sql,'series',id,sourceIds(c));
 return {id,version:1,status:'active',shared:metadata.shared,manager_ids:metadata.manager_ids,next_three:dates};
}
export class Recurring {
 private nextAt=0;constructor(private db:Database){}
 async run(a:z.infer<typeof SeriesCommand>,c:ToolContext):Promise<any>{
  if(a.operation==='list'||a.operation==='read'){const live=await state(this.db);if(live.paused||live.memory_revision!==c.revision)throw new ToolError('task_cancelled');}
  if(a.operation==='list')return (await this.db.query("SELECT * FROM recurring_series WHERE topic_id=$1 AND revision=$2 AND (actor_id=$3 OR (shared=true AND audience='group' AND rule->>'mode'='reminder' AND (manager_ids ? $3 OR $4::boolean))) ORDER BY created_at DESC LIMIT 20",[c.topicId,c.revision,c.actorId,Boolean((c as ReminderContext).administrator)])).rows.filter(row=>canManageReminder(row,c));
  if(a.operation==='create'){if(!a.rule||!a.quote)throw new ToolError('series_rule_and_quote_required');return command(this.db,c,'series_create',a,sql=>createReminderSeries(sql,a.rule!,c,{quote:a.quote!,shared:a.shared}));}
  if(a.operation==='preview'){if(!a.rule)throw new ToolError('series_rule_required');const dates=occurrences(a.rule,new Date(Date.now()-1).toISOString(),3);if(!dates.length)throw new ToolError('series_no_future_occurrences');return command(this.db,c,'series_preview',a,async(sql,id)=>{await sql.query('INSERT INTO recurring_series(id,actor_id,topic_id,rule,revision,source_message_id,audience) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,c.actorId,c.topicId,JSON.stringify(a.rule),c.revision,c.sourceId||null,c.audience||'group']);await recordProvenance(sql,'series',id,sourceIds(c));return {id,version:1,status:'draft',next_three:dates,catch_up:catchUp(a.rule!),notice:'Перевір місцеві дати й години, правило завершення та поведінку під час зміни часу. confirm активує саме цю редакцію.'};});}
  if(a.operation==='read'){const row=await one(this.db,'SELECT * FROM recurring_series WHERE id=$1 AND topic_id=$2 AND revision=$3',[a.id,c.topicId,c.revision]);if(!row||!canManageReminder(row,c))throw new ToolError('own_series_required');return {...row,next_three:occurrences(row.rule,new Date().toISOString(),3),occurrences:(await this.db.query('SELECT occurrence_key,due_at,status,schedule_id FROM recurring_occurrences WHERE series_id=$1 ORDER BY due_at DESC LIMIT 12',[row.id])).rows};}
  if(a.operation==='end')return command(this.db,c,'series_change',a,async sql=>{
   const row=await one(sql,'SELECT * FROM recurring_series WHERE id=$1 AND topic_id=$2 AND revision=$3 FOR UPDATE',[a.id,c.topicId,c.revision]);
   const ownPrivateId=Boolean(a.id&&c.requestText?.toLowerCase().includes(a.id.toLowerCase()));
   const manageable=row&&canManageReminder(row,c,ownPrivateId);
   const visible=row&&!manageable&&row.audience==='group'?await (await import('./reminder-consent.js')).visibleConsentReminderCandidates(sql,c,{id:a.id}):[];
   // Do not expose another person's private existence/version as an oracle.
   if(!row||!manageable&&!visible.some(item=>item.ref==='series:'+row.id))return {id:a.id,status:'not_found',notice:'Доступної тобі серії в цій темі не знайшов.'};
   requireVersion(row.version,a.version);
   const result=await cancelReminderRequest(sql,{text:c.requestText||'',id:a.id,scope:'series'},c);
   const ended=result.status==='cancelled'||result.status==='stopped_with_in_flight';
   return {...result,id:a.id,...(ended?{status:'ended',version:a.version!+1}:{}),...(result.inFlight?{in_flight:result.inFlight}:{}),notice:result.message||'Не маю підтвердженого прохання зупинити цю серію.'};
  });
  return command(this.db,c,'series_change',a,async sql=>{const row=await one(sql,'SELECT * FROM recurring_series WHERE id=$1 AND topic_id=$2 AND revision=$3 FOR UPDATE',[a.id,c.topicId,c.revision]);if(!row||!canManageReminder(row,c)||a.operation!=='end'&&row.actor_id!==c.actorId)throw new ToolError('own_series_required');requireVersion(row.version,a.version);
   if(a.operation==='confirm'){if(row.status!=='draft')throw new ToolError('series_draft_required');occurrences(row.rule,new Date().toISOString(),3);await sql.query("UPDATE recurring_series SET status='active',version=version+1 WHERE id=$1",[row.id]);}
   if(a.operation==='revise'||a.operation==='end'){
    if(a.operation==='revise'&&!a.rule)throw new ToolError('series_rule_required');if(a.rule)occurrences(a.rule,new Date().toISOString(),3);
    const stopped=await stopSeries(sql,row);if(a.operation==='end'&&stopped.inFlight)row.in_flight=stopped.inFlight;
    if(a.operation==='revise')await sql.query("DELETE FROM recurring_occurrences WHERE series_id=$1 AND status='cancelled' AND due_at>now()",[row.id]);await sql.query('UPDATE recurring_series SET rule=$2,status=$3,version=version+1,confirmed_at=NULL,last_materialized=NULL WHERE id=$1',[row.id,JSON.stringify(a.rule||row.rule),a.operation==='end'?'ended':'draft']);
   }
   if(a.operation==='skip'||a.operation==='move'){
    const occurrence=await one(sql,'SELECT * FROM recurring_occurrences WHERE series_id=$1 AND occurrence_key=$2 FOR UPDATE',[row.id,a.occurrence_key]);if(!occurrence||!['pending','scheduled','needs_input'].includes(occurrence.status))throw new ToolError('future_occurrence_required');if(occurrence.schedule_id){const old=await one(sql,'SELECT status FROM scheduled_actions WHERE id=$1',[occurrence.schedule_id]);if(!old||!['pending','awaiting_confirmation','queued','needs_input'].includes(old.status))throw new ToolError('occurrence_already_dispatched');await sql.query("UPDATE scheduled_actions SET status='cancelled' WHERE id=$1",[occurrence.schedule_id]);await sql.query("UPDATE outbox SET status='cleared' WHERE status='pending' AND dedup_key LIKE $1",['scheduled:'+occurrence.schedule_id+':%']);}
    if(a.operation==='move'&&(!a.move_to||Date.parse(a.move_to)<Date.now()+5000))throw new ToolError('future_move_time_required');await sql.query('UPDATE recurring_occurrences SET status=$3,due_at=COALESCE($4::timestamptz,due_at),schedule_id=NULL,version=version+1 WHERE series_id=$1 AND occurrence_key=$2',[row.id,a.occurrence_key,a.operation==='skip'?'skipped':'pending',a.move_to||null]);await sql.query('UPDATE recurring_series SET version=version+1 WHERE id=$1',[row.id]);
   }return {id:row.id,version:row.version+1,status:a.operation==='revise'?'draft':a.operation==='end'?'ended':a.operation==='confirm'?'active':row.status,...(row.in_flight?{in_flight:row.in_flight,notice:'Майбутні повтори зупинено; один із запусків уже розпочато або його доставку ще не підтверджено.'}:{})};
  });
 }
 async tick(now=Date.now()){
  if(now<this.nextAt)return false;this.nextAt=now+30000;
  return this.db.tx(async sql=>{const s=await state(sql,true);if(s.paused)return false;const series=(await sql.query<RecurringSeries<Rule>>("SELECT * FROM recurring_series WHERE status='active' AND revision=$1 ORDER BY next_check LIMIT 20 FOR UPDATE SKIP LOCKED",[s.memory_revision])).rows;
   for(const row of series){
    await sql.query("UPDATE recurring_occurrences o SET status=a.status FROM scheduled_actions a WHERE o.series_id=$1 AND o.schedule_id=a.id AND o.status IN ('pending','scheduled','needs_input') AND a.status IN ('completed','cancelled','failed','needs_input')",[row.id]);
    const future=Number((await one(sql,"SELECT count(*) AS n FROM recurring_occurrences WHERE series_id=$1 AND due_at>now() AND status IN ('pending','scheduled','skipped')",[row.id]))!.n);
    if(future<10){const after=row.last_materialized?new Date(row.last_materialized).toISOString():new Date(row.created_at).toISOString();let next;try{next=window(row.rule,after,now,10-future);}catch{await sql.query("UPDATE recurring_series SET status='needs_input' WHERE id=$1",[row.id]);continue;}
     for(const item of next)await sql.query('INSERT INTO recurring_occurrences(series_id,occurrence_key,due_at,status,coalesced_count) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[row.id,item.key,item.due,item.skipped?'skipped':'pending',item.coalesced_count]);if(next.length)await sql.query("UPDATE recurring_series SET last_materialized=$2,next_check=now()+interval '30 seconds' WHERE id=$1",[row.id,next.at(-1)!.due]);
    }

    const policy=catchUp(row.rule);
    await settleScheduledCatchUp(sql,row,s.memory_revision);
    const due=(await sql.query("SELECT * FROM recurring_occurrences WHERE series_id=$1 AND status='pending' AND due_at<=now()+interval '1 day' ORDER BY due_at LIMIT 20",[row.id])).rows;const missed=due.filter(x=>new Date(x.due_at).getTime()<now-3600000),missedCount=missed.reduce((n,x)=>n+Number(x.coalesced_count||1),0);if(missed.length>1)await sql.query("UPDATE recurring_occurrences SET status='missed' WHERE series_id=$1 AND occurrence_key=ANY($2::text[])",[row.id,missed.slice(0,-1).map(x=>x.occurrence_key)]);
    for(const item of due.filter(x=>!missed.slice(0,-1).includes(x))){if(missed.includes(item)&&policy!=='latest'){await sql.query('UPDATE recurring_occurrences SET status=$3 WHERE series_id=$1 AND occurrence_key=$2',[row.id,item.occurrence_key,policy==='ask'?'needs_input':'missed']);if(policy==='ask')await missedNotice(sql,row,s.memory_revision,item.occurrence_key,missedCount,item.version);continue;}const id=stableId('series:'+row.id+':'+item.occurrence_key+':'+item.version),rule=row.rule;
     await sql.query("INSERT INTO scheduled_actions(id,dedup_key,author_id,topic_id,title,instruction,mode,due_at,timezone,status,action_hash,revision,source_message_id,expires_at,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,now()+interval '1 day',now()) ON CONFLICT(dedup_key) DO NOTHING",[id,'series:'+id,row.actor_id,row.topic_id,rule.title,rule.instruction+(missedCount>1&&item===missed.at(-1)?` (після перерви об’єднано ${missedCount} пропущених повторів)`:'') ,rule.mode,item.due_at,rule.timezone,digest({rule,occurrence:item.occurrence_key}),s.memory_revision,row.source_message_id]);await transferProvenance(sql,'series',row.id,'schedule',id);await sql.query("UPDATE recurring_occurrences SET status='scheduled',schedule_id=$3 WHERE series_id=$1 AND occurrence_key=$2",[row.id,item.occurrence_key,id]);
    }
   }return Boolean(series.length);
  });
 }
}
