import {one,state,type SQL,type Row} from './db.js';
import {digest} from './evolution-core.js';
import {specHash,ENGINE_VERSION} from './commitments.js';
import {openInteraction,interactionView,queueInteraction} from './interactions.js';
import {reminderRequestSource,reminderSearchTokens,type ReminderContext,type ReminderRoot,type ReminderResult} from './reminder-control.js';
import {ToolError} from './safe-http.js';
import type {ToolContext} from './agent-tools.js';
import {requestAuthorityView} from './outcomes.js';
import {stableId} from './operations.js';

export interface ReminderStopBinding {
 ref:string;version:number|string;ownerId:string;sourceId:number;topicId:string;revision:number;ruleHash:string;
}
export interface ConsentReminderRoot extends ReminderRoot {approval_visibility:'sent_group'|'consented_launch';}
type StopScope='series'|'occurrence';
type StopLaunch={kind:'reminder_cancel';version:1;namespaceChatId:string;bindings:ReminderStopBinding[];scope:StopScope;requester:{actorId:string;sourceId:number;sourceHash:string}};
export type ReminderStopExecutor=(sql:SQL,bindings:ReadonlyArray<ReminderStopBinding>,c:ReminderContext,scope:StopScope)=>Promise<ReminderResult>;
/** Minted only by the transport callback path, never a model/tool argument. */
export interface ReminderStopCallbackProof {id:string;version:number;action:string;}
type StopVote={proposalId:string;version:number;actorId:string;sourceId:number;specHash:string;decision:string;sourceHash:string;sourceTelegramId:number;sourceEditedAt:string|null;sourceEnvelopeHash:string;modality:'initial_requester'|'native_text'|'voice_transcription'|'callback';callbackAction?:string;nativeCardReply?:number};
const active=['active','draft','needs_input','paused'];
const isId=(value:unknown):value is string=>typeof value==='string'&&/^\d+$/.test(value);

async function currentGroup(sql:SQL,c:ReminderContext){
 const s=await state(sql,true);
 if(s.paused||s.memory_revision!==c.revision)throw new ToolError('task_cancelled');
 if(Number(s.chat_id)>=0||c.audience==='private'||c.chatId!==undefined&&String(s.chat_id)!==c.chatId)throw new ToolError('other_chat');
 if(!await currentMember(sql,c.actorId,s))throw new ToolError('member_required');
 return s;
}
async function currentMember(sql:SQL,actor:string,s:Row){
 const row=await one(sql,'SELECT active FROM members WHERE user_id=$1',[actor]);
 return row?row.active===true:String(s.owner_id)===actor||(s.participants||[]).some((p:any)=>String(p.id)===actor);
}
function binding(root:ReminderRoot):ReminderStopBinding{
 return {ref:root.ref,version:root.version,ownerId:root.actor_id,sourceId:Number(root.source_message_id),topicId:root.topic_id,revision:Number(root.revision),ruleHash:digest(root.rule)};
}
function matches(root:Row,query:string){
 // Only the public card title is visible to another group member. Internal
 // task instructions/goals are not a search oracle for that member.
 const wanted=reminderSearchTokens(query),actual=reminderSearchTokens(String(root.rule?.title||''));
 return wanted.every(word=>actual.some(other=>other===word||word.length>=4&&other.length>=4&&(word.startsWith(other)||other.startsWith(word))));
}

/** Delivery proves visibility of this group task, never permission to stop it.
 * A title match, group membership, or a private child alone is insufficient. */
async function sentGroupTask(sql:SQL,row:Row,chatId:string){
 return Boolean(await one(sql,`SELECT o.id FROM recurring_occurrences r
  JOIN scheduled_actions a ON a.id=r.schedule_id
  JOIN agent_tasks t ON t.id=a.task_id
  JOIN outbox o ON o.body->>'taskId'=t.id::text
  WHERE r.series_id=$1 AND a.topic_id=$2 AND a.revision=$3 AND a.author_id=$4
   AND a.source_message_id=$5 AND a.audience='group' AND t.actor_id=$4 AND t.topic_id=$2
   AND t.revision=$3 AND t.source_message_id=$5 AND t.audience='group'
   AND o.kind='task_status' AND o.status='sent' AND o.telegram_id>0 AND o.audience='group' AND o.revision=$3 AND o.actor_id=$4
   AND o.source_message_id=$5 AND strpos(o.body->>'text',$7)>0
   AND o.body->'deliveryReceipt'->>'provider'='telegram'
   AND o.body->'deliveryReceipt'->>'destination_chat_id'=$6
   AND o.body->'deliveryReceipt'->>'source_chat_id'=$6
   AND o.body->'deliveryReceipt'->>'scope_topic_id'=$2
   AND o.body->'deliveryReceipt'->>'actor_id'=$4
   AND o.body->'deliveryReceipt'->>'audience'='group'
   AND o.body->'deliveryReceipt'->>'message_id'=o.telegram_id::text
   AND o.body->'deliveryReceipt'->>'task_id'=t.id::text
   AND o.body->'deliveryReceipt'->>'source_message_id'=($5::bigint)::text
   AND COALESCE(o.body->>'scopeTopicId',o.body->>'threadId','0')=$2
   AND NOT EXISTS(SELECT 1 FROM outbox hidden WHERE hidden.body->>'taskId'=t.id::text AND hidden.audience='private')
   AND NOT EXISTS(SELECT 1 FROM media_jobs m WHERE m.task_id=t.id AND m.audience='private' AND (m.goal_version IS NULL OR m.goal_version=t.goal_version))
  LIMIT 1`,[row.id,String(row.topic_id),row.revision,String(row.actor_id),row.source_message_id,chatId,String(row.rule?.title||'')]));
}

