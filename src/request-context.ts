import {createHash} from 'node:crypto';
import {topicKey} from './topic-scope.js';
import {one,type SQL,type Row} from './db.js';

export const ORIGINAL_REQUEST_MAX_BYTES=16*1024;
export const ORIGINAL_REQUEST_MAX_ENTITIES=128;
/** Canonicalize an internal DB/job identifier at its boundary. node-postgres
 * returns BIGSERIAL as decimal text; never coerce arbitrary model/user values. */
export function storedSourceId(value:unknown):number|undefined {
 if(typeof value==='number')return Number.isSafeInteger(value)&&value>0?value:undefined;
 if(typeof value!=='string'||!/^[1-9]\d*$/.test(value))return;
 const result=Number(value);return Number.isSafeInteger(result)&&result>0&&String(result)===value?result:undefined;
}
export type OriginalNativeEntity={type:'blockquote'|'expandable_blockquote'|'code'|'pre';offset:number;length:number};
export type OriginalReplyRef={chat_id:string;message_id:number;from_id?:string;from_is_bot?:boolean};
export interface OriginalRequestDescriptor {
 version:1;source_id:number;actor_id:string;namespace_chat_id:string;
 transport_chat_id:string;transport_chat_type:'private'|'group'|'supergroup';topic_id:string;
 telegram_message_id:number;field:'text'|'caption';body_sha256:string;body_utf16_length:number;
 received_at:string;quote_code_entities:OriginalNativeEntity[];forwarded:boolean;via_bot:boolean;reply_ref?:OriginalReplyRef;
}
export interface ValidatedOriginalRequest {
 descriptor:OriginalRequestDescriptor;body:string;entities:ReadonlyArray<OriginalNativeEntity>;receivedAt:Date;
 sourceId:number;actorId:string;topicId:string;namespaceChatId:string;
 transportChatId:string;transportChatType:OriginalRequestDescriptor['transport_chat_type'];
 telegramMessageId:number;field:'text'|'caption';forwarded:boolean;viaBot:boolean;replyRef?:OriginalReplyRef;
 createdAt:Date;editedAt?:Date;
}
export interface OriginalRequestScope {
 sourceId:number;actorId:string;topicId:string;namespaceChatId:string;
 audience?:'group'|'private'|'personal';revision?:number;
}
export interface OriginalRequestCaptureScope {namespaceChatId:string;sourceTopicId:string;}

