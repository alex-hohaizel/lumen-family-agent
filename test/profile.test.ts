import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAvatar,ensureTextProfile,TEXT_PROFILE } from '../src/profile.js';
import { ConfigSchema } from '../src/config.js';
import { Telegram } from '../src/telegram.js';

describe('Встановлення анімованого профілю', () => {
  const bot = { id: 123, username: 'lumen_family_agent' };
  it('надсилає анімований MP4 один раз, а перезапуск пропускає', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lumen-avatar-')); let calls = 0;
    const telegram = new Telegram('test', (async (url: any, init: any) => {
      calls++; assert.match(String(url), /\/setMyProfilePhoto$/);
      const form = init.body as FormData;
      const photo = JSON.parse(String(form.get('photo')));
      assert.equal(photo.type, 'animated'); assert.equal(photo.animation, 'attach://avatar');
      const file = form.get('avatar') as File; assert.equal(file.type, 'video/mp4'); assert.ok(file.size > 0);
      return Response.json({ ok: true, result: true });
    }) as typeof fetch);
    const config = ConfigSchema.parse({ runtimeDir: dir });
    assert.equal(await ensureAvatar(telegram, config, bot), true);
    assert.equal(await ensureAvatar(telegram, config, bot), false); assert.equal(calls, 1);
  });
  it('не змінює профіль іншого бота за помилкового токена', async () => {
    const config = ConfigSchema.parse({ runtimeDir: await mkdtemp(join(tmpdir(), 'lumen-avatar-')) }); let calls = 0;
    const telegram = new Telegram('test', (async () => { calls++; return Response.json({ ok: true, result: true }); }) as typeof fetch);
    await assert.rejects(() => ensureAvatar(telegram, config, { id: 555, username: 'another_bot' }), /unexpected_telegram_bot/);
    assert.equal(calls, 0);
  });
  it('після відмови Telegram не записує хибний успіх', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lumen-avatar-'));
    const config = ConfigSchema.parse({ runtimeDir: dir });
    const telegram = new Telegram('test', (async () => Response.json({ ok: false, error_code: 429 }, { status: 429 })) as typeof fetch);
    await assert.rejects(() => ensureAvatar(telegram, config, bot), /telegram_429/);
    await assert.rejects(() => access(join(dir, 'avatar.json')));
  });
  it('зміна файлу анімації оновлює попередню позначку лише після успіху', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lumen-avatar-')); let calls = 0;
    await writeFile(join(dir, 'avatar.json'), JSON.stringify({ bot_id: bot.id, sha256: 'old-version' }));
    const telegram = new Telegram('test', (async () => { calls++; return Response.json({ ok: true, result: true }); }) as typeof fetch);
    assert.equal(await ensureAvatar(telegram, ConfigSchema.parse({ runtimeDir: dir }), bot), true); assert.equal(calls, 1);
  });
  it('не переписує незмінений текстовий профіль і не викликає API на повторному старті',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'lumen-text-profile-'));let reads=0;const telegram=new Telegram('test',(async(url:any)=>{const method=String(url).split('/').at(-1);reads++;assert.ok(method?.startsWith('get'));const result=method==='getMyName'?{name:TEXT_PROFILE.name}:method==='getMyDescription'?{description:TEXT_PROFILE.description}:TEXT_PROFILE.commands;return Response.json({ok:true,result});}) as typeof fetch);const c=ConfigSchema.parse({runtimeDir:dir});assert.equal(await ensureTextProfile(telegram,c,bot),true);assert.equal(reads,3);assert.equal(await ensureTextProfile(telegram,c,bot),false);assert.equal(reads,3);
  });
  it('ліміт Telegram на зміну імені не записує хибну позначку успіху',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'lumen-text-profile-'));const telegram=new Telegram('test',(async(url:any)=>String(url).endsWith('/getMyName')?Response.json({ok:true,result:{name:'Старе ім’я'}}):Response.json({ok:false,error_code:429,parameters:{retry_after:60}},{status:429})) as typeof fetch);await assert.rejects(()=>ensureTextProfile(telegram,ConfigSchema.parse({runtimeDir:dir}),bot),/telegram_429/);await assert.rejects(()=>access(join(dir,'text-profile.json')));
  });

});