/** Older confirmed launches retain historical visibility even after their
 * execution lease expires. They do not confer new mutation authority. Match
 * the exact creation tool result/rule/source and immutable consent spec. */
async function consentedLaunch(sql:SQL,row:Row,actor:string){
 const runs=(await sql.query(`SELECT id,arguments FROM tool_runs WHERE tool='schedule.series'
  AND status='succeeded' AND actor_id=$1 AND revision=$2 AND source_message_id=$3
  AND result->>'id'=$4 AND arguments->>'operation' IN ('preview','create') LIMIT 9`,[row.actor_id,row.revision,row.source_message_id,String(row.id)])).rows;
 if(!runs.some(run=>run.arguments?.rule&&digest(run.arguments.rule)===digest(row.rule)))return false;
 const launches=(await sql.query(`SELECT i.*,c.spec AS committed_spec,c.spec_hash,c.kind AS commitment_kind
  FROM interactions i JOIN commitments c ON c.id=i.action_id
  JOIN consent_grants g ON g.action_id=c.id AND g.actor_id=$1 AND g.source_message_id=$2
  WHERE i.topic_id=$3 AND i.revision=$4 AND c.topic_id=$3 AND c.revision=$4
   AND c.kind='activity_launch' AND g.spec_hash=c.spec_hash AND g.decision IN ('agree','answer') LIMIT 9`,[row.actor_id,row.source_message_id,String(row.topic_id),row.revision])).rows;
 let matches=0;
 for(const launch of launches){
  const spec=launch.committed_spec,people=spec?.participants,action=spec?.launch;
  if(!spec||launch.spec_hash!==specHash(spec)||!Array.isArray(people)||people.length<2
   ||action?.kind!=='tool'||action.name!=='schedule.series'||!launch.launch
   ||!people.some((p:any)=>String(p.id)===actor)||!people.some((p:any)=>String(p.id)===String(row.actor_id))
   ||digest(people)!==digest(launch.participants)||digest(action)!==digest(launch.launch)
   ||spec.interaction?.scope!=='invited')continue;
  let args:any;try{args=JSON.parse(action.arguments);}catch{continue;}
  if(!['preview','create'].includes(args?.operation)||digest(args.rule)!==digest(row.rule))continue;
  const grants=(await sql.query("SELECT actor_id FROM consent_grants WHERE action_id=$1 AND spec_hash=$2 AND decision IN ('agree','answer')",[launch.action_id,launch.spec_hash])).rows;
  if(people.every((p:any)=>isId(p.id)&&grants.some(g=>g.actor_id===p.id)))matches++;
 }
 return matches===1;
}

/** Search only roots this actor can already see, without giving stop rights.
 * The normal authorized resolver remains the first route. */
