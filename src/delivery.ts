import {MediaAssets,assetFor} from './media-assets.js';
import {detachDeliveredText} from './storage-lifecycle.js';
import {digest} from './evolution-core.js';
import {queueInteraction} from './interactions.js';
import {ToolError} from './safe-http.js';
import {readResultView} from './result-views.js';
import {reserveEffect,claimEffect,observeEffect} from './commitments.js';
import {PrivateResults} from './private-results.js';
import {transferProvenance} from './provenance.js';
import { state, one, queueText, type Database, type SQL } from './db.js';
import { Telegram, TelegramError,telegramRepairHint } from './telegram.js';
import {transportThread} from './topic-scope.js';
import { Media } from './media.js';
import type { Config } from './config.js';
import { errorCode } from './engine.js';
import {ambientStillRelevant,recordDeliveredContribution,unsolicitedBudgetAvailable} from './attention.js';
import {activityFor} from './activity-status.js';
import {resolveTaskAudience} from './task-journal.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {inspectAlbumPdf} from './media-pdf.js';
import {resolveMediaAudioExpectation,verifiedOriginalAudio} from './media-expectation.js';
import {recordIncident,describeFailure,type IncidentReceipt} from './incidents.js';
import {storedSourceId} from './request-context.js';

export class Delivery {
  constructor(private db:Database,private telegram:Telegram,private config:Config,private media=new Media(config,undefined,db)){}
  private async stopMediaPublication(sql:SQL,row:Record<string,any>,status='revoked'){
    if(row.kind==='media_asset')await sql.query("UPDATE media_publications SET status=$1 WHERE id=$2 AND actor_id=$3 AND asset_id=$4 AND status='queued'",[status,row.body.publicationId,row.actor_id,row.body.id]);
  }
  private async checkMediaJob(row:Record<string,any>,sql:SQL=this.db,outputData?:{asset:Record<string,any>;bytes:Uint8Array}){
    if(!row.body.mediaJobId)return;
    const live=await state(sql);if(live.paused||live.memory_revision!==row.revision)throw new ToolError('outbound_cancelled');
    const job=await one(sql,'SELECT * FROM media_jobs WHERE id=$1',[row.body.mediaJobId]);
    if(!job||job.status!=='ready'||job.stage!=='verified')throw new ToolError('media_delivery_not_ready');
    if(job.output_id!==row.body.id||job.revision!==row.revision)throw new ToolError('media_delivery_output_changed');
    if(row.body.mediaKind!==undefined&&row.body.mediaKind!==job.kind)throw new ToolError('media_delivery_not_verified');
    if(job.actor_id!==String(row.actor_id)||job.audience!==row.audience||job.audience!==row.body.audience||job.topic_id!==row.scopeTopicId||row.body.destination_id)throw new ToolError('media_delivery_scope_changed');
    if((job.task_id||null)!==(row.body.taskId||null)||(job.goal_version||null)!==(row.body.goalVersion||null))throw new ToolError('media_delivery_task_changed');
    if((job.action_id||null)!==(row.body.actionId||null))throw new ToolError('media_delivery_action_changed');
    if(job.action_id){const action=await one(sql,'SELECT actor_id,topic_id,revision,phase,expires_at FROM commitments WHERE id=$1',[job.action_id]);if(!action||action.actor_id!==job.actor_id||action.topic_id!==job.topic_id||action.revision!==job.revision||!['runnable','executing','delivering'].includes(action.phase)||new Date(action.expires_at).getTime()<=Date.now())throw new ToolError('outbound_cancelled');}
    if(job.task_id){const task=await one(sql,'SELECT id,actor_id,topic_id,revision,status,goal_version,audience FROM agent_tasks WHERE id=$1',[job.task_id]);if(!task||task.actor_id!==job.actor_id||task.topic_id!==job.topic_id||task.revision!==row.revision||task.goal_version!==job.goal_version||['cancelled','paused','completed','failed'].includes(task.status))throw new ToolError('media_delivery_task_changed');if(await resolveTaskAudience(sql,task,String(live.chat_id))!==job.audience)throw new ToolError('media_delivery_scope_changed');}
    const member=await one(sql,'SELECT active FROM members WHERE user_id=$1',[job.actor_id]);if(member?.active===false||!member&&live.owner_id!==job.actor_id&&!(live.participants||[]).some((p:any)=>String(p.id)===job.actor_id))throw new ToolError('media_delivery_scope_changed');
    const resource=job.kind==='story'?await one(sql,'SELECT version,audience,owner_id FROM studio_projects WHERE id=$1',[job.resource_id]):job.kind==='album'?await one(sql,'SELECT version,audience,owner_id FROM archive_collections WHERE id=$1',[job.resource_id]):undefined;
    if(!resource||resource.version!==job.resource_version||resource.audience!==job.audience||resource.audience==='private'&&resource.owner_id!==job.actor_id||job.manifest.resource_id!==job.resource_id||job.manifest.version!==job.resource_version||job.manifest.audience!==job.audience||digest(job.manifest)!==job.manifest_hash)throw new ToolError('media_delivery_resource_changed');
    const inputs=(await sql.query('SELECT asset_id,asset_version FROM media_job_inputs WHERE job_id=$1',[job.id])).rows;
    const expected=new Map<string,number>();
    for(const input of [...(Array.isArray(job.manifest.items)?job.manifest.items:[]),...(job.manifest.soundtrack?[job.manifest.soundtrack]:[])]){
      if(!input.asset_id||!Number.isInteger(input.asset_version)||expected.has(input.asset_id)&&expected.get(input.asset_id)!==input.asset_version)throw new ToolError('media_delivery_source_changed');
      expected.set(input.asset_id,input.asset_version);
    }
    if(!expected.size||inputs.length!==expected.size||inputs.some(input=>expected.get(input.asset_id)!==input.asset_version))throw new ToolError('media_delivery_source_changed');
    const context={actorId:job.actor_id,chatId:String(live.chat_id),topicId:job.topic_id,revision:row.revision,updateId:row.dedup_key,requested:true,audience:job.audience as 'group'|'private'};
    const sourceAssets=new Map<string,Record<string,any>>();
    for(const input of inputs)try{sourceAssets.set(input.asset_id,await assetFor(sql,input.asset_id,input.asset_version,context));}catch{throw new ToolError('media_delivery_source_changed');}
    const proof=job.verification;
    if(job.kind==='album'){
      const output=await assetFor(sql,job.output_id,row.body.version,context),pdf=proof?.pdf;
      if(job.manifest.kind!=='album'||job.manifest.soundtrack||job.manifest.require_audio||output.mime!=='application/pdf'||!/^[a-f0-9]{64}$/.test(row.body.sha256||'')||output.sha256!==row.body.sha256||!pdf||pdf.decoded!==true||pdf.attachments_verified!==true||!Number.isSafeInteger(pdf.pages)||pdf.pages<=0||pdf.pages<job.manifest.items.length)throw new ToolError('media_delivery_not_verified');
      const originals=new Map([...sourceAssets].filter(([,asset])=>!String(asset.mime).startsWith('image/')));
      if(!Array.isArray(pdf.attachments)||pdf.attachments.length<originals.size||new Set(pdf.attachments.map((attachment:any)=>attachment?.asset_id)).size!==originals.size||pdf.attachments.some((attachment:any)=>{const asset=originals.get(attachment?.asset_id);return !asset||attachment.asset_version!==asset.version||typeof attachment.name!=='string'||!attachment.name||attachment.sha256!==asset.sha256||attachment.bytes!==Number(asset.bytes);}))throw new ToolError('media_delivery_not_verified');
      if(outputData){
        if(outputData.asset.id!==output.id||outputData.asset.version!==output.version||outputData.asset.mime!=='application/pdf'||digest(outputData.bytes)!==output.sha256)throw new ToolError('media_delivery_output_changed');
        try{const decoded=await inspectAlbumPdf(outputData.bytes),attachments=(entries:any[])=>entries.map(entry=>[entry.name,entry.sha256,entry.bytes]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));if(decoded.pages!==pdf.pages||digest(attachments(decoded.attachments))!==digest(attachments(pdf.attachments)))throw new Error('album_contents_changed');}catch{throw new ToolError('media_delivery_not_verified');}
      }
    }else{
      const sourceId=storedSourceId(job.source_message_id);if(job.source_message_id!==null&&job.source_message_id!==undefined&&sourceId===undefined)throw new ToolError('request_source_invalid');
      const expectation=await resolveMediaAudioExpectation(sql,{...context,sourceId,taskId:job.task_id||undefined,goalVersion:job.goal_version||undefined,actionId:job.action_id||undefined,resourceId:job.resource_id},job.manifest.audio_expectation);
      const audioRequired=Boolean(job.manifest.require_audio||expectation.required),sourceIds=(ids:unknown)=>Array.isArray(ids)&&ids.every(id=>Number.isSafeInteger(id)&&Number(id)>0)?[...new Set(ids)].sort((a,b)=>Number(a)-Number(b)):null;
      const original=expectation.audio_source==='original';let originalVerified=false;
      if(original&&verifiedOriginalAudio(job.manifest,proof,[...sourceAssets.values()].map(asset=>({id:String(asset.id),version:Number(asset.version),mime:String(asset.mime),sha256:String(asset.sha256),status:String(asset.status)})))){
        const output=await assetFor(sql,job.output_id,row.body.version,context);
        originalVerified=output.mime==='video/mp4'&&output.sha256===row.body.sha256&&proof.output_sha256===output.sha256&&Number.isSafeInteger(proof.output_bytes)&&proof.output_bytes===Number(output.bytes)&&(!outputData||outputData.asset.id===output.id&&outputData.asset.version===output.version&&outputData.asset.mime==='video/mp4'&&digest(outputData.bytes)===output.sha256&&outputData.bytes.length===proof.output_bytes);
      }
      if(job.kind!=='story'||!proof||!Number.isFinite(proof.expected_duration)||proof.expected_duration<=0||proof.video?.decoded!==true||proof.video.codec!=='h264'||proof.has_soundtrack!==Boolean(job.manifest.soundtrack)||audioRequired&&(original?!originalVerified:!job.manifest.soundtrack)||job.manifest.audio_source==='original'&&!original||expectation.mode==='silent'&&(job.manifest.soundtrack||proof.has_original_audio===true)||job.manifest.soundtrack&&(proof.audio?.decoded!==true||proof.audio?.non_silent!==true||proof.audio?.codec!=='aac')||job.manifest.audio_expectation&&(proof.audio_required!==audioRequired||digest(sourceIds(proof.audio_source_ids))!==digest(sourceIds(expectation.source_ids))))throw new ToolError('media_delivery_not_verified');
    }
  }
  private async mediaDeliveryNotice(row:Record<string,any>,status:string,code:string,incident?:IncidentReceipt){
    await this.db.tx(async sql=>{
      const live=await state(sql,true);if(live.paused||live.memory_revision!==row.revision)return;
      const member=await one(sql,'SELECT active FROM members WHERE user_id=$1',[row.actor_id]);if(member?.active===false||!member&&live.owner_id!==row.actor_id&&!(live.participants||[]).some((p:any)=>String(p.id)===row.actor_id))return;
      if(row.source_message_id&&!await one(sql,'SELECT id FROM messages WHERE id=$1',[row.source_message_id]))return;
      const job=row.body.mediaJobId?await one(sql,'SELECT kind,actor_id,audience,topic_id,task_id,goal_version FROM media_jobs WHERE id=$1',[row.body.mediaJobId]):undefined;
      if(row.body.mediaJobId&&(!job||job.actor_id!==row.actor_id||job.topic_id!==row.scopeTopicId))return;
      if(job?.task_id){const task=await one(sql,'SELECT goal_version,status FROM agent_tasks WHERE id=$1',[job.task_id]);if(!task||task.goal_version!==job.goal_version||['cancelled','paused','completed'].includes(task.status))return;}
      const album=job?.kind==='album',story=job?.kind==='story',subject=album?'альбом':story?'відео':'файл',genitive=album?'альбому':story?'відео':'файла';
      const explanations:Record<string,string>={media_delivery_not_ready:album?'Альбом ще не має готового перевіреного PDF.':story?'Монтаж ще не має готового перевіреного файла.':'Матеріал ще не має готового перевіреного файла.',media_delivery_not_verified:album?'Перевірка готового PDF та вкладень не підтверджена.':story?'Перевірка готового відео або звуку не підтверджена.':'Перевірка готового файла не підтверджена.',media_delivery_output_changed:'Готовий файл змінився після підготовки відправки.',media_delivery_resource_changed:album?'Склад альбому вже змінився; попередній варіант зупинено.':'Склад матеріалу вже змінився; попередній варіант зупинено.',media_delivery_source_changed:'Один із вихідних матеріалів змінився або його доступ відкликано.',media_delivery_scope_changed:'Дозвіл або аудиторія матеріалу змінилися.',media_delivery_task_changed:'Доручення вже змінено або зупинено.',asset_unavailable:'Файл уже недоступний або дозвіл на нього відкликано.',asset_bytes_unavailable:'Не вдалося прочитати збережений файл.',asset_checksum_mismatch:'Збережений файл не пройшов перевірку цілісності.',publication_source_changed:'Версія файла змінилася після підготовки відправки.',publication_permission_revoked:'Дозвіл на публікацію в каналі відкликано.',channel_publish_rights_changed:'У автора або бота більше немає потрібних прав у каналі.',publication_manifest_changed:'Параметри відправки змінилися; потрібне нове підтвердження.',publication_revoked:'Відправку цього файла відкликано.',telegram_403:'Telegram не дозволив надіслати файл у цей чат.',telegram_400:'Telegram відхилив файл або параметри відправки.',telegram_413:'Telegram відхилив файл через його розмір.'};
      const cause=explanations[code]||describeFailure(code);
      const text=(status==='uncertain'?`Telegram не підтвердив доставку ${genitive}. Можливо, він уже надійшов. ${cause} Перевір чат; автоматично не надсилаю повторно, щоб не створити дубль.`:`Не вдалося надіслати ${subject}. ${cause} Можна перевірити стан у матеріалах.`)+(incident?`\nКод для розробників: ${incident.code}. Передай його розробникам для перевірки.`:'');
      const asset=await one(sql,'SELECT audience,owner_id FROM media_assets WHERE id=$1',[row.body.id]);
      const privateInput=job&&await one(sql,"SELECT 1 FROM media_job_inputs i JOIN media_assets a ON a.id=i.asset_id WHERE i.job_id=$1 AND a.audience='private' LIMIT 1",[row.body.mediaJobId]);
      const audience=row.audience==='private'||job?.audience==='private'||asset?.audience==='private'||privateInput?'private':'group';
      const sources=(await sql.query("SELECT source_message_id FROM provenance_edges WHERE derived_kind='outbox' AND derived_key=$1",[String(row.id)])).rows.map(x=>Number(x.source_message_id));
      await queueText(sql,text,live.memory_revision,'media-delivery-error:'+row.id,false,{actorId:row.actor_id,audience,threadId:audience==='private'?undefined:Number(row.scopeTopicId)||undefined,sourceMessageId:row.source_message_id||undefined,sourceIds:sources,outputLanguage:row.body.outputLanguage});
    });
  }
  private async native(row:Record<string,any>){
    const b=row.body,base={chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:row.body.outputLanguage,...(b.threadId?{message_thread_id:b.threadId}:{})};
    if(b.operation==='send_album'){const sent=await this.telegram.call<any[]>('sendMediaGroup',{...base,media:b.files.map((f:any,i:number)=>({type:'photo',media:f.file_id,...(i===0&&b.caption?{caption:b.caption}:{})}))});if(sent.length!==b.files.length)throw Object.assign(new TelegramError('telegram_partial_album',0,true),{partialMessageIds:sent.map(x=>x.message_id).filter(Number.isSafeInteger)});return {...sent[0],message_ids:sent.map(x=>x.message_id)};}
    if(b.operation==='send_file')return this.telegram.call('sendDocument',{...base,document:b.files[0].file_id,caption:b.caption || ''});
    if(b.operation==='send_animation')return this.telegram.call('sendAnimation',{...base,animation:b.files[0].file_id,caption:b.caption || ''});
    if(b.operation==='send_sticker')return this.telegram.call('sendSticker',{...base,sticker:b.files[0].file_id});
    if(b.operation==='send_location')return this.telegram.call('sendLocation',{...base,latitude:b.latitude,longitude:b.longitude});
    if(b.operation==='edit_message')await this.telegram.call('editMessageText',{chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:row.body.outputLanguage,message_id:b.message_id,text:b.text,link_preview_options:{is_disabled:true}});
    else if(b.operation==='pin_message')await this.telegram.call('pinChatMessage',{chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:row.body.outputLanguage,message_id:b.message_id,disable_notification:true});
    else if(b.operation==='unpin_message')await this.telegram.call('unpinChatMessage',{chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:row.body.outputLanguage,message_id:b.message_id});
    else if(b.operation==='stop_poll')await this.telegram.call('stopPoll',{chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:row.body.outputLanguage,message_id:b.message_id});
    else throw Error('unknown_native_operation');
    return {message_id:b.message_id};
  }
  async next(lane?:'text'|'media'){
    const row=await this.db.tx<Record<string,any>|null>(async sql=>{
      const s=await state(sql,true);
      const row=await one(sql,`SELECT * FROM outbox WHERE status='pending' AND available_at<=now() ${lane?"AND kind "+(lane==='text'?'NOT IN':'IN')+" ('artifact','voice','image','animation','private_result','media_asset')":""} ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if(!row || !s.chat_id)return null;
      if(row.revision!==s.memory_revision || (s.paused && !row.service)){
        await this.stopMediaPublication(sql,row);await sql.query("DELETE FROM outbox WHERE id=$1",[row.id]);return null;
      }
      if(row.dedup_key.startsWith('signals:')){const ids=row.dedup_key.slice(8).split(':').filter((id:string)=>/^[a-f0-9-]{36}$/.test(id));const signals=(await sql.query("SELECT g.* FROM signals g LEFT JOIN projects p ON p.id=g.project_id WHERE g.id=ANY($1::uuid[]) AND g.status='queued' AND g.expires_at>now() AND (g.project_id IS NULL OR p.status='active')",[ids])).rows;const prefs=await one(sql,'SELECT * FROM proactivity_preferences WHERE user_id=$1',[row.actor_id]);if(!signals.length||prefs?.enabled===false||(prefs?.muted_topics||[]).includes(String(row.body.threadId||0))){await sql.query("UPDATE outbox SET status='cleared' WHERE id=$1",[row.id]);return null;}const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:this.config.timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date()));const quiet=s.quiet_start!==s.quiet_end&&(s.quiet_start<s.quiet_end?hour>=s.quiet_start&&hour<s.quiet_end:hour>=s.quiet_start||hour<s.quiet_end);if(quiet||prefs?.snoozed_until&&new Date(prefs.snoozed_until).getTime()>Date.now()){await sql.query("UPDATE outbox SET available_at=now()+interval '5 minutes' WHERE id=$1",[row.id]);return null;}row.body.text=signals.map(x=>`${x.title}\n${x.body}\nЧому зараз: ${x.reason}`).join('\n\n').slice(0,3400);}
      if(row.kind==='interaction'){const v=await one(sql,'SELECT phase,version,card_hash,card_seq FROM interactions WHERE id=$1',[row.body.id]);if(!v||v.version!==row.body.version||v.card_hash!==row.body.hash||v.card_seq!==row.body.seq){await sql.query("UPDATE outbox SET status='cleared' WHERE id=$1",[row.id]);return null;}}
      if(row.body.compositionId){const owner=await one(sql,'SELECT phase,revision,deadline FROM composition_runs WHERE id=$1',[row.body.compositionId]);if(!owner||!['running','delivering'].includes(owner.phase)||owner.revision!==row.revision||new Date(owner.deadline).getTime()<=Date.now()){await sql.query("UPDATE outbox SET status='cleared',error_code='composition_unavailable' WHERE id=$1",[row.id]);return null;}}
      if(row.body.taskId&&row.body.goalVersion){const task=await one(sql,'SELECT id,actor_id,topic_id,goal_version,status,progress_hash,audience FROM agent_tasks WHERE id=$1',[row.body.taskId]);if(!task||task.actor_id!==row.actor_id||task.goal_version!==row.body.goalVersion||row.kind!=='task_status'&&['cancelled','paused'].includes(task.status)||row.kind==='task_status'&&(row.body.status!==task.status||row.body.hash!==task.progress_hash)){await this.stopMediaPublication(sql,row);await sql.query('DELETE FROM outbox WHERE id=$1',[row.id]);return null;}if(row.kind!=='media_asset'&&await resolveTaskAudience(sql,task,String(s.chat_id))==='private')row.audience='private';}
      if(row.body.ambient){
        const source=await one(sql,'SELECT telegram_id,user_id,author,created_at,topic_id FROM messages WHERE id=$1',[row.source_message_id]);
        if(!source||!await ambientStillRelevant(sql,{message_id:Number(source.telegram_id),date:Math.floor(new Date(source.created_at).getTime()/1000),from:{id:Number(source.user_id),first_name:source.author},chat:{id:Number(s.chat_id),type:'supergroup'},message_thread_id:source.topic_id==='0'?undefined:Number(source.topic_id)},Number(row.source_message_id),s,this.config.timezone,true)){
          await sql.query("DELETE FROM outbox WHERE source_message_id=$1 AND body->>'ambient'='true' AND status='pending'",[row.source_message_id]);return null;
        }
        if(!await unsolicitedBudgetAvailable(sql,Number(row.source_message_id))){await sql.query("UPDATE outbox SET status='cleared',error_code='ambient_budget_exhausted' WHERE id=$1",[row.id]);return null;}
      }
      if(row.audience==='private'&&!/^\d+$/.test(row.actor_id||'')){await sql.query("UPDATE outbox SET status='failed',error_code='private_recipient_required' WHERE id=$1",[row.id]);return null;}
      const sourceScope=row.audience==='private'&&row.body.scopeTopicId===undefined&&row.body.threadId===undefined&&row.source_message_id?await one(sql,'SELECT topic_id FROM messages WHERE id=$1',[row.source_message_id]):undefined;
      try{row.scopeTopicId=String(transportThread(row.body.scopeTopicId??row.body.threadId??sourceScope?.topic_id??0)??0);}
      catch{await sql.query("UPDATE outbox SET status='failed',error_code='telegram_topic_invalid' WHERE id=$1",[row.id]);return null;}
      row.body.scopeTopicId=row.scopeTopicId;
      if(row.audience==='private')delete row.body.threadId;
      // Reject a mismatched job owner before an outbox effect can claim or alter
      // an unrelated action. Full source/output checks follow before upload.
      if(row.kind==='media_asset'&&row.body.mediaJobId){const job=await one(sql,'SELECT actor_id,topic_id,audience,action_id FROM media_jobs WHERE id=$1',[row.body.mediaJobId]);if(!job||job.actor_id!==row.actor_id||job.topic_id!==row.scopeTopicId||job.audience!==row.audience||row.audience!=='private'&&String(row.body.threadId||0)!==row.scopeTopicId||(job.action_id||null)!==(row.body.actionId||null)){await this.stopMediaPublication(sql,row);await sql.query("UPDATE outbox SET status='cleared',error_code='media_delivery_scope_changed' WHERE id=$1",[row.id]);return null;}}
      // Logical scope is receipt metadata. Exclude it from the existing effect
      // argument hash so pending pre-upgrade operations keep their identity.
      const {generated,scopeTopicId,incidentCode,...operationBody}=row.body;
      try{
      const existing=await one(sql,'SELECT topic_id FROM effect_operations WHERE operation_key=$1',['outbox:'+row.dedup_key]);
      const operation=await reserveEffect(sql,{key:'outbox:'+row.dedup_key,arguments:{kind:row.kind,body:operationBody},actorId:row.actor_id||'system',topicId:existing?.topic_id??row.scopeTopicId,revision:row.revision,sourceId:row.source_message_id||undefined,actionId:row.body.actionId});
      const claim=await claimEffect(sql,operation.id,row.revision,Boolean(row.service));
      if(claim.cached){await sql.query("UPDATE outbox SET status='sent',telegram_id=$1 WHERE id=$2",[claim.result?.message_id||null,row.id]);return null;}
      await sql.query("UPDATE outbox SET status='sending',attempts=attempts+1,operation_id=$2,body=$3,audience=$4 WHERE id=$1",[row.id,operation.id,JSON.stringify(row.body),row.audience]);return {...row,operation_id:operation.id,chatId:row.audience==='private'?row.actor_id:s.chat_id,sourceChatId:String(s.chat_id)};
      }catch(e){if(!(e instanceof ToolError))throw e;await this.stopMediaPublication(sql,row,/uncertain/.test(e.code)?'uncertain':'revoked');await sql.query("UPDATE outbox SET status=$1,error_code=$2 WHERE id=$3",[/uncertain/.test(e.code)?'uncertain':'cleared',e.code,row.id]);return null;}
    });
    if(!row)return false;
    try{
      let bytes:Buffer|undefined;
      let deliveredOutput:{id:string;sha256:string;bytes:number;mime:string;version?:number;revision:number}|undefined;
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
      if(row.body.actionId)await this.db.tx(async sql=>{const owner=await one(sql,'SELECT phase,revision,expires_at FROM commitments WHERE id=$1',[row.body.actionId]);if(!owner||!['executing','runnable','delivering'].includes(owner.phase)||owner.revision!==row.revision||new Date(owner.expires_at).getTime()<=Date.now())throw new ToolError('outbound_cancelled');});
      const progress=/^(progress:|task-progress:)/.test(row.dedup_key);
      if(current.paused)await activityFor(this.db,this.telegram).stopAll();
      if(!progress&&row.source_message_id)await activityFor(this.db,this.telegram).stopSource(Number(row.source_message_id));
      let sent:{message_id:number;message_ids?:number[]};
      if(row.kind==='interaction'){
        const v=await one(this.db,'SELECT card_message_id,card_message_ids FROM interactions WHERE id=$1',[row.body.id]);
        const previous=v?.card_message_ids?.[row.body.part||0]||((row.body.parts||1)===1?v?.card_message_id:undefined);
        if(previous){try{await this.telegram.call('editMessageText',{chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:row.body.outputLanguage,message_id:Number(previous),text:row.body.text,entities:row.body.entities,reply_markup:row.body.replyMarkup||{inline_keyboard:[]}});sent={message_id:Number(previous)};}catch(e){if(e instanceof TelegramError&&e.code==='telegram_message_not_modified')sent={message_id:Number(previous)};else{if(!(e instanceof TelegramError)||e.code!=='telegram_400')throw e;sent=await this.telegram.text(row.chatId,row.body.text,{actorId:row.actor_id,outputLanguage:row.body.outputLanguage,threadId:row.body.threadId,entities:row.body.entities,replyMarkup:row.body.replyMarkup});}}}
        else sent=await this.telegram.text(row.chatId,row.body.text,{actorId:row.actor_id,outputLanguage:row.body.outputLanguage,threadId:row.body.threadId,entities:row.body.entities,replyMarkup:row.body.replyMarkup});
        await this.db.query("UPDATE interactions SET card_message_ids=jsonb_set(card_message_ids,$1::text[],$2::jsonb,true),card_message_id=CASE WHEN $3 THEN $4 ELSE card_message_id END WHERE id=$5",[[String(row.body.part||0)],JSON.stringify(sent.message_id),(row.body.part||0)===(row.body.parts||1)-1,sent.message_id,row.body.id]);
      }else if(row.kind==='panel'){
        const view=await readResultView(this.db,row.body,String(row.actor_id),row.revision);
        const base={chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:view.outputLanguage||row.body.outputLanguage,text:view.text,entities:view.entities,reply_markup:view.replyMarkup,...(row.body.threadId?{message_thread_id:row.body.threadId}:{})};
        if(Number(row.chatId)>0)sent=await this.telegram.call('sendMessage',base);
        else try{sent=await this.telegram.call('sendMessage',{...base,ephemeral_message_parameters:{receiver_user_id:Number(row.body.receiverId),callback_query_id:row.body.callbackQueryId}});}
        catch(e){if(!(e instanceof TelegramError)||e.code!=='telegram_400')throw e;sent=await this.telegram.text(view.private?String(row.actor_id):row.chatId,view.text,{actorId:row.actor_id,outputLanguage:view.outputLanguage||row.body.outputLanguage,threadId:view.private?undefined:row.body.threadId,entities:view.entities,replyMarkup:view.replyMarkup});}
      }else if(row.kind==='media_asset'){
        await this.checkMediaJob(row);
        const publication=await one(this.db,"SELECT * FROM media_publications WHERE id=$1 AND actor_id=$2 AND status='queued'",[row.body.publicationId,row.actor_id]);
        if(!publication||digest(publication.manifest)!==digest(Object.fromEntries(['id','version','sha256','caption','destination_id','audience'].filter(k=>row.body[k]!==undefined).map(k=>[k,row.body[k]]))))throw new ToolError('publication_manifest_changed');
        const context={actorId:String(row.actor_id),chatId:String(current.chat_id),topicId:String(row.body.threadId||0),revision:row.revision,updateId:row.dedup_key,requested:true,audience:row.audience as 'group'|'private'};
        const media=new MediaAssets(this.db,this.config,this.telegram),data=await media.bytes(row.body.id,row.body.version,context);
        if(data.asset.sha256!==row.body.sha256)throw new ToolError('publication_source_changed');
        if(row.body.destination_id){
          const target=await one(this.db,"SELECT d.* FROM media_destinations d JOIN asset_destination_grants g ON g.destination_id=d.id WHERE d.id=$1 AND d.owner_id=$2 AND d.status='active' AND g.asset_id=$3 AND g.asset_version=$4 AND g.grantor_id=$5",[row.body.destination_id,row.actor_id,data.asset.id,data.asset.version,data.asset.owner_id]);
          if(!target)throw new ToolError('publication_permission_revoked');
          const me=await this.telegram.call('getMe'),author=await this.telegram.call('getChatMember',{chat_id:target.chat_id,user_id:Number(row.actor_id)}),bot=await this.telegram.call('getChatMember',{chat_id:target.chat_id,user_id:me.id});
          if(!['creator','administrator'].includes(author.status)||bot.status!=='creator'&&(bot.status!=='administrator'||bot.can_post_messages!==true))throw new ToolError('channel_publish_rights_changed');
          row.chatId=String(target.chat_id);delete row.body.threadId;row.externalDestination=true;
        }
        await assetFor(this.db,data.asset.id,data.asset.version,context);
        const valid=await one(this.db,"SELECT id FROM media_publications WHERE id=$1 AND status='queued'",[publication.id]);if(!valid)throw new ToolError('publication_revoked');
        await this.checkMediaJob(row,this.db,data);
        deliveredOutput={id:data.asset.id,version:Number(data.asset.version),revision:row.revision,sha256:createHash('sha256').update(data.bytes).digest('hex'),bytes:data.bytes.length,mime:data.asset.mime};
        const method=data.asset.mime.startsWith('image/')?'sendPhoto':data.asset.mime==='video/mp4'?'sendVideo':'sendDocument';
        sent=await this.telegram.upload(method,row.chatId,data.bytes,row.body.caption||data.asset.title,data.asset.mime,row.body.threadId,data.asset.title+(method==='sendVideo'?'.mp4':data.asset.mime==='application/pdf'?'.pdf':''),row.actor_id);
      }else if(row.kind==='private_result'){const data=await new PrivateResults(this.db,this.config).read(row.body.id,row.actor_id);sent=await this.telegram.upload('sendDocument',row.chatId,Buffer.from(JSON.stringify(data,null,2)),data.summary,'application/json',undefined,'Особиста_відповідь.json',row.actor_id);
      }else if(row.kind==='task_status'){const task=await one(this.db,'SELECT progress_message_id FROM agent_tasks WHERE id=$1',[row.body.taskId]);if(task?.progress_message_id){const previous=await one(this.db,"SELECT body,audience FROM outbox WHERE kind='task_status' AND status='sent' AND telegram_id=$1 AND body->>'taskId'=$2 ORDER BY id DESC LIMIT 1",[task.progress_message_id,row.body.taskId]);const scope=previous?.body?.scopeTopicId??previous?.body?.deliveryReceipt?.scope_topic_id??(previous?.audience==='group'?String(previous.body.threadId||0):undefined);if(!previous||previous.audience!==row.audience||String(previous.body?.deliveryReceipt?.destination_chat_id)!==row.chatId||String(scope)!==row.scopeTopicId)task.progress_message_id=null;}if(task?.progress_message_id){try{await this.telegram.call('editMessageText',{chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:row.body.outputLanguage,message_id:Number(task.progress_message_id),text:row.body.text});sent={message_id:Number(task.progress_message_id)};}catch(e){if(!(e instanceof TelegramError)||e.code!=='telegram_400')throw e;sent=await this.telegram.text(row.chatId,row.body.text,{actorId:row.actor_id,outputLanguage:row.body.outputLanguage,threadId:row.body.threadId});}}else sent=await this.telegram.text(row.chatId,row.body.text,{actorId:row.actor_id,outputLanguage:row.body.outputLanguage,threadId:row.body.threadId});await this.db.query('UPDATE agent_tasks SET progress_message_id=$1 WHERE id=$2',[sent.message_id,row.body.taskId]);
      }else if(row.kind==='artifact'||row.kind==='voice'){
        const artifact=await one(this.db,'SELECT name,mime,content,revision,encoding FROM agent_artifacts WHERE id=$1 AND actor_id=$2',[row.body.id,row.actor_id]);
        if(!artifact||artifact.revision!==row.revision)throw Error('artifact_not_available');
        const outputBytes=Buffer.from(artifact.content,artifact.encoding==='base64'?'base64':'utf8');
        deliveredOutput={id:String(row.body.id),revision:artifact.revision,sha256:createHash('sha256').update(outputBytes).digest('hex'),bytes:outputBytes.length,mime:artifact.mime};
        sent=await this.telegram.upload(row.kind==='voice'?'sendVoice':'sendDocument',row.chatId,outputBytes,artifact.name,artifact.mime,row.body.threadId,artifact.name,row.actor_id);
      }else if(row.kind==='telegram')sent=await this.native(row);
      else if(row.kind==='reaction'){
        await this.telegram.call('setMessageReaction',{chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:row.body.outputLanguage,message_id:row.body.messageId,reaction:[{type:'emoji',emoji:row.body.emoji}],is_big:false});sent={message_id:row.body.messageId};
      }else if(row.kind==='sticker')sent=await this.telegram.sticker(row.chatId,row.body.fileId,row.body.threadId,row.body.replyToMessageId);
      else if(bytes)sent=await this.telegram.upload(animated?'sendAnimation':'sendPhoto',row.chatId,bytes,animated?row.body.caption || '': 'Люмен ✨',animated?'video/mp4':'image/png',row.body.threadId,undefined,row.actor_id);
      else if(row.kind==='poll')sent=await this.telegram.poll(row.chatId,row.body.question,row.body.options,row.body.threadId,row.body.quiz,row.actor_id);
      else {
        const answer=/^(?:answer|error):(\d+):0$/.exec(row.dedup_key);
        const previous=answer?await one(this.db,"SELECT telegram_id FROM outbox WHERE dedup_key=$1 AND status='sent'",[`progress:${answer[1]}:0`]):undefined;
        if(previous?.telegram_id){
          try{await this.telegram.call('editMessageText',{chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:row.body.outputLanguage,message_id:Number(previous.telegram_id),text:row.body.text,entities:row.body.entities || [],reply_markup:row.body.replyMarkup || {inline_keyboard:[]},link_preview_options:{is_disabled:true}});sent={message_id:Number(previous.telegram_id)};}
          catch(e){if(!(e instanceof TelegramError)||e.code!=='telegram_400')throw e;sent=await this.telegram.text(row.chatId,row.body.text,{actorId:row.actor_id,outputLanguage:row.body.outputLanguage,replyMarkup:row.body.replyMarkup,replyToMessageId:row.body.replyToMessageId,threadId:row.body.threadId,entities:row.body.entities});}
        }else sent=await this.telegram.text(row.chatId,row.body.text,{actorId:row.actor_id,outputLanguage:row.body.outputLanguage,replyMarkup:row.body.replyMarkup,replyToMessageId:row.body.replyToMessageId,threadId:row.body.threadId,entities:row.body.entities});
      }
      if(!progress&&row.kind!=='text'&&row.source_message_id){
        const waiting=await one(this.db,"SELECT id FROM outbox WHERE source_message_id=$1 AND kind='text' AND status IN ('pending','sending') AND dedup_key NOT LIKE 'progress:%' LIMIT 1",[row.source_message_id]);
        const notice=!waiting?await one(this.db,"SELECT id,telegram_id FROM outbox WHERE source_message_id=$1 AND dedup_key LIKE 'progress:%' AND status='sent' LIMIT 1",[row.source_message_id]):undefined;
        if(notice?.telegram_id)try{await this.telegram.call('deleteMessage',{chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:row.body.outputLanguage,message_id:Number(notice.telegram_id)});await this.db.query("UPDATE outbox SET status='cleared' WHERE id=$1",[notice.id]);}catch{}
      }
      if(row.kind!=='panel'&&typeof (sent as any).text==='string')row.body.text=(sent as any).text;
      if((sent as any).poll){row.body.question=(sent as any).poll.question;row.body.options=(sent as any).poll.options.map((x:any)=>x.text);}
      const deliveredText=row.kind==='panel'?'[перегляд збереженого матеріалу]':row.kind==='private_result'?'[особистий результат сервісу]':['artifact','voice','media_asset'].includes(row.kind)?`[файл Люмена: ${row.body.id}]`:row.kind==='telegram'?`[дія Telegram: ${row.body.operation}] ${row.body.text || row.body.caption || ''}`:animated?`[анімація Люмена: ${row.body.asset}]`:row.kind==='image'?`[зображення Люмена] ${row.body.prompt || ''}`:row.kind==='reaction'?`[реакція Люмена: ${row.body.emoji}]`:row.kind==='sticker'?`[стікер Люмена: ${row.body.emoji || ''}]`:row.kind==='poll'?`[${row.body.quiz?'вікторина':'опитування'}] ${row.body.question}\n${row.body.options.join(' · ')}`:row.body.text;
      const deliveredRelease=await this.db.tx(async sql=>{
        const live=await state(sql,true);if(live.memory_revision!==row.revision)return;
        const still=await one(sql,'SELECT id FROM outbox WHERE id=$1',[row.id]);if(!still)return;
        const causalScope={scope_topic_id:row.scopeTopicId,source_chat_id:row.sourceChatId,actor_id:row.actor_id,audience:row.audience,...(row.source_message_id?{source_message_id:Number(row.source_message_id)}:{}),...(row.body.taskId?{task_id:row.body.taskId,goal_version:row.body.goalVersion}:{}),...(row.body.mediaJobId?{media_job_id:row.body.mediaJobId}:{})};
        const receipt={provider:'telegram',message_id:sent.message_id,message_ids:sent.message_ids||[sent.message_id],destination_chat_id:row.chatId,operation_id:row.operation_id,...causalScope,...(deliveredOutput?{output:deliveredOutput}:{})};
        if(!await observeEffect(sql,row.operation_id,{...receipt,kind:row.kind},row.revision,Boolean(row.service)))return;
        await sql.query("UPDATE outbox SET status='sent',telegram_id=$1,body=$2 WHERE id=$3",[sent.message_id,JSON.stringify({...row.body,...(row.kind==='panel'?{}:{text:deliveredText}),sentAt:new Date().toISOString(),deliveryReceipt:receipt}),row.id]);
        await recordDeliveredContribution(sql,row);
        if(row.kind==='media_asset')await sql.query("UPDATE media_publications SET status='delivered',receipts=$2 WHERE id=$1 AND status='queued'",[row.body.publicationId,JSON.stringify([{...receipt,chat_id:row.chatId,verified_at:new Date().toISOString()}])]);
        if(row.body.goalId)await sql.query('UPDATE conversation_goals SET question_message_id=$1 WHERE id=$2',[sent.message_id,row.body.goalId]);
        if(row.kind==='text'&&row.source_message_id)await sql.query("UPDATE scheduled_actions SET confirmation_message_id=$1 WHERE source_message_id=$2 AND status='awaiting_confirmation'",[sent.message_id,row.source_message_id]);
        if(row.kind==='poll'&&(sent as any).poll?.id)await sql.query('INSERT INTO polls(poll_id,message_id,topic_id,question,options,correct,revision,source_message_id,interaction_id,interaction_version,composition_id,composition_step) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING',[(sent as any).poll.id,sent.message_id,String(row.body.threadId || 0),row.body.question,JSON.stringify(row.body.options),row.body.quiz?.correct ?? null,row.revision,row.source_message_id,row.body.interactionId||null,row.body.interactionVersion||null,row.body.compositionId||null,row.body.compositionStep||null]);
        if(row.kind==='telegram'&&row.body.operation==='stop_poll')await sql.query('UPDATE polls SET closed=true WHERE message_id=$1',[row.body.message_id]);
        if(row.kind==='telegram'&&row.body.operation==='edit_message'){await detachDeliveredText(sql,row.body.message_id);await sql.query("UPDATE messages SET body=$1,edited_at=now() WHERE role='assistant' AND telegram_id=$2",[row.body.text,row.body.message_id]);}
        if(!row.service && !live.paused && !progress && row.audience!=='private' && !row.externalDestination && !['interaction','panel'].includes(row.kind)){const inserted=await sql.query("INSERT INTO messages (telegram_id,user_id,author,role,body,topic_id,source_message_id) VALUES ($1,'lumen','Люмен','assistant',$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id",[sent.message_id,deliveredText,String(row.body.threadId || 0),row.source_message_id]);if(inserted.rows[0])await transferProvenance(sql,'outbox',row.id,'message',inserted.rows[0].id);}
        if(row.kind==='telegram'&&['pin_message','unpin_message','stop_poll','edit_message'].includes(row.body.operation)){const verbs:Record<string,string>={pin_message:'закріпив повідомлення',unpin_message:'відкріпив повідомлення',stop_poll:'завершив голосування',edit_message:'оновив повідомлення'};await import('./db.js').then(({queueText})=>queueText(sql,`${row.body.actor_name || 'Готово'}, ${verbs[row.body.operation]}.`,live.memory_revision,`native-done:${row.id}`,false,{actorId:row.actor_id,outputLanguage:row.body.outputLanguage,threadId:row.body.threadId,sourceMessageId:row.source_message_id}));}
        if(row.dedup_key.startsWith('signals:'))await sql.query("UPDATE signals SET status='sent' WHERE id=ANY($1::uuid[]) AND status='queued'",[row.dedup_key.slice(8).split(':').filter((id:string)=>/^[a-f0-9-]{36}$/.test(id))]);
        if(row.body.actionId&&!await one(sql,"SELECT id FROM outbox WHERE body->>'actionId'=$1 AND status<>'sent' LIMIT 1",[row.body.actionId])){
          const finished=await one(sql,"UPDATE commitments SET phase='completed',result=$1,state_version=state_version+1 WHERE id=$2 AND phase='delivering' AND expected_result IN ('interaction_resolved','delivery_confirmed') RETURNING id",[JSON.stringify({proof:'telegram_delivery',message_id:sent.message_id}),row.body.actionId]);
          if(finished){const interaction=await one(sql,"UPDATE interactions SET phase='resolved',result='Дію виконано, результат доставлено.',updated_at=now() WHERE action_id=$1 AND phase IN ('ready','active') RETURNING id",[finished.id]);if(interaction)await queueInteraction(sql,interaction.id);await sql.query("UPDATE conversation_goals SET status='completed' WHERE id=$1",[finished.id]);}
        }
        const taskResult=/^task-result:([0-9a-f-]{36}):/.exec(row.dedup_key);if(taskResult&&!await one(sql,"SELECT id FROM outbox WHERE dedup_key LIKE $1 AND status<>'sent' LIMIT 1",[row.dedup_key.split(':').slice(0,-1).join(':')+':%']))await sql.query("UPDATE agent_tasks SET status='completed',updated_at=now() WHERE id=$1 AND status='delivering'",[taskResult[1]]);
        const scheduled=/^scheduled:([a-f0-9-]{36}):/.exec(row.dedup_key);if(scheduled&&!await one(sql,"SELECT id FROM outbox WHERE dedup_key LIKE $1 AND status<>'sent' LIMIT 1",[`scheduled:${scheduled[1]}:%`]))await sql.query("UPDATE scheduled_actions SET status='completed' WHERE id=$1 AND status='queued'",[scheduled[1]]);
        const compositionResult=/^composition-result:([a-f0-9-]{36}):/.exec(row.dedup_key);
        if(compositionResult&&!await one(sql,"SELECT id FROM outbox WHERE dedup_key LIKE $1 AND status<>'sent' LIMIT 1",['composition-result:'+compositionResult[1]+':%'])){
          await sql.query("UPDATE composition_runs SET phase='completed' WHERE id=$1 AND phase='delivering'",[compositionResult[1]]);
          await sql.query("UPDATE commitments SET phase='completed',updated_at=now() WHERE id IN (SELECT interaction_id FROM composition_runs WHERE id=$1 AND phase='completed') AND phase NOT IN ('cancelled','expired','failed')",[compositionResult[1]]);
          await sql.query("UPDATE interactions SET phase='resolved',result='Активність завершено, підсумок надіслано.' WHERE id IN (SELECT interaction_id FROM composition_runs WHERE id=$1 AND phase='completed') AND phase='active'",[compositionResult[1]]);
        }
        const match=/^reminder:(\d+):/.exec(row.dedup_key);
        if(match)await sql.query("UPDATE reminders SET status='sent' WHERE id=$1",[match[1]]);
      const release=/^release:(.+):0$/.exec(row.dedup_key);
        if(release){const result=await sql.query("UPDATE release_notices SET status='sent',telegram_id=$1 WHERE version=$2 RETURNING version",[sent.message_id,release[1]]);return result.rows[0]?.version as string|undefined;}
      });
      if(row.dedup_key.startsWith('task-result:')&&row.body.taskId)await new (await import('./task-journal.js')).TaskJournal(this.db).publish(row.body.taskId,true);
      if(deliveredRelease)console.log(JSON.stringify({event:'release_notice_delivered',version:deliveredRelease,group:createHash('sha256').update(String(row.chatId)).digest('hex').slice(0,16)}));
    }catch(e){
      const tg=e instanceof TelegramError?e:null;
      const code=tg?.code||(e instanceof ToolError?e.code:errorCode(e));
      const repairHint=telegramRepairHint(code);
      if(repairHint)await this.db.query("UPDATE outbox SET body=body||jsonb_build_object('repairHint',$2::text) WHERE id=$1",[row.id,repairHint]);
      const retry=tg?.retryAfter || 0;
      // Ambiguous deliveries are not retried automatically: Telegram has no sendMessage idempotency key.
      const localized=(e as any)?.code==='localization_unavailable',cancelled=['outbound_cancelled','task_cancelled','action_unavailable'].includes((e as any)?.code);
      const status=cancelled?'cleared':localized&&row.attempts<3?'pending':tg?.uncertain?'uncertain':retry?'pending':'failed';
      const incident=await this.db.tx(async sql=>{const live=await state(sql,true);if(live.paused||live.memory_revision!==row.revision)return;return recordIncident(sql,{operation:'delivery',stage:'delivery',attemptKey:`delivery:${row.id}:${row.attempts}`,actorId:row.actor_id,topicId:row.scopeTopicId||String(row.body.threadId||'0'),audience:row.audience==='private'?'private':'group',sourceId:row.source_message_id,revision:row.revision,actionId:row.body.actionId,taskId:row.body.taskId,outboxId:row.id,effectState:status==='uncertain'?'uncertain':cancelled?'unchanged':undefined,facts:{delivery_status:status,attempt:Number(row.attempts),retry_after:retry}},e);});
      const partialIds=(e as any)?.partialMessageIds;if(Array.isArray(partialIds)&&partialIds.length){const receipt={provider:'telegram',message_ids:partialIds,destination_chat_id:row.chatId,operation_id:row.operation_id,completeness:'partial'};await this.db.query("UPDATE outbox SET body=body||jsonb_build_object('partialDeliveryReceipt',$2::jsonb) WHERE id=$1",[row.id,JSON.stringify(receipt)]);if(row.operation_id)await this.db.query('UPDATE effect_operations SET result=$2 WHERE id=$1',[row.operation_id,JSON.stringify({partialDeliveryReceipt:receipt})]);}
      if(row.kind==='media_asset'&&status!=='pending')await this.db.query("UPDATE media_publications SET status=$2 WHERE id=$1 AND status='queued'",[row.body.publicationId,status==='uncertain'?'uncertain':status==='cleared'?'revoked':'failed']);
      if(row.operation_id)await this.db.query("UPDATE effect_operations SET phase=$1,error_code=$2,updated_at=now() WHERE id=$3 AND phase='dispatch_started'",[status==='pending'?'reserved':status==='uncertain'?'uncertain':status==='cleared'?'cancelled':'failed',code,row.operation_id]);
      await this.db.query("UPDATE outbox SET status=$1,error_code=$2,available_at=now()+($3 * interval '1 second') WHERE id=$4",[status,localized?'localization_unavailable':cancelled?'outbound_cancelled':code,Math.max(localized?15:1,retry),row.id]);
      if(row.body.actionId&&['failed','uncertain'].includes(status))await this.db.tx(async sql=>{const s=await state(sql,true);if(s.paused||s.memory_revision!==row.revision)return;await sql.query("UPDATE commitments SET phase=$1,error_code='delivery_unconfirmed',state_version=state_version+1 WHERE id=$2 AND phase IN ('executing','runnable','delivering')",[status==='uncertain'?'uncertain':'blocked',row.body.actionId]);if(row.kind!=='media_asset'&&incident)await queueText(sql,incident.message,s.memory_revision,'action-delivery-error:'+row.id,false,{actorId:row.actor_id,sourceMessageId:row.source_message_id,audience:row.audience==='private'?'private':'group',threadId:row.body.threadId});});
      if(row.kind==='media_asset'&&['failed','uncertain'].includes(status)&&incident)await this.mediaDeliveryNotice(row,status,code,incident);
      if(row.body.taskId&&!retry&&status!=='pending'&&status!=='cleared')await this.db.query("UPDATE agent_tasks SET status='needs_input',error_code='result_delivery_unconfirmed',updated_at=now() WHERE id=$1 AND status='delivering'",[row.body.taskId]);
      const scheduled=/^scheduled:([a-f0-9-]{36}):/.exec(row.dedup_key);if(scheduled&&(status==='failed'||status==='uncertain'))await this.db.query("UPDATE scheduled_actions SET status='needs_input' WHERE id=$1 AND status='queued'",[scheduled[1]]);
      const release=/^release:(.+):0$/.exec(row.dedup_key);if(release)console.error(JSON.stringify({event:'release_notice_delivery_error',version:release[1],group:createHash('sha256').update(String(row.chatId)).digest('hex').slice(0,16),status,code:tg?.code || errorCode(e)}));
      if(row.kind==='panel'&&status==='failed'&&incident)await this.db.tx(async sql=>{const s=await state(sql,true);if(!s.paused&&s.memory_revision===row.revision)await import('./db.js').then(({queueText})=>queueText(sql,incident.message,s.memory_revision,'panel-error:'+row.id,false,{actorId:row.actor_id,sourceMessageId:row.source_message_id,audience:row.audience==='private'?'private':'group',threadId:row.body.threadId}));});
      if(!localized&&!cancelled&&!retry&&!tg?.uncertain&&row.kind==='telegram'&&incident)await this.db.tx(async sql=>{const s=await state(sql,true);if(!s.paused&&s.memory_revision===row.revision)await import('./db.js').then(({queueText})=>queueText(sql,incident.message,s.memory_revision,`native-error:${row.id}`,false,{actorId:row.actor_id,outputLanguage:row.body.outputLanguage,threadId:row.body.threadId,sourceMessageId:row.source_message_id}));});
    }
    return true;
  }
}
