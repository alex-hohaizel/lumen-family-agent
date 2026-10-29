import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {atomicJSON} from './config.js';
import {createHash} from 'node:crypto';
import {Telegram,type TGSticker} from './telegram.js';
import {rememberSticker} from './presentation.js';
import type {Database} from './db.js';

export const STICKER_SET='Lumen_Moods_by_lumen_family_agent';
export interface StickerAsset {id:string;emoji:string;label:string;description:string;file:string;bytes:number;sha256:string;motion_version?:number;preview?:string;scene?:string;}
export interface LumenPack {name:string;stickers:TGSticker[];title?:string;}
export async function stickerAssets(){return JSON.parse(await readFile(new URL('../../assets/stickers/manifest.json',import.meta.url),'utf8')) as StickerAsset[];}
export async function ensureStickerPack(telegram:Telegram,ownerId:string,runtimeDir?:string,paceMs=200){
  const assets=await stickerAssets();
  if(assets.length!==50||new Set(assets.map(a=>a.id)).size!==50||new Set(assets.map(a=>a.emoji)).size!==50||new Set(assets.map(a=>a.sha256)).size!==50)throw Error('sticker_assets_incomplete');
  // Check the entire release before the first external mutation. An invalid last
  // file must not leave a live pack half replaced.
  const binaries=[];
  for(const a of assets){
    if(!/^[a-z0-9_]+\.webm$/.test(a.file))throw Error('sticker_asset_path_invalid');
    const bytes=await readFile(new URL('../../assets/stickers/'+a.file,import.meta.url));
    if(bytes.length!==a.bytes||bytes.length>256*1024||createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw Error('sticker_asset_invalid');
    binaries.push(bytes);
  }
  const title='Люмен — 50 емоцій';
  const path=runtimeDir?resolve(runtimeDir,'sticker-pack.json'):undefined;
  let saved:{items:Record<string,{sha256:string;file_unique_id:string}>}={items:{}};
  if(path)try{saved=JSON.parse(await readFile(path,'utf8'));if(!saved?.items||typeof saved.items!=='object'||Array.isArray(saved.items))throw Error();}catch(e:any){if(e.code!=='ENOENT')throw Error('sticker_checkpoint_invalid');}
  const persist=async()=>{if(path)await atomicJSON(path,saved);};
  const valid=(pack:LumenPack)=>{if(typeof pack?.name!=='string'||pack.name.toLowerCase()!==STICKER_SET.toLowerCase()||!Array.isArray(pack.stickers)||pack.stickers.length>50||pack.stickers.some(s=>!s.is_video))throw Error('sticker_set_unexpected');return pack;};
  let existing:LumenPack|undefined;let created=false;
  try{existing=await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET});}catch(e:any){if(e.code!=='telegram_400')throw e;}
  if(!existing){
    created=true;
    const form=new FormData();form.set('user_id',ownerId);form.set('name',STICKER_SET);form.set('title',title);form.set('sticker_type','regular');
    const stickers=[];
    for(const [index,a] of assets.entries()){
      const bytes=binaries[index]!;
      const field='sticker'+index;form.set(field,new Blob([bytes],{type:'video/webm'}),a.file);stickers.push({sticker:'attach://'+field,format:'video',emoji_list:[a.emoji],keywords:[a.label,'Люмен']});
    }
    form.set('stickers',JSON.stringify(stickers));
    try{await telegram.multipart('createNewStickerSet',form);}catch(e){try{existing=await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET});}catch{throw e;}}
    existing ||= await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET});
  }
  valid(existing);
  if(created){
    if(existing.stickers.length!==50)throw Error('sticker_set_unexpected');
    for(const [index,a] of assets.entries())saved.items[a.id]={sha256:a.sha256,file_unique_id:existing.stickers[index]!.file_unique_id};
    await persist();
  }
  for(const [index,a] of assets.entries()){
    const before=existing.stickers[index];const checkpoint=saved.items[a.id];
    if(before&&checkpoint?.sha256===a.sha256&&checkpoint.file_unique_id===before.file_unique_id){
      if(before.emoji?.replace(/\uFE0F/g,'')!==a.emoji.replace(/\uFE0F/g,'')){await telegram.call('setStickerEmojiList',{sticker:before.file_id,emoji_list:[a.emoji]});before.emoji=a.emoji;}
      continue;
    }
    const snapshot=existing;const expectedCount=snapshot.stickers.length+(before?0:1);
    for(let attempt=0;;attempt++){
      const form=new FormData();form.set('user_id',ownerId);form.set('name',STICKER_SET);
      if(before)form.set('old_sticker',before.file_id);
      form.set('video',new Blob([binaries[index]!],{type:'video/webm'}),a.file);
      form.set('sticker',JSON.stringify({sticker:'attach://video',format:'video',emoji_list:[a.emoji],keywords:[a.label,'Люмен']}));
      let failed:any;
      try{await telegram.multipart(before?'replaceStickerInSet':'addStickerToSet',form);}catch(e){failed=e;}
      const current=valid(await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET}));
      const othersUnchanged=snapshot.stickers.every((s,i)=>i===index||current.stickers[i]?.file_unique_id===s.file_unique_id);
      const changed=current.stickers[index]?.file_unique_id!==before?.file_unique_id;
      const correctEmoji=current.stickers[index]?.emoji?.replace(/\uFE0F/g,'')===a.emoji.replace(/\uFE0F/g,'');
      const applied=current.stickers.length===expectedCount&&othersUnchanged&&correctEmoji&&(!failed||changed);
      if(applied){existing=current;break;}
      // Resolve an uncertain add by inspecting its position and count before any
      // retry. After a process restart, that position is replaced, never appended
      // a second time. Never delete/recreate the user's subscribed sticker set.
      if(!failed)throw Error('sticker_set_update_unconfirmed');
      if(failed.code==='telegram_429'&&failed.retryAfter>0&&failed.retryAfter<=60&&attempt<2){await delay(failed.retryAfter*1000+200);continue;}
      throw failed;
    }
    saved.items[a.id]={sha256:a.sha256,file_unique_id:existing.stickers[index]!.file_unique_id};await persist();
    if(paceMs)await delay(paceMs);
  }
  if(existing.stickers.length!==50||new Set(existing.stickers.map(s=>s.file_unique_id)).size!==50||existing.stickers.some((s,i)=>s.emoji?.replace(/\uFE0F/g,'')!==assets[i]!.emoji.replace(/\uFE0F/g,'')))throw Error('sticker_set_unexpected');
  if(existing.title&&existing.title!==title){await telegram.call('setStickerSetTitle',{name:STICKER_SET,title});existing.title=title;}
  return existing;
}
export async function seedStickerPack(db:Database,pack:LumenPack){
  const assets=await stickerAssets();if(pack.stickers.length!==assets.length||pack.name.toLowerCase()!==STICKER_SET.toLowerCase())throw Error('sticker_set_unexpected');
  await db.tx(async sql=>{
    await sql.query('DELETE FROM stickers WHERE lower(set_name)=lower($1) AND NOT(file_unique_id=ANY($2::text[]))',[pack.name,pack.stickers.map(s=>s.file_unique_id)]);
    for(const [index,sticker] of pack.stickers.entries()){
      const asset=assets[index]!;await rememberSticker(sql,{...sticker,emoji:asset.emoji,set_name:pack.name},null);
      await sql.query('UPDATE stickers SET description=$1,keywords=$2 WHERE file_unique_id=$3',[`${asset.label}. ${asset.description}`.slice(0,1400),asset.label+', Люмен',sticker.file_unique_id]);
    }
    const count=await sql.query('SELECT count(*)::int AS n FROM stickers WHERE lower(set_name)=lower($1)',[pack.name]);
    if(Number(count.rows[0]?.n)!==assets.length)throw Error('sticker_catalog_incomplete');
  });
  console.log(JSON.stringify({event:'sticker_catalog_ready',count:assets.length}));
}
export function stickerSetURL(){return 'https://t.me/addstickers/'+STICKER_SET;}
