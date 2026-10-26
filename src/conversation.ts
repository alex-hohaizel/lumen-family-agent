import {one,state,type SQL} from './db.js';
import type {Message} from './telegram.js';
import type {Plan} from './model.js';
import {seriousConversation} from './behavior.js';

export async function continuation(sql:SQL,m:Message,revision:number){
  if(!m.from||m.reply_to_message&&!m.reply_to_message.from?.is_bot)return;
  if(/@[A-Za-z0-9_]+/.test(m.text || '')&&!m.reply_to_message?.from?.is_bot)return;
  const topic=String(m.message_thread_id || 0),uid=String(m.from.id);
  const d=await one(sql,"SELECT * FROM dialogues WHERE topic_id=$1 AND revision=$2 AND expires_at>now() AND (user_id=$3 OR audience='group') ORDER BY (user_id=$3) DESC,created_at DESC LIMIT 1",[topic,revision,uid]);
  if(d){
    const later=await one(sql,'SELECT count(*) AS n FROM messages WHERE topic_id=$1 AND created_at>$2',[topic,d.created_at]);
    if(Number(later?.n || 0)<=12||d.kind==='activity')return d;
  }
  const pending=await one(sql,"SELECT * FROM pending_intents WHERE user_id=$1 AND topic_id=$2 AND revision=$3 AND created_at>now()-interval '10 minutes'",[uid,topic,revision]);
  if(pending)return {question:pending.request_text,allowed:pending.allowed,audience:'personal',kind:'question',user_id:uid};
}
export async function helpfulCandidate(sql:SQL,m:Message,s:Record<string,any>,timezone:string){
  if(!s.open_group||s.proactive_mode==='off'||m.reply_to_message||Date.now()-m.date*1000>90000)return false;
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  if(s.quiet_start!==s.quiet_end&&(s.quiet_start<s.quiet_end?hour>=s.quiet_start&&hour<s.quiet_end:hour>=s.quiet_start||hour<s.quiet_end))return false;
  const gap=Math.max(10,Number(s.proactive_gap_minutes || 45))*60000;
  if(Date.now()-Math.max(s.last_social_at?new Date(s.last_social_at).getTime():0,s.last_bot_at?new Date(s.last_bot_at).getTime():0)<gap||s.since_bot<6)return false;
  const recent=await sql.query("SELECT user_id,body FROM messages WHERE topic_id=$1 AND created_at>now()-interval '5 minutes' ORDER BY id DESC LIMIT 10",[String(m.message_thread_id || 0)]);
  if(new Set(recent.rows.map(x=>x.user_id)).size<2||seriousConversation([...recent.rows].reverse().map(x=>({body:String(x.body || '')}))))return false;
  return /не виходить|помилк|як (?:нам|це|краще)|треба (?:обрати|вирішити|зібрати|спланувати)|потрібно (?:обрати|вирішити|зібрати)|їдемо|плануємо|зустріч|святку|скину.*варіант|не можемо (?:обрати|домовит)/iu.test(recent.rows.map(x=>x.body).join('\n'));
}
export async function saveDialogue(sql:SQL,plan:Plan,m:Message,sourceId:number,revision:number,allowed:string[]){
  const explicit=plan.dialogue;const question=explicit?.expecting || plan.reply;
  const active=await one(sql,"SELECT id FROM games WHERE topic_id=$1 AND status='active'",[String(m.message_thread_id || 0)]);
  if(!explicit&&!plan.reply.includes('?')&&!active){await sql.query('DELETE FROM dialogues WHERE topic_id=$1 AND user_id=$2',[String(m.message_thread_id || 0),String(m.from!.id)]);return;}
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
