import {formatText,validEntities} from './text-document.js';
import {one,state,type SQL} from './db.js';
import {transferProvenance} from './provenance.js';
import {stableId} from './operations.js';
export async function queueResultView(sql:SQL,input:{panelId:string;index:number;actorId:string;topicId:string;callbackId:string;updateId:number}) {
  const s=await state(sql,true),p=await one(sql,'SELECT * FROM message_panels WHERE id=$1',[input.panelId]);
  const accessible=p&&p.topic_id===input.topicId&&(p.audience!=='private'||p.actor_id===input.actorId);
  let notice='';
  if(s.paused)notice='Пам’ять цього чату на паузі. Матеріал зараз недоступний.';
  else if(!accessible)notice='Цей матеріал уже недоступний або призначений іншому читачеві.';
  else if(p.revision!==s.memory_revision)notice='Ця кнопка стосується попереднього контексту. Відкрий актуальний матеріал у розмові.';
  else if(new Date(p.expires_at).getTime()<=Date.now())notice='Строк доступу через цю кнопку минув. Можна попросити Люмена перевірити, чи залишився збережений результат.';
  else if(!Number.isSafeInteger(input.index)||input.index<0||input.index>=p.pages.length)notice='Такої сторінки немає. Відкрий матеріал із першої сторінки.';
  const key='panel-read:'+stableId(input.callbackId);
  const row=await one(sql,"INSERT INTO outbox(dedup_key,kind,body,revision,service,actor_id,source_message_id) VALUES($1,'panel',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id",[key,JSON.stringify({panelId:notice?undefined:p!.id,index:input.index,notice:notice||undefined,receiverId:input.actorId,callbackQueryId:input.callbackId,threadId:input.topicId==='0'?undefined:Number(input.topicId),outputLanguage:p?.output_language||undefined}),s.memory_revision,Boolean(notice),input.actorId,notice?null:p!.source_message_id]);
  if(row&&!notice)await transferProvenance(sql,'panel',p!.id,'outbox',row.id);
  return {queued:Boolean(row),notice:Boolean(notice)};
}
export async function readResultView(sql:SQL,body:any,actor:string,revision:number) {
  if(body.notice)return {text:String(body.notice),private:true};
  const s=await state(sql),p=await one(sql,'SELECT * FROM message_panels WHERE id=$1',[body.panelId]);
  if(!p||s.paused||s.memory_revision!==revision||p.revision!==revision||p.topic_id!==String(body.threadId||0)||new Date(p.expires_at).getTime()<=Date.now()||p.audience==='private'&&p.actor_id!==actor)return {text:'Цей матеріал уже недоступний у поточному контексті.',private:true};
  const raw=p.pages[body.index],page=typeof raw==='string'?formatText(raw):raw;if(!page||typeof page.text!=='string')return {text:'Такої сторінки немає.',private:true};
  let prefix='';
  if(p.action_id){const a=await one(sql,'SELECT phase FROM commitments WHERE id=$1',[p.action_id]);const labels:Record<string,string>={waiting_acceptance:'очікуємо погодження',runnable:'готово до виконання',executing:'триває',delivering:'результат доставляється',completed:'завершено',blocked:'потрібне відновлення',uncertain:'результат не підтверджений',cancelled:'скасовано',expired:'строк минув'};prefix='Збережений матеріал від '+new Date(p.created_at).toISOString().slice(0,16).replace('T',' ')+'. Поточний стан: '+(labels[a?.phase]||'недоступний')+'.\n\n';}
  const buttons=[];
  if(body.index>0)buttons.push({text:'Назад',callback_data:`lp:${p.id}:${body.index-1}`});
  if(body.index+1<p.pages.length)buttons.push({text:'Далі',callback_data:`lp:${p.id}:${body.index+1}`});
  return {text:prefix+page.text,entities:validEntities(prefix+page.text,(page.entities||[]).map((e:any)=>({...e,offset:e.offset+prefix.length}))),private:p.audience==='private',outputLanguage:p.output_language,replyMarkup:{inline_keyboard:[[{text:`Сторінка ${body.index+1}/${p.pages.length}`,callback_data:`lp:${p.id}:${body.index}`}],...(buttons.length?[buttons]:[])]}};
}
