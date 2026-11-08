import {one,state,type SQL} from './db.js';
import type {Message} from './telegram.js';
import type {Plan} from './model.js';
import {relatedDiscussions} from './attention.js';

export async function continuation(sql:SQL,m:Message,revision:number){
  if(!m.from||m.reply_to_message&&!m.reply_to_message.from?.is_bot)return;
  if(/@[A-Za-z0-9_]+/.test(m.text || '')&&!m.reply_to_message?.from?.is_bot)return;
  const topic=String(m.message_thread_id || 0),uid=String(m.from.id),s=await state(sql);
  const scheduled=await one(sql,"SELECT id,instruction,due_at,timezone FROM scheduled_actions WHERE author_id=$1 AND topic_id=$2 AND revision=$3 AND status='awaiting_confirmation' AND expires_at>now() ORDER BY created_at DESC LIMIT 1",[uid,topic,revision]);
  if(scheduled)return {question:`Підтвердження дії ${scheduled.id}: ${scheduled.instruction}, ${new Date(scheduled.due_at).toISOString()}, ${scheduled.timezone}`,allowed:['schedule_decision'],audience:'personal',kind:'question',user_id:uid,origin:'scheduled_confirmation'};
  const candidates=(await sql.query("SELECT * FROM conversation_goals WHERE topic_id=$1 AND revision=$2 AND expires_at>now() AND status='waiting' AND (actor_id=$3 OR audience='group') ORDER BY updated_at DESC LIMIT 8",[topic,revision,uid])).rows;
  const bound=m.reply_to_message?candidates.filter(d=>Number(d.question_message_id)===m.reply_to_message!.message_id):candidates;
  if(bound.length===1){const d=bound[0]!;return {question:d.question,allowed:d.allowed,goal_id:d.id,reference_id:d.id,audience:d.audience,kind:'question',user_id:d.actor_id,origin:'clarification',source_message_id:d.source_message_id};}
  if(bound.length>1)return {origin:'ambiguous',kind:'question',audience:'personal',allowed:[],question:'Кілька чинних питань: уточни, яке продовжується.',candidates:bound.map(x=>({id:x.id,question:x.question}))};
  const d=await one(sql,"SELECT * FROM dialogues WHERE topic_id=$1 AND revision=$2 AND expires_at>now() AND user_id=$3 ORDER BY created_at DESC LIMIT 1",[topic,revision,uid]);
  if(d)return {...d,origin:'explicit_dialogue',reference_id:String(d.source_message_id)};
  if(s.conversation_style==='addressed'||s.proactive_mode==='off')return;
  // A recent turn is a social candidate, never authority to run actions.
  const previous=await one(sql,"SELECT id,telegram_id,body FROM messages WHERE role='assistant' AND topic_id=$1 AND created_at>now()-interval '3 minutes' ORDER BY id DESC LIMIT 1",[topic]);
  if(previous)return {origin:'social_candidate',question:previous.body,allowed:[],audience:'group',kind:'reaction',message_id:previous.telegram_id};
  const current=await one(sql,"SELECT id FROM messages WHERE telegram_id=$1 AND role='user' AND user_id=$2 AND topic_id=$3",[m.message_id,uid,topic]);
  if(current){
    const related=await relatedDiscussions(sql,m.text||m.caption||'',Number(current.id));
    const bot=related.find(row=>row.role==='assistant');
    if(bot)return {origin:'social_candidate',question:bot.body,allowed:[],audience:'group',kind:'reaction',message_id:bot.message_id};
  }
}
export async function saveDialogue(sql:SQL,plan:Plan,m:Message,sourceId:number,revision:number,allowed:string[]){
  const explicit=plan.dialogue;const question=plan.behavior?.clarification?.question || explicit?.expecting || plan.reply;
  const active=await one(sql,"SELECT id FROM games WHERE topic_id=$1 AND status='active'",[String(m.message_thread_id || 0)]);
  if(!explicit&&!plan.behavior?.clarification&&!active){await sql.query('DELETE FROM dialogues WHERE topic_id=$1 AND user_id=$2',[String(m.message_thread_id || 0),String(m.from!.id)]);return;}
  const kind=explicit?.kind || (active?'activity':'question');
  const audience=explicit?.audience || plan.presentation?.audience || (active||plan.presentation?.choices?.length?'group':'personal');
  const target=audience==='group'?'*':String(m.from!.id);
  await sql.query(`INSERT INTO dialogues(topic_id,user_id,question,kind,audience,allowed,source_message_id,revision,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+($9 * interval '1 minute')) ON CONFLICT(topic_id,user_id) DO UPDATE SET question=excluded.question,kind=excluded.kind,audience=excluded.audience,allowed=excluded.allowed,source_message_id=excluded.source_message_id,revision=excluded.revision,expires_at=excluded.expires_at,created_at=now()`,[String(m.message_thread_id || 0),target,question.slice(0,2000),kind,audience,JSON.stringify(allowed),sourceId,revision,kind==='activity'?45:10]);
}
export function selectionText(m:Message,reply:string){
  const choice=m.lumen_choice;if(!choice)return reply;
  const actor=[m.from?.first_name,m.from?.last_name].filter(Boolean).join(' ');
  if(reply.includes(actor)&&reply.includes(m.text || ''))return reply;
  const selections=choice.selected.slice(-8).map(x=>`${x.name} — «${x.label}»`).join('; ');
  return [selections?`${selections}.`:`${actor} обирає «${m.text}».`,reply].filter(Boolean).join('\n\n');
}
export async function cancelImages(sql:SQL,uid:string,ownerId:string,topic:string,id?:number){
  const rows=await sql.query("UPDATE image_jobs SET cancelled=true,status='cancelled',updated_at=now() WHERE topic_id=$1 AND (author_id=$2 OR $2=$3) AND ($4::bigint IS NULL OR id=$4) AND status IN ('pending','processing','ready') RETURNING id",[topic,uid,ownerId,id || null]);
  return rows.rows.length?'Зупинив підготовку зображення.':'Активної генерації для цього прохання не знайшов.';
}
export async function currentRevision(sql:SQL,revision:number){const s=await state(sql);return !s.paused&&s.memory_revision===revision;}
