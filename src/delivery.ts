import { state, one, type Database } from './db.js';
import { Telegram, TelegramError } from './telegram.js';
import { Media } from './media.js';
import type { Config } from './config.js';
import { errorCode } from './engine.js';
import { readFile } from 'node:fs/promises';

export class Delivery {
  constructor(private db:Database,private telegram:Telegram,private config:Config,private media=new Media(config)){}
  async next(){
    const row=await this.db.tx<Record<string,any>|null>(async sql=>{
      const s=await state(sql,true);
      const row=await one(sql,"SELECT * FROM outbox WHERE status='pending' AND available_at<=now() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
      if(!row || !s.chat_id)return null;
      if(row.revision!==s.memory_revision || (s.paused && !row.service)){
        await sql.query("DELETE FROM outbox WHERE id=$1",[row.id]);return null;
      }
      await sql.query("UPDATE outbox SET status='sending',attempts=attempts+1 WHERE id=$1",[row.id]);return {...row,chatId:s.chat_id};
    });
    if(!row)return false;
    try{
      let bytes:Buffer|undefined;
      let animated=false;
      if(row.kind==='animation'){
        if(!['waving','happy','thinking'].includes(row.body.asset))throw new Error('invalid_animation');
        bytes=await readFile(new URL(`../../assets/lumen-${row.body.asset}.mp4`,import.meta.url));animated=true;
      }
      if(row.kind==='image'){
        if(row.body.generated)bytes=Buffer.from(row.body.generated,'base64');
        else{
          bytes=await this.media.image(row.body.prompt);
          await this.db.query('UPDATE outbox SET body=$1 WHERE id=$2',[JSON.stringify({...row.body,generated:bytes.toString('base64')}),row.id]);
        }
      }
      const current=await state(this.db);
      const exists=await one(this.db,'SELECT id FROM outbox WHERE id=$1',[row.id]);
      if(!exists || current.memory_revision!==row.revision || (current.paused&&!row.service))return true;
      let sent:{message_id:number};
      if(row.kind==='reaction'){
        await this.telegram.call('setMessageReaction',{chat_id:row.chatId,message_id:row.body.messageId,reaction:[{type:'emoji',emoji:row.body.emoji}],is_big:false});sent={message_id:row.body.messageId};
      }else if(row.kind==='sticker')sent=await this.telegram.sticker(row.chatId,row.body.fileId,row.body.threadId,row.body.replyToMessageId);
      else if(bytes)sent=await this.telegram.upload(animated?'sendAnimation':'sendPhoto',row.chatId,bytes,animated?row.body.caption || '': 'Люмен ✨',animated?'video/mp4':'image/png',row.body.threadId);
      else if(row.kind==='poll')sent=await this.telegram.poll(row.chatId,row.body.question,row.body.options,row.body.threadId,row.body.quiz);
      else sent=await this.telegram.text(row.chatId,row.body.text,{replyMarkup:row.body.replyMarkup,replyToMessageId:row.body.replyToMessageId,threadId:row.body.threadId,entities:row.body.entities});
      const deliveredText=animated?`[анімація Люмена: ${row.body.asset}]`:row.kind==='image'?'[зображення Люмена]':row.kind==='reaction'?`[реакція Люмена: ${row.body.emoji}]`:row.kind==='sticker'?`[стікер Люмена: ${row.body.emoji || ''}]`:row.kind==='poll'?`[${row.body.quiz?'вікторина':'опитування'}] ${row.body.question}\n${row.body.options.join(' · ')}`:row.body.text;
      await this.db.tx(async sql=>{
        const live=await state(sql,true);if(live.memory_revision!==row.revision)return;
        const still=await one(sql,'SELECT id FROM outbox WHERE id=$1',[row.id]);if(!still)return;
        await sql.query("UPDATE outbox SET status='sent',telegram_id=$1,body=$2 WHERE id=$3",[sent.message_id,JSON.stringify({text:deliveredText}),row.id]);
        if(!row.service && !live.paused)await sql.query("INSERT INTO messages (telegram_id,user_id,author,role,body,topic_id) VALUES ($1,'lumen','Люмен','assistant',$2,$3) ON CONFLICT DO NOTHING",[sent.message_id,deliveredText,String(row.body.threadId || 0)]);
        const match=/^reminder:(\d+):/.exec(row.dedup_key);
        if(match)await sql.query("UPDATE reminders SET status='sent' WHERE id=$1",[match[1]]);
      });
    }catch(e){
      const tg=e instanceof TelegramError?e:null;
      const retry=tg?.retryAfter || 0;
      // Ambiguous deliveries are not retried automatically: Telegram has no sendMessage idempotency key.
      const status=tg?.uncertain?'uncertain':retry?'pending':'failed';
      await this.db.query("UPDATE outbox SET status=$1,error_code=$2,available_at=now()+($3 * interval '1 second') WHERE id=$4",[status,tg?.code || errorCode(e),Math.max(1,retry),row.id]);
    }
    return true;
  }
}
