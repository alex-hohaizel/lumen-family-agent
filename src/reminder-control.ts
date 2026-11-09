import {one,state,type SQL,type Row} from './db.js';
import {digest} from './evolution-core.js';
import {bareIntent,provesCommand} from './personalization.js';
import {requestAuthorityView} from './outcomes.js';
import {ToolError} from './safe-http.js';
import {loadOriginalRequestContext,type ValidatedOriginalRequest} from './request-context.js';
import type {Message} from './telegram.js';
import {topicKey} from './topic-scope.js';
import {stableId} from './operations.js';
import {isAuthoredCancellationQuote,hasUnconditionalCancellationQuote} from './reminder-intent.js';

/** The caller supplies transport-verified identity; model arguments never set administrator. */
export interface ReminderContext {
 actorId:string;topicId:string;revision:number;chatId?:string;sourceId?:number;
 requestText?:string;administrator?:boolean;audience?:'group'|'private';updateId?:string;
 cancellationQuote?:string;
 cancellationTargets?:ReadonlyArray<{ref:string;version:number|string}>;
}
export interface ReminderRoot extends Row {
 kind:'series'|'schedule'|'legacy'|'occurrence';ref:string;id:string;title:string;
 actor_id:string;topic_id:string;status:string;shared:boolean;manager_ids:string[];
 audience:'group'|'private';version:number|string;series_id?:string;
}
export interface ReminderRequest {
 text:string;id?:string|number;query?:string;scope?:'auto'|'series'|'occurrence';all?:boolean;
}
export interface ReminderResult {handled:boolean;status:string;message:string;roots?:string[];inFlight?:number;}
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const liveStatuses=['pending','awaiting_confirmation','queued','needs_input','dispatched','paused'];
const seriesStatuses=['active','draft','needs_input','paused'];
const ids=(value:unknown)=>Array.isArray(value)?value.filter((x):x is string=>typeof x==='string'&&/^\d+$/.test(x)):[];
const privateCue=/(?<![\p{L}\p{N}])(?:(?:лише|тільки)\s+мені|особисто|приватно|лично|только\s+мне|only\s+me|in\s+private|(?:в|у)\s+приват|privately|DM|(?:приватн[\p{L}]*|особист[\p{L}]*|личн[\p{L}]*|private|personal)\s+(?:нагад[\p{L}]*|напомин[\p{L}]*|reminders?|сері[\p{L}]*|сери[\p{L}]*|series))(?![\p{L}\p{N}])/iu;
const groupCue=/(?<![\p{L}\p{N}])(?:публічно|публично|publicly|(?:у|в|in)\s+(?:(?:цій|нашій|приватній|цьому|нашому|the|this|our|private)\s+)*(?:групі|группе|чаті|чате|group|chat))(?![\p{L}\p{N}])/iu;
/** Pure authored-text cue shared with legacy creation. Contradiction is not a
 * grant to choose either audience; the caller must clarify without effects. */
export function privateReminderCue(text:string){
 const negativeBefore=(index:number)=>/(?<![\p{L}\p{N}])(?:не|ні|not|no|без|without)\s*$|non[-\s]*$/iu.test(text.slice(0,index));
 let yes=false,no=false,group=false,notGroup=false;
 for(const match of text.matchAll(new RegExp(privateCue.source,'giu'))){if(negativeBefore(match.index!))no=true;else yes=true;}
 const subject=/(?:^|\s)(?:(?:про|about)\s+|(?:о|об)\s+(?!\d))/iu.exec(text)?.index??text.length;
 for(const match of text.slice(0,subject).matchAll(new RegExp(groupCue.source,'giu'))){if(negativeBefore(match.index!))notGroup=true;else group=true;}
 return {private:yes&&!no&&!group,ambiguous:yes&&(no||group)||notGroup&&!yes};
}

async function context(sql:SQL,c:ReminderContext,allowPaused=true){
 const s=await state(sql,true);
 if(s.memory_revision!==c.revision||s.paused&&!allowPaused)throw new ToolError('task_cancelled');
 if(c.chatId&&String(s.chat_id)!==c.chatId&&!(Number(c.chatId)>0&&c.chatId===c.actorId&&c.audience==='private'))throw new ToolError('other_chat');
 const member=await one(sql,'SELECT active FROM members WHERE user_id=$1',[c.actorId]);
 if(member?.active===false||!member&&s.owner_id!==c.actorId&&!(s.participants||[]).some((p:any)=>String(p.id)===c.actorId)&&!c.administrator)throw new ToolError('member_required');
 return s;
}

type ReminderSource=Pick<ValidatedOriginalRequest,'body'|'entities'|'forwarded'|'viaBot'|'replyRef'>&{modality:'native_text'|'voice_transcription'};

/** Internal server call after a successful transcription. Not a model tool.
 * The receipt pins the actual received voice and stored transcript without
 * pretending that a transcript is an original Telegram text descriptor. */
export async function recordReminderTranscription(sql:SQL,m:Message,sourceId:number,transcript:string,revision:number,namespaceChatId?:string){
 const s=await state(sql,true),namespace=namespaceChatId||String(s.chat_id),row=await one(sql,'SELECT * FROM messages WHERE id=$1 FOR UPDATE',[sourceId]);
 if(s.paused||s.memory_revision!==revision||String(s.chat_id)!==namespace||!row||row.role!=='user'||row.user_id!==String(m.from?.id)||String(row.telegram_id)!==String(m.message_id)||row.topic_id!==topicKey(m)||String(m.chat.id)!==namespace||!m.voice?.file_id||typeof transcript!=='string'||!transcript.trim())throw new ToolError('reminder_transcription_unbound');
 const native=m as Message&Record<string,unknown>;
 const authored=!m.from?.is_bot&&!native.via_bot&&!native.is_automatic_forward&&!Object.keys(native).some(k=>k.startsWith('forward_')&&native[k]!==undefined&&native[k]!==null);
 const reply=m.reply_to_message;
 const proof={modality:'voice_transcription',source_id:sourceId,namespace_chat_id:namespace,actor_id:row.user_id,topic_id:row.topic_id,telegram_message_id:m.message_id,file_id:m.voice.file_id,revision,transcript_sha256:digest(transcript),source_edited_at:row.edited_at?new Date(row.edited_at).toISOString():null,authored,...(reply?{reply_ref:{chat_id:namespace,message_id:reply.message_id,from_is_bot:reply.from?.is_bot===true,...(reply.from?.id?{from_id:String(reply.from.id)}:{})}}:{})};
 await sql.query("INSERT INTO attachments(source_message_id,topic_id,kind,file_id,file_unique_id,mime,metadata,status,revision) VALUES($1,$2,'audio',$3,'',$4,$5,'stored',$6) ON CONFLICT(source_message_id,file_id) DO UPDATE SET metadata=attachments.metadata||excluded.metadata,status='stored',revision=excluded.revision",[sourceId,row.topic_id,m.voice.file_id,m.voice.mime_type||'audio/ogg',JSON.stringify({original_kind:'voice',reminder_transcription:proof}),revision]);
 await sql.query('UPDATE messages SET body=$1,request_context=NULL WHERE id=$2',['[голосове] '+transcript,sourceId]);
 return {modality:'voice_transcription' as const,authored};
}

