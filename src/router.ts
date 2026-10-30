import {setCalendarOwnerResolver} from './calendar-groups.js';
import {setCalendarChangeListener} from './calendar-sync.js';
import {PrivacyFenceDatabase} from './privacy-fence.js';
import {recoverDispatches} from './commitments.js';
import {queueResultView} from './result-views.js';
import {looksLikeCredential} from './secrets.js';
import {PersonalizedBrain,recoverPersonalization} from './personalization.js';
import {OutboundLocalizer} from './localization.js';
import {OAuthDevices} from './oauth-device.js';
import {Coordinator} from './agent-services.js';
import {PrivateInbox} from './private-inbox.js';
import {Decisions} from './group-work.js';
import {SessionEngine} from './session-engine.js';
import {cancelOperations,drainOperations,operationCount,retainOperation,runOperation} from './operations.js';
import {disposeActivity} from './activity-status.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {browsers} from './browser.js';
import {createHash} from 'node:crypto';
import type {Config} from './config.js';
import {ChatRegistry,type RegisteredChat,type RuntimeLane,type RuntimeWork,type PrivateIngressReference} from './registry.js';
import {state,one,queueText,type Database,type SQL} from './db.js';
import {ingressOf,ingressContext,isIngressStale,withIngress,routedUpdate} from './ingress-context.js';
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
export interface RuntimePolicy {maxWarm?:number;idleMs?:number;safetyPollMs?:number;now?:()=>number;}
interface RuntimeUse {lastUsed:number;leases:number;checkAfter?:number;retiring?:Promise<void>;}
export class ChatRouter {
  private initializing=new Map<string,Promise<ChatRuntime>>();
  private runtimes=new Map<string,ChatRuntime>();
  private auth:ChatGPTAuth;
  private uses=new Map<string,RuntimeUse>();
  private work=new Map<string,RuntimeWork>();
  private workEpoch=new Map<string,number>();
  private scopedChats=new AsyncLocalStorage<RegisteredChat[]>();
  private startupChats=new Set<string>();
  private routing=0;
  private sweepAt=0;
  private sweeping?:Promise<void>;
  private pruning?:Promise<void>;
  private policy:Required<RuntimePolicy>;
  private served=new Map<string,number>();
  private maintenanceAfter=new Map<string,number>();
  private sequence=0;
  private publicStickers?:Promise<TGSticker[]>;
  private lumenPack?:LumenPack;
  private localizers=new Map<string,OutboundLocalizer>();
  setStickerPack(pack:LumenPack){this.lumenPack=pack;}
  async probePersonalizationScheduling(){
    const runtime=await this.probeRuntime();if(!runtime)throw new Error('no_active_runtime');
    const brain=new OpenAIModel(runtime.engine.config,this.auth,undefined,undefined,runtime.db),fixture=new Date(Date.now()+2*86400000);fixture.setUTCHours(1,23,0,0);
    const context={now:fixture.toISOString(),local_time:new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Kyiv',dateStyle:'short',timeStyle:'short'}).format(fixture),timezone:'Europe/Kyiv',current_author:{id:'501',name:'Oleksandr'},current_topic:{id:'0'},owner_id:'501',personalization:{chat:{language:'uk'},people:[{id:'501',name:'Oleksandr',preferences:{}}]},recent_bot_turns:[{body:'О дев’ятій можу придумати короткий доброзичливий жарт про ім’я Люмена й написати його в цій темі.'}]};
    const instructions='Фіксована синтетична перевірка звичайного планування відповіді. Дані вигадані, доступу до пам’яті людей і виконання інструментів немає. Поверни звичайний план для поточної репліки.';
    const plan=await brain.plan({current:'Люмен, ты не понял. Когда тут будет 9 утра по киевскому времени, сделай это. И ещё зафиксируй: абсолютно все свои сообщения в этом чате, игры и активности пиши на русском.',context:JSON.stringify(context),instructions,search:false});
    const setting=plan.actions.find(a=>a.kind==='personalize'&&a.scope==='chat'&&a.language==='ru'),job=plan.actions.find(a=>a.kind==='schedule');
    if(!setting||!job||job.kind!=='schedule'||job.mode!=='task'||job.authorization!=='explicit'||job.timezone!=='Europe/Kyiv'||!/(люмен|имен)/iu.test(job.instruction))throw new Error('contextual_schedule_plan_invalid');
    const format=(d:Date)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d);
    const parts=format(new Date(job.due_at)),original=format(fixture);
    if(!['year','month','day'].every(k=>parts.find(p=>p.type===k)?.value===original.find(p=>p.type===k)?.value)||parts.find(p=>p.type==='hour')?.value!=='09'||parts.find(p=>p.type==='minute')?.value!=='00')throw new Error('contextual_schedule_timezone_invalid');
    const personal=await brain.plan({current:'Люмен, называй меня Саня. А может завтра в девять напомнишь мне выпить воду?',context:JSON.stringify(context),instructions,search:false});
    console.log(JSON.stringify({event:'personalization_scheduling_190_plan',synthetic:true,actions:personal.actions.map(a=>({kind:a.kind,...(a.kind==='personalize'?{scope:a.scope,preferred_name:a.preferred_name}:{}),...(a.kind==='schedule'?{mode:a.mode,authorization:a.authorization}:{} )})),offer_kind:personal.offer?.action.kind,move:personal.behavior?.move}));
    if(!personal.actions.some(a=>a.kind==='personalize'&&a.scope==='self'&&a.preferred_name==='Саня')||!personal.actions.some(a=>a.kind==='schedule'&&a.mode==='reminder'&&a.authorization==='ask'))throw new Error('personal_profile_or_confirmation_plan_invalid');
    const outbound=await new OutboundLocalizer(runtime.db,brain).transform('sendMessage',{chat_id:'synthetic',text:'Нагадування: випити воду',_lumen_output_language:'ru',reply_markup:{inline_keyboard:[[{text:'Підтверджую',callback_data:'fixture'}]]}});
    if(!/напоминание/iu.test(outbound.text)||/[іїєґ]/iu.test(outbound.text)||outbound.reply_markup.inline_keyboard[0][0].callback_data!=='fixture')throw new Error('outbound_language_probe_invalid');
    return {chat_language:true,contextual_task:true,kyiv_time:true,personal_name:true,proposal_needs_confirmation:true,russian_outbound:true,public_fixture_only:true};
  }
  constructor(public registry:ChatRegistry,private config:Config,private telegram:Telegram,private bot:BotIdentity,private brainFactory?:(config:Config,chatId:string)=>Brain,policy:RuntimePolicy={}){
    this.policy={maxWarm:Math.max(0,Math.floor(policy.maxWarm??8)),idleMs:Math.max(0,policy.idleMs??300000),safetyPollMs:Math.max(1000,policy.safetyPollMs??30000),now:policy.now??Date.now};
    this.auth=new ChatGPTAuth(config.runtimeDir);this.telegram.setOutboundTransform?.((method,body)=>this.localizers.get(String(body.chat_id))?.transform(method,body)||Promise.resolve(body));
  }
  async init(){
    await this.registry.init();
    if(this.config.ownerId)await this.registry.claimOwner(this.config.ownerId);
    for(const chat of await this.registry.list())this.startupChats.add(chat.chat_id);
  }
  async runtime(chat:RegisteredChat):Promise<ChatRuntime>{
    const registered=await this.registry.find(chat.chat_id);if(!registered?.enabled)throw new Error('chat_disabled');
    const use=this.uses.get(chat.chat_id);if(use?.retiring){await use.retiring;return this.runtime(registered);}
    const pending=this.initializing.get(chat.chat_id);if(pending){const runtime=await pending;retainOperation(runtime.db);return runtime;}
    const existing=this.runtimes.get(chat.chat_id);if(existing){existing.chat=registered;if(use)use.lastUsed=this.policy.now();retainOperation(existing.db);return existing;}
    const creating=this.createRuntime(registered).catch(error=>{this.localizers.delete(chat.chat_id);this.runtimes.delete(chat.chat_id);this.uses.delete(chat.chat_id);throw error;}).finally(()=>this.initializing.delete(chat.chat_id));
    this.initializing.set(chat.chat_id,creating);const runtime=await creating;retainOperation(runtime.db);return runtime;
  }
  private async createRuntime(chat:RegisteredChat){
    let runtime=this.runtimes.get(chat.chat_id);
    if(runtime){runtime.chat=chat;return runtime;}
    await this.registry.prepare(chat);
    const rawDb=this.registry.database(chat);
    const db=await PrivacyFenceDatabase.open(rawDb,this.config.runtimeDir,chat.schema_name);
    // Model selection is per group. Only the transport's token-refresh manager is shared.
    const initial=await state(db);const config={...this.config,model:initial.model||this.config.model};
    const rawBrain=this.brainFactory?.(config,chat.chat_id) || new OpenAIModel(config,this.auth,undefined,undefined,db);
    try{await recoverPersonalization(db,rawBrain);}catch{console.error(JSON.stringify({event:'personalization_recovery_deferred'}));}
    const brain=new PersonalizedBrain(rawBrain,db);this.localizers.set(chat.chat_id,new OutboundLocalizer(db,rawBrain));
    const visual=new VisualMemory(db,this.telegram,brain);
    runtime={chat,db,engine:new Lumen(db,config,this.telegram,brain,this.bot,undefined,this.auth),delivery:new Delivery(db,this.telegram,config),memory:new Memory(db,brain,config.dailyTurnLimit || (config.authMode==='api'?200:0)),visual,images:new ImageJobs(db,config,this.telegram,visual),agent:new AgentTasks(db,config,brain),monitors:new WebMonitors(db,config)};
    await setCalendarOwnerResolver(db,async actor=>{const personal=await this.registry.ensure(actor,actor,'Особистий чат');return (await this.runtime(personal)).agent.tools.evolution.calendar;});
    if(Number(chat.chat_id)>0)setCalendarChangeListener(db,async change=>{
      const registered=await this.registry.find(change.groupChat);if(!registered?.enabled)return;const target=await this.runtime(registered);
      await this.operate(target,'calendar_change',()=>target.db.tx(async sql=>{const live=await state(sql,true);if(live.paused)return;const event=await one(sql,'SELECT * FROM group_events WHERE id=$1 FOR UPDATE',[change.groupEventId]);
        if(!event||event.details.calendar_owner!==change.ownerId||event.details.calendar_mirror!==change.mirrorId||event.details.calendar_sync_version>=change.version)return;
        const details={...event.details,calendar_sync_version:change.version,calendar_status:change.status,...(change.start?{start_at:change.start,end_at:change.end}:{}),attendance:'not_confirmed'};
        await sql.query("UPDATE group_events SET details=$2,status=CASE WHEN $3='cancelled' THEN 'cancelled' ELSE status END,version=version+1 WHERE id=$1",[event.id,JSON.stringify(details),change.status]);
        await queueText(sql,`Календар власника оновив погоджену подію «${event.title}»: ${change.status==='cancelled'?'скасовано':change.start+' — '+change.end}. Участь інших потребує окремого погодження.`,live.memory_revision,'calendar-change:'+event.id+':'+change.version,false,{actorId:change.ownerId,threadId:event.topic_id==='0'?undefined:Number(event.topic_id),sourceMessageId:event.source_message_id||undefined});
      }));
    });
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
    await db.tx(recoverDispatches);
    await runtime.agent.recover();await new SessionEngine(db,this.config.runtimeDir).recover();
    if(Number(chat.chat_id)<0&&this.startupChats.has(chat.chat_id))await queueReleaseNotice(db,this.lumenPack?'https://t.me/addstickers/'+this.lumenPack.name:undefined);
    this.runtimes.set(chat.chat_id,runtime);this.uses.set(chat.chat_id,{lastUsed:this.policy.now(),leases:0});
    await this.refresh(runtime);
    return runtime;
  }
  all(){return Array.from(this.runtimes.values());}
  async cancelAll(){for(const r of this.runtimes.values())cancelOperations(r.db);}
  async drainAll(){await Promise.allSettled(Array.from(this.runtimes.values(),runtime=>drainOperations(runtime.db)));}
  async active(){
    const scoped=this.scopedChats.getStore();
    if(scoped){const runtimes:ChatRuntime[]=[];for(const chat of scoped){const current=await this.registry.find(chat.chat_id);if(current?.enabled)runtimes.push(await this.runtime(current));}return runtimes;}
    return Array.from(this.runtimes.values()).filter(x=>x.chat.enabled&&!this.uses.get(x.chat.chat_id)?.retiring);
  }
  // Existing durable rows own deadlines. This small content-free directory is
  // rebuilt on restart and by a safety sweep, without constructing runtimes.
  async sweep(force=false){
    if(this.sweeping)return this.sweeping;
    if(!force&&this.policy.now()<this.sweepAt)return;
    this.sweeping=(async()=>{
      const enabled=await this.registry.list(),ids=new Set(enabled.map(chat=>chat.chat_id));
      for(const id of this.work.keys())if(!ids.has(id))this.work.delete(id);
      for(const runtime of this.runtimes.values())if(!ids.has(runtime.chat.chat_id))runtime.chat={...runtime.chat,enabled:false};
      for(const chat of enabled){const epoch=this.workEpoch.get(chat.chat_id)||0;try{const work=await this.registry.inspectWork(chat);if((this.workEpoch.get(chat.chat_id)||0)!==epoch)continue;if(work)this.work.set(chat.chat_id,work);else this.work.delete(chat.chat_id);}catch{console.error(JSON.stringify({event:'runtime_due_scan_deferred'}));}}
      this.sweepAt=this.policy.now()+this.policy.safetyPollMs;
    })().finally(()=>{this.sweeping=undefined;});
    return this.sweeping;
  }
  private async refresh(runtime:ChatRuntime){
    const epoch=(this.workEpoch.get(runtime.chat.chat_id)||0)+1;this.workEpoch.set(runtime.chat.chat_id,epoch);
    if(!runtime.chat.enabled){this.work.delete(runtime.chat.chat_id);return;}
    const work=await this.registry.inspectWork(runtime.chat);
    if(this.workEpoch.get(runtime.chat.chat_id)!==epoch)return;
    if(work)this.work.set(runtime.chat.chat_id,work);else{runtime.chat={...runtime.chat,enabled:false};this.work.delete(runtime.chat.chat_id);}
    const use=this.uses.get(runtime.chat.chat_id);if(use)use.checkAfter=0;
  }
  async ready(lane:RuntimeLane,limit=3,excluded:ReadonlySet<string>=new Set()){
    await this.sweep();const now=this.policy.now(),ready:ChatRuntime[]=[];
    const candidates=Array.from(this.work.values()).filter(work=>(work.next[lane]??Infinity)<=now&&!excluded.has(work.chat.chat_id)&&(lane!=='maintenance'||now>=(this.maintenanceAfter.get(work.chat.chat_id)||0))).sort((a,b)=>(this.served.get(a.chat.chat_id+':'+lane)||0)-(this.served.get(b.chat.chat_id+':'+lane)||0));
    for(const work of candidates){if(ready.length>=limit)break;const chat=await this.registry.find(work.chat.chat_id);if(!chat?.enabled){this.work.delete(work.chat.chat_id);continue;}try{ready.push(await this.runtime(chat));}catch{work.next[lane]=now+this.policy.safetyPollMs;console.error(JSON.stringify({event:'runtime_restore_deferred'}));}this.served.set(chat.chat_id+':'+lane,++this.sequence);}
    return ready;
  }
  async operate<T>(runtime:ChatRuntime,key:string,fn:()=>Promise<T>):Promise<T|undefined>{
    const use=this.uses.get(runtime.chat.chat_id);
    if(!runtime.chat.enabled||!use||use.retiring||this.runtimes.get(runtime.chat.chat_id)!==runtime)return;
    use.leases++;use.lastUsed=this.policy.now();
    try{return await runOperation(runtime.db,key,async()=>{const chat=await this.registry.find(runtime.chat.chat_id);if(!chat?.enabled){runtime.chat={...runtime.chat,enabled:false};return;}return fn();});}
    finally{try{await this.refresh(runtime);if(key==='memory')this.maintenanceAfter.set(runtime.chat.chat_id,this.policy.now()+60000);}catch{this.sweepAt=0;}finally{use.leases--;use.lastUsed=this.policy.now();}}
  }
  async evictIdle(){
    if(this.pruning)return this.pruning;
    this.pruning=(async()=>{
      if(this.routing)return;
      const now=this.policy.now(),ordered=Array.from(this.runtimes.values()).sort((a,b)=>(this.uses.get(a.chat.chat_id)?.lastUsed||0)-(this.uses.get(b.chat.chat_id)?.lastUsed||0));
      for(const runtime of ordered){
        if(this.routing)break;
        const id=runtime.chat.chat_id,use=this.uses.get(id);if(!use||use.retiring||use.leases||operationCount(runtime.db)||this.initializing.has(id)||now<(use.checkAfter||0))continue;
        if(runtime.chat.enabled&&this.runtimes.size<=this.policy.maxWarm&&now-use.lastUsed<this.policy.idleMs)continue;
        // Admission closes before the asynchronous drain check. A new incoming
        // route waits for retirement; workers cannot acquire a retiring entry.
        use.retiring=(async()=>{
          const live=runtime.chat.enabled?await this.registry.inspectWork(runtime.chat):undefined;
          if(live)this.work.set(id,live);
          if(this.routing||use.leases||operationCount(runtime.db))return;
          if(live&&(live.busy||Object.values(live.next).some(deadline=>deadline<=this.policy.now()))){use.checkAfter=this.policy.now()+this.policy.safetyPollMs;return;}
          await disposeActivity(runtime.db);
          if(this.routing||use.leases||operationCount(runtime.db))return;
          this.runtimes.delete(id);this.localizers.delete(id);this.uses.delete(id);
        })();
        try{await use.retiring;}finally{use.retiring=undefined;}
      }
    })().finally(()=>{this.pruning=undefined;});
    return this.pruning;
  }
  private async probeRuntime(){const warm=(await this.active())[0];if(warm)return warm;const chat=(await this.registry.list())[0];return chat?this.runtime(chat):undefined;}
  async probeNativeSearch(){
    const runtime=await this.probeRuntime();const config={...(runtime?.engine.config || this.config),webSearch:true};
    if(runtime){const {reserveModelCall}=await import('./model-budget.js');await reserveModelCall(runtime.db,config);}
    const result=await new OpenAIModel(config,this.auth,undefined,undefined,runtime?.db).searchWeb('Find the official Node.js website. Return its URL.');
    return {searched:result.searched,sources:result.sources};
  }
  async probeFreshnessChoice(){
    const runtime=await this.probeRuntime();const config={...(runtime?.engine.config || this.config),webSearch:true};
    if(runtime){const {reserveModelCall}=await import('./model-budget.js');await reserveModelCall(runtime.db,config);}
    let searched=false;
    const model=new OpenAIModel(config,this.auth,undefined,event=>{if(String(event.type).startsWith('response.web_search_call')||(event.response?.output || []).some((x:any)=>x.type==='web_search_call')||event.item?.type==='web_search_call')searched=true;},runtime?.db);
    const plan=await model.plan({current:'Люмен, яка стабільна версія Node.js доступна для завантаження?',context:JSON.stringify({now:new Date().toISOString(),capabilities:{web_search:true},available_tools:runtime?.agent.tools.catalog() || []}),instructions:'Це перевірка вибору інструмента для звичайного публічного питання. Жодних особистих даних, повідомлень у Telegram чи зовнішніх записів.',search:true});
    const selected=plan.actions.filter(a=>a.kind==='tool').map(a=>a.name);if(!searched&&!selected.some(n=>n==='web.search'||n==='web.read'||n==='research.query'))throw new Error('freshness_search_not_selected');
    return {automatic_search_selected:true,native_search_executed:searched,selected_tools:selected};
  }
  async probeDocuments(){
    const {wordDocument,workbook,officeText}=await import('./office.js');const {scannedPages}=await import('./document-workshop.js');const {documentText}=await import('./documents.js');
    if(!officeText(wordDocument('Lumen 160',['Check 31415']),'test.docx').includes('31415')||!officeText(workbook([['check',31415]]),'test.xlsx').includes('31415'))throw new Error('office_readback_failed');
    const pdf=await browsers.pdf('<!doctype html><meta charset="utf-8"><h1>LUMEN 160</h1><p>Document check 31415</p>');await browsers.trim();const text=await documentText(pdf,'check.pdf');if(!text.includes('31415'))throw new Error('pdf_readback_failed');const pages=await scannedPages(pdf);
    const runtime=await this.probeRuntime();if(runtime){const {reserveModelCall}=await import('./model-budget.js');await reserveModelCall(runtime.db,this.config);}const model=new OpenAIModel(runtime?.engine.config||this.config,this.auth,undefined,undefined,runtime?.db);const answer=await model.text([{role:'user',content:[{type:'input_text',text:'Read the five digit number on this fixed diagnostic page. Reply only with that number.'},...pages.map(p=>({type:'input_image',image_url:p.dataUrl}))]}],'Read the number in the image; no tools or external actions.',false);if(!answer.includes('31415'))throw new Error('vision_ocr_number_not_observed');
    if(runtime)await runtime.db.query("INSERT INTO capability_health(name,status,detail) VALUES('documents','ready','DOCX XLSX PDF and image OCR verified') ON CONFLICT(name,actor_id) DO UPDATE SET status='ready',detail=excluded.detail,checked_at=now()");return {docx_readback:true,xlsx_readback:true,pdf_readback:true,scan_pages:pages.length,vision_ocr:true,number:'31415'};
  }
  async probeCompanion113(){
    const runtime=await this.probeRuntime(),config=runtime?.engine.config||this.config;
    const brain=new OpenAIModel(config,this.auth,undefined,undefined,runtime?.db);
    const {probeCompanionConversation}=await import('./companion-probe.js');
    const result=await probeCompanionConversation(brain,async()=>{if(runtime){const {reserveModelCall}=await import('./model-budget.js');await reserveModelCall(runtime.db,config);}});
    console.log(JSON.stringify({event:'companion_113_model_replay',model:config.model,...result}));
    if(!result.ok)throw new Error('companion_113_replay_failed');
    return {model:config.model,...result};
  }
  async probeBehavior111(){
    const runtime=await this.probeRuntime(),config=runtime?.engine.config||this.config,brain=new OpenAIModel(config,this.auth,undefined,undefined,runtime?.db);
    const goal='00000000-0000-4000-8000-000000000111';
    const cases=[
      {id:'other_recipient',current:'Олю, ти вже вдома?',context:{replying_to:{author:'Оля',user_id:'502',message_id:81,text:'Їду додому'},behavior_context:{references:[],recent_own_contributions:[]}},expected:'listen'},
      {id:'simple_request',current:'Люмен, скільки буде 2+2?',context:{behavior_context:{references:[],recent_own_contributions:[]}},expected:'answer'},
      {id:'material_clarification',current:'Люмен, підготуй для нас дослідження.',context:{behavior_context:{references:[],recent_own_contributions:[]}},expected:'clarify'},
      {id:'bound_answer',current:'О дев’ятій ранку завтра',context:{behavior_context:{references:[{id:goal,actor_id:'501',status:'waiting',question:'О котрій нагадати завтра купити квитки?',goal:'Люмен, нагадай завтра купити квитки',allowed:['remind','schedule']}],recent_own_contributions:[]},active_dialogue:{origin:'clarification',reference_id:goal}},expected:'bound'},
      {id:'ambiguous_acceptance',current:'Так, давай',context:{behavior_context:{references:[{id:goal,actor_id:'501',status:'offered',goal:'Детектив на 10 хвилин'},{id:'00000000-0000-4000-8000-000000000112',actor_id:'501',status:'offered',goal:'Коротке дослідження про океани'}],recent_own_contributions:[]}},expected:'clarify'},
    ];
    const results=[];
    for(const item of cases){
      if(runtime){const {reserveModelCall}=await import('./model-budget.js');await reserveModelCall(runtime.db,config);}
      const plan=await brain.plan({current:item.current,context:JSON.stringify({now:new Date().toISOString(),timezone:'Europe/Kyiv',local_time:new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Kyiv',dateStyle:'short',timeStyle:'short'}).format(new Date()),current_author:{id:'501',name:'Гравець А'},current_topic:{id:'0'},participants:[{id:'501',name:'Гравець А'},{id:'502',name:'Оля'}],...item.context}),instructions:'Фіксована синтетична діагностика поведінки 1.11. Без зовнішніх дій і приватних даних. Сплануй природну відповідь у звичайному форматі behavior/reply/actions. Для чужої розмови за відсутності внеску мовчи. Уточнюй істотні прогалини; не вгадуй неоднозначне погодження.',search:false});
      const ok=item.expected==='bound'?plan.behavior?.reference_id===goal&&plan.behavior.relation==='answer_to_question'&&plan.behavior.move!=='clarify'&&plan.actions.some(a=>a.kind==='remind'||a.kind==='schedule'&&a.mode==='reminder'&&a.authorization==='explicit'):plan.behavior?.move===item.expected&&(item.expected!=='clarify'||Boolean(plan.behavior.clarification)&&!plan.actions.length)&&(item.expected!=='listen'||!plan.reply&&!plan.actions.length);
      results.push({case:item.id,ok,move:plan.behavior?.move,reference_bound:plan.behavior?.reference_id===goal,actions:plan.actions.map(a=>a.kind)});
    }
    console.log(JSON.stringify({event:'behavior_111_model_replay',model:config.model,synthetic:true,results}));
    if(results.some(r=>!r.ok))throw new Error('behavior_111_replay_failed');
    return {model:config.model,synthetic:true,private_data_used:false,cases:results};
  }
  async probeInteractions(){
    const runtime=await this.probeRuntime(),config=runtime?.engine.config||this.config;
    if(runtime){const {reserveModelCall}=await import('./model-budget.js');await reserveModelCall(runtime.db,config);}
    const brain=new OpenAIModel(config,this.auth,undefined,undefined,runtime?.db);
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
  private async suspendPrivatePurposes(actor:string,except?:ChatRuntime,purpose?:'inbox'|'calendar_setup'|'calendar_share'|'connector'){
    await this.registry.suspendPrivatePurposes(actor,except?.chat.chat_id,purpose);
  }
  async ingressScopes(update:Update,sql:SQL):Promise<string[]>{
    if(update.message_reaction)return [String(update.message_reaction.chat.id)];
    if(update.poll_answer||update.poll)return this.registry.ingressPollTargets(sql,update.poll_answer?.poll_id||update.poll!.id);
    const callback=update.callback_query,m=update.message||update.edited_message||callback?.message;
    if(m&&m.chat.type!=='private')return [String(m.chat.id)];
    if(update.my_chat_member)return [String(update.my_chat_member.chat.id)];
    if(!m)return [];
    const actor=String(callback?.from.id||m.from?.id||m.chat.id),data=callback?.data||'',text=m.text||'';
    let reference:PrivateIngressReference|undefined;
    const privateToken=/^lumen:pv:([a-f0-9]{24}):/.exec(data),calendarMode=/^calmode:([a-f0-9-]{36}):/.exec(data),calendarShare=/^calshare:([a-f0-9]{24}):/.exec(data),approval=/^lumen:(?:approve|reject):([a-f0-9-]{36})$/.exec(data),view=/^lm:([a-f0-9-]{36}):/.exec(data);
    if(privateToken)reference={kind:'inbox',id:privateToken[1]!};
    else if(calendarMode)reference={kind:'calendar_setup',id:calendarMode[1]!};
    else if(calendarShare)reference={kind:'calendar_share',id:calendarShare[1]!};
    else if(approval)reference={kind:'approval',id:approval[1]!};
    else if(view)reference={kind:'view',id:view[1]!};
    if(!callback){
      const link=/^\/start(?:@\w+)?\s+(calshare|calbook|cal|p|connect|oauth|approve)_([a-f0-9-]+)\s*$/.exec(text);
      if(link){const kinds={calshare:'calendar_share',calbook:'calendar_share',cal:'calendar_setup',p:'inbox',connect:'connector',oauth:'oauth',approve:'approval'} as const;reference={kind:kinds[link[1] as keyof typeof kinds],id:link[2]!};}
    }
    const target=reference||!callback?await this.registry.ingressPrivateTarget(sql,actor,reference):undefined;
    // Calendar sharing has a primary group purpose and a personal credential/
    // draft store. Guard both, but route the reply only to the primary target.
    if(target)return Array.from(new Set([target.chat.chat_id,...(target.kind==='calendar_share'?[actor]:[])]));
    return [String(m.chat.id)];
  }
  private async discardIngress(update:Update){
    const callback=update.callback_query,m=update.message||update.edited_message||callback?.message;
    if(callback)await this.telegram.call('answerCallbackQuery',{callback_query_id:callback.id}).catch(()=>{});
    if(m?.chat.type==='private'){const actor=String(callback?.from.id||m.from?.id||m.chat.id);await this.registry.consumePrivate(update.update_id,actor,'stale_ingress');}
  }
  async receive(update:Update){
    this.routing++;
    try{
      await withIngress(update,async()=>{
        const context=ingressOf(update);
        const source=update.message||update.edited_message,mayEnable=['member','administrator'].includes(update.my_chat_member?.new_chat_member.status||'')||Boolean(source&&source.chat.type!=='private'&&(source.new_chat_members?.some(user=>user.id===this.bot.id)||/^\/(?:start|bind)(?:@\w+)?\s+\S+/.test(source.text||'')));
        if(context&&await this.registry.ingressStale(context.scopes,context.enqueuedAt,mayEnable)){await this.discardIngress(update);return;}
        const privateMessage=update.message||update.edited_message,callback=update.callback_query;
        const actor=privateMessage?.chat.type==='private'?String(privateMessage.from?.id||''):callback?.message?.chat.type==='private'?String(callback.from.id):undefined;
        let chats:RegisteredChat[]|undefined;
        if(context&&(actor||update.poll_answer||update.poll)){
          chats=[];for(const id of actor?context.scopes.slice(0,1):context.scopes){const chat=await this.registry.find(id);if(chat?.enabled)chats.push(chat);}
        }else{
          const privateChoice=actor&&callback?.message?.chat.type==='private'&&String(callback.message.chat.id)===actor&&callback.message.from?.id===this.bot.id&&!callback.from.is_bot?/^lumen:pv:([a-f0-9]{24}):(task|anonymous|quote|reveal)$/.exec(callback.data||''):null;
          if(privateChoice){const target=await this.registry.privateTarget(actor!,{kind:'inbox',id:privateChoice[1]!});chats=target?[target.chat]:[];}
          else chats=update.poll_answer||update.poll?await this.registry.pollChats(update.poll_answer?.poll_id||update.poll!.id):actor?await this.registry.privateChats(actor):undefined;
        }
        if(chats)return this.scopedChats.run(chats,()=>this.route(update));
        return this.route(update);
      });
    }catch(error){if(!isIngressStale(error))throw error;await this.discardIngress(update);}
    finally{
      for(const runtime of this.runtimes.values())try{await this.refresh(runtime);}catch{this.sweepAt=0;}
      this.routing--;
      await this.evictIdle();
    }
  }
  private async route(update:Update){
    const reaction=update.message_reaction;
    if(reaction){
      if(!reaction.user||reaction.user.is_bot)return;
      const chat=await this.registry.find(String(reaction.chat.id));if(!chat?.enabled)return;
      const runtime=await this.runtime(chat);
      const target=await one(runtime.db,'SELECT telegram_id,user_id,author,body,role,topic_id FROM messages WHERE telegram_id=$1 ORDER BY id DESC LIMIT 1',[reaction.message_id]);
      if(!target)return; // Never invent the missing message or its topic/author.
      const details=reaction.new_reaction.map(x=>x.type==='emoji'?x.emoji:x.type==='custom_emoji'?'[власний емодзі]':'[інша реакція]').join(' ') || '[реакцію прибрано]';
      await runtime.engine.receive(routedUpdate(update,{update_id:update.update_id,message:{message_id:-update.update_id,date:reaction.date,chat:reaction.chat,from:reaction.user,text:`[Зміна реакції на повідомлення] ${details}`,message_thread_id:target.topic_id==='0'?undefined:Number(target.topic_id),reply_to_message:{message_id:reaction.message_id,from:{id:target.role==='assistant'?this.bot.id:Number(target.user_id),first_name:target.author,is_bot:target.role==='assistant'},text:target.body},lumen_event:{kind:'reaction',target_message_id:reaction.message_id,details}}}));return;
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
        if(voteEvent&&answer?.user){const details=answer.option_ids.map(i=>String(poll.options[i])).join(', ') || 'відкликав голос';await runtime.engine.receive(routedUpdate(update,{update_id:update.update_id,message:{message_id:-update.update_id,date:Math.floor(Date.now()/1000),chat:{id:Number(runtime.chat.chat_id),type:'supergroup'},from:answer.user,text:`[Голос в опитуванні «${poll.question}»] ${details}`,message_thread_id:poll.topic_id==='0'?undefined:Number(poll.topic_id),lumen_event:{kind:'poll_vote',target_message_id:Number(poll.message_id),details},...(poll.interaction_id?{lumen_interaction_event:{id:poll.interaction_id,version:Number(poll.interaction_version),action:answer.option_ids.length?String(answer.option_ids[0]):'wait'}}:{})}}));}
        return;
      }return;
    }
    const cb=update.callback_query;
    if(cb){
      // Acknowledge immediately, including stale or unrecognized buttons.
      await this.telegram.call('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
      if(cb.message?.chat.type==='private'&&String(cb.message.chat.id)===String(cb.from.id)&&cb.message.from?.id===this.bot.id&&!cb.from.is_bot&&cb.data?.startsWith('lumen:pv:')){if(!await this.registry.consumePrivate(update.update_id,String(cb.from.id),'private_choice'))return;for(const r of await this.active())if(await new PrivateInbox(r.db,this.config.runtimeDir).choose(cb,this.telegram)){await this.suspendPrivatePurposes(String(cb.from.id),r,'inbox');return;}return;}
      if(cb.message?.from?.id===this.bot.id&&!cb.from.is_bot){
        if(cb.message.chat.type==='private'&&String(cb.message.chat.id)===String(cb.from.id)&&/^(?:calmode|calshare):/.test(cb.data||'')){
          for(const r of await this.active()){
            const handled=cb.data!.startsWith('calmode:')?await r.agent.tools.evolution.calendar.privateCallback(cb,this.telegram):await r.agent.tools.evolution.groupCalendar.privateCallback(cb,this.telegram);
            if(handled){await this.suspendPrivatePurposes(String(cb.from.id),r,cb.data!.startsWith('calmode:')?'calendar_setup':'calendar_share');return;}
          }return;
        }
        if(cb.data?.startsWith('lm:')){if(cb.message.chat.type==='private'){for(const r of await this.active())if(await r.agent.tools.evolution.browser.callback(cb,this.telegram))return;return;}const registered=await this.registry.find(String(cb.message.chat.id));if(registered?.enabled)await (await this.runtime(registered)).agent.tools.evolution.browser.callback(cb,this.telegram);return;}
      }
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
        if(interactive){await runtime.engine.receive(routedUpdate(update,{update_id:update.update_id,message:{message_id:-update.update_id,date:Math.floor(Date.now()/1000),from:cb.from,chat:cb.message.chat,message_thread_id:cb.message.message_thread_id,text:'[Вибір у поточному кроці]',lumen_interaction_event:{id:interactive[1]!,version:Number(interactive[2]),action:interactive[3]!}}}));return;}
        await runtime.db.tx(sql=>queueResultView(sql,{panelId:panel![1]!,index:Number(panel![2]),actorId:String(cb.from.id),topicId:String(cb.message!.message_thread_id||0),callbackId:cb.id,updateId:update.update_id}));return;
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
        await runtime.engine.receive(routedUpdate(update,{update_id:update.update_id,message:{message_id:-update.update_id,chat:cb.message.chat,date:Math.floor(Date.now()/1000),from:cb.from,text:choice.label,message_thread_id:cb.message.message_thread_id,reply_to_message:cb.message,lumen_choice:{menu_id:menu,question:choice.question || cb.message.text || '',audience:choice.audience,selected:votes.rows as {user_id:string;name:string;label:string}[]}}}));return;
      }
      const administrator=String(cb.from.id)===registered.owner_id || await this.admin(registered.chat_id,String(cb.from.id));
      await runtime.engine.receive(routedUpdate(update,{update_id:update.update_id,message:{message_id:cb.message.message_id,chat:cb.message.chat,date:Math.floor(Date.now()/1000),from:cb.from,text:command!,message_thread_id:cb.message.message_thread_id}}),administrator);
      return;
    }
    const member=update.my_chat_member;
    if(member){
      if(!['group','supergroup'].includes(member.chat.type))return;
      const id=String(member.chat.id),status=member.new_chat_member.status;
      const prior=await this.registry.find(id);
      if(['left','kicked'].includes(status)){
        if(prior?.enabled){const runtime=await this.runtime(prior);runtime.chat={...prior,enabled:false};cancelOperations(runtime.db);await drainOperations(runtime.db);await runtime.db.tx(async sql=>{
          await sql.query("UPDATE app_state SET paused=true,memory_revision=memory_revision+1 WHERE id=1");
          await sql.query('DELETE FROM inbox');await sql.query('DELETE FROM choices');await sql.query('DELETE FROM pending_intents');await sql.query('DELETE FROM dialogues');await sql.query('DELETE FROM image_jobs');await sql.query("DELETE FROM outbox WHERE status<>'sent'");
          await sql.query("UPDATE reminders SET status='pending' WHERE status='queued'");
        });await this.registry.disable(id);this.work.delete(id);}return;
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
      if(/^\/start(?:@\w+)?\s+(?:calshare|calbook)_/.test(text)){
        for(const r of await this.active())if(await r.agent.tools.evolution.groupCalendar.privateOpen(m,this.telegram)){await this.suspendPrivatePurposes(uid);return;}
        await this.telegram.text(chatId,'Цей запит календаря недоступний або призначений іншій людині.');return;
      }
      for(const r of await this.active())if(await r.agent.tools.evolution.calendar.privateSetup(m,this.telegram,()=>this.registry.consumePrivate(update.update_id,uid,'calendar_secret'))){if(/^\/start(?:@\w+)?\s+cal_/.test(text))await this.suspendPrivatePurposes(uid,r,'calendar_setup');return;}
      for(const r of await this.active()){
        const manual=await one(r.db,"SELECT token FROM calendar_shares WHERE actor_id=$1 AND status='manual_input' LIMIT 1",[uid]);
        if(manual){if(!await this.registry.consumePrivate(update.update_id,uid,'calendar_availability'))return;if(await r.agent.tools.evolution.groupCalendar.privateMessage(m,this.telegram))return;}
      }
      const approveLink=/^\/start(?:@\w+)?\s+approve_([0-9a-f-]{36})$/.exec(text);if(approveLink){for(const r of await this.active()){const s=await state(r.db);if(s.paused)continue;const a=await one(r.db,"SELECT id,summary FROM tool_approvals WHERE id=$1 AND actor_id=$2 AND audience='private' AND revision=$3 AND status='pending' AND expires_at>now()",[approveLink[1],uid,s.memory_revision]);if(a){await this.telegram.text(chatId,'Підготував конкретний крок. Перевір параметри:\n'+a.summary,{replyMarkup:{inline_keyboard:[[{text:'Підтвердити',callback_data:'lumen:approve:'+a.id},{text:'Скасувати',callback_data:'lumen:reject:'+a.id}]]}});return;}}await this.telegram.text(chatId,'Підтвердження недоступне або прострочене.');return;}
      const oauth=/^\/start(?:@\w+)?\s+oauth_([0-9a-f-]{36})$/.exec(text);if(oauth){for(const r of await this.active())try{if(await new OAuthDevices(r.db,this.config.runtimeDir).begin(oauth[1]!,uid,this.telegram)){await this.suspendPrivatePurposes(uid);return;}}catch(e:any){if(isIngressStale(e))throw e;await this.telegram.text(chatId,'Авторизацію не розпочато: '+(/^[a-z_]+$/.test(e.code||'')?e.code:'провайдер недоступний')+'. Потрібен сервіс із підтримкою Device Flow та зареєстрований client ID.');return;}await this.telegram.text(chatId,'Посилання авторизації недоступне або прострочене.');return;}
      const personal=/^\/start(?:@\w+)?\s+p_([a-f0-9]{24})$/.exec(text);
      if(personal){for(const r of await this.active())if(await new PrivateInbox(r.db,this.config.runtimeDir).open(personal[1]!,uid,this.telegram)){await this.suspendPrivatePurposes(uid);return;}await this.telegram.text(chatId,'Особистий запит недоступний або прострочений.');return;}
      const connect=/^\/start(?:@\w+)?\s+connect_([0-9a-f-]{36})$/.exec(text);
      if(connect){
        for(const r of await this.active()){
          const request=await one(r.db,"UPDATE connection_setups SET status='awaiting_token' WHERE id=$1 AND actor_id=$2 AND expires_at>now() AND status IN ('pending','awaiting_token') RETURNING name,endpoint",[connect[1],uid]);
          if(request){await this.suspendPrivatePurposes(uid,r,'connector');await this.telegram.text(chatId,`Особисте підключення «${request.name}»\nСервер: ${request.endpoint}\n\nНадішли токен доступу одним повідомленням, або - для публічного сервера без токена. Він буде зашифрований і не потрапить у групу чи запит моделі. /cancel скасовує налаштування.`);return;}
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
      for(const r of await this.active()){const inbox=new PrivateInbox(r.db,this.config.runtimeDir);const pending=await inbox.pending(uid);if(!pending)continue;if(!await this.registry.consumePrivate(update.update_id,uid,'purpose_bound_answer'))return;try{const result=await inbox.answer(pending,m,async(request,answer,ref)=>{if(request.payload.decision_id)await new Decisions(r.db,this.config.runtimeDir).ballot(request,answer,ref);if(request.payload.coordinator_key)await new Coordinator(r.db,this.config.runtimeDir).savePreference(request,answer);if(request.session_id)await new SessionEngine(r.db,this.config.runtimeDir).privateMove(request,answer,ref);});await this.telegram.text(chatId,result.clarification?result.clarification:result.cancelled?'Особистий запит скасовано.':'Відповідь збережено з обраними тобою умовами використання.');}catch(e:any){if(isIngressStale(e))throw e;await this.telegram.text(chatId,'Не прийняв відповідь: '+(/^[a-z_]+$/.test(e.code||'')?e.code:'перевір формат')+'. Спробуй ще раз або /cancel.');}return;}
      if(ingressContext()&&ingressContext()!.scopes[0]!==chatId){await this.registry.consumePrivate(update.update_id,uid,'purpose_unavailable');return;}
      if(looksLikeCredential(text)){await this.telegram.text(chatId,'Це схоже на секрет доступу. Не передаю його моделі й не записую в розмову. Для підключення відкрий відповідний особистий майстер налаштування.');try{await this.telegram.call('deleteMessage',{chat_id:chatId,message_id:m.message_id});}catch{}return;}
      if(!/^\/(?:start|id|help)(?:@\w+)?(?:\s|$)/i.test(text)){let permitted=await this.owner(uid);if(!permitted)permitted=(await this.registry.memberChats(uid)).some(chat=>Number(chat.chat_id)<0);if(!permitted){await this.telegram.text(chatId,'Особистий діалог доступний учасникам підключених груп. Спершу напиши в такій групі або відкрий особистий запит Люмена.');return;}const chat=await this.registry.ensure(chatId,uid,'Особистий чат');const r=await this.runtime(chat);await r.db.query("UPDATE app_state SET mention_only=false WHERE id=1");await r.engine.receive(update,true);return;}
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
      const runtime=await this.initializing.get(chatId)||this.runtimes.get(chatId),newId=String(m.migrate_to_chat_id);
      if(runtime){runtime.chat={...runtime.chat,enabled:false};await drainOperations(runtime.db);}
      await this.registry.migrateChat(chatId,newId);
      this.runtimes.delete(chatId);this.work.delete(chatId);this.workEpoch.delete(chatId);this.maintenanceAfter.delete(chatId);
      const use=this.uses.get(chatId),localizer=this.localizers.get(chatId);this.uses.delete(chatId);this.localizers.delete(chatId);
      const migrated=await this.registry.find(newId);
      if(migrated?.enabled){
        if(runtime){runtime.chat=migrated;this.runtimes.set(newId,runtime);this.uses.set(newId,use||{lastUsed:this.policy.now(),leases:0});if(localizer)this.localizers.set(newId,localizer);await setCalendarOwnerResolver(runtime.db,async actor=>{const personal=await this.registry.ensure(actor,actor,'Особистий чат');return (await this.runtime(personal)).agent.tools.evolution.calendar;});await this.refresh(runtime);}
        else await this.runtime(migrated);
      }
      return;
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
