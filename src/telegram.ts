export interface TGUser { id: number; first_name: string; last_name?: string; username?: string; is_bot?: boolean; }
export interface Message {
  message_id: number; date: number; edit_date?: number; from?: TGUser; chat: { id: number; type: string; title?: string };
  text?: string; caption?: string; reply_to_message?: { from?: TGUser; message_id: number };
  photo?: { file_id: string; file_size?: number }[];
  voice?: { file_id: string; file_size?: number; mime_type?: string };
  document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
  migrate_to_chat_id?: number; migrate_from_chat_id?: number;
}
export interface Update { update_id: number; message?: Message; edited_message?: Message; }
export class TelegramError extends Error {
  constructor(public code: string, public retryAfter = 0, public uncertain = false) { super(code); }
}
export class Telegram {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  async call<T = any>(method: string, body: Record<string, unknown> = {}, timeout = 20000): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout)
      });
    } catch { throw new TelegramError('telegram_network', 0, /^(send|edit)/.test(method)); }
    let json: any;
    try { json = await response.json(); } catch { throw new TelegramError('telegram_bad_response', 0, /^(send|edit)/.test(method)); }
    if (!json.ok) throw new TelegramError(`telegram_${json.error_code || response.status}`, Number(json.parameters?.retry_after || 0), response.status >= 500 && /^(send|edit)/.test(method));
    return json.result as T;
  }
  async updates(offset: number) {
    return this.call<Update[]>('getUpdates', { offset, timeout: 30, limit: 50, allowed_updates: ['message','edited_message'] }, 40000);
  }
  async text(chatId: string, text: string) { return this.call<{message_id:number}>('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } }); }
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
  async upload(method: 'sendPhoto' | 'sendVoice' | 'sendAnimation', chatId: string, bytes: Uint8Array, caption: string, mime: string) {
    const field = method === 'sendPhoto' ? 'photo' : method==='sendAnimation' ? 'animation' : 'voice';
    const form = new FormData();
    form.set('chat_id', chatId); form.set('caption', caption.slice(0,900));
    form.set(field, new Blob([bytes as BlobPart], { type: mime }), method === 'sendPhoto' ? 'lumen.png' : method==='sendAnimation'?(mime==='video/mp4'?'lumen.mp4':'lumen.gif'):'lumen.ogg');
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
    try { res = await this.fetcher(`https://api.telegram.org/file/bot${this.token}/${meta.file_path}`, { signal:AbortSignal.timeout(30000), redirect:'error' }); }
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
export function usernameMatches(text: string, username: string) { return username ? text.toLowerCase().includes(`@${username.toLowerCase()}`) : false; }