export async function reminderRequestSource(sql:SQL,c:ReminderContext):Promise<ReminderSource|undefined>{
 if(!c.sourceId)return;
 const s=await state(sql),source=await loadOriginalRequestContext(sql,{sourceId:c.sourceId,actorId:c.actorId,topicId:c.topicId,namespaceChatId:String(s.chat_id),audience:c.audience||'group',revision:c.revision});
 if(source){if(source.forwarded||source.viaBot||c.requestText!==undefined&&c.requestText!==source.body)throw new ToolError('reminder_request_unbound');return {...source,modality:'native_text'};}
 const row=await one(sql,'SELECT * FROM messages WHERE id=$1',[c.sourceId]);
 if(!row||row.role!=='user'||row.user_id!==c.actorId||row.topic_id!==c.topicId||typeof row.body!=='string'||!row.body.startsWith('[голосове] ')||s.paused||s.memory_revision!==c.revision)throw new ToolError('reminder_request_unbound');
 const body=row.body.slice('[голосове] '.length),attachments=(await sql.query("SELECT file_id,metadata FROM attachments WHERE source_message_id=$1 AND topic_id=$2 AND kind='audio' AND revision=$3 AND metadata->>'original_kind'='voice'",[c.sourceId,c.topicId,c.revision])).rows;
 const proof=attachments.map(a=>({a,p:a.metadata?.reminder_transcription})).find(({a,p})=>p?.modality==='voice_transcription'&&p.authored===true&&p.source_id===c.sourceId&&p.namespace_chat_id===String(s.chat_id)&&p.actor_id===c.actorId&&p.topic_id===c.topicId&&p.telegram_message_id===Number(row.telegram_id)&&p.file_id===a.file_id&&p.revision===c.revision&&p.transcript_sha256===digest(body)&&p.source_edited_at===(row.edited_at?new Date(row.edited_at).toISOString():null))?.p;
 if(!proof||c.requestText!==undefined&&c.requestText!==body)throw new ToolError('reminder_request_unbound');
 const reply=proof.reply_ref;if(reply&&(!Number.isSafeInteger(reply.message_id)||reply.message_id<=0||reply.chat_id!==String(s.chat_id)||typeof reply.from_is_bot!=='boolean'))throw new ToolError('reminder_request_unbound');
 return {body,entities:[],forwarded:false,viaBot:false,modality:'voice_transcription',...(reply?{replyRef:reply}:{})};
}

/** Group delivery is shared by default for new reminders, never for historical rows.
 * Names only grant stop authority when present in the actual source and uniquely
 * identify a known active member. A model-supplied manager ID is not accepted. */
export async function reminderMetadata(sql:SQL,c:ReminderContext,options:{shared?:boolean;quote?:string}={}){
 const s=await context(sql,c,false),source=await reminderRequestSource(sql,c),text=source?.body||c.requestText||'';
 if(options.quote&&!provesCommand(text,options.quote))throw new ToolError('reminder_request_unbound');
 const authored=requestAuthorityView(text,source?.entities||[])?.commandText||'';
 const offset=options.quote?text.indexOf(options.quote):-1;
 let bound=authored;
 if(offset>=0&&text.indexOf(options.quote!,offset+1)<0){
  // Expand a unique proof quote to its authored clause, so omitting a trailing
  // "for both" from the quote cannot change managers between retry steps.
  const before=text.slice(0,offset),left=Math.max(...['.','!','?',';','\n'].map(ch=>before.lastIndexOf(ch)))+1;
  const after=offset+options.quote!.length,tail=text.slice(after).search(/[.!?;\n]/u),right=/[.!?;\n]\s*$/u.test(options.quote!)?after:tail<0?text.length:after+tail;
  bound=authored.slice(left,right);
 }else if(offset>=0)bound=authored.slice(offset,offset+options.quote!.length);
 const cue=privateReminderCue(bound);if(cue.ambiguous)throw new ToolError('reminder_audience_ambiguous');
 const personal=cue.private;
 const privateAudience=c.audience==='private'||Number(c.chatId||s.chat_id)>0||personal;
 const shared=!privateAudience&&!personal&&(options.shared??true);
 if(!shared)return {shared:false,manager_ids:[] as string[],audience:privateAudience?'private' as const:'group' as const};
 if(!source)throw new ToolError('reminder_request_unbound');
 // Both requires exactly two known active people. More people do not silently
 // turn an ambiguous "both" into authority for every group member.
 const rows=(await sql.query('SELECT user_id,name FROM members WHERE active=true ORDER BY user_id LIMIT 101')).rows;
 const known=new Map<string,string>();
 for(const p of s.participants||[])if(/^\d+$/.test(String(p.id)))known.set(String(p.id),String(p.name||''));
 for(const p of rows)known.set(String(p.user_id),String(p.name||''));
 const lower=bound.split(/[.!?;\n]/u).filter(clause=>/нагад|напом(?:н|ин)|remind/iu.test(clause)).join(' ').normalize('NFKC').toLocaleLowerCase(),managers=new Set<string>();
 const names=new Map<string,string[]>();
 const nameKey=(value:string)=>(value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)||[]).map(stem).join(' ');
 for(const [id,name] of known){const normalized=nameKey(name);if(normalized.length>=2)names.set(normalized,[...(names.get(normalized)||[]),id]);}
 // A name in the subject ("birthday of X", "return X's book") is data,
 // not a delegation. Only an explicit recipient/coparticipant relation counts.
 const recipient=(segment:string,allowSingle=true)=>{
  segment=segment.replace(/\s+(?:щодн[\p{L}]*|щотиж[\p{L}]*|щоміс[\p{L}]*|ежеднев[\p{L}]*|еженедел[\p{L}]*|ежемесяч[\p{L}]*|кажд[\p{L}]*\s+(?:день|утро|недел[\p{L}]*|месяц)|every\s+(?:day|week|month)|daily|weekly|monthly|(?:о|в|at)\s*\d)[\s\S]*$/iu,'').trim();
  const parts=segment.split(/\s+(?:і|й|та|и|and|із|з|с|with)\s+/iu).map(x=>nameKey(x.replace(/^(?:для|for)\s+/iu,''))).filter(Boolean);
  if(!parts.length)return;
  const chosen:string[]=[],pronouns=new Set(['мене','мені','мне','нам','нас','me','us','both','обох','обом','обоих','обоим','двом','двоим','of']);let both=false,author=false;
  for(const part of parts){
   const people=names.get(part);if(people?.length===1){chosen.push(people[0]!);author||=people[0]===c.actorId;continue;}
   const words=part.split(' ');if(!words.every(w=>pronouns.has(w)))return;
   author||=words.some(w=>['мене','мені','мне','нам','нас','me','us'].includes(w));
   both||=words.some(w=>['both','обох','обом','обоих','обоим','двом','двоим'].includes(w));
  }
  if(allowSingle||author||both)for(const id of chosen)managers.add(id);
  if(both&&known.size===2)for(const id of known.keys())managers.add(id);
 };
 for(const clause of lower.split(/[,;.!?\n]/u)){
  const subject=/(?:^|\s)(?:(?:про|about)\s+|(?:о|об)\s+(?!\d))/iu.exec(clause)?.index??Infinity;
  for(const match of clause.matchAll(/(?:^|\s)(?:для|for)\s+(.+)/giu)){
   if(/(?:^|\s)(?:не|not|без|without)\s*$/iu.test(clause.slice(0,match.index)))continue;
   recipient(match[1]!.split(/\s+(?:про|about|о|об)\s+/iu)[0]!,match.index!<subject);
  }
  const direct=/(?:нагадуй|нагадай|напомни|напоминай|remind)\s+(.+?)(?=\s+(?:про|about|о|об)\s+|$)/iu.exec(clause)?.[1];
  if(direct)recipient(direct);
 }
 managers.delete(c.actorId);
 return {shared:true,manager_ids:[...managers].sort(),audience:'group' as const};
}