const nativeTypes=new Set(['blockquote','expandable_blockquote','code','pre']);
const descriptorKeys=new Set(['version','source_id','actor_id','namespace_chat_id','transport_chat_id','transport_chat_type','topic_id','telegram_message_id','field','body_sha256','body_utf16_length','received_at','quote_code_entities','forwarded','via_bot','reply_ref']);
const isRecord=(value:unknown):value is Record<string,any>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const integer=(value:unknown,min=1):value is number=>Number.isSafeInteger(value)&&Number(value)>=min;
const id=(value:unknown,positive=false):value is string=>typeof value==='string'&&(positive?/^[1-9]\d*$/:/^-?[1-9]\d*$/).test(value)&&Number.isSafeInteger(Number(value));
const topic=(value:unknown):value is string=>value==='0'||id(value,true);
const hash=(body:string)=>createHash('sha256').update(body,'utf8').digest('hex');
const bytes=(value:unknown)=>{try{return Buffer.byteLength(JSON.stringify(value),'utf8');}catch{return Infinity;}};
function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(isRecord(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 return JSON.stringify(value)??'null';
}
const date=(value:unknown)=>{const result=value instanceof Date?value:typeof value==='string'?new Date(value):undefined;return result&&Number.isFinite(result.getTime())?result:undefined;};
function boundary(text:string,index:number){
 if(index===0||index===text.length)return true;
 const previous=text.charCodeAt(index-1),next=text.charCodeAt(index);
 return !(previous>=0xD800&&previous<=0xDBFF&&next>=0xDC00&&next<=0xDFFF);
}
function wellFormed(text:string){
 for(let index=0;index<text.length;index++){
  const unit=text.charCodeAt(index);
  if(unit>=0xD800&&unit<=0xDBFF){const low=text.charCodeAt(++index);if(!(low>=0xDC00&&low<=0xDFFF))return false;}
  else if(unit>=0xDC00&&unit<=0xDFFF)return false;
 }
 return true;
}
// Validate every original entity, including ordinary formatting/mentions, before
// retaining only the structural ranges required to distinguish command and data.
function nativeEntities(body:string,value:unknown):OriginalNativeEntity[]|undefined {
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>ORIGINAL_REQUEST_MAX_ENTITIES||bytes(value)>ORIGINAL_REQUEST_MAX_BYTES)return;
 const result:OriginalNativeEntity[]=[];
 for(const entity of value){
  if(!isRecord(entity)||typeof entity.type!=='string'||!entity.type.length||entity.type.length>64
   ||!integer(entity.offset,0)||!integer(entity.length)||entity.offset+entity.length>body.length
   ||!boundary(body,entity.offset)||!boundary(body,entity.offset+entity.length))return;
  if(nativeTypes.has(entity.type))result.push({type:entity.type as OriginalNativeEntity['type'],offset:entity.offset,length:entity.length});
 }
 result.sort((a,b)=>a.offset-b.offset||a.length-b.length||a.type.localeCompare(b.type));
 return result.filter((entity,index)=>index===0||entity.offset!==result[index-1]!.offset||entity.length!==result[index-1]!.length||entity.type!==result[index-1]!.type);
}
function transportMatches(namespace:string,actor:string,chat:string,type:unknown){
 if(type==='private')return chat===actor&&namespace===chat;
 return (type==='group'||type==='supergroup')&&Number(chat)<0&&chat===namespace;
}
function replyRef(value:unknown,chatId:string):OriginalReplyRef|undefined|null {
 if(value===undefined)return;
 if(!isRecord(value)||!integer(value.message_id))return null;
 const replyChat=value.chat===undefined?chatId:isRecord(value.chat)&&integer(value.chat.id,Number.MIN_SAFE_INTEGER)&&value.chat.id!==0?String(value.chat.id):undefined;
 if(replyChat!==chatId)return null;
 const reply:OriginalReplyRef={chat_id:chatId,message_id:value.message_id};
 if(value.from!==undefined){
  if(!isRecord(value.from)||!integer(value.from.id)||value.from.is_bot!==undefined&&typeof value.from.is_bot!=='boolean')return null;
  reply.from_id=String(value.from.id);
  if(value.from.is_bot!==undefined)reply.from_is_bot=value.from.is_bot;
 }
 return reply;
}
function descriptorValid(value:unknown,row:Row):value is OriginalRequestDescriptor {
 if(!isRecord(value)||bytes(value)>ORIGINAL_REQUEST_MAX_BYTES||Object.keys(value).some(key=>!descriptorKeys.has(key)))return false;
 if(value.version!==1||!integer(value.source_id)||value.source_id!==Number(row.id)
  ||!id(value.actor_id,true)||value.actor_id!==row.user_id||row.role!=='user'
  ||!id(value.namespace_chat_id)||value.namespace_chat_id!==row.current_namespace
  ||!id(value.transport_chat_id)||!transportMatches(value.namespace_chat_id,value.actor_id,value.transport_chat_id,value.transport_chat_type)
  ||!topic(value.topic_id)||value.topic_id!==row.topic_id
  ||!integer(value.telegram_message_id)||String(value.telegram_message_id)!==String(row.telegram_id)
  ||!['text','caption'].includes(value.field)||typeof row.body!=='string'||!wellFormed(row.body)
  ||value.body_sha256!==hash(row.body)||value.body_utf16_length!==row.body.length
  ||typeof value.forwarded!=='boolean'||typeof value.via_bot!=='boolean')return false;
 const received=date(value.received_at),now=date(row.capture_clock),edited=date(row.edited_at);
 if(typeof value.received_at!=='string'||!received||received.toISOString()!==value.received_at||!now||received.getTime()>now.getTime()||edited&&received.getTime()<edited.getTime())return false;
 const entities=nativeEntities(row.body,value.quote_code_entities);
 if(!entities||!Array.isArray(value.quote_code_entities)||entities.length!==value.quote_code_entities.length)return false;
 for(let index=0;index<entities.length;index++){
  const stored=value.quote_code_entities[index],expected=entities[index]!;
  if(!isRecord(stored)||Object.keys(stored).some(key=>!['type','offset','length'].includes(key))||stored.type!==expected.type||stored.offset!==expected.offset||stored.length!==expected.length)return false;
 }
 if(value.reply_ref!==undefined){
  const reply=value.reply_ref;
  if(!isRecord(reply)||Object.keys(reply).some(key=>!['chat_id','message_id','from_id','from_is_bot'].includes(key))
   ||reply.chat_id!==value.transport_chat_id||!integer(reply.message_id)
   ||reply.from_id!==undefined&&!id(reply.from_id,true)||reply.from_is_bot!==undefined&&(typeof reply.from_is_bot!=='boolean'||reply.from_id===undefined))return false;
 }
 return true;
}
async function source(sql:SQL,sourceId:number,lock=false){
 if(!integer(sourceId))return;
 return one(sql,`SELECT m.*,s.chat_id AS current_namespace,s.memory_revision AS current_revision,s.paused,clock_timestamp() AS capture_clock
  FROM messages m CROSS JOIN app_state s WHERE m.id=$1 AND s.id=1${lock?' FOR UPDATE OF m':''}`,[sourceId]);
}

/** Called only from actual server ingress admission/edit, in its transaction.
 * No raw body, queue payload, inferred intent, or derived permission is stored.
 */
