import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {atomicJSON} from './config.js';
import {createHash} from 'node:crypto';
import {Telegram,type TGSticker} from './telegram.js';
import {rememberSticker} from './presentation.js';
import type {Database} from './db.js';
import {STICKER_SET,STICKER_TITLE,STICKER_COUNT,PREVIOUS_STICKER_SETS,STICKER_CHECKPOINT_FILE} from './sticker-set.js';

export {STICKER_SET,STICKER_TITLE,STICKER_COUNT,PREVIOUS_STICKER_SETS,LEGACY_STICKER_SET,STICKER_CHECKPOINT_FILE,stickerSetURL} from './sticker-set.js';
export interface StickerAsset {id:string;emoji:string;telegram_emoji?:string;label:string;description:string;file:string;bytes:number;sha256:string;motion_version?:number;preview?:string;scene?:string;}
export interface LumenPack {name:string;stickers:TGSticker[];title?:string;}
// Preserve the scene's semantic emoji while using an explicit compatible tag
// when Telegram does not yet recognize a newer Unicode emoji.
function telegramEmoji(asset:StickerAsset){return asset.telegram_emoji??asset.emoji;}
export async function stickerAssets(){return JSON.parse(await readFile(new URL('../../assets/stickers/manifest.json',import.meta.url),'utf8')) as StickerAsset[];}
export async function ensureStickerPack(telegram:Telegram,ownerId:string,runtimeDir?:string,paceMs=200){
  const assets=await stickerAssets();
  if(assets.length!==STICKER_COUNT||new Set(assets.map(a=>a.id)).size!==STICKER_COUNT||new Set(assets.map(a=>a.emoji)).size!==STICKER_COUNT||new Set(assets.map(telegramEmoji)).size!==STICKER_COUNT||new Set(assets.map(a=>a.sha256)).size!==STICKER_COUNT)throw Error('sticker_assets_incomplete');
  // Check the entire release before the first external mutation. An invalid last
  // file must not leave a live pack half replaced.
  const binaries=[];
  for(const a of assets){
    if(!/^[a-z0-9_]+\.webm$/.test(a.file))throw Error('sticker_asset_path_invalid');
    const bytes=await readFile(new URL('../../assets/stickers/'+a.file,import.meta.url));
    if(bytes.length!==a.bytes||bytes.length>256*1024||createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw Error('sticker_asset_invalid');
    binaries.push(bytes);
  }
  const title=STICKER_TITLE;
  const path=runtimeDir?resolve(runtimeDir,STICKER_CHECKPOINT_FILE):undefined;
  let saved:{set_name:string;items:Record<string,{sha256:string;file_unique_id:string}>}={set_name:STICKER_SET,items:{}};
  if(path)try{saved=JSON.parse(await readFile(path,'utf8'));if(saved?.set_name!==STICKER_SET||!saved.items||typeof saved.items!=='object'||Array.isArray(saved.items))throw Error();}catch(e:any){if(e.code!=='ENOENT')throw Error('sticker_checkpoint_invalid');}
  const persist=async()=>{if(path)await atomicJSON(path,saved);};
  const valid=(pack:LumenPack)=>{if(typeof pack?.name!=='string'||pack.name.toLowerCase()!==STICKER_SET.toLowerCase()||!Array.isArray(pack.stickers)||pack.stickers.length>STICKER_COUNT||pack.stickers.some(s=>!s.is_video))throw Error('sticker_set_unexpected');return pack;};
  let existing:LumenPack|undefined;let created=false;
  try{existing=await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET});}catch(e:any){if(e.code!=='telegram_400')throw e;}
  console.log(JSON.stringify({event:'sticker_pack_observed',name:STICKER_SET,title:existing?.title??null,count:existing?.stickers?.length??0}));
  if(!existing){
    created=true;
    const form=new FormData();form.set('user_id',ownerId);form.set('name',STICKER_SET);form.set('title',title);form.set('sticker_type','regular');
    const stickers=[];
    // Telegram allows at most 50 initial stickers, even for a 120-item set.
    for(const [index,a] of assets.slice(0,50).entries()){
      const bytes=binaries[index]!;
      const field='sticker'+index;form.set(field,new Blob([bytes],{type:'video/webm'}),a.file);stickers.push({sticker:'attach://'+field,format:'video',emoji_list:[telegramEmoji(a)],keywords:[a.label,'Люмен']});
    }
    form.set('stickers',JSON.stringify(stickers));
    try{await telegram.multipart('createNewStickerSet',form);}catch(e){try{existing=await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET});}catch{throw e;}}
    existing ||= await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET});
  }
  valid(existing);
  if(created){
    if(existing.stickers.length!==Math.min(50,assets.length))throw Error('sticker_set_unexpected');
    for(const [index,a] of assets.slice(0,existing.stickers.length).entries())saved.items[a.id]={sha256:a.sha256,file_unique_id:existing.stickers[index]!.file_unique_id};
    await persist();
    console.log(JSON.stringify({event:'sticker_pack_progress',name:STICKER_SET,count:existing.stickers.length,target:STICKER_COUNT}));
  }
  for(const [index,a] of assets.entries()){
    let before=existing.stickers[index];const checkpoint=saved.items[a.id];
    // Reorder a known existing document instead of replacing it with a copy.
    // This preserves its identity when a later release changes display order.
    if(checkpoint?.sha256===a.sha256&&before?.file_unique_id!==checkpoint.file_unique_id){
      const found=existing.stickers.findIndex(s=>s.file_unique_id===checkpoint.file_unique_id);
      if(found>=0){
        const expected=existing.stickers.slice();const [moving]=expected.splice(found,1);expected.splice(index,0,moving!);
        let failed:unknown;try{await telegram.call('setStickerPositionInSet',{sticker:moving!.file_id,position:index});}catch(e){failed=e;}
        const moved=valid(await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET}));
        if(moved.stickers.length!==expected.length||moved.stickers.some((s,i)=>s.file_unique_id!==expected[i]!.file_unique_id))throw failed||Error('sticker_set_order_unconfirmed');
        existing=moved;before=existing.stickers[index];
      }
    }
    if(before&&checkpoint?.sha256===a.sha256&&checkpoint.file_unique_id===before.file_unique_id){
      if(before.emoji?.replace(/\uFE0F/g,'')!==telegramEmoji(a).replace(/\uFE0F/g,'')){await telegram.call('setStickerEmojiList',{sticker:before.file_id,emoji_list:[telegramEmoji(a)]});before.emoji=telegramEmoji(a);}
      continue;
    }
    const snapshot=existing;const expectedCount=snapshot.stickers.length+(before?0:1);
    for(let attempt=0;;attempt++){
      const form=new FormData();form.set('user_id',ownerId);form.set('name',STICKER_SET);
      if(before)form.set('old_sticker',before.file_id);
      form.set('video',new Blob([binaries[index]!],{type:'video/webm'}),a.file);
      form.set('sticker',JSON.stringify({sticker:'attach://video',format:'video',emoji_list:[telegramEmoji(a)],keywords:[a.label,'Люмен']}));
      let failed:any;
      try{await telegram.multipart(before?'replaceStickerInSet':'addStickerToSet',form);}catch(e){failed=e;}
      const current=valid(await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET}));
      const othersUnchanged=snapshot.stickers.every((s,i)=>i===index||current.stickers[i]?.file_unique_id===s.file_unique_id);
      const changed=current.stickers[index]?.file_unique_id!==before?.file_unique_id;
      const correctEmoji=current.stickers[index]?.emoji?.replace(/\uFE0F/g,'')===telegramEmoji(a).replace(/\uFE0F/g,'');
      const applied=current.stickers.length===expectedCount&&othersUnchanged&&correctEmoji&&(!failed||changed);
      if(applied){existing=current;break;}
      // Resolve an uncertain add by inspecting its position and count before any
      // retry. After a process restart, that position is replaced, never appended
      // a second time. Never delete/recreate the user's subscribed sticker set.
      if(failed?.code==='telegram_429'&&failed.retryAfter>0&&failed.retryAfter<=60&&attempt<2){await delay(failed.retryAfter*1000+200);continue;}
      console.error(JSON.stringify({event:'sticker_pack_item_failed',position:index+1,id:a.id,emoji:a.emoji,telegram_emoji:telegramEmoji(a),observed_emoji:current.stickers[index]?.emoji??null,count:current.stickers.length,code:typeof failed?.code==='string'&&/^telegram_[a-z0-9_]+$/.test(failed.code)?failed.code:'sticker_set_update_unconfirmed'}));
      throw failed||Error('sticker_set_update_unconfirmed');
    }
    saved.items[a.id]={sha256:a.sha256,file_unique_id:existing.stickers[index]!.file_unique_id};await persist();
    if((index+1)%10===0||index+1===assets.length)console.log(JSON.stringify({event:'sticker_pack_progress',name:STICKER_SET,count:existing.stickers.length,target:STICKER_COUNT}));
    if(paceMs)await delay(paceMs);
  }
  if(existing.stickers.length!==STICKER_COUNT||new Set(existing.stickers.map(s=>s.file_unique_id)).size!==STICKER_COUNT||existing.stickers.some((s,i)=>s.emoji?.replace(/\uFE0F/g,'')!==telegramEmoji(assets[i]!).replace(/\uFE0F/g,'')))throw Error('sticker_set_unexpected');
  if(existing.title!==title)await telegram.call('setStickerSetTitle',{name:STICKER_SET,title});
  // Read back the actual remote state after all mutations. A successful title
  // write or an in-memory list is not proof of what Telegram currently serves.
  const confirmed=valid(await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET}));
  if(confirmed.stickers.length!==assets.length||new Set(confirmed.stickers.map(s=>s.file_unique_id)).size!==assets.length)throw Error('sticker_set_unexpected');
  if(confirmed.title!==title)throw Error('sticker_set_title_unconfirmed');
  if(confirmed.stickers.some(s=>s.set_name?.toLowerCase()!==STICKER_SET.toLowerCase()))throw Error('sticker_set_membership_unconfirmed');
  if(confirmed.stickers.some((s,i)=>{
    const asset=assets[i]!,checkpoint=saved.items[asset.id];
    return checkpoint?.sha256!==asset.sha256||checkpoint.file_unique_id!==s.file_unique_id||s.emoji?.replace(/\uFE0F/g,'')!==telegramEmoji(asset).replace(/\uFE0F/g,'');
  }))throw Error('sticker_set_content_unconfirmed');
  console.log(JSON.stringify({event:'sticker_pack_verified',source:'telegram_getStickerSet',name:confirmed.name,title:confirmed.title,count:confirmed.stickers.length,matched_assets:assets.length,matched_memberships:confirmed.stickers.length,verified_at:new Date().toISOString()}));
  return confirmed;
}
export async function seedStickerPack(db:Database,pack:LumenPack){
  const assets=await stickerAssets();if(pack.stickers.length!==assets.length||pack.name.toLowerCase()!==STICKER_SET.toLowerCase())throw Error('sticker_set_unexpected');
  await db.tx(async sql=>{
    await sql.query('DELETE FROM stickers WHERE lower(set_name)=ANY($1::text[]) AND NOT(file_unique_id=ANY($2::text[]))',[[pack.name.toLowerCase(),...PREVIOUS_STICKER_SETS.map(s=>s.toLowerCase())],pack.stickers.map(s=>s.file_unique_id)]);
    for(const [index,sticker] of pack.stickers.entries()){
      const asset=assets[index]!;await rememberSticker(sql,{...sticker,emoji:asset.emoji,set_name:pack.name},null);
      await sql.query('UPDATE stickers SET description=$1,keywords=$2 WHERE file_unique_id=$3',[`${asset.label}. ${asset.description}`.slice(0,1400),asset.label+', Люмен',sticker.file_unique_id]);
    }
    const count=await sql.query('SELECT count(*)::int AS n FROM stickers WHERE lower(set_name)=lower($1)',[pack.name]);
    if(Number(count.rows[0]?.n)!==assets.length)throw Error('sticker_catalog_incomplete');
  });
  console.log(JSON.stringify({event:'sticker_catalog_ready',count:assets.length}));
}