export function canManageReminder(row:Row,c:ReminderContext,privateOwnerControl=false){
 if(row.audience==='private'&&c.audience!=='private')return privateOwnerControl&&String(row.actor_id??row.author_id)===c.actorId;
 if(String(row.actor_id??row.author_id)===c.actorId)return true;
 return row.shared===true&&row.audience==='group'&&(row.mode??row.rule?.mode)==='reminder'&&(c.administrator===true||ids(row.manager_ids).includes(c.actorId));
}
function root(kind:ReminderRoot['kind'],r:Row,series?:Row):ReminderRoot{
 const owner=series||r,id=String(r.id),ref=kind==='occurrence'?'occurrence:'+id:kind+':'+id;
 const version=kind==='series'?Number(r.version):digest({status:r.status,hash:r.action_hash,title:r.title,due:r.due_at,shared:owner.shared,managers:owner.manager_ids});
 return {...r,kind,ref,id,title:String(r.title??r.rule?.title??''),status:String(r.status),actor_id:String(owner.actor_id??owner.author_id),topic_id:String(owner.topic_id),
  shared:owner.shared===true,manager_ids:ids(owner.manager_ids),audience:owner.audience==='private'?'private':'group',version,
  ...(series?{series_id:String(series.id)}:{})};
}
function manageable(r:ReminderRoot,c:ReminderContext,privateOwnerControl=false){return canManageReminder({...r,mode:r.kind==='series'?r.rule?.mode:r.mode||'reminder'},c,privateOwnerControl);}

export type ReminderSearch=ReminderRoot[]&{readonly truncated?:boolean};
function searchResult(roots:ReminderRoot[],truncated=false):ReminderSearch{Object.defineProperty(roots,'truncated',{value:truncated,enumerable:false});return roots;}
/** Filter before the bounded window. A conservative four-letter FTS prefix
 * contains the lexical matcher's candidate set; JS then checks full stems.
 * Overflow never authorizes partial bulk cancellation or a not-found claim. */
async function searchReminders(sql:SQL,c:ReminderContext,query:string,limit:number,privateOwnerControl=false,privateOnly=false):Promise<ReminderSearch>{
 await context(sql,c);
 const tokens=reminderSearchTokens(query),fts=tokens.length?tokens.map(w=>w.slice(0,4)+':*').join(' & '):null;
 const allowPrivate=c.audience==='private'||privateOwnerControl;
 const common=[c.topicId,c.revision,seriesStatuses,c.actorId,Boolean(c.administrator),allowPrivate,privateOnly,fts,limit+1];
 const series=(await sql.query("SELECT * FROM recurring_series WHERE topic_id=$1 AND revision=$2 AND status=ANY($3::text[]) AND (actor_id=$4 OR (shared=true AND audience='group' AND rule->>'mode'='reminder' AND (manager_ids ? $4 OR $5::boolean))) AND (audience<>'private' OR $6::boolean) AND (NOT $7::boolean OR audience='private') AND ($8::text IS NULL OR to_tsvector('simple',normalize(concat_ws(' ',rule->>'title',rule->>'instruction'),NFKC)) @@ to_tsquery('simple',$8)) ORDER BY created_at DESC,id DESC LIMIT $9",common)).rows;
 const scheduled=(await sql.query("SELECT * FROM scheduled_actions a WHERE topic_id=$1 AND revision=$2 AND status=ANY($3::text[]) AND NOT EXISTS(SELECT 1 FROM recurring_occurrences o WHERE o.schedule_id=a.id) AND (author_id=$4 OR (shared=true AND audience='group' AND mode='reminder' AND (manager_ids ? $4 OR $5::boolean))) AND (audience<>'private' OR $6::boolean) AND (NOT $7::boolean OR audience='private') AND ($8::text IS NULL OR to_tsvector('simple',normalize(concat_ws(' ',title,instruction),NFKC)) @@ to_tsquery('simple',$8)) ORDER BY created_at DESC,id DESC LIMIT $9",[...common.slice(0,2),liveStatuses,...common.slice(3)])).rows;
 const legacy=(await sql.query("SELECT * FROM reminders WHERE topic_id=$1 AND status IN ('pending','queued') AND (author_id=$2 OR (shared=true AND audience='group' AND (manager_ids ? $2 OR $3::boolean))) AND (audience<>'private' OR $4::boolean) AND (NOT $5::boolean OR audience='private') AND ($6::text IS NULL OR to_tsvector('simple',normalize(title,NFKC)) @@ to_tsquery('simple',$6)) ORDER BY created_at DESC,id DESC LIMIT $7",[c.topicId,c.actorId,Boolean(c.administrator),allowPrivate,privateOnly,fts,limit+1])).rows;
 const truncated=[series,scheduled,legacy].some(rows=>rows.length>limit);
 const roots=[...series.slice(0,limit).map(r=>root('series',r)),...scheduled.slice(0,limit).map(r=>root('schedule',r)),...legacy.slice(0,limit).map(r=>root('legacy',{...r,mode:'reminder'}))].filter(r=>manageable(r,c,privateOwnerControl)&&matches(r,query));
 return searchResult(roots,truncated);
}
/** A recurring parent and its materialized child are one logical item. */
export async function listReminders(sql:SQL,c:ReminderContext,privateOwnerControl=false):Promise<ReminderSearch>{return searchReminders(sql,c,'',40,privateOwnerControl);}

