import {one,type SQL} from './db.js';
import type {Message} from './telegram.js';

// Eligibility is about timing, never a list of words that humans must say.
export function ambientEnabled(s:Record<string,any>,m:Message,timezone:string){
  if(!s.open_group||s.paused||s.proactive_mode==='off'||s.conversation_style==='addressed'||!m.from||m.from.is_bot)return false;
  if(Date.now()-m.date*1000>90000)return false;
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  return s.quiet_start===s.quiet_end||!(s.quiet_start<s.quiet_end?hour>=s.quiet_start&&hour<s.quiet_end:hour>=s.quiet_start||hour<s.quiet_end);
}

export async function cancelAmbient(sql:SQL,topic:string){
  await sql.query("DELETE FROM inbox WHERE status='pending' AND COALESCE(payload->'message'->>'message_thread_id','0')=$1 AND payload->'engagement'->>'reason'='ambient'",[topic]);
}

export async function queueAmbient(sql:SQL,m:Message,sourceId:number,updateId:number,s:Record<string,any>,timezone:string){
  if(!ambientEnabled(s,m,timezone))return false;
  const topic=String(m.message_thread_id || 0);
  if(await one(sql,'SELECT id FROM topics WHERE id=$1 AND closed=true',[topic]))return false;
  const queued=await one(sql,"SELECT update_id,created_at FROM inbox WHERE status='pending' AND COALESCE(payload->'message'->>'message_thread_id','0')=$1 AND payload->'engagement'->>'reason'='ambient' ORDER BY update_id LIMIT 1",[topic]);
  const payload=JSON.stringify({message:m,sourceId,engagement:{reason:'ambient'}});
  if(queued){
    // A burst becomes one turn with the newest author/source; cap the debounce
    // so a busy chat cannot postpone inspection forever.
    await sql.query("UPDATE inbox SET payload=$1,available_at=LEAST(created_at+interval '8 seconds',now()+interval '2 seconds') WHERE update_id=$2",[payload,queued.update_id]);return true;
  }
  if(await one(sql,"SELECT update_id FROM inbox WHERE status IN ('pending','processing') AND COALESCE(payload->'message'->>'message_thread_id','0')=$1 AND payload->'engagement'->>'reason' IS DISTINCT FROM 'ambient' LIMIT 1",[topic]))return false;
  const inFlight=await one(sql,"SELECT update_id FROM inbox WHERE status='processing' AND COALESCE(payload->'message'->>'message_thread_id','0')=$1 AND payload->'engagement'->>'reason'='ambient' LIMIT 1",[topic]);
  const attention=await one(sql,'SELECT checked_at,spoke_at FROM topic_attention WHERE topic_id=$1',[topic]);
  const gap=Math.max(Number(s.ambient_gap_seconds||0),Number(s.proactive_gap_minutes||0)*60)*1000;
  if(attention?.spoke_at&&Date.now()-new Date(attention.spoke_at).getTime()<gap)return false;
  if(!inFlight&&attention?.checked_at&&Date.now()-new Date(attention.checked_at).getTime()<45000)return false;
  await sql.query("INSERT INTO inbox(update_id,payload,revision,available_at) VALUES($1,$2,$3,now()+interval '2 seconds') ON CONFLICT DO NOTHING",[updateId,payload,s.memory_revision]);return true;
}

export async function claimAttention(sql:SQL,topic:string,sourceId:number){
  await sql.query('INSERT INTO topic_attention(topic_id,checked_at,checked_source_id) VALUES($1,now(),$2) ON CONFLICT(topic_id) DO UPDATE SET checked_at=now(),checked_source_id=$2',[topic,sourceId]);
}

export async function ambientStillRelevant(sql:SQL,m:Message,sourceId:number,s:Record<string,any>,timezone:string,_delivery=false){
  if(!ambientEnabled(s,m,timezone))return false;
  const topic=String(m.message_thread_id || 0);
  if(await one(sql,'SELECT id FROM topics WHERE id=$1 AND closed=true',[topic]))return false;
  // If people have moved on while the model was thinking, do not post an old joke.
  if(await one(sql,"SELECT id FROM messages WHERE topic_id=$1 AND id>$2 AND role='user' LIMIT 1",[topic,sourceId]))return false;
  const a=await one(sql,'SELECT spoke_at,spoke_source_id FROM topic_attention WHERE topic_id=$1',[topic]);
  const gap=Math.max(Number(s.ambient_gap_seconds||0),Number(s.proactive_gap_minutes||0)*60)*1000;
  if(a?.spoke_at&&Number(a.spoke_source_id)!==sourceId&&Date.now()-new Date(a.spoke_at).getTime()<gap)return false;
  return true;
}

const STOP=new Set('this that with have what when where your you our the and for are was were from або але мене тебе його вона вони було були буде буде який яка які щось просто також тоді тепер давай треба можна дуже вже тут там про для без щоб тому коли чому його свою свої цими всіх який це цей цієї этом это этой того что как там тут для или тоже уже мне тебя его она они было были будет очень просто давай нужно можно'.split(/\s+/));
export async function relatedDiscussions(sql:SQL,text:string,sourceId:number){
  let words=[...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w=>w.length>=4&&!STOP.has(w)))].slice(0,12);
  if(!words.length)return [];
  const learned=await sql.query('SELECT alternatives FROM memory_terms WHERE term=ANY($1::text[]) LIMIT 8',[words]);
  const expanded=learned.rows.flatMap(r=>(Array.isArray(r.alternatives)?r.alternatives:[]).flatMap((v:unknown)=>typeof v==='string'?(v.match(/[\p{L}\p{N}]+/gu) || []):[]));
  words=[...new Set([...words,...expanded.filter(w=>w.length>=3)])].slice(0,24);
  const result=await sql.query(`SELECT id,telegram_id AS message_id,author,user_id,role,body,created_at,topic_id FROM messages WHERE id<$1 AND to_tsvector('simple',body) @@ to_tsquery('simple',$2) ORDER BY ts_rank_cd(to_tsvector('simple',body),to_tsquery('simple',$2)) DESC,id DESC LIMIT 8`,[sourceId,words.map(w=>(w.length>=6?w.slice(0,-2):w)+':*').join(' | ')]);
  return result.rows.map(row=>({...row,body:String(row.body).slice(0,1000)}));
}

export function ambientReplyAllowed(plan:{reply:string;engagement?:{respond:boolean};behavior?:{move:string};offer?:unknown}){
  return plan.engagement?.respond!==false&&Boolean(plan.behavior&&plan.behavior.move!=='listen');
}

function fingerprint(reply:string){return reply.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
export async function ambientDuplicate(sql:SQL,topic:string,reply:string){
  const value=fingerprint(reply);if(!value)return false;
  return (await one(sql,'SELECT last_reply FROM topic_attention WHERE topic_id=$1',[topic]))?.last_reply===value;
}

export async function recordAmbientReply(sql:SQL,topic:string,reply:string,sourceId:number,updateId:number){
  const normalized=fingerprint(reply);
  await sql.query('INSERT INTO topic_attention(topic_id,spoke_at,last_reply,spoke_source_id) VALUES($1,now(),$2,$3) ON CONFLICT(topic_id) DO UPDATE SET spoke_at=now(),last_reply=$2,spoke_source_id=$3',[topic,normalized,sourceId]);
  await sql.query("UPDATE outbox SET body=body || '{\"ambient\":true}'::jsonb,source_message_id=$1 WHERE dedup_key LIKE $2 OR dedup_key=$3",[sourceId,`answer:${updateId}:%`,`presentation:${updateId}`]);
  return true;
}
