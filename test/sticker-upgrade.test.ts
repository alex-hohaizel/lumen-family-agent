import {createHash} from 'node:crypto';
import {describe,it} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {stickerAssets,ensureStickerPack,seedStickerPack,STICKER_SET,STICKER_COUNT,STICKER_TITLE,LEGACY_STICKER_SET,STICKER_CHECKPOINT_FILE,stickerSetURL,type LumenPack} from '../src/sticker-pack.js';
import {Telegram,TelegramError} from '../src/telegram.js';import {TestDB} from './helpers.js';
import {rememberSticker} from '../src/presentation.js';

describe('Публікація 120 стікерів і відновлення набору',()=>{
  it('має 120 окремих emoji, сцен, файлів і прозорих прев’ю',async()=>{
    const assets=await stickerAssets();assert.equal(assets.length,120);
    for(const key of ['id','emoji','sha256','file','scene'] as const)assert.equal(new Set(assets.map(a=>a[key])).size,120,key);
    for(const a of assets){
      assert.ok(a.motion_version===3||a.motion_version===4);assert.ok(a.description.length>20);assert.ok(a.preview);
      const bytes=await readFile(new URL('../../assets/stickers/'+a.file,import.meta.url));
      assert.equal(bytes.length,a.bytes);assert.ok(bytes.length<=262144);assert.equal(bytes.subarray(0,4).toString('hex'),'1a45dfa3');assert.equal(createHash('sha256').update(bytes).digest('hex'),a.sha256);
      const png=await readFile(new URL('../../assets/stickers/'+a.preview,import.meta.url));assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),512);assert.equal(png.readUInt32BE(20),512);assert.equal(png[25],6);
    }
  });
  it('завершує набір після 114 позицій із сумісним emoji, не змінюючи готові документи',async()=>{
    const assets=await stickerAssets(),dir=await mkdtemp(join(tmpdir(),'lumen-sticker-compat-'));
    const pending=assets[114]!;assert.equal(pending.emoji,'🫪');assert.equal(pending.telegram_emoji,'🌀');
    assert.equal(new Set(assets.map(a=>a.telegram_emoji??a.emoji)).size,120);
    const pack:LumenPack={name:STICKER_SET,title:STICKER_TITLE,stickers:assets.slice(0,114).map((a,i)=>({file_id:'file-'+i,file_unique_id:'unique-'+i,is_video:true,set_name:STICKER_SET,emoji:a.telegram_emoji??a.emoji}))};
    const originalIds=pack.stickers.map(s=>s.file_unique_id);let uploads=0;
    await writeFile(join(dir,STICKER_CHECKPOINT_FILE),JSON.stringify({set_name:STICKER_SET,items:Object.fromEntries(assets.slice(0,114).map((a,i)=>[a.id,{sha256:a.sha256,file_unique_id:originalIds[i]}]))}));
    const tg={call:async(method:string)=>{assert.equal(method,'getStickerSet');return structuredClone(pack);},multipart:async(method:string,form:FormData)=>{
      assert.equal(method,'addStickerToSet');const emoji=JSON.parse(String(form.get('sticker'))).emoji_list[0];
      if(emoji==='🫪')throw new TelegramError('telegram_400');
      const i=pack.stickers.length;pack.stickers.push({file_id:'file-'+i,file_unique_id:'unique-'+i,is_video:true,set_name:STICKER_SET,emoji});uploads++;return true;
    }} as unknown as Telegram;
    try{
      const result=await ensureStickerPack(tg,'11',dir,0);assert.equal(result.stickers.length,120);assert.equal(uploads,6);
      assert.deepEqual(result.stickers.slice(0,114).map(s=>s.file_unique_id),originalIds);assert.equal(result.stickers[114]!.emoji,'🌀');
      await ensureStickerPack(tg,'11',dir,0);assert.equal(uploads,6);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('відновлює заміни, непевне додавання й перезапуск між додаванням і checkpoint без дубля',async()=>{
    const assets=await stickerAssets(),dir=await mkdtemp(join(tmpdir(),'lumen-sticker-upgrade-'));
    const pack:LumenPack={name:STICKER_SET,title:'Люмен — 30 настроїв',stickers:assets.slice(0,30).map((a,i)=>({file_id:'old-'+i,file_unique_id:'old-unique-'+i,is_video:true,set_name:STICKER_SET,emoji:(a.telegram_emoji??a.emoji)}))};
    const attempts=new Map<number,number>();let fail7=true,rate9=true,readFailure=false,lost35=true,adds=0,titles=0;
    const tg={
      call:async(method:string,body:any)=>{
        if(method==='setStickerSetTitle'){pack.title=body.title;titles++;return true;}
        assert.equal(method,'getStickerSet');if(readFailure){readFailure=false;throw new TelegramError('telegram_network');}return structuredClone(pack);
      },
      multipart:async(method:string,form:FormData)=>{
        assert.equal(form.get('name'),STICKER_SET);
        const oldId=form.get('old_sticker'),i=oldId?pack.stickers.findIndex(s=>s.file_id===oldId):pack.stickers.length;
        assert.ok(i>=0&&i<STICKER_COUNT);assert.equal(method,oldId?'replaceStickerInSet':'addStickerToSet');attempts.set(i,(attempts.get(i)||0)+1);
        const spec=JSON.parse(String(form.get('sticker')));assert.equal(spec.format,'video');assert.equal(spec.emoji_list[0],(assets[i]!.telegram_emoji??assets[i]!.emoji));assert.ok((form.get('video') as Blob).size<=262144);
        if(i===7&&fail7){fail7=false;throw new TelegramError('telegram_503');}
        if(i===9&&rate9){rate9=false;throw new TelegramError('telegram_429',1);}
        if(!oldId)adds++;
        pack.stickers[i]={file_id:'new-'+i,file_unique_id:'new-unique-'+i,is_video:true,set_name:STICKER_SET,emoji:(assets[i]!.telegram_emoji??assets[i]!.emoji)};
        if(i===35&&lost35){lost35=false;readFailure=true;}
        if(i===3||i===31)throw new TelegramError('telegram_upload_uncertain',0,true);
        return true;
      }
    } as unknown as Telegram;
    try{
      await assert.rejects(()=>ensureStickerPack(tg,'11',dir,0),/telegram_503/);
      assert.equal(Object.keys(JSON.parse(await readFile(join(dir,STICKER_CHECKPOINT_FILE),'utf8')).items).length,7);
      await assert.rejects(()=>ensureStickerPack(tg,'11',dir,0),/telegram_network/);assert.equal(pack.stickers.length,36);
      const result=await ensureStickerPack(tg,'11',dir,0);assert.equal(result.name,STICKER_SET);assert.equal(result.stickers.length,STICKER_COUNT);assert.equal(result.title,STICKER_TITLE);assert.equal(titles,1);
      assert.ok(result.stickers.every(s=>s.file_id.startsWith('new-')));assert.equal(adds,STICKER_COUNT-30);assert.equal(attempts.get(3),1);assert.equal(attempts.get(31),1);assert.equal(attempts.get(35),2);
      const count=[...attempts.values()].reduce((a,b)=>a+b,0);assert.equal(count,STICKER_COUNT+3);await ensureStickerPack(tg,'11',dir,0);assert.equal([...attempts.values()].reduce((a,b)=>a+b,0),count);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('перевіряє останній файл до першої операції Telegram',async()=>{
    const assets=await stickerAssets(),a=assets.at(-1)!,path=new URL('../../assets/stickers/'+a.file,import.meta.url),original=await readFile(path);
    const corrupt=Buffer.from(original);corrupt[corrupt.length-1]=corrupt[corrupt.length-1]!^1;let calls=0;
    const tg={call:async()=>{calls++;},multipart:async()=>{calls++;}} as unknown as Telegram;
    try{await writeFile(path,corrupt);await assert.rejects(()=>ensureStickerPack(tg,'11'),/sticker_asset_invalid/);assert.equal(calls,0);}finally{await writeFile(path,original);}
  });
  it('створює початкові 50, додає до 120 і не змінює попередні набори',async()=>{
    const assets=await stickerAssets(),dir=await mkdtemp(join(tmpdir(),'lumen-sticker-version-'));
    const legacyState=JSON.stringify({items:{legacy:{sha256:'legacy',file_unique_id:'legacy'}}});
    await writeFile(join(dir,'sticker-pack.json'),legacyState);
    const pack:LumenPack={name:STICKER_SET,title:STICKER_TITLE,stickers:[]};
    let published=false,uploads=0;
    const tg={call:async(method:string,body:any)=>{
      assert.equal(method,'getStickerSet');assert.equal(body.name,STICKER_SET);assert.notEqual(body.name,LEGACY_STICKER_SET);
      if(!published)throw new TelegramError('telegram_400');return structuredClone(pack);
    },multipart:async(method:string,form:FormData)=>{
      assert.equal(form.get('name'),STICKER_SET);
      if(method==='createNewStickerSet'){
        assert.equal(form.get('title'),STICKER_TITLE);const specs=JSON.parse(String(form.get('stickers')));assert.equal(specs.length,50);assert.ok(specs.every((s:any,i:number)=>s.format==='video'&&s.emoji_list[0]===(assets[i]!.telegram_emoji??assets[i]!.emoji)));
        pack.stickers=assets.slice(0,50).map((a,i)=>({file_id:'published-'+i,file_unique_id:'published-unique-'+i,set_name:STICKER_SET,is_video:true,emoji:(a.telegram_emoji??a.emoji)}));published=true;
      }else{
        assert.equal(method,'addStickerToSet');const i=pack.stickers.length;const spec=JSON.parse(String(form.get('sticker')));assert.equal(spec.emoji_list[0],(assets[i]!.telegram_emoji??assets[i]!.emoji));pack.stickers.push({file_id:'published-'+i,file_unique_id:'published-unique-'+i,set_name:STICKER_SET,is_video:true,emoji:(assets[i]!.telegram_emoji??assets[i]!.emoji)});
      }
      uploads++;return true;
    }} as unknown as Telegram;
    try{
      assert.notEqual(STICKER_SET,LEGACY_STICKER_SET);assert.equal(stickerSetURL(),'https://t.me/addstickers/'+STICKER_SET);
      assert.equal((await ensureStickerPack(tg,'11',dir,0)).stickers.length,STICKER_COUNT);
      const checkpoint=JSON.parse(await readFile(join(dir,STICKER_CHECKPOINT_FILE),'utf8'));
      assert.equal(checkpoint.set_name,STICKER_SET);assert.equal(Object.keys(checkpoint.items).length,STICKER_COUNT);
      assert.equal(await readFile(join(dir,'sticker-pack.json'),'utf8'),legacyState);
      await ensureStickerPack(tg,'11',dir,0);assert.equal(uploads,1+STICKER_COUNT-50);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  for(const failure of ['count','title','content','membership'] as const)it(`не оголошує набір готовим, якщо фінальне перечитування не підтверджує ${failure}`,async()=>{
    const assets=await stickerAssets(),dir=await mkdtemp(join(tmpdir(),'lumen-sticker-readback-'));
    const pack:LumenPack={name:STICKER_SET,title:failure==='title'?'Люмен — 30 настроїв':STICKER_TITLE,stickers:assets.map((a,i)=>({file_id:'current-'+i,file_unique_id:'current-unique-'+i,is_video:true,set_name:STICKER_SET,emoji:(a.telegram_emoji??a.emoji)}))};
    const items=Object.fromEntries(assets.map((a,i)=>[a.id,{sha256:a.sha256,file_unique_id:pack.stickers[i]!.file_unique_id}]));
    await writeFile(join(dir,STICKER_CHECKPOINT_FILE),JSON.stringify({set_name:STICKER_SET,items}));
    let reads=0,titles=0;
    const tg={call:async(method:string)=>{
      if(method==='setStickerSetTitle'){titles++;return true;}
      assert.equal(method,'getStickerSet');reads++;
      const result=structuredClone(pack);
      if(reads===2){if(failure==='count')result.stickers=result.stickers.slice(0,30);if(failure==='content')result.stickers[49]!.file_unique_id='unconfirmed-version';if(failure==='membership')result.stickers[49]!.set_name=LEGACY_STICKER_SET;}
      return result;
    },multipart:async()=>{assert.fail('A matching checkpoint must not reupload stickers');}} as unknown as Telegram;
    try{
      const error={count:'sticker_set_unexpected',title:'sticker_set_title_unconfirmed',content:'sticker_set_content_unconfirmed',membership:'sticker_set_membership_unconfirmed'}[failure];
      await assert.rejects(()=>ensureStickerPack(tg,'11',dir,0),new RegExp(error));
      assert.equal(reads,2);assert.equal(titles,failure==='title'?1:0);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('репертуар групи замінює старі версії Люмена й зберігає чужі стікери',async()=>{
    const db=new TestDB();await db.init();try{
      await db.query('INSERT INTO stickers(file_id,file_unique_id,set_name) VALUES($1,$2,$3),($4,$5,$6),($7,$8,$9)',['old','old-unique',STICKER_SET,'other','other-unique','OtherSet','legacy','legacy-unique',LEGACY_STICKER_SET]);
      await db.query("INSERT INTO stickers(file_id,file_unique_id) VALUES('incoming','new-unique-0')");
      const assets=await stickerAssets();await seedStickerPack(db,{name:STICKER_SET,stickers:assets.map((a,i)=>({file_id:'new-'+i,file_unique_id:'new-unique-'+i,is_video:true,set_name:STICKER_SET,emoji:(a.telegram_emoji??a.emoji)}))});
      assert.equal((await db.query('SELECT * FROM stickers')).rows.length,STICKER_COUNT+1);assert.equal((await db.query("SELECT * FROM stickers WHERE file_id='old'")).rows.length,0);assert.equal((await db.query("SELECT * FROM stickers WHERE file_id='other'")).rows.length,1);
      assert.equal((await db.query('SELECT * FROM stickers WHERE set_name=$1',[STICKER_SET])).rows.length,STICKER_COUNT);
      assert.equal((await db.query('SELECT * FROM stickers WHERE set_name=$1',[LEGACY_STICKER_SET])).rows.length,0);
      await rememberSticker(db,{file_id:'old-reference',file_unique_id:'new-unique-0',set_name:LEGACY_STICKER_SET,emoji:'❌'},null);
      const current=(await db.query("SELECT file_id,set_name,emoji FROM stickers WHERE file_unique_id='new-unique-0'")).rows[0]!;
      assert.equal(current.file_id,'new-0');assert.equal(current.set_name,STICKER_SET);assert.equal(current.emoji,assets[0]!.emoji);
    }finally{await db.close();}
  });
});
