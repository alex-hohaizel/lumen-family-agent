import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, atomicJSON, type Config } from './config.js';
import { Telegram } from './telegram.js';
import { ModelError } from './auth.js';

export const TEXT_PROFILE={name:'Люмен',description:'Люмен — співрозмовник для ваших груп: допомога, ігри, опитування, нотатки й нагадування. Звертайтеся на ім’я або через @згадку. У кожної групи окрема пам’ять.',commands:[{command:'help',description:'Як спілкуватися з Люменом'},{command:'privacy',description:'Як працює пам’ять групи'}]};
export async function ensureTextProfile(telegram:Telegram,config:Config,bot:{id:number;username:string}){
  if(bot.username.toLowerCase()!=='lumen_family_agent')throw new ModelError('unexpected_telegram_bot');
  const sha256=createHash('sha256').update(JSON.stringify(TEXT_PROFILE)).digest('hex'),stamp=resolve(config.runtimeDir,'text-profile.json');
  let previous:{bot_id?:number;sha256?:string}={};try{previous=JSON.parse(await readFile(stamp,'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw new ModelError('profile_state_invalid');}
  if(previous.bot_id===bot.id&&previous.sha256===sha256)return false;
  const name=await telegram.call<{name:string}>('getMyName');
  if(name.name!==TEXT_PROFILE.name)await telegram.call('setMyName',{name:TEXT_PROFILE.name});
  const description=await telegram.call<{description:string}>('getMyDescription');
  if(description.description!==TEXT_PROFILE.description)await telegram.call('setMyDescription',{description:TEXT_PROFILE.description});
  const commands=await telegram.call<{command:string;description:string}[]>('getMyCommands');
  if(JSON.stringify(commands.map(({command,description})=>({command,description})))!==JSON.stringify(TEXT_PROFILE.commands))await telegram.call('setMyCommands',{commands:TEXT_PROFILE.commands});
  await atomicJSON(stamp,{bot_id:bot.id,sha256,applied_at:new Date().toISOString()});return true;
}

export async function ensureAvatar(telegram: Telegram, config: Config, bot: { id: number; username: string }) {
  if (bot.username.toLowerCase() !== 'lumen_family_agent') throw new ModelError('unexpected_telegram_bot');
  const bytes = await readFile(new URL('../../assets/lumen-avatar.mp4', import.meta.url));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const stamp = resolve(config.runtimeDir, 'avatar.json');
  let previous: { bot_id?: number; sha256?: string } = {};
  try { previous = JSON.parse(await readFile(stamp, 'utf8')); }
  catch (e: any) { if (e.code !== 'ENOENT') throw new ModelError('avatar_state_invalid'); }
  if (previous.bot_id === bot.id && previous.sha256 === sha256) return false;
  await telegram.animatedProfile(bytes);
  await atomicJSON(stamp, { bot_id: bot.id, sha256, applied_at: new Date().toISOString() });
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = await loadConfig();
    if (!config.token) throw new ModelError('telegram_token_missing');
    const telegram = new Telegram(config.token);
    const bot = await telegram.call<{ id: number; username: string }>('getMe');
    console.log(await ensureAvatar(telegram, config, bot) ? 'Animated avatar applied.' : 'Current avatar already applied.');
  } catch (e) {
    console.error(e instanceof ModelError ? e.code : 'profile_update_failed'); process.exitCode = 1;
  }
}
