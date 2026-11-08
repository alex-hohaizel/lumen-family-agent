import {one,state,type SQL} from './db.js';
import type {Message} from './telegram.js';
import {seriousConversation} from './behavior.js';
import {createHash} from 'node:crypto';
import {requestAuthorityView} from './outcomes.js';
import {reminderRequestSource} from './reminder-control.js';
import {topicKey} from './topic-scope.js';

// Eligibility is about timing, never a list of words that humans must say.
export function ambientEnabled(s:Record<string,any>,m:Message,timezone:string){
  const group=s.open_group||!s.mention_only&&s.mode==='social'&&s.consent?.length===2;
  if(!group||m.chat.type==='private'||s.paused||s.proactive_mode==='off'||s.conversation_style==='addressed'||!m.from||m.from.is_bot)return false;
  if(Date.now()-m.date*1000>90000)return false;
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  return s.quiet_start===s.quiet_end||!(s.quiet_start<s.quiet_end?hour>=s.quiet_start&&hour<s.quiet_end:hour>=s.quiet_start||hour<s.quiet_end);
}

// v8 already carries historical nondefault gaps into this field. The legacy
// 45-minute default is not a second, hidden lower bound on the 120-second one.
export function ambientGapSeconds(s:Record<string,any>){
  return Math.max(0,Number(s.ambient_gap_seconds??(Number(s.proactive_gap_minutes)!==45?Number(s.proactive_gap_minutes)*60:120))||0);
}
function explicitGroupGap(s:Record<string,any>){return Number(s.proactive_gap_minutes)!==45||ambientGapSeconds(s)!==120?ambientGapSeconds(s)*1000:0;}

export async function unsolicitedBudgetAvailable(sql:SQL,sourceId:number){
  const uncertain=await one(sql,"SELECT id FROM outbox WHERE body->>'ambient'='true' AND status IN ('sending','uncertain') AND source_message_id IS DISTINCT FROM $1::bigint LIMIT 1",[sourceId]);
  if(uncertain)return false;
  const count=await one(sql,"SELECT count(DISTINCT COALESCE(source_message_id::text,dedup_key)) AS n FROM outbox WHERE body->>'ambient'='true' AND status IN ('pending','sending','sent','uncertain') AND (CASE WHEN status='sent' THEN COALESCE(NULLIF(body->>'sentAt','')::timestamptz,created_at) ELSE created_at END)>now()-interval '10 minutes' AND source_message_id IS DISTINCT FROM $1::bigint",[sourceId]);
  return Number(count?.n||0)<4;
}

