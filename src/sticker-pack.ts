import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {atomicJSON} from './config.js';
import {createHash} from 'node:crypto';
import {Telegram,type TGSticker} from './telegram.js';
import {rememberSticker} from './presentation.js';
import type {Database} from './db.js';

export const STICKER_SET='Lumen_Moods_by_lumen_family_agent';
export interface StickerAsset {id:string;emoji:string;label:string;description:string;file:string;bytes:number;sha256:string;motion_version?:number;}
export interface LumenPack {name:string;stickers:TGSticker[];title?:string;}
export async function stickerAssets(){return JSON.parse(await readFile(new URL('../../assets/stickers/manifest.json',import.meta.url),'utf8')) as StickerAsset[];}
export async function ensureStickerPack(telegram:Telegram,ownerId:string,runtimeDir?:string,paceMs=200){
  const assets=await stickerAssets();if(assets.length!==30)throw Error('sticker_assets_incomplete');
  let existing:LumenPack|undefined;let created=false;
  try{existing=await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET});}catch(e:any){if(e.code!=='telegram_400')throw e;}
  if(!existing){
    created=true;
    const form=new FormData();form.set('user_id',ownerId);form.set('name',STICKER_SET);form.set('title','Люмен — 30 настроїв');form.set('sticker_type','regular');
    const stickers=[];
    for(const [index,a] of assets.entries()){
      if(!/^[a-z0-9_]+\.webm$/.test(a.file))throw Error('sticker_asset_path_invalid');
      const bytes=await readFile(new URL('../../assets/stickers/'+a.file,import.meta.url));if(bytes.length>256*1024||createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw Error('sticker_asset_invalid');
      const field='sticker'+index;form.set(field,new Blob([bytes],{type:'video/webm'}),a.file);stickers.push({sticker:'attach://'+field,format:'video',emoji_list:[a.emoji],keywords:[a.label,'Люмен']});
    }
    form.set('stickers',JSON.stringify(stickers));
    try{await telegram.multipart('createNewStickerSet',form);}catch(e){try{existing=await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET});}catch{throw e;}}
    existing ||= await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET});
  }
  if(existing.name.toLowerCase()!==STICKER_SET.toLowerCase()||existing.stickers?.length!==assets.length||existing.stickers.some(s=>!s.is_video))throw Error('sticker_set_unexpected');
  if(runtimeDir&&assets.every(a=>(a.motion_version || 1)>=2)){
    const path=resolve(runtimeDir,'sticker-pack.json');let saved:{items:Record<string,{sha256:string;file_unique_id:string}>}={items:{}};
    try{saved=JSON.parse(await readFile(path,'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw Error('sticker_checkpoint_invalid');}
    saved.items ||= {};
    if(created){for(const [index,a] of assets.entries())saved.items[a.id]={sha256:a.sha256,file_unique_id:existing.stickers[index]!.file_unique_id};await atomicJSON(path,saved);}
    for(const [index,a] of assets.entries()){
      const before=existing.stickers[index]!;const checkpoint=saved.items[a.id];if(checkpoint?.sha256===a.sha256&&checkpoint.file_unique_id===before.file_unique_id)continue;
      if(!/^[a-z0-9_]+\.webm$/.test(a.file))throw Error('sticker_asset_path_invalid');
      const bytes=await readFile(new URL('../../assets/stickers/'+a.file,import.meta.url));if(bytes.length>256*1024||createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw Error('sticker_asset_invalid');
      const form=new FormData();form.set('user_id',ownerId);form.set('name',STICKER_SET);form.set('old_sticker',before.file_id);form.set('video',new Blob([bytes],{type:'video/webm'}),a.file);form.set('sticker',JSON.stringify({sticker:'attach://video',format:'video',emoji_list:[a.emoji],keywords:[a.label,'Люмен']}));
      try{await telegram.multipart('replaceStickerInSet',form);}catch(e:any){const current=await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET});if(current.stickers?.length!==30||current.stickers[index]!.file_unique_id===before.file_unique_id)throw e;}
      existing=await telegram.call<LumenPack>('getStickerSet',{name:STICKER_SET});if(existing.stickers?.length!==30||existing.stickers.some(s=>!s.is_video))throw Error('sticker_set_unexpected');
      saved.items[a.id]={sha256:a.sha256,file_unique_id:existing.stickers[index]!.file_unique_id};await atomicJSON(path,saved);
      if(paceMs)await delay(paceMs);
    }
  }
  return existing;
}
export async function seedStickerPack(db:Database,pack:LumenPack){
  const assets=await stickerAssets();if(pack.stickers.length!==assets.length)throw Error('sticker_set_unexpected');
  await db.tx(async sql=>{await sql.query('DELETE FROM stickers WHERE set_name=$1 AND NOT(file_unique_id=ANY($2::text[]))',[pack.name,pack.stickers.map(s=>s.file_unique_id)]);for(const [index,sticker] of pack.stickers.entries()){await rememberSticker(sql,{...sticker,set_name:pack.name},null);const asset=assets[index]!;await sql.query('UPDATE stickers SET description=$1,keywords=$2 WHERE file_unique_id=$3',[`${asset.label}. ${asset.description}`.slice(0,1400),asset.label+', Люмен',sticker.file_unique_id]);}});
}
export function stickerSetURL(){return 'https://t.me/addstickers/'+STICKER_SET;}
