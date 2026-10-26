import {randomUUID} from 'node:crypto';
import {one,type SQL} from './db.js';
import type {Plan} from './model.js';
import type {InlineKeyboard,Message,TextEntity,TGSticker} from './telegram.js';

// The model names visible text spans, never UTF-16 offsets or Telegram API methods.
export function textEntities(text:string,formatting:NonNullable<Plan['presentation']>['formatting']):TextEntity[]{
  const entities:TextEntity[]=[];
  for(const f of formatting || []){
    const offset=text.indexOf(f.text);if(offset<0)continue;
    const entity:TextEntity={type:f.style,offset,length:f.text.length};
    if(f.style==='text_link'){
      try{const url=new URL(f.url || '');if(url.protocol!=='https:'||url.username||url.password)continue;entity.url=url.href;}catch{continue;}
    }
    const end=offset+entity.length;
    if(entities.some(e=>{
      const eEnd=e.offset+e.length,overlap=offset<eEnd&&e.offset<end;
      if(!overlap)return false;
      if(['code','pre'].includes(e.type)||['code','pre'].includes(entity.type))return true;
      if(e.type.includes('blockquote')&&entity.type.includes('blockquote'))return true;
      if(e.type==='text_link'&&entity.type==='text_link')return true;
      return !(offset>=e.offset&&end<=eEnd || e.offset>=offset&&eEnd<=end);
    }))continue;
    if(!entities.some(e=>e.type===entity.type&&e.offset===offset&&e.length===entity.length))entities.push(entity);
  }
  return entities.sort((a,b)=>a.offset-b.offset || b.length-a.length);
}
export async function contextualKeyboard(sql:SQL,presentation:Plan['presentation'],m:Message,revision:number){
  const labels=[...new Set(presentation?.choices?.map(x=>x.trim()).filter(x=>x&&!x.startsWith('/')) || [])];
  if(labels.length<2)return undefined;
  await sql.query("DELETE FROM choices WHERE created_at<now()-interval '1 day'");
  const buttons=[];
  for(const label of labels){const id=randomUUID();await sql.query('INSERT INTO choices(id,label,topic_id,revision) VALUES($1,$2,$3,$4)',[id,label,String(m.message_thread_id || 0),revision]);buttons.push({text:label,callback_data:`lumen:choice:${id}`});}
  const keyboard:InlineKeyboard={inline_keyboard:[]};for(let i=0;i<buttons.length;i+=2)keyboard.inline_keyboard.push(buttons.slice(i,i+2));return keyboard;
}
export async function rememberSticker(sql:SQL,sticker:TGSticker,sourceId:number|null){
  if(sticker.type&&sticker.type!=='regular')return;
  if(!/^[A-Za-z0-9_-]{1,512}$/.test(sticker.file_id)||!sticker.file_unique_id)return;
  await sql.query('INSERT INTO stickers(file_id,file_unique_id,emoji,set_name,source_message_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(file_unique_id) DO UPDATE SET file_id=excluded.file_id,source_message_id=COALESCE(excluded.source_message_id,stickers.source_message_id)',[sticker.file_id,sticker.file_unique_id.slice(0,128),(sticker.emoji || '').slice(0,16),(sticker.set_name || '').slice(0,64),sourceId]);
}
export async function queueDecoration(sql:SQL,plan:Plan,m:Message,revision:number,updateId:string|number,serious=false,humorOff=false){
  const p=plan.presentation;if(!p?.sticker_id&&!p?.reaction)return false;
  const explicit=/стікер|реакці|sticker|react/iu.test(m.text || m.caption || '');
  if((serious||humorOff)&&!explicit)return false;
  if(!explicit&&await one(sql,"SELECT id FROM outbox WHERE kind IN ('sticker','reaction') AND created_at>now()-interval '5 minutes' LIMIT 1"))return false;
  let kind:string,body:Record<string,unknown>;
  if(p.sticker_id){
    const sticker=await one(sql,'SELECT id,file_id,emoji FROM stickers WHERE id=$1',[p.sticker_id]);if(!sticker)return false;
    kind='sticker';body={fileId:sticker.file_id,stickerId:sticker.id,emoji:sticker.emoji};
  }else{if(m.message_id<=0)return false;kind='reaction';body={emoji:p.reaction,messageId:m.message_id};}
  await sql.query('INSERT INTO outbox(dedup_key,kind,body,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[`presentation:${updateId}`,kind,JSON.stringify({...body,threadId:m.message_thread_id,replyToMessageId:m.message_id>0?m.message_id:m.reply_to_message?.message_id}),revision]);return true;
}
