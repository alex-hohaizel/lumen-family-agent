import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {stickerAssets,ensureStickerPack,STICKER_SET,STICKER_TITLE,STICKER_CHECKPOINT_FILE} from '../src/sticker-pack.js';
import {Telegram,TelegramError} from '../src/telegram.js';

describe('Палітра емоцій і стабільний порядок 1.10',()=>{
  it('зберігає затверджені палітру, порядок і хеші оригіналів після адресного ремонту',async()=>{
    const release=JSON.parse(await readFile(new URL('../../test/fixtures/sticker-release-1131.json',import.meta.url),'utf8'));
    const plan=release.palette,assets=await stickerAssets(),archive=release.original50;
    assert.equal(plan.face_keyboard.length,104);assert.equal(plan.extra_emotions.length,11);assert.equal(plan.retained_gestures.length,5);
    assert.deepEqual(new Set(assets.map(x=>x.emoji)),new Set([...plan.face_keyboard,...plan.extra_emotions,...plan.retained_gestures]));
    assert.deepEqual(assets.map(x=>x.id),release.ordered_ids);
    const retained=assets.filter(x=>archive.some((a:any)=>a.id===x.id));assert.equal(retained.length,31);assert.equal(assets.length-retained.length,89);
    assert.equal(release.repairs.length,35);
    for(const a of retained){
      const original=archive.find((x:any)=>x.id===a.id);assert.equal(a.file,original.file);
      if(a.sha256!==original.sha256){
        assert.equal(a.motion_version,6);const accepted=release.repairs.find((row:any)=>row.id===a.id);assert.ok(accepted,a.id);
        assert.equal(accepted.before_sha256,original.sha256);assert.equal(accepted.after_sha256,a.sha256);
      }
      const bytes=await readFile(new URL('../../assets/stickers/'+a.file,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),a.sha256);
    }
    const first=assets.slice(0,20).map(x=>x.emoji);for(const emoji of ['😂','🥰','🤔','😤','🫠','😱','🙄','🥹','😭','😎','🤨','😴','😬'])assert.ok(first.includes(emoji),emoji);
    const firstCategories=assets.slice(0,20).map(asset=>(asset as typeof asset & {category?:string}).category);
    assert.deepEqual(firstCategories,release.first20_categories);assert.ok(new Set(firstCategories).size>=10);
    for(const omitted of ['👹','👺','👽','👾','😺'])assert.ok(!assets.some(x=>x.emoji===omitted));
  });
  it('відновлює порядок відомих документів без повторного завантаження, навіть після втраченої відповіді Telegram',async()=>{
    const assets=await stickerAssets(),dir=await mkdtemp(join(tmpdir(),'lumen-sticker-order-'));
    const ordered=assets.map((a,i)=>({file_id:'file-'+i,file_unique_id:'unique-'+i,is_video:true,set_name:STICKER_SET,emoji:(a.telegram_emoji??a.emoji)}));
    const pack={name:STICKER_SET,title:STICKER_TITLE,stickers:ordered.toReversed()};let moves=0;
    await writeFile(join(dir,STICKER_CHECKPOINT_FILE),JSON.stringify({set_name:STICKER_SET,items:Object.fromEntries(assets.map((a,i)=>[a.id,{sha256:a.sha256,file_unique_id:ordered[i]!.file_unique_id}]))}));
    const tg={call:async(method:string,body:any)=>{
      if(method==='getStickerSet'){assert.equal(body.name,STICKER_SET);return structuredClone(pack);}
      assert.equal(method,'setStickerPositionInSet');const old=pack.stickers.findIndex(x=>x.file_id===body.sticker);assert.ok(old>=0);const [item]=pack.stickers.splice(old,1);pack.stickers.splice(body.position,0,item!);moves++;
      if(moves===1)throw new TelegramError('telegram_network',0,true);return true;
    },multipart:async()=>{assert.fail('Reordering must preserve uploaded document identities');}} as unknown as Telegram;
    try{
      const result=await ensureStickerPack(tg,'11',dir,0);assert.deepEqual(result.stickers.map(x=>x.file_unique_id),ordered.map(x=>x.file_unique_id));assert.equal(moves,assets.length-1);
      await ensureStickerPack(tg,'11',dir,0);assert.equal(moves,assets.length-1);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
});