export async function visibleConsentReminderCandidates(sql:SQL,c:ReminderContext,request:{query?:string;id?:string|number}={}):Promise<ConsentReminderRoot[]>{
 const s=await currentGroup(sql,c);
 const id=request.id===undefined?null:String(request.id).replace(/^(?:series|schedule|occurrence):/iu,'');
 if(id!==null&&!/^[a-f\d]{8}-[a-f\d-]{27}$/iu.test(id))return [];
 const tokens=reminderSearchTokens(request.query||''),fts=tokens.length?tokens.map(word=>word.slice(0,4)+':*').join(' & '):null;
 const rows=(await sql.query(`SELECT s.* FROM recurring_series s WHERE s.topic_id=$1 AND s.revision=$2
  AND s.status=ANY($3::text[]) AND s.audience='group' AND s.rule->>'mode'='task' AND s.source_message_id IS NOT NULL
  AND ($4::text IS NULL OR s.id::text=$4 OR EXISTS(SELECT 1 FROM recurring_occurrences r WHERE r.series_id=s.id AND r.schedule_id::text=$4))
  AND ($5::text IS NULL OR to_tsvector('simple',normalize(s.rule->>'title',NFKC)) @@ to_tsquery('simple',$5))
  ORDER BY s.created_at DESC,s.id DESC LIMIT 41`,[c.topicId,c.revision,active,id,fts])).rows;
 // An overflow cannot justify cancelling a partial set or claiming not found.
 if(rows.length>40)throw new ToolError('reminder_candidates_overflow');
 const visible:ConsentReminderRoot[]=[];
 for(const row of rows){
  if(!Number.isSafeInteger(Number(row.source_message_id))||Number(row.source_message_id)<=0||!matches(row,request.query||''))continue;
  const kind=await sentGroupTask(sql,row,String(s.chat_id))?'sent_group':await consentedLaunch(sql,row,c.actorId)?'consented_launch':undefined;
  if(kind)visible.push({...row,kind:'series',ref:'series:'+row.id,id:String(row.id),title:String(row.rule?.title||''),actor_id:String(row.actor_id),topic_id:String(row.topic_id),status:String(row.status),shared:row.shared===true,manager_ids:Array.isArray(row.manager_ids)?row.manager_ids:[],audience:'group',version:Number(row.version),approval_visibility:kind});
 }
 return visible;
}

async function freshRequester(sql:SQL,c:ReminderContext){
 const source=await reminderRequestSource(sql,c);
 if(!c.sourceId||!source)throw new ToolError('reminder_request_unbound');
 return source;
}
function toolContext(c:ReminderContext,chat:string):ToolContext{return {...c,chatId:chat,updateId:c.updateId||'reminder-stop:'+c.sourceId,requested:true,audience:'group'};}
async function person(sql:SQL,actor:string,s:Row){
 const member=await one(sql,'SELECT name FROM members WHERE user_id=$1',[actor]);
 return {id:actor,name:String(member?.name||(s.participants||[]).find((p:any)=>String(p.id)===actor)?.name||actor)};
}
function boundProposal(row:Row,commitment:Row|undefined,chatId:string){
 const launch=row.launch as StopLaunch,cleanSpec={...row.spec};delete cleanSpec.reminder_cancel;
 return Boolean(commitment&&commitment.id===row.id&&commitment.engine_version===ENGINE_VERSION&&commitment.kind==='activity_launch'
  &&commitment.topic_id===row.topic_id&&commitment.revision===row.revision&&commitment.actor_id===row.actor_id
  &&Number(commitment.source_message_id)===Number(row.source_message_id)
  &&commitment.spec_hash===specHash(commitment.spec)&&digest(commitment.spec)===digest({interaction:cleanSpec,participants:row.participants,launch})
  &&launch?.kind==='reminder_cancel'&&launch.version===1&&launch.namespaceChatId===chatId&&['series','occurrence'].includes(launch.scope)
  &&launch.requester?.actorId===row.actor_id&&isId(launch.requester.actorId)
  &&Number.isSafeInteger(launch.requester.sourceId)&&launch.requester.sourceId>0&&launch.requester.sourceId===Number(row.source_message_id)
  &&/^[a-f\d]{64}$/u.test(launch.requester.sourceHash)&&Array.isArray(launch.bindings)&&launch.bindings.length>0&&launch.bindings.length<=20
  &&new Set(launch.bindings.map(b=>b.ref)).size===launch.bindings.length
  &&launch.bindings.every(b=>b&&/^series:[a-f\d]{8}-[a-f\d-]{27}$/iu.test(b.ref)&&isId(b.ownerId)
   &&Number.isSafeInteger(b.sourceId)&&b.sourceId>0&&b.topicId===row.topic_id&&b.revision===row.revision
   &&Number.isSafeInteger(b.version)&&Number(b.version)>0&&/^[a-f\d]{64}$/u.test(b.ruleHash)));
}

