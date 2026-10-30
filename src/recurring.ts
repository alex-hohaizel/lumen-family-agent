import {Temporal} from '@js-temporal/polyfill';
import {z} from 'zod';
import {one,state,queueText,type Database,type SQL} from './db.js';
import {command,digest,requireVersion,sourceIds} from './evolution-core.js';
import {recordProvenance,transferProvenance} from './provenance.js';
import {stableId} from './operations.js';
import {ToolError} from './safe-http.js';
import type {ToolContext} from './agent-tools.js';
export const SeriesRule=z.object({title:z.string().min(2).max(160),instruction:z.string().min(3).max(4000),mode:z.enum(['reminder','task']).default('reminder'),timezone:z.string().min(3).max(80),start_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),frequency:z.enum(['daily','weekly','monthly']),interval:z.number().int().min(1).max(12).default(1),weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),until:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),count:z.number().int().min(1).max(3660).optional(),dst:z.enum(['reject','earlier','later','skip']).default('reject'),catch_up:z.enum(['latest','ask','skip']).optional()});
export const SeriesCommand=z.object({operation:z.enum(['preview','confirm','list','read','skip','move','revise','end']),id:z.string().uuid().optional(),version:z.number().int().positive().optional(),rule:SeriesRule.optional(),occurrence_key:z.string().max(80).optional(),move_to:z.string().datetime({offset:true}).optional()});
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
function window(rule:Rule,after:string,now:number,count:number){const future=[],missed=[];for(const item of occurrenceStream(rule,after)){if(Date.parse(item.due)<now-3600000)missed.push(item);else{future.push(item);if(future.length>=count)break;}}return [...(missed.length?[{...missed.at(-1)!,coalesced_count:missed.length}]:[]),...future.map(x=>({...x,coalesced_count:1}))];}
const catchUp=(rule:Rule)=>rule.catch_up==='skip'?'skip':rule.mode==='task'?'ask':rule.catch_up||'latest';
async function missedNotice(sql:SQL,row:any,revision:number,key:string,count:number){await queueText(sql,`Після перерви ${count} пропущених ${row.rule.mode==='task'?'запусків задачі':'нагадувань'} чекають перегляду. Відкрий серію та перенеси потрібний запуск на майбутній час або пропусти його.`,revision,'series-review:'+row.id+':'+key,false,{actorId:row.actor_id,audience:row.audience,threadId:row.topic_id==='0'?undefined:Number(row.topic_id),sourceMessageId:row.source_message_id});}
export class Recurring {
 private nextAt=0;constructor(private db:Database){}
 async run(a:z.infer<typeof SeriesCommand>,c:ToolContext):Promise<any>{
  if(a.operation==='list')return (await this.db.query('SELECT id,version,rule,status FROM recurring_series WHERE actor_id=$1 AND topic_id=$2 ORDER BY created_at DESC LIMIT 20',[c.actorId,c.topicId])).rows;
  if(a.operation==='preview'){if(!a.rule)throw new ToolError('series_rule_required');const dates=occurrences(a.rule,new Date(Date.now()-1).toISOString(),3);if(!dates.length)throw new ToolError('series_no_future_occurrences');return command(this.db,c,'series_preview',a,async(sql,id)=>{await sql.query('INSERT INTO recurring_series(id,actor_id,topic_id,rule,revision,source_message_id,audience) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,c.actorId,c.topicId,JSON.stringify(a.rule),c.revision,c.sourceId||null,c.audience||'group']);await recordProvenance(sql,'series',id,sourceIds(c));return {id,version:1,status:'draft',next_three:dates,catch_up:catchUp(a.rule!),notice:'Перевір місцеві дати й години, правило завершення та поведінку під час зміни часу. confirm активує саме цю редакцію.'};});}
  if(a.operation==='read'){const row=await one(this.db,'SELECT id,version,rule,status FROM recurring_series WHERE id=$1 AND actor_id=$2 AND topic_id=$3',[a.id,c.actorId,c.topicId]);if(!row)throw new ToolError('own_series_required');return {...row,next_three:occurrences(row.rule,new Date().toISOString(),3),occurrences:(await this.db.query('SELECT occurrence_key,due_at,status,schedule_id FROM recurring_occurrences WHERE series_id=$1 ORDER BY due_at DESC LIMIT 12',[row.id])).rows};}
  return command(this.db,c,'series_change',a,async sql=>{const row=await one(sql,'SELECT * FROM recurring_series WHERE id=$1 AND actor_id=$2 AND topic_id=$3 FOR UPDATE',[a.id,c.actorId,c.topicId]);if(!row)throw new ToolError('own_series_required');requireVersion(row.version,a.version);
   if(a.operation==='confirm'){if(row.status!=='draft')throw new ToolError('series_draft_required');occurrences(row.rule,new Date().toISOString(),3);await sql.query("UPDATE recurring_series SET status='active',version=version+1 WHERE id=$1",[row.id]);}
   if(a.operation==='revise'||a.operation==='end'){
    if(a.operation==='revise'&&!a.rule)throw new ToolError('series_rule_required');if(a.rule)occurrences(a.rule,new Date().toISOString(),3);
    const ids=(await sql.query("UPDATE scheduled_actions SET status='cancelled' WHERE id IN (SELECT schedule_id FROM recurring_occurrences WHERE series_id=$1 AND status IN ('pending','scheduled')) AND status IN ('pending','awaiting_confirmation','queued') RETURNING id",[row.id])).rows.map(x=>x.id);if(ids.length)await sql.query("UPDATE outbox SET status='cleared' WHERE status='pending' AND split_part(dedup_key,':',2)=ANY($1::text[])",[ids]);
    await sql.query("UPDATE recurring_occurrences SET status='cancelled' WHERE series_id=$1 AND status IN ('pending','scheduled')",[row.id]);if(a.operation==='revise')await sql.query("DELETE FROM recurring_occurrences WHERE series_id=$1 AND status='cancelled' AND due_at>now()",[row.id]);await sql.query('UPDATE recurring_series SET rule=$2,status=$3,version=version+1,confirmed_at=NULL,last_materialized=NULL WHERE id=$1',[row.id,JSON.stringify(a.rule||row.rule),a.operation==='end'?'ended':'draft']);
   }
   if(a.operation==='skip'||a.operation==='move'){
    const occurrence=await one(sql,'SELECT * FROM recurring_occurrences WHERE series_id=$1 AND occurrence_key=$2 FOR UPDATE',[row.id,a.occurrence_key]);if(!occurrence||!['pending','scheduled','needs_input'].includes(occurrence.status))throw new ToolError('future_occurrence_required');if(occurrence.schedule_id){const old=await one(sql,'SELECT status FROM scheduled_actions WHERE id=$1',[occurrence.schedule_id]);if(!old||!['pending','awaiting_confirmation','queued','needs_input'].includes(old.status))throw new ToolError('occurrence_already_dispatched');await sql.query("UPDATE scheduled_actions SET status='cancelled' WHERE id=$1",[occurrence.schedule_id]);await sql.query("UPDATE outbox SET status='cleared' WHERE status='pending' AND dedup_key LIKE $1",['scheduled:'+occurrence.schedule_id+':%']);}
    if(a.operation==='move'&&(!a.move_to||Date.parse(a.move_to)<Date.now()+5000))throw new ToolError('future_move_time_required');await sql.query('UPDATE recurring_occurrences SET status=$3,due_at=COALESCE($4::timestamptz,due_at),schedule_id=NULL,version=version+1 WHERE series_id=$1 AND occurrence_key=$2',[row.id,a.occurrence_key,a.operation==='skip'?'skipped':'pending',a.move_to||null]);await sql.query('UPDATE recurring_series SET version=version+1 WHERE id=$1',[row.id]);
   }return {id:row.id,version:row.version+1,status:a.operation==='revise'?'draft':a.operation==='end'?'ended':a.operation==='confirm'?'active':row.status};
  });
 }
 async tick(now=Date.now()){
  if(now<this.nextAt)return false;this.nextAt=now+30000;
  return this.db.tx(async sql=>{const s=await state(sql,true);if(s.paused)return false;const series=(await sql.query("SELECT * FROM recurring_series WHERE status='active' AND revision=$1 ORDER BY next_check LIMIT 20 FOR UPDATE SKIP LOCKED",[s.memory_revision])).rows;
   for(const row of series){
    await sql.query("UPDATE recurring_occurrences o SET status=a.status FROM scheduled_actions a WHERE o.series_id=$1 AND o.schedule_id=a.id AND a.status IN ('completed','cancelled','failed','needs_input')",[row.id]);
    const future=Number((await one(sql,"SELECT count(*) AS n FROM recurring_occurrences WHERE series_id=$1 AND due_at>now() AND status IN ('pending','scheduled','skipped')",[row.id]))!.n);
    if(future<10){const after=row.last_materialized?new Date(row.last_materialized).toISOString():new Date(row.created_at).toISOString();let next;try{next=window(row.rule,after,now,10-future);}catch{await sql.query("UPDATE recurring_series SET status='needs_input' WHERE id=$1",[row.id]);continue;}
     for(const item of next)await sql.query('INSERT INTO recurring_occurrences(series_id,occurrence_key,due_at,status,coalesced_count) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[row.id,item.key,item.due,item.skipped?'skipped':'pending',item.coalesced_count]);if(next.length)await sql.query("UPDATE recurring_series SET last_materialized=$2,next_check=now()+interval '30 seconds' WHERE id=$1",[row.id,next.at(-1)!.due]);
    }

    const waiting=(await sql.query("SELECT a.id,o.occurrence_key FROM scheduled_actions a JOIN recurring_occurrences o ON o.schedule_id=a.id WHERE o.series_id=$1 AND a.status='pending' AND a.due_at<now()-interval '1 hour' ORDER BY a.due_at",[row.id])).rows;
    const policy=catchUp(row.rule);
    if(waiting.length){const older=waiting.slice(0,-1).map(x=>x.id),last=waiting.at(-1)!;if(older.length){await sql.query("UPDATE scheduled_actions SET status='cancelled' WHERE id=ANY($1::uuid[])",[older]);await sql.query("UPDATE recurring_occurrences SET status='missed' WHERE schedule_id=ANY($1::uuid[])",[older]);}
     if(policy!=='latest'){await sql.query('UPDATE scheduled_actions SET status=$2 WHERE id=$1',[last.id,policy==='ask'?'needs_input':'cancelled']);await sql.query('UPDATE recurring_occurrences SET status=$2 WHERE schedule_id=$1',[last.id,policy==='ask'?'needs_input':'missed']);if(policy==='ask')await missedNotice(sql,row,s.memory_revision,last.occurrence_key,waiting.length);}
     else if(waiting.length>1)await sql.query("UPDATE scheduled_actions SET instruction=instruction||$2 WHERE id=$1",[last.id,` (після перерви: ${waiting.length} повторів об’єднано)`]);
    }
    const due=(await sql.query("SELECT * FROM recurring_occurrences WHERE series_id=$1 AND status='pending' AND due_at<=now()+interval '1 day' ORDER BY due_at LIMIT 20",[row.id])).rows;const missed=due.filter(x=>new Date(x.due_at).getTime()<now-3600000),missedCount=missed.reduce((n,x)=>n+Number(x.coalesced_count||1),0);if(missed.length>1)await sql.query("UPDATE recurring_occurrences SET status='missed' WHERE series_id=$1 AND occurrence_key=ANY($2::text[])",[row.id,missed.slice(0,-1).map(x=>x.occurrence_key)]);
    for(const item of due.filter(x=>!missed.slice(0,-1).includes(x))){if(missed.includes(item)&&policy!=='latest'){await sql.query('UPDATE recurring_occurrences SET status=$3 WHERE series_id=$1 AND occurrence_key=$2',[row.id,item.occurrence_key,policy==='ask'?'needs_input':'missed']);if(policy==='ask')await missedNotice(sql,row,s.memory_revision,item.occurrence_key,missedCount);continue;}const id=stableId('series:'+row.id+':'+item.occurrence_key+':'+item.version),rule=row.rule;
     await sql.query("INSERT INTO scheduled_actions(id,dedup_key,author_id,topic_id,title,instruction,mode,due_at,timezone,status,action_hash,revision,source_message_id,expires_at,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,now()+interval '1 day',now()) ON CONFLICT(dedup_key) DO NOTHING",[id,'series:'+id,row.actor_id,row.topic_id,rule.title,rule.instruction+(missedCount>1&&item===missed.at(-1)?` (після перерви об’єднано ${missedCount} пропущених повторів)`:'') ,rule.mode,item.due_at,rule.timezone,digest({rule,occurrence:item.occurrence_key}),s.memory_revision,row.source_message_id]);await transferProvenance(sql,'series',row.id,'schedule',id);await sql.query("UPDATE recurring_occurrences SET status='scheduled',schedule_id=$3 WHERE series_id=$1 AND occurrence_key=$2",[row.id,item.occurrence_key,id]);
    }
   }return Boolean(series.length);
  });
 }
}
