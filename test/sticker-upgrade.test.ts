import {describe,it} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {stickerAssets,ensureStickerPack,seedStickerPack,STICKER_SET} from '../src/sticker-pack.js';
import {Telegram,TelegramError} from '../src/telegram.js';import {TestDB} from './helpers.js';

describe('Оновлення 30 стікерів без зміни посилання',()=>{
  it('замінює в тому самому наборі, відновлюється після збою та не повторює виконане',async()=>{
    const assets=await stickerAssets();assert.ok(assets.every(a=>a.motion_version===5));const dir=await mkdtemp(join(tmpdir(),'lumen-sticker-upgrade-'));
    const pack={name:STICKER_SET,stickers:assets.map((a,i)=>({file_id:'old-'+i,file_unique_id:'old-unique-'+i,is_video:true,emoji:a.emoji}))};let temporaryFailure=true;const attempts=new Map<number,number>();
    const tg={call:async(method:string)=>{assert.equal(method,'getStickerSet');return structuredClone(pack);},multipart:async(method:string,form:FormData)=>{assert.equal(method,'replaceStickerInSet');assert.equal(form.get('name'),STICKER_SET);const old=String(form.get('old_sticker'));const i=pack.stickers.findIndex(s=>s.file_id===old);assert.ok(i>=0);attempts.set(i,(attempts.get(i)||0)+1);const spec=JSON.parse(String(form.get('sticker')));assert.equal(spec.format,'video');assert.equal(spec.emoji_list[0],assets[i]!.emoji);assert.ok((form.get('video') as Blob).size<=256*1024);
      if(i===7&&temporaryFailure){temporaryFailure=false;throw new TelegramError('telegram_429',1);}
      pack.stickers[i]={...pack.stickers[i]!,file_id:'new-'+i,file_unique_id:'new-unique-'+i};if(i===3)throw new TelegramError('telegram_upload_uncertain',0,true);return true;
    }} as unknown as Telegram;
    try{await assert.rejects(()=>ensureStickerPack(tg,'11',dir,0),/telegram_429/);const partial=JSON.parse(await readFile(join(dir,'sticker-pack.json'),'utf8'));assert.equal(Object.keys(partial.items).length,7);const result=await ensureStickerPack(tg,'11',dir,0);assert.equal(result.name,STICKER_SET);assert.equal(result.stickers.length,30);assert.ok(result.stickers.every(s=>s.file_id.startsWith('new-')));const count=[...attempts.values()].reduce((a,b)=>a+b,0);assert.equal(count,31);assert.equal(attempts.get(3),1);await ensureStickerPack(tg,'11',dir,0);assert.equal([...attempts.values()].reduce((a,b)=>a+b,0),count);}finally{await rm(dir,{recursive:true,force:true});}
  });
  it('репертуар групи замінює старі версії Люмена й зберігає чужі стікери',async()=>{
    const db=new TestDB();await db.init();try{await db.query('INSERT INTO stickers(file_id,file_unique_id,set_name) VALUES($1,$2,$3),($4,$5,$6)',['old','old-unique',STICKER_SET,'other','other-unique','OtherSet']);const assets=await stickerAssets();await seedStickerPack(db,{name:STICKER_SET,stickers:assets.map((a,i)=>({file_id:'new-'+i,file_unique_id:'new-unique-'+i,is_video:true,emoji:a.emoji}))});assert.equal((await db.query('SELECT * FROM stickers')).rows.length,31);assert.equal((await db.query("SELECT * FROM stickers WHERE file_id='old'")).rows.length,0);assert.equal((await db.query("SELECT * FROM stickers WHERE file_id='other'")).rows.length,1);}finally{await db.close();}
  });
});
