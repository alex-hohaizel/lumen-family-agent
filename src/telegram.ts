import {operationSignal} from './operations.js';
export interface TGUser { id: number; first_name: string; last_name?: string; username?: string; is_bot?: boolean; }
export interface TGChat { id: number; type: string; title?: string; is_forum?: boolean; }
export interface InlineKeyboard { inline_keyboard: { text: string; callback_data?: string; url?: string }[][]; }
export interface TextEntity {type:string;offset:number;length:number;url?:string;}
export interface TGSticker {file_id:string;file_unique_id:string;type?:string;emoji?:string;set_name?:string;is_animated?:boolean;is_video?:boolean;thumbnail?:{file_id:string;file_unique_id?:string};}
export interface TextOptions {sourceIds?:number[];taskId?:string;goalVersion?:number; replyMarkup?: InlineKeyboard; replyToMessageId?: number; targetChatId?: string; threadId?: number; entities?:TextEntity[]; sourceMessageId?:number;actorId?:string;audience?:'personal'|'group'|'private'; }
export interface Message {
  receiver_user?:TGUser;ephemeral_message_id?:number;
  message_id: number; date: number; edit_date?: number; from?: TGUser; chat: TGChat;
  text?: string; caption?: string; reply_to_message?: Partial<Message> & {message_id:number};
  photo?: { file_id: string; file_size?: number }[];
  lumen_interaction?:{id:string;version:number;partial?:boolean;ready?:boolean;response_hash?:string};
  lumen_interaction_event?:{id:string;version:number;action:string};
  lumen_event?:{kind:'reaction'|'poll_vote';target_message_id:number;details:string};
  media_group_id?:string;
  animation?:{file_id:string;file_unique_id?:string;file_size?:number;mime_type?:string;thumbnail?:{file_id:string}};
  video?:{file_id:string;file_unique_id?:string;file_size?:number;mime_type?:string;thumbnail?:{file_id:string}};
  lumen_choice?:{menu_id:string;question:string;audience:string;selected:{user_id:string;name:string;label:string}[]};
  voice?: { file_id: string; file_size?: number; mime_type?: string };
  document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
  sticker?:TGSticker;
  poll?:{id:string;question:string;options:{text:string;voter_count:number}[];total_voter_count:number;type?:string};
  migrate_to_chat_id?: number; migrate_from_chat_id?: number;
  new_chat_members?: TGUser[]; left_chat_member?: TGUser;
  message_thread_id?: number; is_topic_message?: boolean;
  entities?: {type:string;offset:number;length:number;user?:TGUser}[];
  caption_entities?: {type:string;offset:number;length:number;user?:TGUser}[];
  forum_topic_created?: {name:string;icon_color:number}; forum_topic_edited?: {name?:string};
  forum_topic_closed?: Record<string,never>; forum_topic_reopened?: Record<string,never>;
}
export interface MemberUpdate { chat: TGChat; from: TGUser; date: number; old_chat_member: { status: string; is_member?: boolean }; new_chat_member: { status: string; is_member?: boolean }; }
export interface CallbackQuery { id: string; from: TGUser; data?: string; message?: Message; }
export interface Update { update_id: number; message_reaction?:{chat:TGChat;message_id:number;user?:TGUser;date:number;old_reaction:{type:string;emoji?:string}[];new_reaction:{type:string;emoji?:string}[]}; message?: Message; edited_message?: Message; my_chat_member?: MemberUpdate; callback_query?: CallbackQuery;poll_answer?:{poll_id:string;user?:TGUser;option_ids:number[]};poll?:{id:string;is_closed?:boolean}; }
export class TelegramError extends Error {
  constructor(public code: string, public retryAfter = 0, public uncertain = false) { super(code); }
}
export class Telegram {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  async call<T = any>(method: string, body: Record<string, unknown> = {}, timeout = 20000): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: operationSignal(timeout)
      });
    } catch { throw new TelegramError('telegram_network', 0, /^(send|edit)/.test(method)); }
    let json: any;
    try { json = await response.json(); } catch { throw new TelegramError('telegram_bad_response', 0, /^(send|edit)/.test(method)); }
    if (!json.ok) throw new TelegramError(`telegram_${json.error_code || response.status}`, Number(json.parameters?.retry_after || 0), response.status >= 500 && /^(send|edit)/.test(method));
    return json.result as T;
  }
  async updates(offset: number) {
    return this.call<Update[]>('getUpdates', { offset, timeout: 30, limit: 50, allowed_updates: ['message','edited_message','my_chat_member','callback_query','poll','poll_answer','message_reaction'] }, 40000);
  }
  async multipart<T=any>(method:'createNewStickerSet'|'uploadStickerFile'|'addStickerToSet'|'replaceStickerInSet',form:FormData):Promise<T>{
    let response:Response;try{response=await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`,{method:'POST',body:form,signal:AbortSignal.timeout(180000)});}catch{throw new TelegramError('telegram_upload_uncertain',0,true);}
    const json:any=await response.json().catch(()=>null);if(!json?.ok)throw new TelegramError(`telegram_${json?.error_code || response.status}`,Number(json?.parameters?.retry_after || 0),response.status>=500);return json.result as T;
  }
  async text(chatId: string, text: string, options: TextOptions = {}) {
    return this.call<{message_id:number}>('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true },
      ...(options.entities?.length ? {entities:options.entities}:{}),
      ...(options.replyMarkup ? {reply_markup:options.replyMarkup} : {}),
      ...(options.threadId ? {message_thread_id:options.threadId} : {}),
      ...(options.replyToMessageId ? {reply_parameters:{message_id:options.replyToMessageId,allow_sending_without_reply:true}} : {}) });
  }
  async poll(chatId:string,question:string,options:string[],threadId?:number,quiz?:{correct:number;explanation?:string}){
    return this.call<{message_id:number}>('sendPoll',{chat_id:chatId,question,options:options.map(text=>({text})),is_anonymous:false,allows_multiple_answers:false,...(quiz?{type:'quiz',correct_option_ids:[quiz.correct],explanation:quiz.explanation || ''}:{}),...(threadId?{message_thread_id:threadId}:{})});
  }
  async sticker(chatId:string,fileId:string,threadId?:number,replyTo?:number){
    return this.call<{message_id:number}>('sendSticker',{chat_id:chatId,sticker:fileId,...(threadId?{message_thread_id:threadId}:{}),...(replyTo?{reply_parameters:{message_id:replyTo,allow_sending_without_reply:true}}:{})});
  }
  async animatedProfile(bytes: Uint8Array) {
    const form = new FormData();
    form.set('photo', JSON.stringify({ type: 'animated', animation: 'attach://avatar', main_frame_timestamp: 0 }));
    form.set('avatar', new Blob([bytes as BlobPart], { type: 'video/mp4' }), 'lumen-avatar.mp4');
    let response: Response;
    try { response = await this.fetcher(`https://api.telegram.org/bot${this.token}/setMyProfilePhoto`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) }); }
    catch { throw new TelegramError('telegram_profile_network'); }
    let json: any;
    try { json = await response.json(); } catch { throw new TelegramError('telegram_bad_response'); }
    if (!response.ok || !json.ok || json.result !== true) throw new TelegramError(`telegram_${json.error_code || response.status}`);
  }
  async upload(method: 'sendPhoto' | 'sendVoice' | 'sendAnimation' | 'sendDocument', chatId: string, bytes: Uint8Array, caption: string, mime: string, threadId?:number,fileName?:string) {
    const field = method === 'sendPhoto' ? 'photo' : method==='sendAnimation' ? 'animation' : method==='sendDocument'?'document':'voice';
    const form = new FormData();
    form.set('chat_id', chatId); form.set('caption', caption.slice(0,900));
    if(threadId)form.set('message_thread_id',String(threadId));
    form.set(field, new Blob([bytes as BlobPart], { type: mime }), fileName || (method === 'sendPhoto' ? 'lumen.png' : method==='sendAnimation'?(mime==='video/mp4'?'lumen.mp4':'lumen.gif'):method==='sendDocument'?'lumen.txt':'lumen.ogg'));
    let response: Response;
    try { response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, { method:'POST', body:form, signal:AbortSignal.timeout(120000) }); }
    catch { throw new TelegramError('telegram_upload_uncertain',0,true); }
    let json: any;
    try { json = await response.json(); } catch { throw new TelegramError('telegram_bad_response',0,true); }
    if (!json.ok) throw new TelegramError(`telegram_${json.error_code || response.status}`,Number(json.parameters?.retry_after || 0),response.status>=500);
    return json.result as {message_id:number};
  }
  async file(fileId: string, maxBytes: number) {
    const meta = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (!meta.file_path || (meta.file_size || 0) > maxBytes) throw new TelegramError('file_too_large');
    // Only Telegram-returned paths, fixed host and bounded streaming body.
    if (!/^[\w/.-]+$/.test(meta.file_path) || meta.file_path.includes('..')) throw new TelegramError('file_path_invalid');
    let res: Response;
    try { res = await this.fetcher(`https://api.telegram.org/file/bot${this.token}/${meta.file_path}`, { signal:operationSignal(30000), redirect:'error' }); }
    catch { throw new TelegramError('file_download_failed'); }
    if (!res.ok || !res.body) throw new TelegramError('file_download_failed');
    const chunks: Uint8Array[] = []; let total = 0;
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      total += chunk.length; if (total > maxBytes) { await res.body.cancel().catch(()=>{}); throw new TelegramError('file_too_large'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
export function usernameMatches(text: string, username: string) { return username ? new RegExp(`@${username.replace(/[^A-Za-z0-9_]/g,'')}(?=$|[^A-Za-z0-9_])`,'i').test(text) : false; }