const stopWords=new Set('люмен люмене lumen can you could would можеш можете можешь чи допоможи помоги мій моє мої моих мое мои мой mine my own private personal не not non видали видалити скасуй скасувати прибери припини зупини удали удалить отмени отменить убери прекрати напоминание напоминания напоминаний эти всех обоих обоим мне ежедневно ближайший ближайшее серию серии только cancel delete remove stop reminding reminder reminders нагадування нагадувань нагадувач нагадувачі ці цієї це цей ці всі усі усе все ті те про about the these those any нарешті будь ласка для обох обом нам мені щодня щоденне щоденні повтор серію серії всю найближчий найближче лише тільки і й та и для for both all'.split(' '));
function stem(word:string){return word.length>=5?word.replace(/(?:ами|ями|ові|еві|ах|ях|ою|ею|ів|ing|es|[аяюуіиеоь]$|s$)$/u,''):word;}
export function reminderSearchTokens(text:string){return [...new Set((text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)||[]).filter(w=>!stopWords.has(w)&&!(/^(?:приватн|особист|личн)/u.test(w))&&w.length>=2).map(stem))].slice(0,12);}
function searchText(text:string){
 const target=/(?:нагадуван[\p{L}]*|напоминан[\p{L}]*|reminders?)\s+(?:про\s+|about\s+)?(.+)/iu.exec(text)?.[1]||text;
 return target.split(/(?:нарешті|наконец|для\s+обох|для\s+обоих|для\s+мене|для\s+меня|і\s+для|и\s+для|for\s+both|[.!?\n])/iu)[0]||'';
}
function matches(r:ReminderRoot,query:string){
 const wanted=reminderSearchTokens(query);if(!wanted.length)return true;
 const actual=reminderSearchTokens(r.title+' '+(r.instruction??r.rule?.instruction??''));
 return wanted.every(w=>actual.some(a=>a===w||a.length>=4&&w.length>=4&&(a.startsWith(w)||w.startsWith(a))));
}

export async function resolveReminders(sql:SQL,c:ReminderContext,request:{id?:string|number;query?:string;scope?:'auto'|'series'|'occurrence';privateOwnerControl?:boolean;privateOnly?:boolean}={}):Promise<ReminderSearch>{
 await context(sql,c);
 if(request.id!==undefined){
  const id=String(request.id).replace(/^(?:series|schedule|legacy|occurrence):/iu,'');
  if(/^\d+$/.test(id)){
   const r=await one(sql,"SELECT * FROM reminders WHERE id=$1 AND topic_id=$2 AND status IN ('pending','queued') FOR UPDATE",[id,c.topicId]);
   return r&&canManageReminder({...r,mode:'reminder'},c,request.privateOwnerControl)?[root('legacy',{...r,mode:'reminder'})]:[];
  }
  if(!uuid.test(id))return [];
  const series=await one(sql,'SELECT * FROM recurring_series WHERE id=$1 AND topic_id=$2 AND revision=$3 FOR UPDATE',[id,c.topicId,c.revision]);
  if(series)return seriesStatuses.includes(series.status)&&canManageReminder(series,c,request.privateOwnerControl)?[root('series',series)]:[];
  const scheduled=await one(sql,'SELECT * FROM scheduled_actions WHERE id=$1 AND topic_id=$2 AND revision=$3 FOR UPDATE',[id,c.topicId,c.revision]);
  if(!scheduled||!liveStatuses.includes(scheduled.status))return [];
  const parent=await one(sql,'SELECT s.* FROM recurring_series s JOIN recurring_occurrences o ON o.series_id=s.id WHERE o.schedule_id=$1 AND s.topic_id=$2 AND s.revision=$3 FOR UPDATE OF s',[id,c.topicId,c.revision]);
  if(parent){if(!seriesStatuses.includes(parent.status)||!canManageReminder(parent,c,request.privateOwnerControl))return [];return request.scope==='series'?[root('series',parent)]:[root('occurrence',scheduled,parent)];}
  return canManageReminder(scheduled,c,request.privateOwnerControl)?[root('schedule',scheduled)]:[];
 }
 return searchReminders(sql,c,request.query||'',100,request.privateOwnerControl,request.privateOnly);
}

