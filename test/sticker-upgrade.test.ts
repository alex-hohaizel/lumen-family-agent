import {createHash} from 'node:crypto';
import {describe,it} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {stickerAssets,ensureStickerPack,seedStickerPack,STICKER_SET,type LumenPack} from '../src/sticker-pack.js';
import {Telegram,TelegramError} from '../src/telegram.js';import {TestDB} from './helpers.js';

describe('Оновлення 30 → 50 стікерів зі збереженням посилання',()=>{
  it('має 50 окремих emoji, сцен, файлів і прозорих прев’ю',async()=>{
    const assets=await stickerAssets();assert.equal(assets.length,50);
    for(const key of ['id','emoji','sha256','file','scene'] as const)assert.equal(new Set(assets.map(a=>a[key])).size,50,key);
    for(const a of assets){
      assert.equal(a.motion_version,3);assert.ok(a.description.length>20);assert.ok(a.preview);
      const bytes=await readFile(new URL('../../assets/stickers/'+a.file,import.meta.url));
      assert.equal(bytes.length,a.bytes);assert.ok(bytes.length<=262144);assert.equal(bytes.subarray(0,4).toString('hex'),'1a45dfa3');assert.equal(createHash('sha256').update(bytes).digest('hex'),a.sha256);
      const png=await readFile(new URL('../../assets/stickers/'+a.preview,import.meta.url));assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),512);assert.equal(png.readUInt32BE(20),512);assert.equal(png[25],6);
    }
  });
  it('відновлює заміни, непевне додавання й перезапуск між додаванням і checkpoint без дубля',async()=>{
    const assets=await stickerAssets(),dir=await mkdtemp(join(tmpdir(),'lumen-sticker-upgrade-'));
    const pack:LumenPack={name:STICKER_SET,title:'Люмен — 30 настроїв',stickers:assets.slice(0,30).map((a,i)=>({file_id:'old-'+i,file_unique_id:'old-unique-'+i,is_video:true,emoji:a.emoji}))};
    const attempts=new Map<number,number>();let fail7=true,rate9=true,readFailure=false,lost35=true,adds=0,titles=0;
    const tg={
      call:async(method:string,body:any)=>{
        if(method==='setStickerSetTitle'){pack.title=body.title;titles++;return true;}
        assert.equal(method,'getStickerSet');if(readFailure){readFailure=false;throw new TelegramError('telegram_network');}return structuredClone(pack);
      },
      multipart:async(method:string,form:FormData)=>{
        assert.equal(form.get('name'),STICKER_SET);
        const oldId=form.get('old_sticker'),i=oldId?pack.stickers.findIndex(s=>s.file_id===oldId):pack.stickers.length;
        assert.ok(i>=0&&i<50);assert.equal(method,oldId?'replaceStickerInSet':'addStickerToSet');attempts.set(i,(attempts.get(i)||0)+1);
        const spec=JSON.parse(String(form.get('sticker')));assert.equal(spec.format,'video');assert.equal(spec.emoji_list[0],assets[i]!.emoji);assert.ok((form.get('video') as Blob).size<=262144);
        if(i===7&&fail7){fail7=false;throw new TelegramError('telegram_503');}
        if(i===9&&rate9){rate9=false;throw new TelegramError('telegram_429',1);}
        if(!oldId)adds++;
        pack.stickers[i]={file_id:'new-'+i,file_unique_id:'new-unique-'+i,is_video:true,emoji:assets[i]!.emoji};
        if(i===35&&lost35){lost35=false;readFailure=true;}
        if(i===3||i===31)throw new TelegramError('telegram_upload_uncertain',0,true);
        return true;
      }
    } as unknown as Telegram;
    try{
      await assert.rejects(()=>ensureStickerPack(tg,'11',dir,0),/telegram_503/);
      assert.equal(Object.keys(JSON.parse(await readFile(join(dir,'sticker-pack.json'),'utf8')).items).length,7);
      await assert.rejects(()=>ensureStickerPack(tg,'11',dir,0),/telegram_network/);assert.equal(pack.stickers.length,36);
      const result=await ensureStickerPack(tg,'11',dir,0);assert.equal(result.name,STICKER_SET);assert.equal(result.stickers.length,50);assert.equal(result.title,'Люмен — 50 емоцій');assert.equal(titles,1);
      assert.ok(result.stickers.every(s=>s.file_id.startsWith('new-')));assert.equal(adds,20);assert.equal(attempts.get(3),1);assert.equal(attempts.get(31),1);assert.equal(attempts.get(35),2);
      const count=[...attempts.values()].reduce((a,b)=>a+b,0);assert.equal(count,53);await ensureStickerPack(tg,'11',dir,0);assert.equal([...attempts.values()].reduce((a,b)=>a+b,0),count);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('перевіряє останній файл до першої операції Telegram',async()=>{
    const assets=await stickerAssets(),a=assets.at(-1)!,path=new URL('../../assets/stickers/'+a.file,import.meta.url),original=await readFile(path);
    const corrupt=Buffer.from(original);corrupt[corrupt.length-1]=corrupt[corrupt.length-1]!^1;let calls=0;
    const tg={call:async()=>{calls++;},multipart:async()=>{calls++;}} as unknown as Telegram;
    try{await writeFile(path,corrupt);await assert.rejects(()=>ensureStickerPack(tg,'11'),/sticker_asset_invalid/);assert.equal(calls,0);}finally{await writeFile(path,original);}
  });
  it('репертуар групи замінює старі версії Люмена й зберігає чужі стікери',async()=>{
    const db=new TestDB();await db.init();try{
      await db.query('INSERT INTO stickers(file_id,file_unique_id,set_name) VALUES($1,$2,$3),($4,$5,$6)',['old','old-unique',STICKER_SET,'other','other-unique','OtherSet']);
      await db.query("INSERT INTO stickers(file_id,file_unique_id) VALUES('incoming','new-unique-0')");
      const assets=await stickerAssets();await seedStickerPack(db,{name:STICKER_SET,stickers:assets.map((a,i)=>({file_id:'new-'+i,file_unique_id:'new-unique-'+i,is_video:true,emoji:a.emoji}))});
      assert.equal((await db.query('SELECT * FROM stickers')).rows.length,51);assert.equal((await db.query("SELECT * FROM stickers WHERE file_id='old'")).rows.length,0);assert.equal((await db.query("SELECT * FROM stickers WHERE file_id='other'")).rows.length,1);
      assert.equal((await db.query('SELECT * FROM stickers WHERE set_name=$1',[STICKER_SET])).rows.length,50);
    }finally{await db.close();}
  });
});
