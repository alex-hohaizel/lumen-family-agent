import {looksLikeCredential} from './secrets.js';
import {PersonalizedBrain,recoverPersonalization} from './personalization.js';
import {OutboundLocalizer} from './localization.js';
import {OAuthDevices} from './oauth-device.js';
import {Coordinator} from './agent-services.js';
import {PrivateInbox} from './private-inbox.js';
import {Decisions} from './group-work.js';
import {SessionEngine} from './session-engine.js';
import {cancelOperations} from './operations.js';
import {browsers} from './browser.js';
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
  private initializing=new Map<string,Promise<ChatRuntime>>();
  private runtimes=new Map<string,ChatRuntime>();
  private auth:ChatGPTAuth;
  private publicStickers?:Promise<TGSticker[]>;
  private lumenPack?:LumenPack;
  private localizers=new Map<string,OutboundLocalizer>();
  setStickerPack(pack:LumenPack){this.lumenPack=pack;}
  async probePersonalizationScheduling(){
    const runtime=(await this.active())[0];if(!runtime)throw new Error('no_active_runtime');
    const brain=new OpenAIModel(runtime.engine.config,this.auth),fixture=new Date(Date.now()+2*86400000);fixture.setUTCHours(1,23,0,0);
    const context={now:fixture.toISOString(),local_time:new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Kyiv',dateStyle:'short',timeStyle:'short'}).format(fixture),timezone:'Europe/Kyiv',current_author:{id:'501',name:'Oleksandr'},current_topic:{id:'0'},owner_id:'501',personalization:{chat:{language:'uk'},people:[{id:'501',name:'Oleksandr',preferences:{}}]},recent_bot_turns:[{body:'О дев’ятій можу придумати короткий доброзичливий жарт про ім’я Люмена й написати його в цій темі.'}]};
    const instructions='Фіксована синтетична перевірка звичайного планування відповіді. Дані вигадані, доступу до пам’яті людей і виконання інструментів немає. Поверни звичайний план для поточної репліки.';
    const plan=await brain.plan({current:'Люмен, ты не понял. Когда тут будет 9 утра по киевскому времени, сделай это. И ещё зафиксируй: абсолютно все свои сообщения в этом чате, игры и активности пиши на русском.',context:JSON.stringify(context),instructions,search:false});
    const setting=plan.actions.find(a=>a.kind==='personalize'&&a.scope==='chat'&&a.language==='ru'),job=plan.actions.find(a=>a.kind==='schedule');
    if(!setting||!job||job.kind!=='schedule'||job.mode!=='task'||job.authorization!=='explicit'||job.timezone!=='Europe/Kyiv'||!/(люмен|имен)/iu.test(job.instruction))throw new Error('contextual_schedule_plan_invalid');
    const format=(d:Date)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d);
    const parts=format(new Date(job.due_at)),original=format(fixture);
    if(!['year','month','day'].every(k=>parts.find(p=>p.type===k)?.value===original.find(p=>p.type===k)?.value)||parts.find(p=>p.type==='hour')?.value!=='09'||parts.find(p=>p.type==='minute')?.value!=='00')throw new Error('contextual_schedule_timezone_invalid');
    const personal=await brain.plan({current:'Люмен, называй меня Саня. А может завтра в девять напомнишь мне выпить воду?',context:JSON.stringify(context),instructions,search:false});
    if(!personal.actions.some(a=>a.kind==='personalize'&&a.scope==='self'&&a.preferred_name==='Саня')||!personal.actions.some(a=>a.kind==='schedule'&&a.mode==='reminder'&&a.authorization==='ask'))throw new Error('personal_profile_or_confirmation_plan_invalid');
    const outbound=await new OutboundLocalizer(runtime.db,brain).transform('sendMessage',{chat_id:'synthetic',text:'Нагадування: випити воду',_lumen_output_language:'ru',reply_markup:{inline_keyboard:[[{text:'Підтверджую',callback_data:'fixture'}]]}});
    if(!/напоминание/iu.test(outbound.text)||/[іїєґ]/iu.test(outbound.text)||outbound.reply_markup.inline_keyboard[0][0].callback_data!=='fixture')throw new Error('outbound_language_probe_invalid');
    return {chat_language:true,contextual_task:true,kyiv_time:true,personal_name:true,proposal_needs_confirmation:true,russian_outbound:true,public_fixture_only:true};
  }
  constructor(public registry:ChatRegistry,private config:Config,private telegram:Telegram,private bot:BotIdentity,private brainFactory?:(config:Config,chatId:string)=>Brain){this.auth=new ChatGPTAuth(config.runtimeDir);this.telegram.setOutboundTransform?.((method,body)=>this.localizers.get(String(body.chat_id))?.transform(method,body)||Promise.resolve(body));}
  async init(){
    await this.registry.init();
    if(this.config.ownerId)await this.registry.claimOwner(this.config.ownerId);
    for(const chat of await this.registry.list(true)){const runtime=await this.runtime(chat);if(chat.enabled&&Number(chat.chat_id)<0)await queueReleaseNotice(runtime.db,this.lumenPack?'https://t.me/addstickers/'+this.lumenPack.name:undefined);}
  }
  async runtime(chat:RegisteredChat){const existing=this.runtimes.get(chat.chat_id);if(existing){existing.chat=chat;return existing;}let pending=this.initializing.get(chat.chat_id);if(!pending){pending=this.createRuntime(chat).finally(()=>this.initializing.delete(chat.chat_id));this.initializing.set(chat.chat_id,pending);}return pending;}
  private async createRuntime(chat:RegisteredChat){
    let runtime=this.runtimes.get(chat.chat_id);
    if(runtime){runtime.chat=chat;return runtime;}
    const db=this.registry.database(chat);
    await db.tx(applySchema);
    // Model selection is per group. Only the transport's token-refresh manager is shared.
    const initial=await state(db);const config={...this.config,model:initial.model||this.config.model};
    const rawBrain=this.brainFactory?.(config,chat.chat_id) || new OpenAIModel(config,this.auth);
    try{await recoverPersonalization(db,rawBrain);}catch{console.error(JSON.stringify({event:'personalization_recovery_deferred'}));}
    const brain=new PersonalizedBrain(rawBrain,db);this.localizers.set(chat.chat_id,new OutboundLocalizer(db,rawBrain));
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
    await db.query("UPDATE tool_connections SET health='check_pending' WHERE health='checking'");
    await runtime.agent.recover();await new SessionEngine(db,this.config.runtimeDir).recover();
    return runtime;
  }
  all(){return Array.from(this.runtimes.values());}
  async cancelAll(){for(const r of this.runtimes.values())cancelOperations(r.db);}
  async active(){return Array.from(this.runtimes.values()).filter(x=>x.chat.enabled);}
  async probeNativeSearch(){
    const runtime=(await this.active())[0];const config={...(runtime?.engine.config || this.config),webSearch:true};
    if(runtime){const {reserveModelCall}=await import('./model-budget.js');await reserveModelCall(runtime.db,config);}
    const result=await new OpenAIModel(config,this.auth).searchWeb('Find the official Node.js website. Return its URL.');
    return {searched:result.searched,sources:result.sources};
  }
  async probeFreshnessChoice(){
    const runtime=(await this.active())[0];const config={...(runtime?.engine.config || this.config),webSearch:true};
    if(runtime){const {reserveModelCall}=await import('./model-budget.js');await reserveModelCall(runtime.db,config);}
    let searched=false;
    const model=new OpenAIModel(config,this.auth,undefined,event=>{if(String(event.type).startsWith('response.web_search_call')||(event.response?.output || []).some((x:any)=>x.type==='web_search_call')||event.item?.type==='web_search_call')searched=true;});
    const plan=await model.plan({current:'Люмен, яка стабільна версія Node.js доступна для завантаження?',context:JSON.stringify({now:new Date().toISOString(),capabilities:{web_search:true},available_tools:runtime?.agent.tools.catalog() || []}),instructions:'Це перевірка вибору інструмента для звичайного публічного питання. Жодних особистих даних, повідомлень у Telegram чи зовнішніх записів.',search:true});
    const selected=plan.actions.filter(a=>a.kind==='tool').map(a=>a.name);if(!searched&&!selected.some(n=>n==='web.search'||n==='web.read'||n==='research.query'))throw new Error('freshness_search_not_selected');
    return {automatic_search_selected:true,native_search_executed:searched,selected_tools:selected};
  }
  async probeDocuments(){
    const {wordDocument,workbook,officeText}=await import('./office.js');const {scannedPages}=await import('./document-workshop.js');const {documentText}=await import('./documents.js');
    if(!officeText(wordDocument('Lumen 160',['Check 31415']),'test.docx').includes('31415')||!officeText(workbook([['check',31415]]),'test.xlsx').includes('31415'))throw new Error('office_readback_failed');
    const pdf=await browsers.pdf('<!doctype html><meta charset="utf-8"><h1>LUMEN 160</h1><p>Document check 31415</p>');await browsers.trim();const text=await documentText(pdf,'check.pdf');if(!text.includes('31415'))throw new Error('pdf_readback_failed');const pages=await scannedPages(pdf);
    const runtime=(await this.active())[0];if(runtime){const {reserveModelCall}=await import('./model-budget.js');await reserveModelCall(runtime.db,this.config);}const model=new OpenAIModel(runtime?.engine.config||this.config,this.auth);const answer=await model.text([{role:'user',content:[{type:'input_text',text:'Read the five digit number on this fixed diagnostic page. Reply only with that number.'},...pages.map(p=>({type:'input_image',image_url:p.dataUrl}))]}],'Read the number in the image; no tools or external actions.',false);if(!answer.includes('31415'))throw new Error('vision_ocr_number_not_observed');
    if(runtime)await runtime.db.query("INSERT INTO capability_health(name,status,detail) VALUES('documents','ready','DOCX XLSX PDF and image OCR verified') ON CONFLICT(name,actor_id) DO UPDATE SET status='ready',detail=excluded.detail,checked_at=now()");return {docx_readback:true,xlsx_readback:true,pdf_readback:true,scan_pages:pages.length,vision_ocr:true,number:'31415'};
  }
  async probeInteractions(){
    const runtime=(await this.active())[0],config=runtime?.engine.config||this.config;
    if(runtime){const {reserveModelCall}=await import('./model-budget.js');await reserveModelCall(runtime.db,config);}
    const brain=new OpenAIModel(config,this.auth);
    const plan=await brain.plan({current:'Люмен, ми вже обоє погодили спільну пригоду. Розділи ролі: один досліджує фото, друга перевіряє кімнату. Дай кожному можливість обрати дві різні дії й працювати паралельно.',context:JSON.stringify({current_author:{id:'501',name:'Гравець А'},participants:[{id:'501',name:'Гравець А'},{id:'502',name:'Гравець Б'}],interaction:{id:'00000000-0000-4000-8000-000000000017',phase:'active',kind:'activity',participants:[{id:'501',name:'Гравець А'},{id:'502',name:'Гравець Б'}]},available_tools:runtime?.agent.tools.catalog()||[]}),instructions:'Фіксована публічна діагностика без доступу до даних людей чи зовнішніх дій. Поверни тільки план нового компактного паралельного етапу через верхньорівневий interaction або interaction.open. Не виконуй інструментів.',search:false});
    let spec=plan.interaction;for(const a of plan.actions)if(a.kind==='tool'&&a.name==='interaction.open')spec=JSON.parse(a.arguments);
    const {InteractionSpec}=await import('./interactions.js');const value=InteractionSpec.parse(spec);
    if(value.policy!=='parallel'||value.max_choices!==2||value.roles.length!==2||new Set(value.roles.map(x=>x.user_id)).size!==2||value.roles.some(x=>!['501','502'].includes(x.user_id)||x.options.length<2))throw new Error('parallel_interaction_plan_invalid');
    return {parallel:true,max_choices_per_participant:value.max_choices,individual_roles:value.roles.length,compact_characters:plan.reply.length,private_data_used:false};
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
        if(voteEvent&&answer?.user){const details=answer.option_ids.map(i=>String(poll.options[i])).join(', ') || 'відкликав голос';await runtime.engine.receive({update_id:update.update_id,message:{message_id:-update.update_id,date:Math.floor(Date.now()/1000),chat:{id:Number(runtime.chat.chat_id),type:'supergroup'},from:answer.user,text:`[Голос в опитуванні «${poll.question}»] ${details}`,message_thread_id:poll.topic_id==='0'?undefined:Number(poll.topic_id),lumen_event:{kind:'poll_vote',target_message_id:Number(poll.message_id),details},...(poll.interaction_id?{lumen_interaction_event:{id:poll.interaction_id,version:Number(poll.interaction_version),action:answer.option_ids.length?String(answer.option_ids[0]):'wait'}}:{})}});}
        return;
      }return;
    }
    const cb=update.callback_query;
    if(cb){
      // Acknowledge immediately, including stale or unrecognized buttons.
      await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
      if(cb.message?.chat.type==='private'&&cb.message.from?.id===this.bot.id&&!cb.from.is_bot&&cb.data?.startsWith('lumen:pv:')){for(const r of await this.active())if(await new PrivateInbox(r.db,this.config.runtimeDir).choose(cb,this.telegram)){for(const other of await this.active())if(other!==r)await other.db.query("UPDATE private_requests SET status='offered' WHERE recipient_id=$1 AND status='answering'",[String(cb.from.id)]);return;}return;}
      const approval=/^lumen:(approve|reject):([0-9a-f-]{36})$/.exec(cb.data || '');
      if(approval&&cb.message?.chat.type==='private'&&cb.message.from?.id===this.bot.id&&String(cb.message.chat.id)===String(cb.from.id)&&!cb.from.is_bot){for(const runtime of await this.active()){const s=await state(runtime.db);if(s.paused)continue;const record=await one(runtime.db,"UPDATE tool_approvals SET status=$1 WHERE id=$2 AND actor_id=$3 AND audience='private' AND revision=$4 AND status='pending' AND expires_at>now() RETURNING task_id",[approval[1]==='approve'?'approved':'cancelled',approval[2],String(cb.from.id),s.memory_revision]);if(record){if(record.task_id&&approval[1]==='reject')await runtime.db.query("UPDATE agent_tasks SET status='needs_input',error_code='action_rejected',updated_at=now() WHERE id=$1 AND status='waiting'",[record.task_id]);return;}}return;}
      if(approval&&cb.message&&cb.message.from?.id===this.bot.id&&!cb.from.is_bot){
        const registered=await this.registry.find(String(cb.message.chat.id));if(!registered?.enabled)return;
        const runtime=await this.runtime(registered);await runtime.db.tx(async sql=>{const s=await state(sql,true);if(s.paused)return;
          const row=await one(sql,"UPDATE tool_approvals SET status=$1 WHERE id=$2 AND actor_id=$3 AND revision=$4 AND topic_id=$5 AND status='pending' AND expires_at>now() RETURNING task_id",[approval[1]==='approve'?'approved':'cancelled',approval[2],String(cb.from.id),s.memory_revision,String(cb.message!.message_thread_id || 0)]);
          if(row?.task_id&&approval[1]==='reject')await sql.query("UPDATE agent_tasks SET status='needs_input',error_code='action_rejected',updated_at=now() WHERE id=$1 AND status='waiting'",[row.task_id]);
        });return;
      }
      const interactive=/^li:([0-9a-f-]{36}):(\d+):([a-z0-9_]+)$/.exec(cb.data||'');
      const panel=/^lp:([0-9a-f-]{36}):(\d+)$/.exec(cb.data||'');
      if((interactive||panel)&&cb.message?.from?.id===this.bot.id&&!cb.from.is_bot){
        if(cb.message.chat.type==='private'&&String(cb.message.chat.id)!==String(cb.from.id))return;
        const chat=await this.registry.find(String(cb.message.chat.id));if(!chat?.enabled)return;const runtime=await this.runtime(chat);
        if(interactive){await runtime.engine.receive({update_id:update.update_id,message:{message_id:-update.update_id,date:Math.floor(Date.now()/1000),from:cb.from,chat:cb.message.chat,message_thread_id:cb.message.message_thread_id,text:'[Вибір у поточному кроці]',lumen_interaction_event:{id:interactive[1]!,version:Number(interactive[2]),action:interactive[3]!}}});return;}
        const s=await state(runtime.db),row=await one(runtime.db,'SELECT * FROM message_panels WHERE id=$1 AND revision=$2 AND expires_at>now() AND topic_id=$3',[panel![1],s.memory_revision,String(cb.message.message_thread_id||0)]);
        if(!row||s.paused||row.audience==='private'&&row.actor_id!==String(cb.from.id))return;
        const index=Number(panel![2]),pages:string[]=row.pages;if(index<0||index>=pages.length)return;
        const keys={inline_keyboard:[[{text:`Сторінка ${index+1}/${pages.length}`,callback_data:`lp:${row.id}:${index}`}],...(index+1<pages.length?[[{text:'Далі',callback_data:`lp:${row.id}:${index+1}`}]]:[]),...(index>0?[[{text:'Назад',callback_data:`lp:${row.id}:${index-1}`}]]:[])]};
        try{await this.telegram.call('sendMessage',{chat_id:cb.message.chat.id,text:pages[index],ephemeral_message_parameters:{receiver_user_id:cb.from.id,callback_query_id:cb.id},reply_markup:keys});}catch{await this.telegram.text(String(cb.message.chat.id),pages[index]!,{threadId:cb.message.message_thread_id,replyMarkup:keys});}return;
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
    // New private Telegram event shapes must never enter ordinary group memory.
    if(m.receiver_user||m.ephemeral_message_id!==undefined)return;
    if(m.chat.type==='private'){
      if(await this.registry.privateConsumed(update.update_id,uid))return;
      const approveLink=/^\/start(?:@\w+)?\s+approve_([0-9a-f-]{36})$/.exec(text);if(approveLink){for(const r of await this.active()){const s=await state(r.db);if(s.paused)continue;const a=await one(r.db,"SELECT id,summary FROM tool_approvals WHERE id=$1 AND actor_id=$2 AND audience='private' AND revision=$3 AND status='pending' AND expires_at>now()",[approveLink[1],uid,s.memory_revision]);if(a){await this.telegram.text(chatId,'Підготував конкретний крок. Перевір параметри:\n'+a.summary,{replyMarkup:{inline_keyboard:[[{text:'Підтвердити',callback_data:'lumen:approve:'+a.id},{text:'Скасувати',callback_data:'lumen:reject:'+a.id}]]}});return;}}await this.telegram.text(chatId,'Підтвердження недоступне або прострочене.');return;}
      const oauth=/^\/start(?:@\w+)?\s+oauth_([0-9a-f-]{36})$/.exec(text);if(oauth){for(const r of await this.active())try{if(await new OAuthDevices(r.db,this.config.runtimeDir).begin(oauth[1]!,uid,this.telegram))return;}catch(e:any){await this.telegram.text(chatId,'Авторизацію не розпочато: '+(/^[a-z_]+$/.test(e.code||'')?e.code:'провайдер недоступний')+'. Потрібен сервіс із підтримкою Device Flow та зареєстрований client ID.');return;}await this.telegram.text(chatId,'Посилання авторизації недоступне або прострочене.');return;}
      const personal=/^\/start(?:@\w+)?\s+p_([a-f0-9]{24})$/.exec(text);
      if(personal){for(const r of await this.active()){await r.db.query("UPDATE private_requests SET status='offered' WHERE recipient_id=$1 AND status='answering'",[uid]);await r.db.query("UPDATE connection_setups SET status='pending' WHERE actor_id=$1 AND status='awaiting_token'",[uid]);}for(const r of await this.active())if(await new PrivateInbox(r.db,this.config.runtimeDir).open(personal[1]!,uid,this.telegram))return;await this.telegram.text(chatId,'Особистий запит недоступний або прострочений.');return;}
      const connect=/^\/start(?:@\w+)?\s+connect_([0-9a-f-]{36})$/.exec(text);
      if(connect){
        for(const r of await this.active()){await r.db.query("UPDATE connection_setups SET status='pending' WHERE actor_id=$1 AND status='awaiting_token'",[uid]);await r.db.query("UPDATE private_requests SET status='offered' WHERE recipient_id=$1 AND status='answering'",[uid]);}
        for(const r of await this.active()){
          const request=await one(r.db,"UPDATE connection_setups SET status='awaiting_token' WHERE id=$1 AND actor_id=$2 AND expires_at>now() AND status='pending' RETURNING name,endpoint",[connect[1],uid]);
          if(request){await this.telegram.text(chatId,`Особисте підключення «${request.name}»\nСервер: ${request.endpoint}\n\nНадішли токен доступу одним повідомленням, або - для публічного сервера без токена. Він буде зашифрований і не потрапить у групу чи запит моделі. /cancel скасовує налаштування.`);return;}
        }await this.telegram.text(chatId,'Посилання підключення недоступне або прострочене. Попроси підготувати нове.');return;
      }
      for(const r of await this.active()){
        const pending=await one(r.db,"SELECT * FROM connection_setups WHERE actor_id=$1 AND status='awaiting_token' AND expires_at>now() ORDER BY created_at DESC LIMIT 1",[uid]);if(!pending)continue;
        if(text==='/cancel'){await r.db.query("UPDATE connection_setups SET status='cancelled' WHERE id=$1",[pending.id]);await this.telegram.text(chatId,'Підключення скасоване.');return;}
        if(!text||text.length>20000||text.startsWith('/')){await this.telegram.text(chatId,'Очікую токен одним повідомленням або /cancel.');return;}
        if(!await this.registry.consumePrivate(update.update_id,uid,'connector_secret'))return;
        const token=text.trim()==='-'?undefined:text.trim();
        const saved=await r.db.tx(async sql=>{const s=await state(sql,true);const active=await one(sql,"SELECT * FROM connection_setups WHERE id=$1 AND actor_id=$2 AND status='awaiting_token' AND expires_at>now() AND revision=$3",[pending.id,uid,s.memory_revision]);if(s.paused||!active)return false;const vault=new ConnectorVault({query:(q,a)=>sql.query(q,a),tx:fn=>fn(sql),close:async()=>{}},this.config.runtimeDir);if(token)await vault.put(uid,active.name,token);await sql.query("INSERT INTO tool_connections(id,owner_id,endpoint,credential_name,health,verification_task_id,verification_goal_version) VALUES($1,$2,$3,$4,'check_pending',$5,$6) ON CONFLICT(owner_id,id) DO UPDATE SET endpoint=excluded.endpoint,credential_name=excluded.credential_name,enabled=true,health='check_pending',auth_metadata='{}',trusted_read_tools='[]',confirmation_contract='{}',verification_task_id=excluded.verification_task_id,verification_goal_version=excluded.verification_goal_version",[active.name,uid,active.endpoint,token?active.name:null,active.task_id||null,active.goal_version||1]);await sql.query('DELETE FROM tool_grants WHERE actor_id=$1 AND connection_id=$2',[uid,active.name]);await vault.remove(uid,'refresh_'+active.name);await sql.query("UPDATE connection_setups SET status='completed' WHERE id=$1",[active.id]);return true;});
        if(!saved){await this.telegram.text(chatId,'Налаштування скасоване або прострочене. Секрет не передаю моделі; відкрий новий особистий запит підключення.');return;}
        await this.telegram.text(chatId,`Доступ до «${pending.name}» збережено зашифрованим. Перевіряю сервіс у фоновій черзі; результат повідомлю тут. Відповіді особистого сервісу за замовчуванням не передаю в груповий контекст.`);
        try{await this.telegram.call('deleteMessage',{chat_id:chatId,message_id:m.message_id});}catch{}return;
      }
      for(const r of await this.active()){const inbox=new PrivateInbox(r.db,this.config.runtimeDir);const pending=await inbox.pending(uid);if(!pending)continue;if(!await this.registry.consumePrivate(update.update_id,uid,'purpose_bound_answer'))return;try{const result=await inbox.answer(pending,m,async(request,answer,ref)=>{if(request.payload.decision_id)await new Decisions(r.db,this.config.runtimeDir).ballot(request,answer,ref);if(request.payload.coordinator_key)await new Coordinator(r.db,this.config.runtimeDir).savePreference(request,answer);if(request.session_id)await new SessionEngine(r.db,this.config.runtimeDir).privateMove(request,answer,ref);});await this.telegram.text(chatId,result.cancelled?'Особистий запит скасовано.':'Відповідь збережено з обраними тобою умовами використання.');}catch(e:any){await this.telegram.text(chatId,'Не прийняв відповідь: '+(/^[a-z_]+$/.test(e.code||'')?e.code:'перевір формат')+'. Спробуй ще раз або /cancel.');}return;}
      if(looksLikeCredential(text)){await this.telegram.text(chatId,'Це схоже на секрет доступу. Не передаю його моделі й не записую в розмову. Для підключення відкрий відповідний особистий майстер налаштування.');try{await this.telegram.call('deleteMessage',{chat_id:chatId,message_id:m.message_id});}catch{}return;}
      if(!/^\/(?:start|id|help)(?:@\w+)?(?:\s|$)/i.test(text)){let permitted=await this.owner(uid);if(!permitted)for(const r of await this.active())if(Number(r.chat.chat_id)<0&&await one(r.db,'SELECT user_id FROM members WHERE user_id=$1 AND active=true',[uid])){permitted=true;break;}if(!permitted){await this.telegram.text(chatId,'Особистий діалог доступний учасникам підключених груп. Спершу напиши в такій групі або відкрий особистий запит Люмена.');return;}const chat=await this.registry.ensure(chatId,uid,'Особистий чат');const r=await this.runtime(chat);await r.db.query("UPDATE app_state SET mention_only=false WHERE id=1");await r.engine.receive(update,true);return;}
      const payload=text.trim().split(/\s+/)[1] || '';
      if(validSetupPayload(payload,this.config)&&(!this.config.ownerId||this.config.ownerId===uid))await this.registry.claimOwner(uid);
      const own=await this.owner(uid);
      await this.telegram.text(chatId,own?'Привіт! Підключення готове. Додай мене в потрібну групу кнопкою нижче. У кожної групи буде своя пам’ять; тут я її не показую. Також можеш написати мені особисте запитання — цей діалог матиме окрему пам’ять.':`Привіт, я Люмен. Працюю в підключених групах. Твій Telegram ID: ${uid}. Тут можна спілкуватися особисто: пам’ять цього чату окрема, приватні відповіді з групових задач обробляються за твоїм дозволом.`,own?{replyMarkup:groupSetupKeys(this.bot.username,this.config)}:{});
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