const unstartedTask=`t.status IN ('pending','needs_input') AND t.step=0 AND NOT EXISTS(SELECT 1 FROM task_events e WHERE e.task_id=t.id AND e.kind IN ('running','recurring_catch_up_resumed')) AND NOT EXISTS(SELECT 1 FROM tool_runs r WHERE r.task_id=t.id) AND NOT EXISTS(SELECT 1 FROM tool_approvals p WHERE p.task_id=t.id)`;
async function stopPendingDelivery(sql:SQL,prefix:string){
 const inFlight=await one(sql,"SELECT count(*) AS n FROM outbox o WHERE dedup_key LIKE $1 AND (status IN ('sending','uncertain') OR EXISTS(SELECT 1 FROM effect_operations e WHERE (e.id=o.operation_id OR e.operation_key='outbox:'||o.dedup_key) AND e.phase IN ('dispatch_started','uncertain')))",[prefix]);
 const cleared=(await sql.query("UPDATE outbox o SET status='cleared',error_code='reminder_cancelled' WHERE dedup_key LIKE $1 AND status='pending' AND NOT EXISTS(SELECT 1 FROM effect_operations e WHERE (e.id=o.operation_id OR e.operation_key='outbox:'||o.dedup_key) AND e.phase IN ('dispatch_started','uncertain')) RETURNING dedup_key",[prefix])).rows;
 for(const x of cleared)await sql.query("UPDATE effect_operations SET phase='cancelled',error_code='reminder_cancelled' WHERE operation_key=$1 AND phase='reserved'",['outbox:'+x.dedup_key]);
 return Number(inFlight?.n||0);
}
async function cancelSchedule(sql:SQL,id:string){
 const r=await one(sql,'SELECT * FROM scheduled_actions WHERE id=$1 FOR UPDATE',[id]);if(!r)return {cancelled:0,inFlight:0};
 const inFlight=await stopPendingDelivery(sql,'scheduled:'+id+':%');
 const task=r.task_id?await one(sql,`SELECT t.id FROM agent_tasks t WHERE t.id=$1 AND ${unstartedTask}`,[r.task_id]):null;
 if(inFlight||r.task_id&&!task&&r.status==='dispatched')return {cancelled:0,inFlight:Math.max(1,inFlight)};
 if(['completed','cancelled','failed','expired'].includes(r.status))return {cancelled:0,inFlight:0};
 await sql.query("UPDATE scheduled_actions SET status='cancelled' WHERE id=$1",[id]);
 if(task)await sql.query("UPDATE agent_tasks SET status='cancelled',error_code='reminder_cancelled',updated_at=now() WHERE id=$1",[task.id]);
 return {cancelled:1,inFlight:0};
}

/** Caller holds the app_state transaction fence. Preserve claimed/uncertain effects. */
export async function stopSeries(sql:SQL,row:Row){
 let inFlight=0,cancelled=0;
 const schedules=(await sql.query('SELECT a.id FROM scheduled_actions a JOIN recurring_occurrences o ON o.schedule_id=a.id WHERE o.series_id=$1 FOR UPDATE OF a',[row.id])).rows;
 for(const r of schedules){const result=await cancelSchedule(sql,r.id);inFlight+=result.inFlight;cancelled+=result.cancelled;}
 await sql.query("UPDATE recurring_occurrences o SET status='cancelled' WHERE series_id=$1 AND status IN ('pending','scheduled','needs_input') AND (schedule_id IS NULL OR EXISTS(SELECT 1 FROM scheduled_actions a WHERE a.id=o.schedule_id AND a.status='cancelled'))",[row.id]);
 inFlight+=await stopPendingDelivery(sql,'series-review:'+row.id+':%');
 return {cancelled,inFlight};
}

type CancelProgress={cancelled:number;inFlight:number;reason?:'no_future'|'invalid_rule'};
async function cancelRoot(sql:SQL,r:ReminderRoot,scope:'series'|'occurrence'):Promise<CancelProgress>{
 if(r.kind==='series'&&scope==='series'){
  const result=await stopSeries(sql,r);
  await sql.query("UPDATE recurring_series SET status='ended',version=version+1 WHERE id=$1",[r.id]);return result;
 }
 if(r.kind==='series'){
  // Delivery can finish before the scheduler's next reconciliation tick.
  await sql.query("UPDATE recurring_occurrences o SET status=a.status FROM scheduled_actions a WHERE o.series_id=$1 AND o.schedule_id=a.id AND o.status IN ('pending','scheduled','needs_input') AND a.status IN ('completed','cancelled','failed','expired')",[r.id]);
  const next=await one(sql,"SELECT o.* FROM recurring_occurrences o LEFT JOIN scheduled_actions a ON a.id=o.schedule_id WHERE o.series_id=$1 AND o.status IN ('pending','scheduled','needs_input') AND o.due_at>now()-interval '1 hour' AND (a.id IS NULL OR a.status IN ('pending','awaiting_confirmation','queued','needs_input','paused') OR (a.status='dispatched' AND EXISTS(SELECT 1 FROM agent_tasks t WHERE t.id=a.task_id AND "+unstartedTask+"))) ORDER BY o.due_at LIMIT 1 FOR UPDATE OF o",[r.id]);
  if(!next){
   // Reserve the actual civil-time key before the first materialization tick.
   // Existing skipped/terminal/claimed future keys are never resurrected.
   const known=(await sql.query('SELECT occurrence_key FROM recurring_occurrences WHERE series_id=$1',[r.id])).rows;
   const keys=new Set(known.map(x=>String(x.occurrence_key)));let future;
   try{const {nextUnreservedOccurrence}=await import('./recurring.js');future=nextUnreservedOccurrence(r.rule,new Date(Date.now()-1).toISOString(),keys);}
   catch{return {cancelled:0,inFlight:0,reason:'invalid_rule'};}
   if(!future)return {cancelled:0,inFlight:0,reason:'no_future'};
   const saved=await sql.query("INSERT INTO recurring_occurrences(series_id,occurrence_key,due_at,status) VALUES($1,$2,$3,'skipped') ON CONFLICT DO NOTHING RETURNING occurrence_key",[r.id,future.key,future.due]);
   if(!saved.rows.length)return {cancelled:0,inFlight:0,reason:'no_future'};
   await sql.query('UPDATE recurring_series SET version=version+1 WHERE id=$1',[r.id]);
   return {cancelled:1,inFlight:0};
  }
  const result=next.schedule_id?await cancelSchedule(sql,next.schedule_id):{cancelled:1,inFlight:0};
  if(result.cancelled&&!result.inFlight){await sql.query("UPDATE recurring_occurrences SET status='skipped',version=version+1 WHERE series_id=$1 AND occurrence_key=$2",[r.id,next.occurrence_key]);await sql.query('UPDATE recurring_series SET version=version+1 WHERE id=$1',[r.id]);}
  return result;
 }
 if(r.kind==='legacy'){
  const inFlight=await stopPendingDelivery(sql,'reminder:'+r.id+':%');
  if(inFlight)return {cancelled:0,inFlight};
  await sql.query("UPDATE reminders SET status='cancelled' WHERE id=$1",[r.id]);
  return {cancelled:1,inFlight:0};
 }
 const result=await cancelSchedule(sql,r.id);
 if(r.kind==='occurrence'&&result.cancelled&&!result.inFlight){await sql.query("UPDATE recurring_occurrences SET status='skipped',version=version+1 WHERE schedule_id=$1",[r.id]);await sql.query('UPDATE recurring_series SET version=version+1 WHERE id=$1',[r.series_id]);}
 return result;
}

/** Internal executor used only after the immutable consent proposal has been
 * validated by finishReminderStopApproval. Lock and validate the whole binding
 * set before changing any root; the model never supplies this authority. */
