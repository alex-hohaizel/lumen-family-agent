import { createHmac } from 'node:crypto';
import type { Config } from './config.js';
import type { InlineKeyboard } from './telegram.js';
import { secureEqual } from './auth.js';

const button=(text:string,callback_data:string)=>({text,callback_data:`lumen:${callback_data}`});
export const CONSENT_KEYS:InlineKeyboard={inline_keyboard:[
  [button('👋 Можемо знайомитися','consent')],
  [button('Що ти вмієш?','help'),button('Як працює пам’ять?','privacy')]
]};
export const HOME_KEYS:InlineKeyboard={inline_keyboard:[
  [button('🎲 Пограти','games'),button('📊 Опитування','poll')],
  [button('⏰ Нагадування','reminders'),button('📝 Нотатки','notes')],
  [button('⚙️ Мій стиль','preferences'),button('🔒 Пам’ять групи','privacy')]
]};
export const GAME_KEYS:InlineKeyboard={inline_keyboard:[
  [button('Вікторина','game:quiz'),button('Детектив','game:detective')],
  [button('20 запитань','game:twenty'),button('Історія по черзі','game:story')],
  [button('Аргументи','game:debate'),button('Зупинити гру','stopgame')],
  [button('← Можливості','menu')]
]};
export const PREFERENCE_KEYS:InlineKeyboard={inline_keyboard:[
  [button('Коротко','style:short'),button('Звичайно','style:balanced'),button('Докладно','style:detailed')],
  [button('З гумором','humor:light'),button('Без жартів','humor:off')],
  [button('← Можливості','menu')]
]};
export const INITIATIVE_KEYS:InlineKeyboard={inline_keyboard:[
  [button('Лише коли звертаємось','mode:quiet')],
  [button('← Можливості','menu')]
]};
export const PRIVACY_KEYS:InlineKeyboard={inline_keyboard:[
  [button('Пауза пам’яті','pause'),button('Поновити спілкування','consent')],
  [button('← Можливості','menu')]
]};

const COMMANDS:Record<string,string>={consent:'/consent',menu:'/menu',help:'/help',privacy:'/privacy',games:'/games',notes:'/notes',reminders:'/reminders',poll:'/poll',preferences:'/preferences',initiative:'/initiative',stopgame:'/stopgame',pause:'/pause'};
export function callbackCommand(data:string){
  if(!data.startsWith('lumen:')||data.length>64)return undefined;
  const key=data.slice(6);
  if(COMMANDS[key])return COMMANDS[key];
  const match=/^(game|style|humor|mode):([a-z]+)$/.exec(key);
  if(!match)return undefined;
  const allowed:Record<string,string[]>={game:['quiz','detective','twenty','story','debate'],style:['short','balanced','detailed'],humor:['off','light'],mode:['quiet','social','host']};
  return allowed[match[1]!]!.includes(match[2]!)?`/${match[1]} ${match[2]}`:undefined;
}

// A private activation link replaces copying a server secret. After the owner is known,
// adding the bot to a group is sufficient; the link never enters conversational memory.
export function setupPayload(config:Config){
  return config.pairCodeHash?`setup_${createHmac('sha256',config.pairCodeHash).update('lumen-owner-setup-v1').digest('base64url')}`:'';
}
export function validSetupPayload(payload:string,config:Config){const expected=setupPayload(config);return !!expected&&secureEqual(payload,expected);}
export function ownerSetupLink(username:string,config:Config){return `https://t.me/${username}?start=${setupPayload(config)}`;}
export function groupSetupKeys(username:string,config:Config):InlineKeyboard{
  return {inline_keyboard:[[{text:'➕ Додати Люмена в нашу групу',url:`https://t.me/${username}?startgroup=${setupPayload(config)}`}]]};
}
