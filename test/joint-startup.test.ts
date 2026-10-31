import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigSchema,loadConfig} from '../src/config.js';
import {activateWithStickerPack,assertJointStickerAssets,JOINT_STICKER_FINGERPRINT,stickerReleaseFingerprint} from '../src/joint-startup.js';
import {stickerAssets,STICKER_SET,STICKER_TITLE,STICKER_CHECKPOINT_FILE,type LumenPack} from '../src/sticker-pack.js';
import {Telegram,TelegramError} from '../src/telegram.js';

async function packFixture(finalRead?:(pack:LumenPack)=>Promise<LumenPack>){
  const assets=await stickerAssets(),dir=await mkdtemp(join(tmpdir(),'lumen-joint-start-'));
  const pack:LumenPack={name:STICKER_SET,title:STICKER_TITLE,stickers:assets.map((asset,index)=>({file_id:'joint-'+index,file_unique_id:'joint-unique-'+index,is_video:true,set_name:STICKER_SET,emoji:asset.telegram_emoji??asset.emoji}))};
  await writeFile(join(dir,STICKER_CHECKPOINT_FILE),JSON.stringify({set_name:STICKER_SET,items:Object.fromEntries(assets.map((asset,index)=>[asset.id,{sha256:asset.sha256,file_unique_id:pack.stickers[index]!.file_unique_id}]))}));
  let reads=0,uploads=0;
  const telegram={call:async(method:string)=>{
    assert.equal(method,'getStickerSet');reads++;
    const current=structuredClone(pack);return reads===2&&finalRead?finalRead(current):current;
  },multipart:async()=>{uploads++;assert.fail('An exact checkpoint requires no upload');}} as unknown as Telegram;
  return {telegram,dir,pack,reads:()=>reads,uploads:()=>uploads,close:()=>rm(dir,{recursive:true,force:true})};
}

test('required joint startup activates only after real final readback of the approved 120',async()=>{
  const f=await packFixture(),events:string[]=[];
  try{
    const result=await activateWithStickerPack({telegram:f.telegram,ownerId:'11',runtimeDir:f.dir,requireVerified:true,paceMs:0,ready:pack=>{assert.equal(pack.stickers.length,120);assert.equal(f.reads(),2);events.push('verified');}},async pack=>{assert.equal(pack!.name,STICKER_SET);assert.equal(pack!.stickers.length,120);events.push('activate');return 'runtime';});
    assert.equal(result,'runtime');assert.deepEqual(events,['verified','activate']);assert.equal(f.uploads(),0);
  }finally{await f.close();}
});

test('required startup accepts a verified Telegram set name with different letter case',async()=>{
  const f=await packFixture(async pack=>({...pack,name:pack.name.toLowerCase()}));let activation=0;
  try{
    await activateWithStickerPack({telegram:f.telegram,ownerId:'11',runtimeDir:f.dir,requireVerified:true,paceMs:0},async pack=>{assert.equal(pack!.name,STICKER_SET.toLowerCase());activation++;});
    assert.equal(activation,1);assert.equal(f.reads(),2);
  }finally{await f.close();}
});

test('deferred final Telegram readback cannot activate runtimes, polling or release notices early',async()=>{
  let enter!:()=>void,release!:(pack:LumenPack)=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),held=new Promise<LumenPack>(resolve=>{release=resolve;});
  const f=await packFixture(async()=>{enter();return held;}),effects={runtimes:0,polling:0,notice:0};
  try{
    const pending=activateWithStickerPack({telegram:f.telegram,ownerId:'11',runtimeDir:f.dir,requireVerified:true,paceMs:0},async()=>{effects.runtimes++;effects.polling++;effects.notice++;return true;});
    await entered;assert.deepEqual(effects,{runtimes:0,polling:0,notice:0});
    release(structuredClone(f.pack));assert.equal(await pending,true);assert.deepEqual(effects,{runtimes:1,polling:1,notice:1});
  }finally{release(structuredClone(f.pack));await f.close();}
});

for(const invalid of ['count','membership','order','unknown'] as const)test(`required joint startup blocks activation after late ${invalid} readback failure`,async()=>{
  const f=await packFixture(async pack=>{
    if(invalid==='unknown')throw new TelegramError('telegram_network');
    if(invalid==='count')pack.stickers.pop();
    if(invalid==='membership')pack.stickers[119]!.set_name='Other_by_other_bot';
    if(invalid==='order')[pack.stickers[118],pack.stickers[119]]=[pack.stickers[119]!,pack.stickers[118]!];
    return pack;
  });let activated=0,failures=0;
  try{
    await assert.rejects(activateWithStickerPack({telegram:f.telegram,ownerId:'11',runtimeDir:f.dir,requireVerified:true,paceMs:0,failed:()=>{failures++;}},async()=>{activated++;}),invalid==='unknown'?/telegram_network/:/sticker_set_/);
    assert.equal(activated,0);assert.equal(failures,1);assert.equal(f.reads(),2);assert.equal(f.uploads(),0);
  }finally{await f.close();}
});