export async function cancelApprovedReminderRoots(sql:SQL,bindings:ReadonlyArray<{ref:string;version:number|string;ownerId:string;sourceId:number;topicId:string;revision:number;ruleHash:string}>,c:ReminderContext,scope:'series'|'occurrence'):Promise<ReminderResult>{
 await context(sql,c);
 if(!bindings.length||new Set(bindings.map(item=>item.ref)).size!==bindings.length)return {handled:true,status:'stale',message:'Не вдалося звірити серію для цього погодження. Потрібен новий запит.'};
 const roots:ReminderRoot[]=[];
 for(const binding of bindings){
  if(!binding.ref.startsWith('series:')||binding.topicId!==c.topicId||binding.revision!==c.revision)return {handled:true,status:'stale',message:'Запит на зупинку вже не відповідає поточній серії. Перевірмо її заново.'};
  const row=await one(sql,'SELECT * FROM recurring_series WHERE id=$1 AND topic_id=$2 AND revision=$3 FOR UPDATE',[binding.ref.slice(7),c.topicId,c.revision]);
  if(!row||!seriesStatuses.includes(row.status)||row.audience!=='group'||row.rule?.mode!=='task'||String(row.actor_id)!==binding.ownerId||Number(row.source_message_id)!==binding.sourceId||row.version!==binding.version||digest(row.rule)!==binding.ruleHash)return {handled:true,status:'stale',message:'Серія змінилася після запиту на зупинку. Потрібне нове погодження.'};
  roots.push(root('series',row));
 }
 let cancelled=0,inFlight=0;
 for(const item of roots){const progress=await cancelRoot(sql,item,scope);cancelled+=progress.cancelled;inFlight+=progress.inFlight;}
 const message=scope==='series'?'Майбутні повтори зупинив.':cancelled?'Найближчий повтор скасував; серія залишається.':'Майбутнього повтору для скасування вже немає; серію залишив.';
 return {handled:true,status:inFlight?'stopped_with_in_flight':'cancelled',message:message+(inFlight?' Один із запусків уже розпочато або його доставку ще не підтверджено; не видаю його за скасований.':''),roots:roots.map(item=>item.ref),inFlight};
}

const cancellation=/^(?:(?:скасуй|скасувати|видали|видалити|прибери|припини|зупини|удали|удалить|отмени|отменить|убери|прекрати|cancel|delete|remove|\/cancel)(?:[\s,!:.]|$)|не\s+(?:нагадуй|напоминай)(?:[\s,!:.]|$))/iu;
const allScope=/(?:усю|всю|цілу|целую|whole)\s+(?:(?:приватн[\p{L}]*|личн[\p{L}]*|private|personal)\s+)?(?:сері|сери|series)|всі\s+повтор|усі\s+повтор|(?:всі|усі|все|all)\s+(?:(?:мої|мои|my|own|(?:не\s+)?приватн[\p{L}]*|(?:не\s+)?личн[\p{L}]*|(?:not\s+|non-)?private|personal)\s+)*(?:нагад|напомин|reminder)|ці\s+нагад|эти\s+напомин|для\s+обох|для\s+обоих|обом|all\s+(?:reminders|repeats)/iu;
const occurrenceScope=/найближч|ближайш|лише\s+(?:цей|це|один|одне)|тільки\s+(?:цей|це|один|одне)|только\s+(?:это|этот|один|одно)|цей\s+повтор|next\s+(?:one|occurrence)|only\s+(?:one|this)/iu;
function requestStart(text:string){
 let value=text.trim();
 for(let i=0;i<2;i++)value=value.replace(/^(?:будь ласка|пожалуйста|please|прошу|давай)[,!:\s]+/iu,'').replace(/^(?:люмене?|lumen|@\w+)[,!:\s]+/iu,'');
 return value;
}
function cancellationIntent(text:string,raw:string){
 const start=requestStart(text);
 if(cancellation.test(start))return true;
 // Targeted polite requests remain actionable; capability questions with no
 // concrete target do not delete the only item by accident.
 return /^(?:чи\s+)?(?:можеш|можете|можешь|мог\s+бы\s+ты|can\s+you|could\s+you|would\s+you|help\s+me|допоможи|помоги)\s+(?:(?:будь ласка|пожалуйста|please)[,\s]+)?(?:видалити|скасувати|прибрати|удалить|отменить|убрать|cancel|delete|remove)(?=$|[\s,!:.?])/iu.test(start)&&(reminderSearchTokens(searchText(raw)).length>0||allScope.test(start));
}
function cancellationAnswer(text:string){
 if(/[?？]/u.test(text))return;
 const answer=requestStart(bareIntent(text)).replace(/^(?:так|да|yes)[,!:\s]+/iu,'').replace(/[,\s]+(?:будь ласка|пожалуйста|please)[.!\s]*$/iu,'').trim().replace(/[.!]+$/u,'');
 if(/^(?:(?:усю|всю|цілу|целую|whole|the whole)\s+(?:(?:приватну|личную|private|personal)\s+)?(?:серію|серию|series)|усі повтори|всі повтори|все повторы|all repeats)$/iu.test(answer))return 'series';
 if(/^(?:усі|всі|все|all)$/iu.test(answer))return 'all';
 if(/^(?:(?:лише|тільки|только)\s+)?(?:найближчий(?: повтор)?|найближче|ближайший(?: повтор)?|ближайшее|next(?: occurrence| one)?|only (?:the )?next(?: occurrence| one)?)$/iu.test(answer))return 'occurrence';
 if(/^[1-9]\d?$/.test(answer))return Number(answer)-1;
}

async function clarification(sql:SQL,c:ReminderContext,roots:ReminderRoot[],purpose:string,requestedScope?:'series'){
 const hiddenPrivate=c.audience!=='private'&&roots.some(r=>r.audience==='private');
 if(hiddenPrivate)purpose=purpose==='series_scope'?'private_series_scope':'private_roots';
 // A question with no saved source cannot authorize an implicit follow-up.
 if(c.sourceId)await sql.query("INSERT INTO reminder_clarifications(actor_id,topic_id,revision,source_message_id,candidates,purpose,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes') ON CONFLICT(actor_id,topic_id) DO UPDATE SET revision=excluded.revision,source_message_id=excluded.source_message_id,candidates=excluded.candidates,purpose=excluded.purpose,expires_at=excluded.expires_at",[c.actorId,c.topicId,c.revision,c.sourceId,JSON.stringify(roots.map(r=>({ref:r.ref,version:r.version,...(requestedScope?{requested_scope:requestedScope}:{})}))),purpose]);
 const message=purpose==='series_scope'||purpose==='private_series_scope'?'Скасувати найближчий повтор чи всю серію?':hiddenPrivate?'Уточни ідентифікатор приватного нагадування або напиши «усі», якщо треба зупинити всі за цим запитом.':`Знайшов кілька нагадувань. Уточни номер або назву:\n${roots.map((r,i)=>`${i+1}. ${r.title}${r.rule?.time?' — '+r.rule.time:r.due_at?' — '+new Date(r.due_at).toISOString():''}`).join('\n')}`;
 return {handled:true,status:'needs_input',message,roots:roots.map(r=>r.ref)};
}