const silenceDigest=(text:string)=>createHash('sha256').update(text).digest('hex');
/** A temporary turn-taking interruption, not a permanent group preference. */
export async function updateAmbientSilence(sql:SQL,m:Message,sourceId:number,s:Record<string,any>){
  if(m.chat.type==='private'||!m.from)return false;
  const live=await state(sql,true);if(live.paused||live.memory_revision!==s.memory_revision)return false;
  const topic=topicKey(m),actor=String(m.from.id);
  let source;try{source=await reminderRequestSource(sql,{sourceId,actorId:actor,topicId:topic,revision:s.memory_revision,chatId:String(s.chat_id),audience:'group'});}catch{return false;}
  if(!source)return false;
  const plain=requestAuthorityView(source.body,source.entities)?.commandText.trim()||'';
  if(!plain)return false;
  const requested=/^(?:(?:люмене?|lumen|@\w+)[,!: ]*)?(?:(?:будь ласка|пожалуйста|please|давай)[,!: ]*)?(?:(?:поки|зараз|пока|сейчас)\s+)?(?:помовчи|помолчи|мовчи|молчи|не\s+(?:відповідай|отвечай)|don['’]t\s+reply|do\s+not\s+reply)(?=$|[\s,.!:])/iu.test(plain);
  if(requested){
    await sql.query('INSERT INTO topic_attention(topic_id,silenced_source_id,silenced_revision,silenced_body_sha256) VALUES($1,$2,$3,$4) ON CONFLICT(topic_id) DO UPDATE SET silenced_source_id=$2,silenced_revision=$3,silenced_body_sha256=$4',[topic,sourceId,s.memory_revision,silenceDigest(source.body)]);
    await cancelAmbient(sql,topic);return true;
  }
  // The person who asked for space can address the bot again. Other people's
  // direct requests still work, without overriding that person's interruption.
  await sql.query('UPDATE topic_attention a SET silenced_source_id=NULL,silenced_revision=NULL,silenced_body_sha256=NULL WHERE topic_id=$1 AND EXISTS(SELECT 1 FROM messages m WHERE m.id=a.silenced_source_id AND m.user_id=$2)',[topic,actor]);
  return false;
}

async function ambientSilenced(sql:SQL,topic:string,s:Record<string,any>){
  const row=await one(sql,'SELECT a.silenced_source_id,a.silenced_revision,a.silenced_body_sha256,m.user_id FROM topic_attention a LEFT JOIN messages m ON m.id=a.silenced_source_id WHERE a.topic_id=$1',[topic]);
  if(!row?.silenced_source_id||row.silenced_revision!==s.memory_revision||!row.user_id)return false;
  if((await one(sql,'SELECT active FROM members WHERE user_id=$1',[row.user_id]))?.active===false)return false;
  try{const source=await reminderRequestSource(sql,{sourceId:Number(row.silenced_source_id),actorId:row.user_id,topicId:topic,revision:s.memory_revision,chatId:String(s.chat_id),audience:'group'});return Boolean(source&&silenceDigest(source.body)===row.silenced_body_sha256);}catch{return false;}
}

async function gapActive(sql:SQL,topic:string,sourceId:number,s:Record<string,any>){
  const a=await one(sql,'SELECT spoke_at,spoke_source_id FROM topic_attention WHERE topic_id=$1',[topic]);
  if(a?.spoke_at&&Number(a.spoke_source_id)!==sourceId&&Date.now()-new Date(a.spoke_at).getTime()<ambientGapSeconds(s)*1000)return true;
  const gap=explicitGroupGap(s);
  if(gap){
    const last=await one(sql,"SELECT created_at,body FROM outbox WHERE body->>'ambient'='true' AND status='sent' AND source_message_id IS DISTINCT FROM $1::bigint ORDER BY id DESC LIMIT 1",[sourceId]);
    if(last&&Date.now()-new Date(last.body.sentAt||last.created_at).getTime()<gap)return true;
  }
  return false;
}

export async function cancelAmbient(sql:SQL,topic:string){
  const unsolicited="(payload->'engagement'->>'reason' IN ('ambient','helpful') OR (payload->'engagement'->>'reason'='continuation' AND payload->'engagement'->'dialogue'->>'origin'='social_candidate'))";
  await sql.query("DELETE FROM inbox WHERE status='pending' AND COALESCE(payload->'message'->>'message_thread_id','0')=$1 AND "+unsolicited,[topic]);
  await sql.query("UPDATE inbox SET payload=jsonb_set(payload,'{engagement,cancelled}','true'::jsonb) WHERE status='processing' AND COALESCE(payload->'message'->>'message_thread_id','0')=$1 AND "+unsolicited,[topic]);
  await sql.query("UPDATE outbox SET status='cleared',error_code='ambient_superseded' WHERE status='pending' AND body->>'ambient'='true' AND COALESCE(body->>'scopeTopicId',body->>'threadId','0')=$1",[topic]);
}

export async function queueAmbient(sql:SQL,m:Message,sourceId:number,updateId:number,s:Record<string,any>,timezone:string,candidate?:{origin:string;question?:string;message_id?:unknown}){
  if(!ambientEnabled(s,m,timezone))return false;
  const topic=String(m.message_thread_id || 0);
  if(await ambientSilenced(sql,topic,s))return false;
  if(await one(sql,'SELECT id FROM topics WHERE id=$1 AND closed=true',[topic]))return false;
  const queued=await one(sql,"SELECT update_id,created_at FROM inbox WHERE status='pending' AND COALESCE(payload->'message'->>'message_thread_id','0')=$1 AND payload->'engagement'->>'reason'='ambient' ORDER BY update_id LIMIT 1",[topic]);
  // Keep the discussion hint for relevance, without importing action authority.
  const dialogue=candidate?.origin==='social_candidate'?{origin:'social_candidate',question:String(candidate.question||'').slice(0,2000),message_id:candidate.message_id,allowed:[],audience:'group',kind:'reaction'}:undefined;
  const payload=JSON.stringify({message:m,sourceId,engagement:{reason:'ambient',dialogue}});
  const attention=await one(sql,'SELECT checked_at,spoke_at FROM topic_attention WHERE topic_id=$1',[topic]);
  const notBefore=attention?.checked_at?new Date(new Date(attention.checked_at).getTime()+45000):new Date();
  if(await gapActive(sql,topic,sourceId,s))return false;
  if(queued){
    // A burst becomes one turn with the newest author/source; cap the debounce
    // so a busy chat cannot postpone inspection forever.
    await sql.query("UPDATE inbox SET payload=$1,available_at=GREATEST(LEAST(created_at+interval '8 seconds',now()+interval '2 seconds'),$3::timestamptz) WHERE update_id=$2",[payload,queued.update_id,notBefore]);return true;
  }
  if(await one(sql,"SELECT update_id FROM inbox WHERE status IN ('pending','processing') AND COALESCE(payload->'message'->>'message_thread_id','0')=$1 AND payload->'engagement'->>'reason' IS DISTINCT FROM 'ambient' LIMIT 1",[topic]))return false;
  await sql.query("INSERT INTO inbox(update_id,payload,revision,available_at) VALUES($1,$2,$3,GREATEST(now()+interval '2 seconds',$4::timestamptz)) ON CONFLICT DO NOTHING",[updateId,payload,s.memory_revision,notBefore]);return true;
}

export async function claimAttention(sql:SQL,topic:string,sourceId:number){
  await sql.query('INSERT INTO topic_attention(topic_id,checked_at,checked_source_id) VALUES($1,now(),$2) ON CONFLICT(topic_id) DO UPDATE SET checked_at=now(),checked_source_id=$2',[topic,sourceId]);
}

export async function ambientStillRelevant(sql:SQL,m:Message,sourceId:number,s:Record<string,any>,timezone:string,_delivery=false){
  if(!ambientEnabled(s,m,timezone))return false;
  const topic=String(m.message_thread_id || 0);
  if(await ambientSilenced(sql,topic,s))return false;
  if(await one(sql,'SELECT id FROM topics WHERE id=$1 AND closed=true',[topic]))return false;
  // A newer message is not itself a topic change. Keep a conservative lexical
  // continuity fence over a bounded episode; unrelated new content still wins.
  const newer=(await sql.query("SELECT body FROM messages WHERE topic_id=$1 AND id>$2 AND role='user' ORDER BY id DESC LIMIT 8",[topic,sourceId])).rows;
  if(newer.length){
    const anchor=await one(sql,"SELECT body FROM messages WHERE id=$1 AND topic_id=$2 AND role='user'",[sourceId,topic]);
    if(!anchor||!newer.every(row=>sameDiscussion(String(anchor.body),String(row.body))))return false;
  }
  if(await gapActive(sql,topic,sourceId,s))return false;
  return true;
}

const STOP=new Set('this that with have what when where your you our the and for are was were from або але мене тебе його вона вони було були буде буде який яка які щось просто також тоді тепер давай треба можна дуже вже тут там про для без щоб тому коли чому його свою свої цими всіх який це цей цієї этом это этой того что как там тут для или тоже уже мне тебя его она они было были будет очень просто давай нужно можно'.split(/\s+/));
function stems(text:string){return new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)||[]).filter(w=>w.length>=4&&!STOP.has(w)).map(w=>w.length>=6?w.slice(0,-2):w));}
export function sameDiscussion(before:string,after:string){
  if(seriousConversation([{body:after}])&&!seriousConversation([{body:before}]))return false;
  // Explicit discourse changes cannot be rescued by repeating one old noun.
  if(/змін(?:имо|імо|ити)\s+тем|(?:інша|іншу|другая|другую)\s+тем|change\s+(?:the\s+)?(?:topic|subject)|different\s+(?:topic|subject)/iu.test(after))return false;
  const anchor=stems(before),next=stems(after);
  const shared=[...next].filter(word=>[...anchor].some(known=>word===known||word.slice(0,4)===known.slice(0,4))).length;
  // Require the new turn's content anchors to remain predominantly in the
  // episode. A brief repetition can continue it; one repeated noun amid a new
  // subject is insufficient. This is a conservative fence, not semantic proof.
  return shared>0&&shared>=next.size-shared;
}
export async function relatedDiscussions(sql:SQL,text:string,sourceId:number):Promise<Record<string,any>[]>{
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

export async function recordAmbientReply(sql:SQL,_topic:string,reply:string,sourceId:number,updateId:number,interactionId?:string){
  // Reservation metadata only. A queued reply has not been spoken.
  await sql.query("UPDATE outbox SET body=body || $4::jsonb,source_message_id=$1 WHERE status='pending' AND (dedup_key LIKE $2 OR dedup_key=$3 OR ($5::text IS NOT NULL AND dedup_key LIKE $5))",[sourceId,`answer:${updateId}:%`,`presentation:${updateId}`,JSON.stringify({ambient:true,ambientReply:fingerprint(reply)}),interactionId?`interaction:${interactionId}:%`:null]);
  return true;
}

export async function recordDeliveredContribution(sql:SQL,row:Record<string,any>){
  if(row.service||row.audience==='private'||row.externalDestination||['panel','reaction','task_status'].includes(row.kind)||row.kind==='interaction'&&!row.body.ambient||row.dedup_key.startsWith('progress:'))return;
  await sql.query('UPDATE app_state SET last_bot_at=now(),since_bot=0,last_model_error=NULL WHERE id=1');
  if(!row.body.ambient)return;
  const topic=String(row.scopeTopicId??row.body.scopeTopicId??row.body.threadId??0),sourceId=row.source_message_id;
  await sql.query('INSERT INTO topic_attention(topic_id,spoke_at,last_reply,spoke_source_id) VALUES($1,now(),$2,$3) ON CONFLICT(topic_id) DO UPDATE SET spoke_at=now(),last_reply=$2,spoke_source_id=$3',[topic,row.body.ambientReply??fingerprint(row.body.text||''),sourceId]);
}
