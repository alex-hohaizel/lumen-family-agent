import {createHash} from 'node:crypto';
import type {Config} from './config.js';
import {ChatRegistry,type RegisteredChat} from './registry.js';
import {state,one,queueText,applySchema,type Database} from './db.js';
import {Lumen,type BotIdentity} from './engine.js';
import {Telegram,type Update,type TGChat,type TGSticker} from './telegram.js';
import {ChatGPTAuth,secureEqual} from './auth.js';
import {OpenAIModel,type Brain} from './model.js';
import {Delivery} from './delivery.js';
import {Memory} from './memory.js';
import {callbackCommand,groupSetupKeys,validSetupPayload} from './ui.js';
import {rememberSticker} from './presentation.js';
import {GROUP_WELCOME} from './personality.js';
import {VisualMemory} from './visual.js';
import {queueReleaseNotice,RELEASE} from './release.js';
import {ImageJobs} from './image-jobs.js';
import {seedStickerPack,type LumenPack} from './sticker-pack.js';
import {AgentTasks} from './agent-tasks.js';
import {WebMonitors} from './web-monitors.js';
import {ConnectorVault} from './connector-vault.js';
import {MCPClient} from './mcp-client.js';

export interface ChatRuntime {chat:RegisteredChat;db:Database;engine:Lumen;delivery:Delivery;memory:Memory;visual:VisualMemory;images:ImageJobs;agent:AgentTasks;monitors:WebMonitors;}
export class ChatRouter {
  private runtimes=new Map<string,ChatRuntime>();
  private auth:ChatGPTAuth;
  private publicStickers?:Promise<TGSticker[]>;
  private lumenPack?:LumenPack;
  setStickerPack(pack:LumenPack){this.lumenPack=pack;}
  constructor(public registry:ChatRegistry,private config:Config,private telegram:Telegram,private bot:BotIdentity,private brainFactory?:(config:Config,chatId:string)=>Brain){this.auth=new ChatGPTAuth(config.runtimeDir);}
  async init(){
    await this.registry.init();
    if(this.config.ownerId)await this.registry.claimOwner(this.config.ownerId);
    for(const chat of await this.registry.list()){const runtime=await this.runtime(chat);if(chat.enabled)await queueReleaseNotice(runtime.db,this.lumenPack?'https://t.me/addstickers/'+this.lumenPack.name:undefined);}
  }
  async runtime(chat:RegisteredChat){
    let runtime=this.runtimes.get(chat.chat_id);
    if(runtime){runtime.chat=chat;return runtime;}
    const db=this.registry.database(chat);
    await db.tx(applySchema);
    // Model selection is per group. Only the transport's token-refresh manager is shared.
    const initial=await state(db);const config={...this.config,model:initial.model||this.config.model};
    const brain=this.brainFactory?.(config,chat.chat_id) || new OpenAIModel(config,this.auth);
    const visual=new VisualMemory(db,this.telegram,brain);
    runtime={chat,db,engine:new Lumen(db,config,this.telegram,brain,this.bot,undefined,this.auth),delivery:new Delivery(db,this.telegram,config),memory:new Memory(db,brain,config.dailyTurnLimit || (config.authMode==='api'?200:0)),visual,images:new ImageJobs(db,config,this.telegram,visual),agent:new AgentTasks(db,config,brain),monitors:new WebMonitors(db,config)};
    this.runtimes.set(chat.chat_id,runtime);
    if(!await one(db,'SELECT id FROM stickers LIMIT 1')){
      // A fixed public starter set is an asset, never imported memory from another group.
      this.publicStickers ||= this.telegram.call<{stickers:TGSticker[]}>('getStickerSet',{name:'UtyaDuck'}).then(set=>(set.stickers || []).filter(s=>s.type==='regular'&&s.emoji).slice(0,32)).catch(()=>[]);
      const stickers=await this.publicStickers;
      if(stickers.length)await db.tx(async sql=>{for(const sticker of stickers)await rememberSticker(sql,sticker,null);});
    }
    if(this.lumenPack)await seedStickerPack(db,this.lumenPack);
    await db.query("UPDATE inbox SET status='pending' WHERE status='processing'");
    await db.query("UPDATE attachments SET status='pending' WHERE status='processing'");
    await db.query("UPDATE image_jobs SET status='uncertain',error_code='restart_during_generation' WHERE status='processing'");
    await db.query("UPDATE outbox SET status='uncertain',error_code='restart_during_delivery' WHERE status='sending'");
    await runtime.agent.recover();
    return runtime;
  }
  async active(){return Array.from(this.runtimes.values()).filter(x=>x.chat.enabled);}
  async probeNativeSearch(){
    const runtime=(await this.active())[0];const config={...(runtime?.engine.config || this.config),webSearch:true};
    if(runtime){const {reserveModelCall}=await import('./model-budget.js');await reserveModelCall(runtime.db,config);}
    const result=await new OpenAIModel(config,this.auth).searchWeb('Find the official Node.js website. Return its URL.');
    return {searched:result.searched,sources:result.sources};
  }
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
      await sql.query("INSERT INTO release_notices(version,status) VALUES($1,'included_onboarding') ON CONFLICT DO NOTHING",[RELEASE]);
      await queueText(sql,GROUP_WELCOME+(this.bot.can_read_all_group_messages?'':'\nЩоб читати фонову розмову, мені потрібні права адміністратора або вимкнений Privacy Mode у BotFather.'),s.memory_revision,`onboarding:${updateId}`,true);
    });
    return runtime;
  }
  async receive(update:Update){
    const reaction=update.message_reaction;
    if(reaction){
      if(!reaction.user||reaction.user.is_bot)return;
      const chat=await this.registry.find(String(reaction.chat.id));if(!chat?.enabled)return;
      const runtime=await this.runtime(chat);
      const target=await one(runtime.db,'SELECT telegram_id,user_id,author,body,role,topic_id FROM messages WHERE telegram_id=$1 ORDER BY id DESC LIMIT 1',[reaction.message_id]);
      if(!target)return; // Never invent the missing message or its topic/author.
      const details=reaction.new_reaction.map(x=>x.type==='emoji'?x.emoji:x.type==='custom_emoji'?'[власний емодзі]':'[інша реакція]').join(' ') || '[реакцію прибрано]';
      await runtime.engine.receive({update_id:update.update_id,message:{message_id:-update.update_id,date:reaction.date,chat:reaction.chat,from:reaction.user,text:`[Зміна реакції на повідомлення] ${details}`,message_thread_id:target.topic_id==='0'?undefined:Number(target.topic_id),reply_to_message:{message_id:reaction.message_id,from:{id:target.role==='assistant'?this.bot.id:Number(target.user_id),first_name:target.author,is_bot:target.role==='assistant'},text:target.body},lumen_event:{kind:'reaction',target_message_id:reaction.message_id,details}}});return;
    }
    if(update.poll_answer||update.poll){
      const answer=update.poll_answer;const id=answer?.poll_id || update.poll!.id;
      for(const runtime of await this.active()){
        const poll=await one(runtime.db,'SELECT * FROM polls WHERE poll_id=$1',[id]);if(!poll)continue;
        let voteEvent=false;
        await runtime.db.tx(async sql=>{const s=await state(sql,true);if(s.paused||s.memory_revision!==poll.revision||await one(sql,'SELECT update_id FROM receipts WHERE update_id=$1',[update.update_id]))return;voteEvent=Boolean(answer?.user&&!answer.user.is_bot&&answer.option_ids.every(i=>Number.isInteger(i)&&i>=0&&i<poll.options.length));if(!voteEvent)await sql.query('INSERT INTO receipts(update_id) VALUES($1)',[update.update_id]);
          if(update.poll?.is_closed)await sql.query('UPDATE polls SET closed=true WHERE poll_id=$1',[id]);
          if(answer?.user&&!answer.user.is_bot&&answer.option_ids.every(i=>Number.isInteger(i)&&i>=0&&i<poll.options.length))await sql.query('INSERT INTO poll_votes(poll_id,user_id,name,option_ids) VALUES($1,$2,$3,$4) ON CONFLICT(poll_id,user_id) DO UPDATE SET name=excluded.name,option_ids=excluded.option_ids,updated_at=now()',[id,String(answer.user.id),[answer.user.first_name,answer.user.last_name].filter(Boolean).join(' '),JSON.stringify(answer.option_ids)]);
        });
        if(voteEvent&&answer?.user){const details=answer.option_ids.map(i=>String(poll.options[i])).join(', ') || 'відкликав голос';await runtime.engine.receive({update_id:update.update_id,message:{message_id:-update.update_id,date:Math.floor(Date.now()/1000),chat:{id:Number(runtime.chat.chat_id),type:'supergroup'},from:answer.user,text:`[Голос в опитуванні «${poll.question}»] ${details}`,message_thread_id:poll.topic_id==='0'?undefined:Number(poll.topic_id),lumen_event:{kind:'poll_vote',target_message_id:Number(poll.message_id),details}}});}
        return;
      }return;
    }
    const cb=update.callback_query;
    if(cb){
      // Acknowledge immediately, including stale or unrecognized buttons.
      await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
      const approval=/^lumen:(approve|reject):([0-9a-f-]{36})$/.exec(cb.data || '');
      if(approval&&cb.message&&cb.message.from?.id===this.bot.id&&!cb.from.is_bot){
        const registered=await this.registry.find(String(cb.message.chat.id));if(!registered?.enabled)return;
        const runtime=await this.runtime(registered);await runtime.db.tx(async sql=>{const s=await state(sql,true);if(s.paused)return;
          const row=await one(sql,"UPDATE tool_approvals SET status=$1 WHERE id=$2 AND actor_id=$3 AND revision=$4 AND topic_id=$5 AND status='pending' AND expires_at>now() RETURNING task_id",[approval[1]==='approve'?'approved':'cancelled',approval[2],String(cb.from.id),s.memory_revision,String(cb.message!.message_thread_id || 0)]);
          if(row?.task_id&&approval[1]==='reject')await sql.query("UPDATE agent_tasks SET status='needs_input',error_code='action_rejected',updated_at=now() WHERE id=$1 AND status='waiting'",[row.task_id]);
        });return;
      }
      const command=cb.data&&callbackCommand(cb.data);
      const choiceId=/^lumen:choice:([0-9a-f-]{36})$/.exec(cb.data || '')?.[1];
      if((!command&&!choiceId) || !cb.message || cb.message.from?.id!==this.bot.id || cb.from.is_bot)return;
      const registered=await this.registry.find(String(cb.message.chat.id));if(!registered?.enabled)return;
      const runtime=await this.runtime(registered);
      if(choiceId){
        const choice=await one(runtime.db,"SELECT * FROM choices WHERE id=$1 AND created_at>now()-interval '1 day'",[choiceId]);const s=await state(runtime.db);
        if(!choice||s.paused||choice.revision!==s.memory_revision||choice.topic_id!==String(cb.message.message_thread_id || 0))return;
        if(choice.audience==='personal'&&choice.target_user_id!==String(cb.from.id))return;
        if(await one(runtime.db,'SELECT update_id FROM receipts WHERE update_id=$1',[update.update_id]))return;
        const menu=choice.menu_id || choice.id;
        await runtime.db.query('INSERT INTO choice_votes(menu_id,user_id,name,label) VALUES($1,$2,$3,$4) ON CONFLICT(menu_id,user_id) DO UPDATE SET label=excluded.label,name=excluded.name,updated_at=now()',[menu,String(cb.from.id),[cb.from.first_name,cb.from.last_name].filter(Boolean).join(' ').slice(0,80),choice.label]);
        const votes=await runtime.db.query('SELECT user_id,name,label FROM choice_votes WHERE menu_id=$1 ORDER BY updated_at',[menu]);
        await runtime.engine.receive({update_id:update.update_id,message:{message_id:-update.update_id,chat:cb.message.chat,date:Math.floor(Date.now()/1000),from:cb.from,text:choice.label,message_thread_id:cb.message.message_thread_id,reply_to_message:cb.message,lumen_choice:{menu_id:menu,question:choice.question || cb.message.text || '',audience:choice.audience,selected:votes.rows as {user_id:string;name:string;label:string}[]}}});return;
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
          await sql.query('DELETE FROM inbox');await sql.query('DELETE FROM choices');await sql.query('DELETE FROM pending_intents');await sql.query('DELETE FROM dialogues');await sql.query('DELETE FROM image_jobs');await sql.query("DELETE FROM outbox WHERE status<>'sent'");
          await sql.query("UPDATE reminders SET status='pending' WHERE status='queued'");
        });}return;
      }
      if(['member','administrator'].includes(status)&&await this.owner(String(member.from.id)))await this.attach(member.chat,String(member.from.id),update.update_id);
      return;
    }
    const m=update.message || update.edited_message;if(!m?.from||m.from.is_bot)return;
    const uid=String(m.from.id),chatId=String(m.chat.id),text=m.text || '';
    if(m.chat.type==='private'){
      const connect=/^\/start(?:@\w+)?\s+connect_([0-9a-f-]{36})$/.exec(text);
      if(connect){
        for(const r of await this.active())await r.db.query("UPDATE connection_setups SET status='pending' WHERE actor_id=$1 AND status='awaiting_token'",[uid]);
        for(const r of await this.active()){
          const request=await one(r.db,"UPDATE connection_setups SET status='awaiting_token' WHERE id=$1 AND actor_id=$2 AND expires_at>now() AND status='pending' RETURNING name,endpoint",[connect[1],uid]);
          if(request){await this.telegram.text(chatId,`Особисте підключення «${request.name}»\nСервер: ${request.endpoint}\n\nНадішли токен доступу одним повідомленням, або - для публічного сервера без токена. Він буде зашифрований і не потрапить у групу чи запит моделі. /cancel скасовує налаштування.`);return;}
        }await this.telegram.text(chatId,'Посилання підключення недоступне або прострочене. Попроси підготувати нове.');return;
      }
      for(const r of await this.active()){
        const pending=await one(r.db,"SELECT * FROM connection_setups WHERE actor_id=$1 AND status='awaiting_token' AND expires_at>now() ORDER BY created_at DESC LIMIT 1",[uid]);if(!pending)continue;
        if(text==='/cancel'){await r.db.query("UPDATE connection_setups SET status='cancelled' WHERE id=$1",[pending.id]);await this.telegram.text(chatId,'Підключення скасоване.');return;}
        if(!text||text.length>20000||text.startsWith('/')){await this.telegram.text(chatId,'Очікую токен одним повідомленням або /cancel.');return;}
        const token=text.trim()==='-'?undefined:text.trim();const vault=new ConnectorVault(r.db,this.config.runtimeDir);
        if(token)await vault.put(uid,pending.name,token);
        await r.db.query('INSERT INTO tool_connections(id,owner_id,endpoint,credential_name) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,id) DO UPDATE SET endpoint=excluded.endpoint,credential_name=excluded.credential_name,enabled=true',[pending.name,uid,pending.endpoint,token?pending.name:null]);
        await r.db.query("UPDATE connection_setups SET status='completed' WHERE id=$1",[pending.id]);
        try{const tools=await new MCPClient(pending.endpoint,token).list();await this.telegram.text(chatId,`Підключення «${pending.name}» перевірене: доступно ${tools.length} інструментів. Особистий токен у групу не передаю.`);}catch{await this.telegram.text(chatId,`Підключення «${pending.name}» збережене, але сервер не підтвердив доступ. Перевір токен та адресу; робочим його поки не вважаю.`);}
        try{await this.telegram.call('deleteMessage',{chat_id:chatId,message_id:m.message_id});}catch{}return;
      }
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