function explicitVote(text:string,entities:ReadonlyArray<{type:string;offset:number;length:number}>,decision:string,scope:StopScope,cardReply=false){
 const authority=requestAuthorityView(text,entities);
 // A vote accepts this frozen action. Masking an additional quoted target or
 // specification must not turn a different instruction into that acceptance.
 if(!authority||decision==='agree'&&(authority.quotedDataRanges.length>0||authority.codeDataRanges.length>0))return false;
 const plain=authority.commandText.trim().replace(/^(?:люмене?|lumen|@\w+)[,!:\s]+/iu,'');
 if(!plain||/[?？]|(?:^|[^\p{L}\p{N}])(?:якщо|если|if|when|коли|переклади|переведи|translate|процитуй|quote)(?=$|[^\p{L}\p{N}])/iu.test(plain))return false;
 const answer=plain.replace(/[\s.!]+$/u,'');
 if(decision==='agree'){
  if(/(?:^|[^\p{L}\p{N}])(?:не|ні|нет|no|not|never|don't)(?=$|[^\p{L}\p{N}])/iu.test(plain))return false;
  // Match the whole authored answer, not a positive prefix. Any new timing,
  // condition, target, or narrower/wider scope needs a separate proposal.
  const nominal=/^(?:(?:я|i)\s+)?(?:підтверджую|погоджую|погоджуюсь\s+на|погоджуюся\s+на|confirm|agree\s+to)\s+(?:зупинку|зупинення|скасування|припинення|видалення|stop(?:ping)?|cancel(?:lation|ling)?)\s+(.+)$/iu.exec(answer);
  const imperative=/^(?:так|ага|да|yes)[,\s]+(?:зупиняй|скасовуй|припиняй|видаляй|зупинити|скасувати|припинити|stop|cancel)\s+(.+)$/iu.exec(answer);
  const target=(nominal||imperative)?.[1];
  const exactScope=scope==='series'
   ?/^(?:(?:цієї|всієї|усієї|цю|всю|усю)\s+)?сері[їю]$|^(?:(?:усіх|всіх)\s+)?майбутніх\s+повторів$|^(?:(?:усі|всі)\s+)?майбутні\s+повтори$|^(?:the\s+)?(?:entire\s+)?series$/iu
   :/^(?:(?:лише|тільки)\s+)?(?:(?:цього|найближчого|наступного)\s+(?:повтору|запуску)|(?:цей|найближчий|наступний)\s+(?:повтор|запуск))$|^(?:the\s+)?next\s+(?:occurrence|run)$/iu;
  if(target&&exactScope.test(target))return true;
  return cardReply&&(/^(?:(?:я|i)\s+)?(?:так|ага|да|yes|згоден|згодна|погоджуюсь|погоджуюся|підтверджую|confirm|agree)$/iu.test(answer)
   ||/^(?:(?:я|i)\s+)?(?:підтверджую|погоджую\s+на|погоджуюсь\s+на|погоджуюся\s+на)\s+(?:цю\s+дію|дію\s+з\s+картки)$/iu.test(answer));
 }
 if(decision==='decline'||decision==='leave')return /^(?:залишити|залиш)\s+(?:цю\s+)?(?:серію|повтори|роботу|нагадування)(?=$|[\s,!:.])/iu.test(answer)||cardReply&&/^(?:(?:я|i)\s+)?(?:ні|нет|no|не\s+погоджую(?:сь|ся)?|відхиляю|відмовляюсь|відмовляюся|виходжу|decline|leave)$/iu.test(answer);
 if(decision==='not_ready')return /^(?:поки\s+(?:не|ні)|ще\s+не|не\s+готов|зачекай|хвилинку|wait|not\s+yet|later)(?=$|[\s,!:.\p{L}])/iu.test(plain);
 return false;
}
function callbackDecision(action:string){return action==='yes'?'agree':action==='no'?'decline':action==='wait'?'not_ready':undefined;}
function voteId(id:string,version:number,actor:string,sourceId:number){return stableId(`reminder-stop-vote:${id}:${version}:${actor}:${sourceId}`);}
async function nativeVoteContext(sql:SQL,row:Row,c:ToolContext){
 const source=await reminderRequestSource(sql,{...c,requestText:undefined});
 if(!source)throw new ToolError('reminder_vote_unbound');
 // A bare "yes" belongs to this actual current card (or an exact reply to
 // it), not to an arbitrary older proposal selected by a model.
 const {currentInteraction}=await import('./interactions.js');
 const current=await currentInteraction(sql,c.topicId,c.actorId,source.replyRef?.message_id);
 if(current?.id!==row.id||source.replyRef&&source.replyRef.from_is_bot!==true)throw new ToolError('reminder_vote_unbound');
 return source;
}
async function actualCardReply(sql:SQL,row:Row,c:ToolContext,source:Awaited<ReturnType<typeof reminderRequestSource>>){
 if(!source?.replyRef||source.replyRef.from_is_bot!==true)return false;
 const message=source.replyRef.message_id;
 if(Number(row.card_message_id)!==message&&!Object.values(row.card_message_ids||{}).some(id=>Number(id)===message))return false;
 return Boolean(await one(sql,`SELECT id FROM outbox WHERE kind='interaction' AND status='sent' AND telegram_id=$1
  AND revision=$2 AND audience='group' AND body->>'id'=$3 AND body->>'version'=$4
  AND body->'deliveryReceipt'->>'provider'='telegram' AND body->'deliveryReceipt'->>'message_id'=$1::text
  AND body->'deliveryReceipt'->>'destination_chat_id'=$5 AND body->'deliveryReceipt'->>'scope_topic_id'=$6 LIMIT 1`,[message,c.revision,row.id,String(row.version),String(c.chatId),c.topicId]));
}
async function callbackSource(sql:SQL,c:ToolContext){
 const row=c.sourceId?await one(sql,'SELECT id,user_id,topic_id,role,telegram_id,body,request_context,edited_at FROM messages WHERE id=$1',[c.sourceId]):undefined;
 if(!row||row.role!=='user'||row.user_id!==c.actorId||row.topic_id!==c.topicId||!Number.isSafeInteger(Number(row.telegram_id))||Number(row.telegram_id)>=0||row.request_context!==null||row.edited_at!==null||row.body!=='[Вибір у поточному кроці]')throw new ToolError('reminder_vote_unbound');
 return row;
}
function sourcePin(source:Row){return {sourceTelegramId:Number(source.telegram_id),sourceEditedAt:source.edited_at?new Date(source.edited_at).toISOString():null,sourceEnvelopeHash:digest(source.request_context??null)};}

/** Validate before answerInteraction writes responses or consent grants.
 * An LLM-selected interaction_response is not itself a user's agreement. */
export async function validateReminderStopVote(sql:SQL,row:Row,answer:{id:string;version:number;decision:string;submit:boolean},c:ToolContext,callback?:ReminderStopCallbackProof):Promise<void>{
 if(!row?.spec?.reminder_cancel&&row?.launch?.kind!=='reminder_cancel')return;
 const s=await currentGroup(sql,c),commitment=await one(sql,'SELECT * FROM commitments WHERE id=$1 FOR UPDATE',[row.action_id]);
 if(!boundProposal(row,commitment,String(s.chat_id))||commitment!.phase!=='waiting_acceptance'||!['collecting','ready'].includes(row.phase)||row.id!==answer.id||row.version!==answer.version||!row.participants.some((p:any)=>String(p.id)===c.actorId)||!c.sourceId)throw new ToolError('reminder_vote_unbound');
 if(!answer.submit)throw new ToolError('reminder_vote_explicit_required');
 if(new Date(row.expires_at).getTime()<=Date.now()||new Date(commitment!.expires_at).getTime()<=Date.now())throw new ToolError('reminder_approval_unavailable');
 const launch=row.launch as StopLaunch;
 let vote:StopVote;
 if(callback){
  if(callback.id!==row.id||callback.version!==row.version||callbackDecision(callback.action)!==answer.decision)throw new ToolError('reminder_vote_unbound');
  const source=await callbackSource(sql,c);
  vote={proposalId:row.id,version:row.version,actorId:c.actorId,sourceId:c.sourceId,specHash:commitment!.spec_hash,decision:answer.decision,sourceHash:digest(source.body),...sourcePin(source),modality:'callback',callbackAction:callback.action};
 }else{
  let source;try{source=await reminderRequestSource(sql,{...c,requestText:undefined});}catch(e){if(e instanceof ToolError&&e.code==='reminder_request_unbound')throw new ToolError('reminder_vote_unbound');throw e;}
  if(!source)throw new ToolError('reminder_vote_unbound');
  const initial=answer.decision==='agree'&&c.actorId===launch.requester.actorId&&c.sourceId===launch.requester.sourceId&&digest(source.body)===launch.requester.sourceHash;
  let cardReply=false;
  if(!initial){
   await nativeVoteContext(sql,row,c);
   cardReply=await actualCardReply(sql,row,c,source);
   if(!explicitVote(source.body,source.entities,answer.decision,launch.scope,cardReply))throw new ToolError('reminder_vote_explicit_required');
  }
  const stored=(await one(sql,'SELECT telegram_id,request_context,edited_at FROM messages WHERE id=$1',[c.sourceId]))!;
  vote={proposalId:row.id,version:row.version,actorId:c.actorId,sourceId:c.sourceId,specHash:commitment!.spec_hash,decision:answer.decision,sourceHash:digest(source.body),...sourcePin(stored),modality:initial?'initial_requester':source.modality,...(cardReply?{nativeCardReply:source.replyRef!.message_id}:{})};
 }
 const id=voteId(row.id,row.version,c.actorId,c.sourceId),hash=digest(vote),old=await one(sql,'SELECT domain,actor_id,arguments_hash,result FROM domain_commands WHERE id=$1',[id]);
 if(old){if(old.domain!=='reminder_stop_vote'||old.actor_id!==c.actorId||old.arguments_hash!==hash||digest(old.result)!==hash)throw new ToolError('reminder_vote_changed');return;}
 await sql.query("INSERT INTO domain_commands(id,domain,actor_id,arguments_hash,result,source_message_id,source_ids) VALUES($1,'reminder_stop_vote',$2,$3,$4,$5,$6)",[id,c.actorId,hash,JSON.stringify(vote),c.sourceId,JSON.stringify([c.sourceId])]);
}

async function validRecordedVote(sql:SQL,row:Row,commitment:Row,response:Row,namespace:string){
 const sourceId=Number(response.source_message_id);
 if(!Number.isSafeInteger(sourceId)||sourceId<=0)return false;
 const receipt=await one(sql,'SELECT domain,actor_id,arguments_hash,result,source_message_id FROM domain_commands WHERE id=$1',[voteId(row.id,row.version,String(response.user_id),sourceId)]);
 const vote=receipt?.result as StopVote;
 if(!receipt||!vote||typeof vote!=='object'||receipt.domain!=='reminder_stop_vote'||receipt.actor_id!==response.user_id||Number(receipt.source_message_id)!==sourceId||receipt.arguments_hash!==digest(vote)
  ||vote.proposalId!==row.id||vote.version!==row.version||vote.actorId!==response.user_id||vote.sourceId!==sourceId||vote.specHash!==commitment.spec_hash||vote.decision!=='agree')return false;
 const c:ToolContext={actorId:String(response.user_id),chatId:namespace,topicId:row.topic_id,revision:row.revision,sourceId,updateId:'reminder-vote-check',requested:true,audience:'group'};
 try{
  if(vote.modality==='callback'){
   const source=await callbackSource(sql,c);
   return vote.callbackAction==='yes'&&digest({sourceTelegramId:vote.sourceTelegramId,sourceEditedAt:vote.sourceEditedAt,sourceEnvelopeHash:vote.sourceEnvelopeHash})===digest(sourcePin(source))&&vote.sourceHash===digest(source.body);
  }
  const source=await reminderRequestSource(sql,c),stored=await one(sql,'SELECT telegram_id,request_context,edited_at FROM messages WHERE id=$1',[sourceId]);
  if(!source||!stored||digest({sourceTelegramId:vote.sourceTelegramId,sourceEditedAt:vote.sourceEditedAt,sourceEnvelopeHash:vote.sourceEnvelopeHash})!==digest(sourcePin(stored))||vote.sourceHash!==digest(source.body))return false;
  const launch=row.launch as StopLaunch;
  if(vote.modality==='initial_requester')return c.actorId===launch.requester.actorId&&sourceId===launch.requester.sourceId&&vote.sourceHash===launch.requester.sourceHash;
  const cardReply=vote.nativeCardReply!==undefined&&source.replyRef?.message_id===vote.nativeCardReply&&await actualCardReply(sql,row,c,source);
  return vote.modality===source.modality&&explicitVote(source.body,source.entities,'agree',launch.scope,cardReply);
 }catch(e){if(e instanceof ToolError&&/^(reminder_|task_cancelled)/u.test(e.code))return false;throw e;}
}

export async function requestReminderStopApproval(sql:SQL,roots:ReadonlyArray<ReminderRoot>,c:ReminderContext,scope:StopScope='series'):Promise<ReminderResult>{
 const s=await currentGroup(sql,c),source=await freshRequester(sql,c);
 if(!roots.length||roots.length>20)throw new ToolError('reminder_approval_target_required');
 const bindings:ReminderStopBinding[]=[],owners=new Set<string>();
 for(const supplied of roots){
  const current=(await visibleConsentReminderCandidates(sql,c,{id:supplied.ref})).find(row=>row.ref===supplied.ref);
  if(!current||digest(binding(current))!==digest(binding(supplied)))throw new ToolError('reminder_target_changed');
  bindings.push(binding(current));owners.add(current.actor_id);
 }
 bindings.sort((a,b)=>a.ref.localeCompare(b.ref));
 const required=[...new Set([c.actorId,...owners])].sort();
 if(required.length===1)throw new ToolError('reminder_approval_not_required');
 if(required.length>30)throw new ToolError('reminder_approval_target_required');
 const people=await Promise.all(required.map(id=>person(sql,id,s)));
 for(const owner of owners)if(!await currentMember(sql,owner,s))return {handled:true,status:'owner_required',message:`Власник цієї серії — ${(await person(sql,owner,s)).name}. Потрібне його підтвердження, але зараз він не є активним учасником цієї групи; серію поки не змінював.`,roots:bindings.map(x=>x.ref)};
 const pending=(await sql.query("SELECT * FROM interactions WHERE actor_id=$1 AND topic_id=$2 AND revision=$3 AND phase='collecting' AND expires_at>now() AND spec->>'reminder_cancel'='true' ORDER BY created_at DESC LIMIT 8 FOR UPDATE",[c.actorId,c.topicId,c.revision])).rows;
 for(const previous of pending){
  if(previous.launch?.kind==='reminder_cancel'&&previous.launch.scope===scope&&Array.isArray(previous.launch.bindings)&&digest(previous.launch.bindings)===digest(bindings)){
   const commitment=await one(sql,'SELECT * FROM commitments WHERE id=$1',[previous.action_id]);
   if(!boundProposal(previous,commitment,String(s.chat_id))||commitment!.phase!=='waiting_acceptance'||new Date(commitment!.expires_at).getTime()<=Date.now())continue;
   let oldSource;try{oldSource=await freshRequester(sql,{...c,sourceId:previous.launch.requester.sourceId,requestText:undefined});}catch(e){if(!(e instanceof ToolError)||e.code!=='reminder_request_unbound')throw e;}
   if(!oldSource||digest(oldSource.body)!==previous.launch.requester.sourceHash){await closeProposal(sql,previous.id,'Початкове прохання змінилося. Потрібен новий запит.','cancelled');await queueInteraction(sql,previous.id);continue;}
   const view=await interactionView(sql,previous.id);
   await queueInteraction(sql,view.id);
   return {handled:true,status:'needs_participant_approval',message:approvalMessage(roots,people.filter(p=>owners.has(p.id))),roots:bindings.map(x=>x.ref)};
  }
 }
 const launch:StopLaunch={kind:'reminder_cancel',version:1,namespaceChatId:String(s.chat_id),bindings,scope,requester:{actorId:c.actorId,sourceId:c.sourceId!,sourceHash:digest(source.body)}};
 const titles=roots.map(r=>r.title).join('», «').slice(0,350);
 const question=scope==='series'?`Зупинити майбутні повтори «${titles}»? Уже розпочаті запуски перевірятимуться окремо.`:`Скасувати найближчий повтор «${titles}», зберігши серію?`;
 // Build through the existing interaction contract. Its roster currently uses
 // registered pair participants; members in an open group are added only here,
 // from verified active membership, before recording any response/grant.
 const initial=await openInteraction(sql,{title:scope==='series'?'Зупинка повторюваної роботи':'Скасування найближчого повтору',kind:'consent',scope:'personal',policy:'all',participant_ids:[],question,options:[]},toolContext(c,String(s.chat_id)),{launch,autoAccept:false});
 const spec={...initial.spec,scope:'invited',participant_ids:required};
 const committed={interaction:spec,participants:people,launch};
 await sql.query('UPDATE commitments SET spec=$2,spec_hash=$3 WHERE id=$1 AND phase=\'waiting_acceptance\'',[initial.id,JSON.stringify(committed),specHash(committed)]);
 await sql.query('UPDATE interactions SET spec=$2,participants=$3 WHERE id=$1',[initial.id,JSON.stringify({...spec,reminder_cancel:true}),JSON.stringify(people)]);
 // The actual requester is the sole automatic acceptance, backed by source.
 const {answerInteraction}=await import('./interactions.js');
 const view=await answerInteraction(sql,{id:initial.id,version:initial.version,decision:'agree'},toolContext(c,String(s.chat_id)));
 await queueInteraction(sql,view.id);
 return {handled:true,status:'needs_participant_approval',message:approvalMessage(roots,people.filter(p=>owners.has(p.id))),roots:bindings.map(x=>x.ref)};
}
function approvalMessage(roots:ReadonlyArray<ReminderRoot>,owners:ReadonlyArray<{name:string}>){return `Знайшов «${roots.map(r=>r.title).join('», «')}». Власник ${owners.length===1?'цієї серії':'цих серій'} — ${owners.map(p=>p.name).join(', ')}. Твоє прохання зафіксував; для зупинки потрібне підтвердження ${owners.length===1?'власника':'власників'} кнопкою в картці. До погодження стан серії не змінюю.`;}

/** Consume only server-created cancellation proposals. Never enqueue a model
 * continuation: a version-bound owner button executes the canonical stop. */
export async function finishReminderStopApproval(sql:SQL,input:any,c:ToolContext,execute:ReminderStopExecutor):Promise<boolean>{
 if(!input?.spec?.reminder_cancel&&input?.launch?.kind!=='reminder_cancel')return false;
 const s=await currentGroup(sql,c),view=await interactionView(sql,String(input.id));
 const row=await one(sql,'SELECT * FROM interactions WHERE id=$1 FOR UPDATE',[view.id]);
 if(!row||input.version!==row.version||row.topic_id!==c.topicId||row.revision!==c.revision||!row.participants.some((p:any)=>String(p.id)===c.actorId))throw new ToolError('reminder_approval_unavailable');
 if(row.phase==='resolved'||row.phase==='cancelled')return true;
 const commitment=await one(sql,'SELECT * FROM commitments WHERE id=$1 FOR UPDATE',[row.action_id]);
 const launch=row.launch as StopLaunch;
 if(!boundProposal(row,commitment,String(s.chat_id))||commitment!.phase!=='waiting_acceptance')throw new ToolError('reminder_approval_unbound');
 const requester:ReminderContext={actorId:launch.requester.actorId,chatId:String(s.chat_id),topicId:row.topic_id,revision:row.revision,sourceId:launch.requester.sourceId,audience:'group'};
 if(new Date(row.expires_at).getTime()<=Date.now()||new Date(commitment!.expires_at).getTime()<=Date.now()||s.paused){await closeProposal(sql,row.id,'Час погодження минув. Серію не змінював; потрібен новий запит.','cancelled');await queueInteraction(sql,row.id);return true;}
 let source;try{source=await freshRequester(sql,requester);}catch(e){if(!(e instanceof ToolError)||e.code!=='reminder_request_unbound')throw e;}
 if(!source||digest(source.body)!==launch.requester.sourceHash){await closeProposal(sql,row.id,'Початкове прохання змінилося. Серію не змінював; потрібен новий запит.','cancelled');await queueInteraction(sql,row.id);return true;}
 const required=[...new Set([requester.actorId,...launch.bindings.map(b=>b.ownerId)])].sort();
 if(digest(required)!==digest(row.participants.map((p:any)=>String(p.id)).sort()))throw new ToolError('reminder_approval_unbound');
 for(const actor of required)if(!await currentMember(sql,actor,s))throw new ToolError('reminder_approval_unavailable');
 const responses=(await sql.query('SELECT user_id,decision,submitted,spec_hash,source_message_id FROM interaction_responses WHERE interaction_id=$1 AND version=$2',[row.id,row.version])).rows;
 if(responses.some(r=>required.includes(r.user_id)&&r.submitted&&['decline','leave'].includes(r.decision))){await closeProposal(sql,row.id,'Зупинку не погоджено. Серія залишається активною.','cancelled');await queueInteraction(sql,row.id);return true;}
 if(row.phase!=='ready')return true;
 if(!required.every(actor=>responses.some(r=>r.user_id===actor&&r.submitted&&r.decision==='agree'&&r.spec_hash===commitment!.spec_hash))){await closeProposal(sql,row.id,'Потрібна згода змінилася або більше недоступна. Серію не змінював; потрібне нове погодження.','cancelled');await queueInteraction(sql,row.id);return true;}
 const grants=(await sql.query("SELECT actor_id FROM consent_grants WHERE action_id=$1 AND spec_hash=$2 AND decision='agree'",[row.id,commitment!.spec_hash])).rows;
 if(!required.every(actor=>grants.some(g=>g.actor_id===actor)))throw new ToolError('reminder_approval_unbound');
 for(const actor of required)if(!await validRecordedVote(sql,row,commitment!,responses.find(r=>r.user_id===actor)!,String(s.chat_id))){await closeProposal(sql,row.id,'Не вдалося підтвердити власну згоду потрібного учасника. Серію не змінював; потрібне нове погодження.','cancelled');await queueInteraction(sql,row.id);return true;}
 for(const expected of launch.bindings){
  const current=(await visibleConsentReminderCandidates(sql,requester,{id:expected.ref})).find(root=>root.ref===expected.ref);
  if(!current||digest(binding(current))!==digest(expected)){await closeProposal(sql,row.id,'Серія змінилася після запиту. Нічого не скасовував; перевірмо її заново.','cancelled');await queueInteraction(sql,row.id);return true;}
 }
 const result=await execute(sql,launch.bindings,requester,launch.scope);
 await closeProposal(sql,row.id,result.message,'resolved',result);
 await queueInteraction(sql,row.id);
 return true;
}
async function closeProposal(sql:SQL,id:string,message:string,phase:'cancelled'|'resolved',result?:ReminderResult){
 await sql.query('UPDATE interactions SET phase=$2,result=$3,updated_at=now() WHERE id=$1',[id,phase,message]);
 await sql.query('UPDATE commitments SET phase=$2,result=$3,state_version=state_version+1,updated_at=now() WHERE id=$1',[id,phase==='resolved'?'completed':'cancelled',JSON.stringify(result||{status:phase,message})]);
}