test('required startup without the registry owner cannot contact Telegram or activate',async()=>{
  let api=0,activation=0;const telegram={call:async()=>{api++;}} as unknown as Telegram;
  await assert.rejects(activateWithStickerPack({telegram,ownerId:null,requireVerified:true},async()=>{activation++;}),/joint_sticker_owner_required/);
  assert.equal(api,0);assert.equal(activation,0);
});

test('an older or reordered 120-item asset list cannot satisfy the approved release fingerprint',async()=>{
  const assets=await stickerAssets();assert.equal(assets.length,120);assert.equal(stickerReleaseFingerprint(assets),JOINT_STICKER_FINGERPRINT);assertJointStickerAssets(assets);
  const old=assets.map(asset=>({...asset}));old[119]!.sha256='0'.repeat(64);
  assert.throws(()=>assertJointStickerAssets(old),/joint_sticker_assets_unapproved/);
  assert.throws(()=>assertJointStickerAssets([...assets.slice(1),assets[0]!]),/joint_sticker_assets_unapproved/);
  assert.throws(()=>assertJointStickerAssets(assets.slice(0,119)),/joint_sticker_assets_unapproved/);
});

test('legacy optional startup without owner preserves onboarding and skips Telegram',async()=>{
  let api=0;const telegram={call:async()=>{api++;}} as unknown as Telegram;
  assert.equal(await activateWithStickerPack({telegram,requireVerified:false},async pack=>{assert.equal(pack,undefined);return 'onboarding';}),'onboarding');assert.equal(api,0);
});

test('legacy optional ensure failure activates once without a pack',async()=>{
  let activation=0,failures=0;const telegram={call:async()=>{throw new TelegramError('telegram_network');}} as unknown as Telegram;
  assert.equal(await activateWithStickerPack({telegram,ownerId:'11',requireVerified:false,paceMs:0,failed:()=>{failures++;}},async pack=>{activation++;assert.equal(pack,undefined);return 'legacy';}),'legacy');
  assert.equal(activation,1);assert.equal(failures,1);
});

test('runtime activation errors propagate once instead of being treated as sticker failure',async()=>{
  const f=await packFixture();let activation=0,failures=0;
  try{
    await assert.rejects(activateWithStickerPack({telegram:f.telegram,ownerId:'11',runtimeDir:f.dir,requireVerified:false,paceMs:0,failed:()=>{failures++;}},async()=>{activation++;throw Error('runtime_init_failed');}),/runtime_init_failed/);
    assert.equal(activation,1);assert.equal(failures,0);
  }finally{await f.close();}
});

test('joint release flag defaults false and accepts only exact true or false env overrides',async()=>{
  assert.equal(ConfigSchema.parse({}).requireVerifiedStickerPack,false);
  const dir=await mkdtemp(join(tmpdir(),'lumen-joint-config-')),savedDir=process.env.RUNTIME_DIR,savedFlag=process.env.LUMEN_REQUIRE_VERIFIED_STICKER_PACK;
  try{
    process.env.RUNTIME_DIR=dir;delete process.env.LUMEN_REQUIRE_VERIFIED_STICKER_PACK;assert.equal((await loadConfig()).requireVerifiedStickerPack,false);
    process.env.LUMEN_REQUIRE_VERIFIED_STICKER_PACK='true';assert.equal((await loadConfig()).requireVerifiedStickerPack,true);
    await writeFile(join(dir,'config.json'),JSON.stringify({requireVerifiedStickerPack:true}));
    process.env.LUMEN_REQUIRE_VERIFIED_STICKER_PACK='false';assert.equal((await loadConfig()).requireVerifiedStickerPack,false);
    for(const invalid of ['TRUE','yes','1','']){process.env.LUMEN_REQUIRE_VERIFIED_STICKER_PACK=invalid;await assert.rejects(loadConfig(),/invalid_joint_sticker_pack_flag/);}
  }finally{
    if(savedDir===undefined)delete process.env.RUNTIME_DIR;else process.env.RUNTIME_DIR=savedDir;
    if(savedFlag===undefined)delete process.env.LUMEN_REQUIRE_VERIFIED_STICKER_PACK;else process.env.LUMEN_REQUIRE_VERIFIED_STICKER_PACK=savedFlag;
    await rm(dir,{recursive:true,force:true});
  }
});
