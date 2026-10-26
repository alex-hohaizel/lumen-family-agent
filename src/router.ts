import {createHash} from 'node:crypto';
import type {Config} from './config.js';
import {ChatRegistry,type RegisteredChat} from './registry.js';
import {state,one,queueText,type Database} from './db.js';
import {Lumen,type BotIdentity} from './engine.js';
import {Telegram,type Update,type TGChat,type TGSticker} from './telegram.js';
import {ChatGPTAuth,secureEqual} from './auth.js';
import {OpenAIModel,type Brain} from './model.js';
import {Delivery} from './delivery.js';
import {Memory} from './memory.js';
import {callbackCommand,groupSetupKeys,validSetupPayload} from './ui.js';
import {rememberSticker} from './presentation.js';
import {GROUP_WELCOME} from './personality.js';

export interface ChatRuntime {chat:RegisteredChat;db:Database;engine:Lumen;delivery:Delivery;memory:Memory;}
export class ChatRouter {
  private runtimes=new Map<string,ChatRuntime>();
  private auth:ChatGPTAuth;
  private publicStickers?:Promise<TGSticker[]>;
  constructor(public registry:ChatRegistry,private config:Config,private telegram:Telegram,private bot:BotIdentity,private brainFactory?:(config:Config,chatId:string)=>Brain){this.auth=new ChatGPTAuth(config.runtimeDir);}
  async init(){
    await this.registry.init();
    if(this.config.ownerId)await this.registry.claimOwner(this.config.ownerId);
    for(const chat of await this.registry.list())await this.runtime(chat);
  }
  async runtime(chat:RegisteredChat){
    let runtime=this.runtimes.get(chat.chat_id);
    if(runtime){runtime.chat=chat;return runtime;}
    const db=this.registry.database(chat);
    // Model selection is per group. Only the transport's token-refresh manager is shared.
    const initial=await state(db);const config={...this.config,model:initial.model||this.config.model};
    const brain=this.brainFactory?.(config,chat.chat_id) || new OpenAIModel(config,this.auth);
    runtime={chat,db,engine:new Lumen(db,config,this.telegram,brain,this.bot,undefined,this.auth),delivery:new Delivery(db,this.telegram,config),memory:new Memory(db,brain)};
    this.runtimes.set(chat.chat_id,runtime);
    if(!await one(db,'SELECT id FROM stickers LIMIT 1')){
      // A fixed public starter set is an asset, never imported memory from another group.
      this.publicStickers ||= this.telegram.call<{stickers:TGSticker[]}>('getStickerSet',{name:'UtyaDuck'}).then(set=>(set.stickers || []).filter(s=>s.type==='regular'&&s.emoji).slice(0,32)).catch(()=>[]);
      const stickers=await this.publicStickers;
      if(stickers.length)await db.tx(async sql=>{for(const sticker of stickers)await rememberSticker(sql,sticker,null);});
    }
    await db.query("UPDATE inbox SET status='pending' WHERE status='processing'");
    await db.query("UPDATE outbox SET status='uncertain',error_code='restart_during_delivery' WHERE status='sending'");
    return runtime;
  }
  async active(){return Array.from(this.runtimes.values()).filter(x=>x.chat.enabled);}
  private async owner(uid:string){return (await this.registry.transport()).owner_user_id===uid;}
  private async admin(chatId:string,uid:string){
    try{const member=await this.telegram.call<{status:string}>('getChatMember',{chat_id:chatId,user_id:Number(uid)});return ['creator','administrator'].includes(member.status);}catch{return false;}
  }
  private async attach(chat:TGChat,uid:string,updateId:number){
    const registered=await this.registry.ensure(String(chat.id),uid,chat.title || '');
    const runtime=await this.runtime(registered);
    await runtime.db.tx(async sql=>{
      const inserted=await sql.query('INSERT INTO onboarding_chats(chat_id,inviter_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING chat_id',[String(chat.id),uid]);
      if(!inserted.rows.length)return;
      const s=await state(sql,true);
      await queueText(sql,GROUP_WELCOME+(this.bot.can_read_all_group_messages?'':'\nЩоб читати фонову розмову, мені потрібні права адміністратора або вимкнений Privacy Mode у BotFather.'),s.memory_revision,`onboarding:${updateId}`,true);
    });
    return runtime;
  }
  async receive(update:Update){
    const cb=update.callback_query;
    if(cb){
      // Acknowledge immediately, including stale or unrecognized buttons.
      await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
      const command=cb.data&&callbackCommand(cb.data);
      const choiceId=/^lumen:choice:([0-9a-f-]{36})$/.exec(cb.data || '')?.[1];
      if((!command&&!choiceId) || !cb.message || cb.message.from?.id!==this.bot.id || cb.from.is_bot)return;
      const registered=await this.registry.find(String(cb.message.chat.id));if(!registered?.enabled)return;
      const runtime=await this.runtime(registered);
      if(choiceId){
        const choice=await one(runtime.db,"SELECT * FROM choices WHERE id=$1 AND created_at>now()-interval '1 day'",[choiceId]);const s=await state(runtime.db);
        if(!choice||s.paused||choice.revision!==s.memory_revision||choice.topic_id!==String(cb.message.message_thread_id || 0))return;
        await runtime.engine.receive({update_id:update.update_id,message:{message_id:-update.update_id,chat:cb.message.chat,date:Math.floor(Date.now()/1000),from:cb.from,text:choice.label,message_thread_id:cb.message.message_thread_id,reply_to_message:cb.message}});return;
      }
      const administrator=String(cb.from.id)===registered.owner_id || await this.admin(registered.chat_id,String(cb.from.id));
      await runtime.engine.receive({update_id:update.update_id,message:{message_id:cb.message.message_id,chat:cb.message.chat,date:Math.floor(Date.now()/1000),from:cb.from,text:command!,message_thread_id:cb.message.message_thread_id}},administrator);
      return;
    }
    const member=update.my_chat_member;
    if(member){
      if(!['group','supergroup'].includes(member.chat.type))return;
      const id=String(member.chat.id),status=member.new_chat_member.status;
      const prior=await this.registry.find(id);
      if(['left','kicked'].includes(status)){
        if(prior){await this.registry.disable(id);const runtime=await this.runtime({...prior,enabled:false});await runtime.db.tx(async sql=>{
          await sql.query("UPDATE app_state SET paused=true,memory_revision=memory_revision+1 WHERE id=1");
          await sql.query('DELETE FROM inbox');await sql.query('DELETE FROM choices');await sql.query('DELETE FROM pending_intents');await sql.query("DELETE FROM outbox WHERE status<>'sent'");
          await sql.query("UPDATE reminders SET status='pending' WHERE status='queued'");
        });}return;
      }
      if(['member','administrator'].includes(status)&&await this.owner(String(member.from.id)))await this.attach(member.chat,String(member.from.id),update.update_id);
      return;
    }
    const m=update.message || update.edited_message;if(!m?.from||m.from.is_bot)return;
    const uid=String(m.from.id),chatId=String(m.chat.id),text=m.text || '';
    if(m.chat.type==='private'){
      if(!/^\/(?:start|id|help)(?:@\w+)?(?:\s|$)/i.test(text))return;
      const payload=text.trim().split(/\s+/)[1] || '';
      if(validSetupPayload(payload,this.config)&&(!this.config.ownerId||this.config.ownerId===uid))await this.registry.claimOwner(uid);
      const own=await this.owner(uid);
      await this.telegram.text(chatId,own?'Привіт! Підключення готове. Додай мене в потрібну групу кнопкою нижче. У кожної групи буде своя пам’ять; тут я її не показую.':`Привіт, я Люмен. Працюю в підключених групах. Твій Telegram ID: ${uid}. Приватну розмову та дані інших груп тут не зберігаю.`,own?{replyMarkup:groupSetupKeys(this.bot.username,this.config)}:{});
      return;
    }
    if(!['group','supergroup'].includes(m.chat.type))return;
    const toOtherBot=/^\/\w+@([A-Za-z0-9_]+)/.exec(text)?.[1];if(toOtherBot&&toOtherBot.toLowerCase()!==this.bot.username.toLowerCase())return;
    let registered=await this.registry.find(chatId);
    if(m.migrate_to_chat_id&&registered){
      await this.registry.migrateChat(chatId,String(m.migrate_to_chat_id));
      this.runtimes.delete(chatId);
      const migrated=await this.registry.find(String(m.migrate_to_chat_id));if(migrated)await this.runtime(migrated);return;
    }
    const added=m.new_chat_members?.some(u=>u.id===this.bot.id);
    const start=/^\/start(?:@\w+)?\s+(\S+)\s*$/.exec(text);
    const bind=/^\/bind(?:@\w+)?\s+(\S+)\s*$/.exec(text);
    const validBind=bind&&this.config.pairCodeHash&&secureEqual(createHash('sha256').update(bind[1]!).digest('hex'),this.config.pairCodeHash);
    const setup=start&&validSetupPayload(start[1]!,this.config) || validBind;
    if(setup&&(!this.config.ownerId||this.config.ownerId===uid))await this.registry.claimOwner(uid);
    if((added||setup)&&await this.owner(uid)){
      const runtime=await this.attach(m.chat,uid,update.update_id);registered=runtime.chat;
      if(setup)return; // Deep-link payloads and pairing secrets never become chat memory.
    }
    if(!registered?.enabled)return;
    const runtime=await this.runtime(registered);
    // Privileged checks use Telegram membership, never a name or a model's assertion.
    const needsAdmin=/^\/(?:consent|forget_all)(?:@\w+)?\b|понов|віднов|увімк|очист|забуд|видали/iu.test(text);
    const administrator=uid===registered.owner_id || needsAdmin&&await this.admin(chatId,uid);
    await runtime.engine.receive(update,administrator);
  }
}