/** One authority/resolver/cancellation route for text, command and model actions.
 * Call from the caller's SQL transaction, after recording the real user source. */
export async function cancelReminderRequest(sql:SQL,request:ReminderRequest,c:ReminderContext):Promise<ReminderResult>{
 await context(sql,c);
 const source=await reminderRequestSource(sql,c),actual=source?.body||c.requestText||'';if(actual&&actual!==request.text)throw new ToolError('reminder_request_unbound');
 const plain=requestAuthorityView(request.text,source?.entities||[])?.commandText||'';
 const audienceCue=privateReminderCue(plain);
 const negated=/(?<![\p{L}\p{N}])(?:не|don't|do\s+not|not)\s+(?:видал|скас|приб|зупин|удал|отмен|убер|cancel|delete|remove)/iu.test(plain);
 const semanticCancel=Boolean(source&&c.cancellationQuote&&isAuthoredCancellationQuote(source.body,source.entities,c.cancellationQuote));
 if(c.cancellationQuote&&!semanticCancel)throw new ToolError('reminder_request_unbound');
 const freshCancel=semanticCancel?hasUnconditionalCancellationQuote(source!.body,source!.entities,c.cancellationQuote):cancellationIntent(plain,request.text)&&!negated&&!/(?:якщо|если|\bif\b|переклади|процитуй|переведи|процитируй|translate|quote)/iu.test(plain);
 let scope:'series'|'occurrence'=occurrenceScope.test(plain)||request.scope==='occurrence'?'occurrence':'series',roots:ReminderRoot[]=[];
 const pending=await one(sql,'SELECT * FROM reminder_clarifications WHERE actor_id=$1 AND topic_id=$2',[c.actorId,c.topicId]);
 if(!freshCancel){
  if(!pending)return {handled:false,status:'unrelated',message:''};
  const answer=cancellationAnswer(plain),all=answer==='series'||answer==='all',occurrence=answer==='occurrence',number=typeof answer==='number'?answer:undefined;
  if(answer===undefined)return {handled:false,status:'unrelated',message:''};
  if(source?.replyRef){
   const reply=source.replyRef,bound=reply.from_is_bot&&await one(sql,"SELECT id FROM outbox WHERE source_message_id=$1 AND telegram_id=$2 AND status='sent' AND actor_id=$3 AND COALESCE(body->>'scopeTopicId',body->>'threadId','0')=$4",[pending.source_message_id,reply.message_id,c.actorId,c.topicId]);
   if(!bound)return {handled:false,status:'unrelated',message:''};
  }
  if(pending.revision!==c.revision||new Date(pending.expires_at).getTime()<=Date.now()||!pending.source_message_id||c.sourceId===Number(pending.source_message_id)){
   await sql.query('DELETE FROM reminder_clarifications WHERE actor_id=$1 AND topic_id=$2',[c.actorId,c.topicId]);return {handled:true,status:'stale',message:'Це уточнення вже не чинне. Напиши, яке нагадування зараз скасувати.'};
  }
  const privatePending=pending.purpose==='private_series_scope'||pending.purpose==='private_roots';
  if(pending.purpose==='private_roots'&&answer!=='all')return {handled:true,status:'needs_input',message:'Уточни ідентифікатор приватного нагадування або напиши «усі» для цього запиту.'};
  const candidates=Array.isArray(pending.candidates)?pending.candidates:[];
  const chosen=number===undefined?candidates:candidates[number]?[candidates[number]]:[];
  for(const candidate of chosen){
   let found=await resolveReminders(sql,c,{id:candidate.ref,scope:occurrence?'occurrence':'series',privateOwnerControl:privatePending&&Boolean(source)});
   if(!found.length&&source&&c.audience!=='private'&&!privatePending)found=await (await import('./reminder-consent.js')).visibleConsentReminderCandidates(sql,c,{id:candidate.ref});
   if(found.length!==1||found[0]!.version!==candidate.version){
    await sql.query('DELETE FROM reminder_clarifications WHERE actor_id=$1 AND topic_id=$2',[c.actorId,c.topicId]);
    return {handled:true,status:'stale',message:'Нагадування змінилося після запитання. Перевірмо його заново.'};
   }
   roots.push(found[0]!);
  }
  if(!roots.length)return {handled:true,status:'needs_input',message:'Такого номера тут немає. Укажи номер із мого останнього списку.'};
  if(pending.purpose==='which_root'&&number===undefined&&!all)return clarification(sql,c,roots,'which_root');
  if(pending.purpose==='which_root'&&roots.length===1&&roots[0]!.kind==='series'&&!all&&!occurrence&&!chosen.every(candidate=>candidate.requested_scope==='series'))return clarification(sql,c,roots,'series_scope');
  scope=occurrence?'occurrence':'series';
 }else{
  if(audienceCue.ambiguous)return {handled:true,status:'needs_input',message:'Уточни: зупинити приватне нагадування чи нагадування в групі? Поки нічого не змінював.'};
  if(!semanticCancel&&request.id===undefined&&request.query===undefined&&!/нагад|напом|remind|^\/cancel/iu.test(plain))return {handled:false,status:'unrelated',message:''};
  const query=request.query??searchText(request.text.replace(/^\/cancel(?:@\w+)?\s*/iu,''));
  if(request.query&&reminderSearchTokens(request.query).some(w=>!reminderSearchTokens(request.text).some(a=>a===w||a.length>=4&&w.length>=4&&(a.startsWith(w)||w.startsWith(a)))))throw new ToolError('reminder_target_unbound');
  const supplied=request.id===undefined?'':String(request.id).replace(/^(?:series|schedule|legacy|occurrence):/iu,'');
  const literalId=Boolean(supplied&&request.text.toLowerCase().includes(supplied.toLowerCase())),privateView=audienceCue.private;
  let found=await resolveReminders(sql,c,{id:request.id,query,scope:allScope.test(plain)||semanticCancel&&request.scope==='series'&&!occurrenceScope.test(plain)?'series':scope==='occurrence'?'occurrence':'auto',privateOwnerControl:Boolean(source)&&(literalId||privateView),privateOnly:privateView});
  if(source&&c.audience!=='private'&&!privateView){
   const visible=await (await import('./reminder-consent.js')).visibleConsentReminderCandidates(sql,c,{id:request.id,...(request.id===undefined?{query}:{})});
   found=searchResult([...found,...visible.filter(item=>!found.some(own=>own.ref===item.ref))],Boolean(found.truncated));
  }
  if(found.truncated)return {handled:true,status:'needs_input',message:'За цим запитом надто багато кандидатів для однієї безпечної зміни. Уточни назву або ідентифікатор; поки жодного нагадування не скасував.'};
  roots=found;
  if(privateView)roots=roots.filter(r=>r.audience==='private');
  if(!source)roots=roots.filter(r=>!r.shared&&r.actor_id===c.actorId);
  if(roots.some(r=>r.kind==='occurrence'))scope='occurrence';
  const suppliedId=request.id===undefined?'':String(request.id).replace(/^(?:series|schedule|legacy|occurrence):/iu,'').toLowerCase();
  if(semanticCancel&&roots.some(item=>c.cancellationTargets?.some(target=>target.ref===item.ref&&target.version!==item.version)))return {handled:true,status:'stale',message:'Серія змінилася під час перевірки. Потрібно звірити її заново.'};
  if(semanticCancel&&!literalId&&c.cancellationTargets!==undefined&&roots.some(item=>!c.cancellationTargets!.some(target=>target.ref===item.ref&&target.version===item.version)))return {handled:true,status:'needs_input',message:'Потрібно звірити актуальну серію перед зупинкою. Поки нічого не змінював.'};
  const observedTarget=semanticCancel&&roots.length===1&&c.cancellationTargets?.some(target=>target.ref===roots[0]!.ref&&target.version===roots[0]!.version);
  if(suppliedId&&!request.text.toLowerCase().includes(suppliedId)&&!observedTarget)return {handled:true,status:'needs_input',message:'Уточни назву або номер нагадування, яке треба скасувати.'};
  if(/для\s+обох|для\s+обоих|for\s+both/iu.test(plain)&&roots.length>1)roots=roots.filter(r=>r.shared||r.approval_visibility);
  if(!roots.length)return {handled:true,status:'not_found',message:'Активного нагадування, яким ти можеш керувати в цій темі, не знайшов. Уточни назву або час.'};
  const all=allScope.test(plain);
  if(roots.length>1&&all&&!reminderSearchTokens(query).length&&!/всі\s+нагад|усі\s+нагад|все\s+напомин|all\s+reminders/iu.test(plain))return clarification(sql,c,roots,'which_root');
  if(roots.length>1&&!all)return clarification(sql,c,roots,'which_root',semanticCancel&&request.scope==='series'?'series':undefined);
  if(roots.length===1&&roots[0]!.kind==='series'&&request.id===undefined&&!all&&!occurrenceScope.test(plain)&&!(semanticCancel&&request.scope==='series'))return clarification(sql,c,roots,'series_scope');
 }
 const refs=roots.map(r=>r.ref).sort(),args={refs,scope,text:request.text};
 const receiptId=c.sourceId?stableId(`reminder-cancel:${c.actorId}:${c.sourceId}:${digest({refs,scope})}`):undefined;
 if(receiptId){const previous=await one(sql,'SELECT arguments_hash,result FROM domain_commands WHERE id=$1',[receiptId]);if(previous){if(previous.arguments_hash!==digest(args))throw new ToolError('reminder_request_changed');return previous.result as ReminderResult;}}
 const approvalRoots=roots.filter(item=>!manageable(item,c,true));
 if(approvalRoots.length){
  const approval=await (await import('./reminder-consent.js')).requestReminderStopApproval(sql,approvalRoots,c,scope);
  let direct=0,inFlight=0;
  for(const item of roots.filter(item=>manageable(item,c,true))){const stopped=await cancelRoot(sql,item,scope);direct++;inFlight+=stopped.inFlight;}
  await sql.query('DELETE FROM reminder_clarifications WHERE actor_id=$1 AND topic_id=$2',[c.actorId,c.topicId]);
  const result={...approval,message:(direct?'Доступні тобі повтори зупинив. ':'')+approval.message+(inFlight?' Один із запусків уже розпочато або його доставку ще не підтверджено.':''),inFlight};
  if(receiptId)await sql.query("INSERT INTO domain_commands(id,domain,actor_id,arguments_hash,result,source_message_id,source_ids) VALUES($1,'reminder_cancel',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",[receiptId,c.actorId,digest(args),JSON.stringify(result),c.sourceId,JSON.stringify([c.sourceId])]);
  return result;
 }
 let inFlight=0,cancelled=0,invalid=false;
 for(const r of roots){const result=await cancelRoot(sql,r,scope);inFlight+=result.inFlight;cancelled+=result.cancelled;invalid||=result.reason==='invalid_rule';}
 await sql.query('DELETE FROM reminder_clarifications WHERE actor_id=$1 AND topic_id=$2',[c.actorId,c.topicId]);
 const series=scope==='series'&&roots.some(r=>r.kind==='series');
 let message=series?'Майбутні повтори зупинив.':scope==='occurrence'?cancelled?'Найближчий повтор скасував; серія залишається.':inFlight?'Цей повтор уже розпочато або його доставку ще не підтверджено; серію залишив.':invalid?'Правило повтору потребує уточнення; цей повтор поки не скасував.':'Майбутнього повтору для скасування вже немає; серію залишив.':cancelled?'Нагадування скасував.':'Це нагадування вже завершено або зупинено.';
 if(inFlight&&(series||cancelled))message+=' Один із запусків уже розпочато або його доставку ще не підтверджено; не видаю його за скасований.';
 const result:ReminderResult={handled:true,status:inFlight?'stopped_with_in_flight':invalid?'needs_input':scope==='occurrence'&&!cancelled?'already_done':'cancelled',message,roots:roots.map(r=>r.ref),inFlight};
 if(receiptId)await sql.query("INSERT INTO domain_commands(id,domain,actor_id,arguments_hash,result,source_message_id,source_ids) VALUES($1,'reminder_cancel',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",[receiptId,c.actorId,digest(args),JSON.stringify(result),c.sourceId,JSON.stringify([c.sourceId])]);
 return result;
}
