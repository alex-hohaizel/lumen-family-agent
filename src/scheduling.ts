import {z} from 'zod';
import {createHash,randomUUID} from 'node:crypto';
import {one,state,queueText,type SQL,type Database} from './db.js';
import {provesCommand,bareIntent} from './personalization.js';
import type {Message} from './telegram.js';
import {recordProvenance} from './provenance.js';
import {taskCompletionCriteria} from './result-verifier.js';
import {prepareRecurringSchedule} from './recurrence-policy.js';

export const ScheduleSchema=z.object({kind:z.literal('schedule'),title:z.string().min(2).max(160),instruction:z.string().min(3).max(6000),mode:z.enum(['reminder','task']),due_at:z.string().datetime({offset:true}),local_time:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),timezone:z.string().min(3).max(80),authorization:z.enum(['explicit','ask']).default('ask'),quote:z.string().min(2).max(2500)});
export const ScheduleDecisionSchema=z.object({kind:z.literal('schedule_decision'),id:z.string().uuid(),decision:z.enum(['confirm','cancel']),quote:z.string().min(2).max(1000)});
type Schedule=z.infer<typeof ScheduleSchema>;
const fail=(code:string)=>Object.assign(Error(code),{code});
function when(due:string|Date,timezone:string){return new Intl.DateTimeFormat('uk-UA',{timeZone:timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(due))+' ('+timezone+')';}
function validTime(due:string,timezone:string,now=Date.now()){try{new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{throw fail('schedule_timezone_invalid');}const ms=Date.parse(due);if(!Number.isFinite(ms)||ms<now+5000||ms>now+366*86400000)throw fail('schedule_time_invalid');return new Date(ms);}
export async function saveSchedule(sql:SQL,a:Schedule,m:Message,sourceId:number,updateId:number,revision:number,sourceIds:number[]=[]){
  const uid=String(m.from!.id),topic=String(m.message_thread_id||0),text=m.text||m.caption||'';
  if((m as any).forward_origin||!provesCommand(text,a.quote))throw fail('schedule_request_unconfirmed');
  const due=validTime(a.due_at,a.timezone),payload={title:a.title,instruction:a.instruction,mode:a.mode,due_at:due.toISOString(),timezone:a.timezone};
  if(a.local_time){const parts=new Intl.DateTimeFormat('en-GB',{timeZone:a.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(due);const part=(k:string)=>parts.find(p=>p.type===k)!.value;const clock=`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;if(clock!==a.local_time)throw fail('schedule_timezone_mismatch');}
  const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex'),key=`schedule:${updateId}:${hash}`;
  const row=await one(sql,`INSERT INTO scheduled_actions(id,dedup_key,author_id,topic_id,title,instruction,mode,due_at,timezone,status,action_hash,revision,source_message_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+interval '30 minutes') ON CONFLICT(dedup_key) DO UPDATE SET dedup_key=scheduled_actions.dedup_key RETURNING *`,[randomUUID(),key,uid,topic,a.title,a.instruction,a.mode,due,a.timezone,a.authorization==='explicit'?'pending':'awaiting_confirmation',hash,revision,sourceId]);
  await recordProvenance(sql,'schedule',row!.id,[sourceId,...sourceIds]);
  return row!.status==='awaiting_confirmation'?`Уточню: ${a.mode==='task'?'виконати дію':'нагадати'} «${a.instruction}» ${when(due,a.timezone)} у цій темі для тебе. Підтверджуєш?`:`Запланував ${a.mode==='task'?'виконання':'нагадування'} «${a.instruction}» на ${when(due,a.timezone)}.`;
}
export async function scheduleDecision(sql:SQL,a:z.infer<typeof ScheduleDecisionSchema>,m:Message,revision:number){
  const text=m.text||m.caption||'';
  if((m as any).forward_origin||!provesCommand(text,a.quote))throw fail('schedule_confirmation_unbound');
  const row=await one(sql,'SELECT * FROM scheduled_actions WHERE id=$1 FOR UPDATE',[a.id]);
  if(!row||row.author_id!==String(m.from!.id)||row.topic_id!==String(m.message_thread_id||0)||row.revision!==revision)throw fail('schedule_confirmation_unbound');
  if(a.decision==='confirm'){
    if(/(?:^|\s)(?:не|нет|ні|no|not|don't|скас|отмен)/iu.test(bareIntent(text)))throw fail('schedule_confirmation_unbound');
    if(row.status==='pending')return `Цю дію вже заплановано на ${when(row.due_at,row.timezone)}; другого запису не створював.`;
    if(row.status!=='awaiting_confirmation'||new Date(row.expires_at).getTime()<Date.now())throw fail('schedule_confirmation_expired');
    validTime(new Date(row.due_at).toISOString(),row.timezone);
    if(!row.confirmation_message_id)throw fail('schedule_confirmation_unbound');
    if(m.reply_to_message){if(!m.reply_to_message.from?.is_bot||Number(m.reply_to_message.message_id)!==Number(row.confirmation_message_id))throw fail('schedule_confirmation_unbound');}
    else{const last=await one(sql,"SELECT telegram_id FROM messages WHERE role='assistant' AND topic_id=$1 ORDER BY id DESC LIMIT 1",[row.topic_id]);if(Number(last?.telegram_id)!==Number(row.confirmation_message_id))throw fail('schedule_confirmation_unbound');}
    await sql.query("UPDATE scheduled_actions SET status='pending',confirmed_at=now() WHERE id=$1",[row.id]);
    return `Підтверджено: «${row.instruction}» — ${when(row.due_at,row.timezone)}.`;
  }
  if(['completed','cancelled'].includes(row.status))return 'Ця запланована дія вже завершена або скасована.';
  await sql.query("UPDATE scheduled_actions SET status='cancelled' WHERE id=$1",[row.id]);
  if(row.task_id)await sql.query("UPDATE agent_tasks SET status='cancelled',updated_at=now() WHERE id=$1 AND status NOT IN ('completed','cancelled')",[row.task_id]);
  await sql.query("UPDATE outbox SET status='cleared' WHERE dedup_key LIKE $1 AND status='pending'",['scheduled:'+row.id+':%']);
  return 'Заплановану дію скасував.';
}
export async function scheduleContext(sql:SQL,uid:string,topic:string,revision:number){return (await sql.query("SELECT id,title,instruction,mode,due_at,timezone,status,action_hash,task_id FROM scheduled_actions WHERE author_id=$1 AND topic_id=$2 AND revision=$3 AND (status<>'awaiting_confirmation' OR expires_at>now()) ORDER BY created_at DESC LIMIT 8",[uid,topic,revision])).rows;}
export async function dispatchSchedules(db:Database){
  return db.tx(async sql=>{const s=await state(sql,true);if(s.paused||!s.chat_id||(!s.open_group&&s.consent.length!==2))return 0;
    await sql.query("UPDATE scheduled_actions a SET status=CASE WHEN t.status='completed' THEN 'completed' WHEN t.status IN ('failed','needs_input') THEN 'needs_input' WHEN t.status='cancelled' THEN 'cancelled' ELSE 'dispatched' END FROM agent_tasks t WHERE a.task_id=t.id AND a.status IN ('dispatched','needs_input')");
    await sql.query("UPDATE scheduled_actions SET status='cancelled' WHERE status='dispatched' AND task_id IS NULL");
    await sql.query("UPDATE scheduled_actions SET status='expired' WHERE status='awaiting_confirmation' AND expires_at<=now()");
    const rows=(await sql.query("SELECT * FROM scheduled_actions WHERE status='pending' AND revision=$1 AND due_at<=now() ORDER BY due_at LIMIT 20 FOR UPDATE SKIP LOCKED",[s.memory_revision])).rows;
    let dispatched=0;
    for(const candidate of rows){
      const recurrence=await prepareRecurringSchedule(sql,candidate,s.memory_revision);if(!recurrence.allowed)continue;
      const row=(await one(sql,'SELECT * FROM scheduled_actions WHERE id=$1',[candidate.id]))!;
      const sources=(await sql.query("SELECT source_message_id FROM provenance_edges WHERE derived_kind='schedule' AND derived_key=$1",[String(row.id)])).rows.map(source=>Number(source.source_message_id));
      if(row.mode==='reminder'){
        await queueText(sql,`Нагадування: ${row.instruction}`,s.memory_revision,'scheduled:'+row.id,false,{threadId:row.topic_id==='0'?undefined:Number(row.topic_id),actorId:row.author_id,audience:recurrence.audience,sourceMessageId:row.source_message_id?Number(row.source_message_id):undefined,sourceIds:sources});
        await sql.query("UPDATE scheduled_actions SET status='queued' WHERE id=$1",[row.id]);
      }else{
        const task=await one(sql,`INSERT INTO agent_tasks(id,dedup_key,actor_id,topic_id,title,goal,revision,source_message_id,available_at,deadline,criteria,audience) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),now()+interval '30 minutes',$9,$10) ON CONFLICT(dedup_key) DO UPDATE SET dedup_key=agent_tasks.dedup_key RETURNING id`,[randomUUID(),'scheduled-task:'+row.id,row.author_id,row.topic_id,row.title,'Час підтвердженого відкладеного доручення настав. Виконай зараз, не перенось і не плануй повторно: '+row.instruction,s.memory_revision,row.source_message_id,JSON.stringify(taskCompletionCriteria({title:row.title,goal:row.instruction})),recurrence.audience==='private'||Number(s.chat_id)>0?'private':'group']);
        await sql.query("UPDATE scheduled_actions SET status='dispatched',task_id=$1 WHERE id=$2",[task!.id,row.id]);
        await recordProvenance(sql,'task',task!.id,[...sources,...(row.source_message_id?[Number(row.source_message_id)]:[])]);
      }
      dispatched++;
    }
    return dispatched;
  });
}