export async function captureOriginalRequestContext(sql:SQL,sourceId:number,actualMessage:unknown,scope:OriginalRequestCaptureScope):Promise<OriginalRequestDescriptor|null>{
 const row=await source(sql,sourceId,true);
 if(!row||row.paused||!isRecord(actualMessage)||!id(scope.namespaceChatId)||scope.namespaceChatId!==row.current_namespace
  ||!topic(scope.sourceTopicId)||scope.sourceTopicId!==row.topic_id)return null;
 const message=actualMessage,actor=message.from,chat=message.chat;
 if(row.role!=='user'||!isRecord(actor)||!integer(actor.id)||actor.is_bot===true||actor.is_bot!==undefined&&typeof actor.is_bot!=='boolean'
  ||String(actor.id)!==row.user_id||!isRecord(chat)||!integer(chat.id,Number.MIN_SAFE_INTEGER)||chat.id===0
  ||!transportMatches(scope.namespaceChatId,String(actor.id),String(chat.id),chat.type)
  ||!integer(message.message_id)||String(message.message_id)!==String(row.telegram_id)
  ||message.message_thread_id!==undefined&&!integer(message.message_thread_id,0)
  ||topicKey(message)!==scope.sourceTopicId
  ||message.lumen_event!==undefined||message.lumen_interaction_event!==undefined||message.lumen_choice!==undefined)return null;
 if(message.text!==undefined&&typeof message.text!=='string'||message.caption!==undefined&&typeof message.caption!=='string'
  ||message.text&&message.caption||message.lumen_interaction!==undefined)return null;
 const field=typeof message.text==='string'&&message.text.length?'text':'caption';
 const body=message[field];
 if(typeof body!=='string'||!body.length||body!==row.body||!wellFormed(body))return null;
 const entities=nativeEntities(body,field==='text'?message.entities:message.caption_entities);
 const reply=replyRef(message.reply_to_message,String(chat.id));
 if(!entities||reply===null||message.is_automatic_forward!==undefined&&typeof message.is_automatic_forward!=='boolean')return null;
 const descriptor:OriginalRequestDescriptor={version:1,source_id:sourceId,actor_id:String(actor.id),namespace_chat_id:scope.namespaceChatId,
  transport_chat_id:String(chat.id),transport_chat_type:chat.type,topic_id:scope.sourceTopicId,telegram_message_id:message.message_id,
  field,body_sha256:hash(body),body_utf16_length:body.length,received_at:date(row.capture_clock)!.toISOString(),quote_code_entities:entities,
  forwarded:message.is_automatic_forward===true||Object.keys(message).some(key=>key.startsWith('forward_')&&message[key]!==undefined&&message[key]!==null),
  via_bot:message.via_bot!==undefined&&message.via_bot!==null,...(reply?{reply_ref:reply}:{})};
 if(!descriptorValid(descriptor,row))return null;
 if(row.request_context!==null&&row.request_context!==undefined){
  // Redelivery cannot exchange a quote/forward/transport envelope underneath an
  // existing source. Only reviseSource followed by an actual edit can replace it.
  if(!descriptorValid(row.request_context,row))return null;
  const previous=row.request_context as OriginalRequestDescriptor;
  // JSONB key order is not stable, including within entity/reply objects.
  if(canonical({...previous,received_at:''})!==canonical({...descriptor,received_at:''}))return null;
  return previous;
 }
 await sql.query('UPDATE messages SET request_context=$2::jsonb WHERE id=$1 AND request_context IS NULL',[sourceId,JSON.stringify(descriptor)]);
 return descriptor;
}

/** Reloads the live source; unknown legacy or stale metadata never grants authority. */
export async function loadOriginalRequestContext(sql:SQL,scope:OriginalRequestScope):Promise<ValidatedOriginalRequest|undefined>{
 if(!id(scope.actorId,true)||!id(scope.namespaceChatId)||!topic(scope.topicId)
  ||scope.revision!==undefined&&!integer(scope.revision,0)
  ||scope.audience!==undefined&&!['group','private','personal'].includes(scope.audience))return;
 const row=await source(sql,scope.sourceId);
 if(!row||row.paused||row.user_id!==scope.actorId||row.topic_id!==scope.topicId||row.current_namespace!==scope.namespaceChatId
  ||scope.revision!==undefined&&Number(row.current_revision)!==scope.revision||!descriptorValid(row.request_context,row))return;
 const descriptor=row.request_context as OriginalRequestDescriptor;
 if(descriptor.transport_chat_type==='private'&&scope.audience==='group')return;
 const createdAt=date(row.created_at);if(!createdAt)return;
 return {descriptor,body:row.body,entities:descriptor.quote_code_entities,receivedAt:date(descriptor.received_at)!,
  sourceId:descriptor.source_id,actorId:descriptor.actor_id,topicId:descriptor.topic_id,namespaceChatId:descriptor.namespace_chat_id,
  transportChatId:descriptor.transport_chat_id,transportChatType:descriptor.transport_chat_type,telegramMessageId:descriptor.telegram_message_id,
  field:descriptor.field,forwarded:descriptor.forwarded,viaBot:descriptor.via_bot,...(descriptor.reply_ref?{replyRef:descriptor.reply_ref}:{}),
  createdAt,...(row.edited_at?{editedAt:date(row.edited_at)!}:{})};
}
