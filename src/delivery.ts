import {queueInteraction} from './interactions.js';
import {ToolError} from './safe-http.js';
import {readResultView} from './result-views.js';
import {reserveEffect,claimEffect,observeEffect} from './commitments.js';
import {PrivateResults} from './private-results.js';
import {transferProvenance} from './provenance.js';
import { state, one, type Database } from './db.js';
import { Telegram, TelegramError } from './telegram.js';
import { Media } from './media.js';
import type { Config } from './config.js';
import { errorCode } from './engine.js';
import {ambientStillRelevant} from './attention.js';
import {activityFor} from './activity-status.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export class Delivery {
  constructor(private db:Database,private telegram:Telegram,private config:Config,private media=new Media(config)){}
  private async native(row:Record<string,any>){
    const b=row.body,base={chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:row.body.outputLanguage,...(b.threadId?{message_thread_id:b.threadId}:{})};
    if(b.operation==='send_album')return (await this.telegram.call<any[]>('sendMediaGroup',{...base,media:b.files.map((f:any,i:number)=>({type:'photo',media:f.file_id,...(i===0&&b.caption?{caption:b.caption}:{})}))}))[0];
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
      const row=await one(sql,`SELECT * FROM outbox WHERE status='pending' AND available_at<=now() ${lane?"AND kind "+(lane==='text'?'NOT IN':'IN')+" ('artifact','voice','image','animation','private_result')":""} ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if(!row || !s.chat_id)return null;
      if(row.revision!==s.memory_revision || (s.paused && !row.service)){
        await sql.query("DELETE FROM outbox WHERE id=$1",[row.id]);return null;
      }
      if(row.dedup_key.startsWith('signals:')){const ids=row.dedup_key.slice(8).split(':').filter((id:string)=>/^[a-f0-9-]{36}$/.test(id));const signals=(await sql.query("SELECT g.* FROM signals g LEFT JOIN projects p ON p.id=g.project_id WHERE g.id=ANY($1::uuid[]) AND g.status='queued' AND g.expires_at>now() AND (g.project_id IS NULL OR p.status='active')",[ids])).rows;const prefs=await one(sql,'SELECT * FROM proactivity_preferences WHERE user_id=$1',[row.actor_id]);if(!signals.length||prefs?.enabled===false||(prefs?.muted_topics||[]).includes(String(row.body.threadId||0))){await sql.query("UPDATE outbox SET status='cleared' WHERE id=$1",[row.id]);return null;}const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:this.config.timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date()));const quiet=s.quiet_start!==s.quiet_end&&(s.quiet_start<s.quiet_end?hour>=s.quiet_start&&hour<s.quiet_end:hour>=s.quiet_start||hour<s.quiet_end);if(quiet||prefs?.snoozed_until&&new Date(prefs.snoozed_until).getTime()>Date.now()){await sql.query("UPDATE outbox SET available_at=now()+interval '5 minutes' WHERE id=$1",[row.id]);return null;}row.body.text=signals.map(x=>`${x.title}\n${x.body}\nЧому зараз: ${x.reason}`).join('\n\n').slice(0,3400);}
      if(row.kind==='interaction'){const v=await one(sql,'SELECT phase,version,card_hash,card_seq FROM interactions WHERE id=$1',[row.body.id]);if(!v||v.version!==row.body.version||v.card_hash!==row.body.hash||v.card_seq!==row.body.seq){await sql.query("UPDATE outbox SET status='cleared' WHERE id=$1",[row.id]);return null;}}
      if(row.body.compositionId){const owner=await one(sql,'SELECT phase,revision,deadline FROM composition_runs WHERE id=$1',[row.body.compositionId]);if(!owner||!['running','delivering'].includes(owner.phase)||owner.revision!==row.revision||new Date(owner.deadline).getTime()<=Date.now()){await sql.query("UPDATE outbox SET status='cleared',error_code='composition_unavailable' WHERE id=$1",[row.id]);return null;}}
      if(row.body.taskId&&row.body.goalVersion){const task=await one(sql,'SELECT goal_version,status,progress_hash FROM agent_tasks WHERE id=$1',[row.body.taskId]);if(!task||task.goal_version!==row.body.goalVersion||row.kind!=='task_status'&&['cancelled','paused'].includes(task.status)||row.kind==='task_status'&&(row.body.status!==task.status||row.body.hash!==task.progress_hash)){await sql.query('DELETE FROM outbox WHERE id=$1',[row.id]);return null;}}
      if(row.body.ambient){
        const source=await one(sql,'SELECT telegram_id,user_id,author,created_at,topic_id FROM messages WHERE id=$1',[row.source_message_id]);
        if(!source||!await ambientStillRelevant(sql,{message_id:Number(source.telegram_id),date:Math.floor(new Date(source.created_at).getTime()/1000),from:{id:Number(source.user_id),first_name:source.author},chat:{id:Number(s.chat_id),type:'supergroup'},message_thread_id:source.topic_id==='0'?undefined:Number(source.topic_id)},Number(row.source_message_id),s,this.config.timezone,true)){
          await sql.query("DELETE FROM outbox WHERE source_message_id=$1 AND body->>'ambient'='true' AND status='pending'",[row.source_message_id]);return null;
        }
      }
      if(row.audience==='private'&&!/^\d+$/.test(row.actor_id||'')){await sql.query("UPDATE outbox SET status='failed',error_code='private_recipient_required' WHERE id=$1",[row.id]);return null;}
      if(row.audience==='private')delete row.body.threadId;
      const {generated,...operationBody}=row.body;
      try{
      const operation=await reserveEffect(sql,{key:'outbox:'+row.dedup_key,arguments:{kind:row.kind,body:operationBody},actorId:row.actor_id||'system',topicId:String(row.body.threadId||0),revision:row.revision,sourceId:row.source_message_id||undefined,actionId:row.body.actionId});
      const claim=await claimEffect(sql,operation.id,row.revision,Boolean(row.service));
      if(claim.cached){await sql.query("UPDATE outbox SET status='sent',telegram_id=$1 WHERE id=$2",[claim.result?.message_id||null,row.id]);return null;}
      await sql.query("UPDATE outbox SET status='sending',attempts=attempts+1,operation_id=$2 WHERE id=$1",[row.id,operation.id]);return {...row,operation_id:operation.id,chatId:row.audience==='private'?row.actor_id:s.chat_id};
      }catch(e){if(!(e instanceof ToolError))throw e;await sql.query("UPDATE outbox SET status=$1,error_code=$2 WHERE id=$3",[/uncertain/.test(e.code)?'uncertain':'cleared',e.code,row.id]);return null;}
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
      if(row.body.actionId)await this.db.tx(async sql=>{const owner=await one(sql,'SELECT phase,revision,expires_at FROM commitments WHERE id=$1',[row.body.actionId]);if(!owner||!['executing','runnable','delivering'].includes(owner.phase)||owner.revision!==row.revision||new Date(owner.expires_at).getTime()<=Date.now())throw new ToolError('outbound_cancelled');});
      const progress=/^(progress:|task-progress:)/.test(row.dedup_key);
      if(current.paused)await activityFor(this.db,this.telegram).stopAll();
      if(!progress&&row.source_message_id)await activityFor(this.db,this.telegram).stopSource(Number(row.source_message_id));
      let sent:{message_id:number};
      if(row.kind==='interaction'){
        const v=await one(this.db,'SELECT card_message_id,card_message_ids FROM interactions WHERE id=$1',[row.body.id]);
        const previous=v?.card_message_ids?.[row.body.part||0]||((row.body.parts||1)===1?v?.card_message_id:undefined);
        if(previous){try{await this.telegram.call('editMessageText',{chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:row.body.outputLanguage,message_id:Number(previous),text:row.body.text,entities:row.body.entities,reply_markup:row.body.replyMarkup||{inline_keyboard:[]}});sent={message_id:Number(previous)};}catch(e){if(e instanceof TelegramError&&e.code==='telegram_message_not_modified')sent={message_id:Number(previous)};else{if(!(e instanceof TelegramError)||e.code!=='telegram_400')throw e;sent=await this.telegram.text(row.chatId,row.body.text,{actorId:row.actor_id,outputLanguage:row.body.outputLanguage,threadId:row.body.threadId,entities:row.body.entities,replyMarkup:row.body.replyMarkup});}}}
        else sent=await this.telegram.text(row.chatId,row.body.text,{actorId:row.actor_id,outputLanguage:row.body.outputLanguage,threadId:row.body.threadId,entities:row.body.entities,replyMarkup:row.body.replyMarkup});
        await this.db.query("UPDATE interactions SET card_message_ids=jsonb_set(card_message_ids,$1::text[],$2::jsonb,true),card_message_id=CASE WHEN $3 THEN $4 ELSE card_message_id END WHERE id=$5",[[String(row.body.part||0)],JSON.stringify(sent.message_id),(row.body.part||0)===(row.body.parts||1)-1,sent.message_id,row.body.id]);
      }else if(row.kind==='panel'){
        const view=await readResultView(this.db,row.body,String(row.actor_id),row.revision);
        const base={chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:view.outputLanguage||row.body.outputLanguage,text:view.text,reply_markup:view.replyMarkup,...(row.body.threadId?{message_thread_id:row.body.threadId}:{})};
        if(Number(row.chatId)>0)sent=await this.telegram.call('sendMessage',base);
        else try{sent=await this.telegram.call('sendMessage',{...base,ephemeral_message_parameters:{receiver_user_id:Number(row.body.receiverId),callback_query_id:row.body.callbackQueryId}});}
        catch(e){if(!(e instanceof TelegramError)||e.code!=='telegram_400')throw e;sent=await this.telegram.text(view.private?String(row.actor_id):row.chatId,view.text,{actorId:row.actor_id,outputLanguage:view.outputLanguage||row.body.outputLanguage,threadId:view.private?undefined:row.body.threadId,replyMarkup:view.replyMarkup});}
      }else if(row.kind==='private_result'){const data=await new PrivateResults(this.db,this.config).read(row.body.id,row.actor_id);sent=await this.telegram.upload('sendDocument',row.chatId,Buffer.from(JSON.stringify(data,null,2)),data.summary,'application/json',undefined,'Особиста_відповідь.json',row.actor_id);
      }else if(row.kind==='task_status'){const task=await one(this.db,'SELECT progress_message_id FROM agent_tasks WHERE id=$1',[row.body.taskId]);if(task?.progress_message_id){try{await this.telegram.call('editMessageText',{chat_id:row.chatId,_lumen_actor_id:row.actor_id,_lumen_output_language:row.body.outputLanguage,message_id:Number(task.progress_message_id),text:row.body.text});sent={message_id:Number(task.progress_message_id)};}catch(e){if(!(e instanceof TelegramError)||e.code!=='telegram_400')throw e;sent=await this.telegram.text(row.chatId,row.body.text,{actorId:row.actor_id,outputLanguage:row.body.outputLanguage,threadId:row.body.threadId});}}else sent=await this.telegram.text(row.chatId,row.body.text,{actorId:row.actor_id,outputLanguage:row.body.outputLanguage,threadId:row.body.threadId});await this.db.query('UPDATE agent_tasks SET progress_message_id=$1 WHERE id=$2',[sent.message_id,row.body.taskId]);
      }else if(row.kind==='artifact'||row.kind==='voice'){
        const artifact=await one(this.db,'SELECT name,mime,content,revision,encoding FROM agent_artifacts WHERE id=$1 AND actor_id=$2',[row.body.id,row.actor_id]);
        if(!artifact||artifact.revision!==row.revision)throw Error('artifact_not_available');
        sent=await this.telegram.upload(row.kind==='voice'?'sendVoice':'sendDocument',row.chatId,Buffer.from(artifact.content,artifact.encoding==='base64'?'base64':'utf8'),artifact.name,artifact.mime,row.body.threadId,artifact.name,row.actor_id);
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
      const deliveredText=row.kind==='panel'?'[перегляд збереженого матеріалу]':row.kind==='private_result'?'[особистий результат сервісу]':row.kind==='artifact'?`[файл Люмена: ${row.body.id}]`:row.kind==='telegram'?`[дія Telegram: ${row.body.operation}] ${row.body.text || row.body.caption || ''}`:animated?`[анімація Люмена: ${row.body.asset}]`:row.kind==='image'?`[зображення Люмена] ${row.body.prompt || ''}`:row.kind==='reaction'?`[реакція Люмена: ${row.body.emoji}]`:row.kind==='sticker'?`[стікер Люмена: ${row.body.emoji || ''}]`:row.kind==='poll'?`[${row.body.quiz?'вікторина':'опитування'}] ${row.body.question}\n${row.body.options.join(' · ')}`:row.body.text;
      const deliveredRelease=await this.db.tx(async sql=>{
        const live=await state(sql,true);if(live.memory_revision!==row.revision)return;
        const still=await one(sql,'SELECT id FROM outbox WHERE id=$1',[row.id]);if(!still)return;
        if(!await observeEffect(sql,row.operation_id,{message_id:sent.message_id,provider:'telegram',kind:row.kind},row.revision,Boolean(row.service)))return;
        await sql.query("UPDATE outbox SET status='sent',telegram_id=$1,body=$2 WHERE id=$3",[sent.message_id,JSON.stringify({...row.body,...(row.kind==='panel'?{}:{text:deliveredText}),sentAt:new Date().toISOString(),deliveryReceipt:{provider:'telegram',message_id:sent.message_id,operation_id:row.operation_id}}),row.id]);
        if(row.body.goalId)await sql.query('UPDATE conversation_goals SET question_message_id=$1 WHERE id=$2',[sent.message_id,row.body.goalId]);
        if(row.kind==='text'&&row.source_message_id)await sql.query("UPDATE scheduled_actions SET confirmation_message_id=$1 WHERE source_message_id=$2 AND status='awaiting_confirmation'",[sent.message_id,row.source_message_id]);
        if(row.kind==='poll'&&(sent as any).poll?.id)await sql.query('INSERT INTO polls(poll_id,message_id,topic_id,question,options,correct,revision,source_message_id,interaction_id,interaction_version,composition_id,composition_step) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING',[(sent as any).poll.id,sent.message_id,String(row.body.threadId || 0),row.body.question,JSON.stringify(row.body.options),row.body.quiz?.correct ?? null,row.revision,row.source_message_id,row.body.interactionId||null,row.body.interactionVersion||null,row.body.compositionId||null,row.body.compositionStep||null]);
        if(row.kind==='telegram'&&row.body.operation==='stop_poll')await sql.query('UPDATE polls SET closed=true WHERE message_id=$1',[row.body.message_id]);
        if(row.kind==='telegram'&&row.body.operation==='edit_message')await sql.query("UPDATE messages SET body=$1,edited_at=now() WHERE role='assistant' AND telegram_id=$2",[row.body.text,row.body.message_id]);
        if(!row.service && !live.paused && !progress && row.audience!=='private' && !['interaction','panel'].includes(row.kind)){const inserted=await sql.query("INSERT INTO messages (telegram_id,user_id,author,role,body,topic_id,source_message_id) VALUES ($1,'lumen','Люмен','assistant',$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id",[sent.message_id,deliveredText,String(row.body.threadId || 0),row.source_message_id]);if(inserted.rows[0])await transferProvenance(sql,'outbox',row.id,'message',inserted.rows[0].id);}
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
      const retry=tg?.retryAfter || 0;
      // Ambiguous deliveries are not retried automatically: Telegram has no sendMessage idempotency key.
      const localized=(e as any)?.code==='localization_unavailable',cancelled=['outbound_cancelled','task_cancelled','action_unavailable'].includes((e as any)?.code);
      const status=cancelled?'cleared':localized&&row.attempts<3?'pending':tg?.uncertain?'uncertain':retry?'pending':'failed';
      if(row.operation_id)await this.db.query("UPDATE effect_operations SET phase=$1,error_code=$2,updated_at=now() WHERE id=$3 AND phase='dispatch_started'",[status==='pending'?'reserved':status==='uncertain'?'uncertain':status==='cleared'?'cancelled':'failed',tg?.code||'delivery_failed',row.operation_id]);
      await this.db.query("UPDATE outbox SET status=$1,error_code=$2,available_at=now()+($3 * interval '1 second') WHERE id=$4",[status,tg?.code || (localized?'localization_unavailable':cancelled?'outbound_cancelled':errorCode(e)),Math.max(localized?15:1,retry),row.id]);
      if(row.body.actionId&&['failed','uncertain'].includes(status))await this.db.tx(async sql=>{const s=await state(sql,true);if(s.paused||s.memory_revision!==row.revision)return;await sql.query("UPDATE commitments SET phase=$1,error_code='delivery_unconfirmed',state_version=state_version+1 WHERE id=$2 AND phase IN ('executing','runnable','delivering')",[status==='uncertain'?'uncertain':'blocked',row.body.actionId]);await import('./db.js').then(({queueText})=>queueText(sql,status==='uncertain'?'Доставку результату не підтверджено. Автоматично не повторюю її, щоб не створити дубль.':'Не вдалося доставити результат. Зроблене збережено; завершення дії не підтверджено.',s.memory_revision,'action-delivery-error:'+row.id,false,{actorId:row.actor_id,sourceMessageId:row.source_message_id,audience:row.audience==='private'?'private':'group',threadId:row.body.threadId}));});
      if(row.body.taskId&&!retry&&status!=='pending'&&status!=='cleared')await this.db.query("UPDATE agent_tasks SET status='needs_input',error_code='result_delivery_unconfirmed',updated_at=now() WHERE id=$1 AND status='delivering'",[row.body.taskId]);
      const scheduled=/^scheduled:([a-f0-9-]{36}):/.exec(row.dedup_key);if(scheduled&&(status==='failed'||status==='uncertain'))await this.db.query("UPDATE scheduled_actions SET status='needs_input' WHERE id=$1 AND status='queued'",[scheduled[1]]);
      const release=/^release:(.+):0$/.exec(row.dedup_key);if(release)console.error(JSON.stringify({event:'release_notice_delivery_error',version:release[1],group:createHash('sha256').update(String(row.chatId)).digest('hex').slice(0,16),status,code:tg?.code || errorCode(e)}));
      if(row.kind==='panel'&&status==='failed')await this.db.tx(async sql=>{const s=await state(sql,true);if(!s.paused&&s.memory_revision===row.revision)await import('./db.js').then(({queueText})=>queueText(sql,'Не вдалося відкрити збережений матеріал. Telegram не дозволив доставку; сам матеріал не запускав повторно.',s.memory_revision,'panel-error:'+row.id,false,{actorId:row.actor_id,audience:row.audience==='private'?'private':'group',threadId:row.body.threadId}));});
      if(!localized&&!cancelled&&!retry&&!tg?.uncertain&&row.kind==='telegram')await this.db.tx(async sql=>{const s=await state(sql,true);if(!s.paused&&s.memory_revision===row.revision)await import('./db.js').then(({queueText})=>queueText(sql,'Telegram не дозволив цю дію. Можливо, бракує прав або повідомлення вже недоступне; можемо продовжити текстом.',s.memory_revision,`native-error:${row.id}`,false,{actorId:row.actor_id,outputLanguage:row.body.outputLanguage,threadId:row.body.threadId,sourceMessageId:row.source_message_id}));});
    }
    return true;
  }
}
