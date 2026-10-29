import {randomUUID} from 'node:crypto';
import {one,type SQL} from './db.js';
import type {Plan} from './model.js';
import type {InlineKeyboard,Message,TextEntity,TGSticker} from './telegram.js';
import {STICKER_SET} from './sticker-set.js';

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
export async function contextualKeyboard(sql:SQL,presentation:Plan['presentation'],m:Message,revision:number,question='',sourceId?:number){
  const labels=[...new Set(presentation?.choices?.map(x=>x.trim()).filter(x=>x&&!x.startsWith('/')) || [])];
  if(labels.length<2)return undefined;
  await sql.query("DELETE FROM choices WHERE created_at<now()-interval '1 day'");
  const buttons=[];const menu=randomUUID();const audience=presentation?.audience || 'group';
  for(const label of labels){const id=randomUUID();await sql.query('INSERT INTO choices(id,label,topic_id,revision,menu_id,question,audience,target_user_id,source_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,label,String(m.message_thread_id || 0),revision,menu,question.slice(0,2500),audience,audience==='personal'?String(m.from!.id):null,sourceId || null]);buttons.push({text:label.length<=22?label:`Варіант ${buttons.length+1}`,callback_data:`lumen:choice:${id}`});}
  const keyboard:InlineKeyboard={inline_keyboard:[]};for(let i=0;i<buttons.length;i+=(buttons.every(x=>x.text.length<=14)?2:1))keyboard.inline_keyboard.push(buttons.slice(i,i+(buttons.every(x=>x.text.length<=14)?2:1)));return keyboard;
}
export async function rememberSticker(sql:SQL,sticker:TGSticker,sourceId:number|null){
  if(sticker.type&&sticker.type!=='regular')return;
  if(!/^[A-Za-z0-9_-]{1,512}$/.test(sticker.file_id)||!sticker.file_unique_id)return;
  await sql.query("INSERT INTO stickers(file_id,file_unique_id,emoji,set_name,source_message_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(file_unique_id) DO UPDATE SET file_id=CASE WHEN lower(stickers.set_name)=$6 AND lower(excluded.set_name)<>$6 THEN stickers.file_id ELSE excluded.file_id END,emoji=CASE WHEN lower(stickers.set_name)=$6 AND lower(excluded.set_name)<>$6 THEN stickers.emoji ELSE COALESCE(NULLIF(excluded.emoji,''),stickers.emoji) END,set_name=CASE WHEN lower(stickers.set_name)=$6 THEN stickers.set_name ELSE COALESCE(NULLIF(excluded.set_name,''),stickers.set_name) END,source_message_id=COALESCE(excluded.source_message_id,stickers.source_message_id)",[sticker.file_id,sticker.file_unique_id.slice(0,128),(sticker.emoji || '').slice(0,16),(sticker.set_name || '').slice(0,64),sourceId,STICKER_SET.toLowerCase()]);
}
export function explicitStickerRequest(text:string){
  const unquoted=text.replace(/^>.*$/gm,'').replace(/[«“\"][^»”\"]*[»”\"]/g,'');
  if(/(?:(?:^|\s)не\s+хочу|(?:^|\s)без\s+(?:стікер|стикер)|don['’]t\s+want)/iu.test(unquoted))return false;
  if(/(?:(?:^|\s)не\s+(?:треба\s+|потрібно\s+)?(?:надіш|надсила|надсил|відправ|скида|скинь|кида|показ|шли|слати)|(?:do\s+not|don['’]t)\s+(?:send|show))/iu.test(unquoted))return false;
  return /(?:стікер|стикер|sticker)|\p{Extended_Pictographic}/iu.test(unquoted)&&/(?:надішли|над[іи]слати|надсилай|скинь|скинути|відправ|покажи|показати|дай|давай|хочу|можна|пришли|отправ|покажи|send|show|give)/iu.test(unquoted);
}
export async function queueDecoration(sql:SQL,plan:Plan,m:Message,revision:number,updateId:string|number,serious=false,humorOff=false,ownText=plan.reply){
  const p=plan.presentation;if(!p?.sticker_id&&!p?.reaction)return false;
  const explicit=p.sticker_id?p.sticker_purpose==='requested'&&explicitStickerRequest(m.text || m.caption || ''):/реакці|реакци|react/iu.test(m.text || m.caption || '');
  if((serious||humorOff)&&!explicit)return false;
  let kind:string,body:Record<string,unknown>;
  if(p.sticker_id){
    if(!explicit){
      const quote=p.sticker_quote?.trim();
      if(p.sticker_purpose!=='emphasis'||!quote||quote.length<3||!plan.reply.includes(quote)||!ownText.includes(quote)||ownText.trim().length<12)return false;
      const last=await one(sql,"SELECT id,status,created_at,body,COALESCE((body->>'sentAt')::timestamptz,created_at) AS delivered_at,COALESCE((body->>'sentAt')::timestamptz,created_at)>now()-interval '20 minutes' AS recent FROM outbox WHERE kind='sticker' AND status IN ('pending','sending','uncertain','sent') ORDER BY id DESC LIMIT 1");
      if(last){
        if(last.status!=='sent'||last.recent)return false;
        const turns=await one(sql,"SELECT count(*)::int AS n FROM messages WHERE role='assistant' AND created_at>$1 AND body NOT LIKE '[%'",[last.delivered_at]);
        if(Number(turns?.n || 0)<12)return false;
      }
    }
    const sticker=await one(sql,'SELECT id,file_id,emoji,set_name FROM stickers WHERE id=$1',[p.sticker_id]);if(!sticker)return false;
    if(!explicit&&String(sticker.set_name).toLowerCase()!==STICKER_SET.toLowerCase())return false;
    if(!explicit&&await one(sql,"SELECT id FROM (SELECT id,body FROM outbox WHERE kind='sticker' AND status IN ('pending','sending','uncertain','sent') ORDER BY id DESC LIMIT 3) recent WHERE body->>'stickerId'=$1 OR body->>'emoji'=$2 LIMIT 1",[String(sticker.id),sticker.emoji]))return false;
    kind='sticker';body={fileId:sticker.file_id,stickerId:sticker.id,emoji:sticker.emoji,stickerPurpose:explicit?'requested':'emphasis',...(explicit?{}:{stickerQuote:p.sticker_quote})};
  }else{if(m.message_id<=0)return false;if(!explicit&&await one(sql,"SELECT id FROM outbox WHERE kind IN ('sticker','reaction') AND status IN ('pending','sending','sent') AND created_at>now()-interval '5 minutes' LIMIT 1"))return false;kind='reaction';body={emoji:p.reaction,messageId:m.message_id};}
  await sql.query('INSERT INTO outbox(dedup_key,kind,body,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[`presentation:${updateId}`,kind,JSON.stringify({...body,threadId:m.message_thread_id,replyToMessageId:m.message_id>0?m.message_id:m.reply_to_message?.message_id}),revision]);return true;
}
