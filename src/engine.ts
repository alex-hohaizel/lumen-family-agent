import { createHash } from 'node:crypto';
import { state, one, queueText, queueAnimation, eraseAll, forgetPhrase, type Database, type SQL } from './db.js';
import type { Config } from './config.js';
import { type Telegram, type Update, type Message, usernameMatches } from './telegram.js';
import { type Brain, type Plan, type Action, PlanSchema } from './model.js';
import { ChatGPTAuth, ModelError, models, secureEqual } from './auth.js';
import { HELP, WELCOME } from './personality.js';
import { GAME_NAMES, startGame, gameTurn, publicGame } from './games.js';
import { Media } from './media.js';
import { DEFAULT_PREFERENCES, seriousConversation, socialDecision, responseGuidance, type Preferences, type ConversationLine } from './behavior.js';

export interface BotIdentity {id:number;username:string;can_read_all_group_messages?:boolean;}
export function errorCode(e:unknown) {return e instanceof ModelError?e.code:(e as any)?.code==='23505'?'duplicate_operation':'operation_failed';}
function userName(m:Message){return [m.from?.first_name,m.from?.last_name].filter(Boolean).join(' ').slice(0,80) || 'Учасник';}
function textOf(m:Message){return (m.text || m.caption || (m.photo?'[фото]':m.voice?'[голосове]':m.document?'[файл]':'')).slice(0,12000);}
export function isQuietHour(date:Date,timezone:string,start:number,end:number){
  if(start===end)return false;
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'}).format(date));
  return start<end?hour>=start&&hour<end:hour>=start||hour<end;
}
export function addressed(m:Message,bot:BotIdentity){
  return /^\s*(люмен|lumen)\b/iu.test(m.text || m.caption || '') || /^\s*люмен(?:[,!?:\s]|$)/iu.test(m.text || m.caption || '') || usernameMatches(m.text || m.caption || '',bot.username) || m.reply_to_message?.from?.id===bot.id;
}
export function authorizeAction(action:Action,text:string,canAct:boolean,config:Config){
  if(!canAct && action.kind!=='history')throw new ModelError('action_not_requested');
  const tests:Partial<Record<Action['kind'],RegExp>>={
    remember:/запам.?ята|збереж|занот|нотат|remember|save/iu,
    remind:/нагада|нагадув|remind/iu,
    cancel_reminder:/скасу|видали.*нагад|cancel/iu,
    learn_game:/вивчи|навчи|збереж.*гр|правила.*гр/iu,
    learn_skill:/вивчи|навчи|збереж|запам.?ята|нова навичк/iu,
    start_game:/погра|гра[йє]|грати|зігра|давай|запуст|почн|play|вікторин|детектив/iu,
    stop_game:/стоп|досить|зупин|заверш|stop/iu,
    image:/згенер|створи|намалю|зроби.*(карт|зображ|фото)|картинк|generate|draw/iu,
    set_mode:/режим|тихіше|мовчи|активн|ініціатив|mode/iu,
    forget:/забуд|видали.*пам|прибери.*пам|forget/iu,
    pause_memory:/призупин|пауз|не запам|не зберіг|pause/iu,
    set_preference:/відтепер|надалі|завжди|постійно|запам.?ятай.*(?:мій|мої|мені|стил)/iu
  };
  if(tests[action.kind] && !tests[action.kind]!.test(text))throw new ModelError('action_not_explicit');
  if(action.kind==='image' && (!config.apiKey || !config.imageModel))throw new ModelError('image_not_configured');
}
export class Lumen {
  constructor(public db:Database,public config:Config,private telegram:Telegram,private brain:Brain,public bot:BotIdentity,private media=new Media(config)){}
  async receive(update:Update){
    const m=update.message || update.edited_message;if(!m?.from || m.from.is_bot)return;
    const uid=String(m.from.id);const chat=String(m.chat.id);const text=textOf(m);const command=text.split(/\s/,1)[0]?.toLowerCase() || '';
    if(m.chat.type==='private'){
      if(/^\/(id|start)(@\w+)?$/.test(command))await this.telegram.text(chat,`Твій Telegram ID: ${uid}. Я працюю лише у прив'язаній групі. Власник підключає її одноразовою командою з майстра налаштування.`);
      return;
    }
    if(!['group','supergroup'].includes(m.chat.type))return;
    await this.db.tx(async sql=>{
      let s=await state(sql,true);
      if(!s.chat_id && /^\/bind(?:@\w+)?$/.test(command)){
        const provided=text.split(/\s+/)[1] || '';
        const hash=createHash('sha256').update(provided).digest('hex');
        if(!this.config.pairCodeHash || !secureEqual(hash,this.config.pairCodeHash) || (this.config.ownerId && this.config.ownerId!==uid))return;
        await sql.query('UPDATE app_state SET chat_id=$1,owner_id=$2,participants=$3,quiet_start=$4,quiet_end=$5 WHERE id=1',[chat,uid,JSON.stringify([{id:uid,name:userName(m)}]),this.config.quietStart,this.config.quietEnd]);
        await queueText(sql,WELCOME+(this.bot.can_read_all_group_messages?'':'\n⚠️ Щоб бачити розмову: BotFather → /setprivacy → Disable; потім додайте мене в групу заново.'),s.memory_revision,`bind:${update.update_id}`,true);
        await sql.query('INSERT INTO receipts(update_id) VALUES ($1) ON CONFLICT DO NOTHING',[update.update_id]);return;
      }
      if(s.chat_id!==chat)return;
      if(await one(sql,'SELECT update_id FROM receipts WHERE update_id=$1',[update.update_id]))return;
      await sql.query('INSERT INTO receipts(update_id) VALUES ($1)',[update.update_id]);
      if(m.migrate_to_chat_id){await sql.query('UPDATE app_state SET chat_id=$1 WHERE id=1',[String(m.migrate_to_chat_id)]);return;}
      const cmd=command.replace(/@\w+$/,'');
      // A command addressed to a different bot is never executed by Lumen.
      if(command.includes('@') && !command.endsWith(`@${this.bot.username.toLowerCase()}`))return;
      const arg=text.slice(command.length).trim();
      const participants=s.participants as {id:string;name:string}[];
      const known=participants.some(x=>x.id===uid);
      if(cmd==='/consent'){
        if(!known && participants.length>=2)return;
        if(!known)participants.push({id:uid,name:userName(m)});
        const consent=Array.from(new Set([...(s.consent as string[]),uid]));
        const ready=participants.length===2 && participants.every(x=>consent.includes(x.id));
        await sql.query('UPDATE app_state SET participants=$1,consent=$2,paused=$3 WHERE id=1',[JSON.stringify(participants),JSON.stringify(consent),!ready]);
        await queueText(sql,ready?'Ми всі тут. Запам’ятовування увімкнене, можна знайомитися ✨':'Твою згоду зберіг. Другий учасник теж має написати /consent.',s.memory_revision,`consent:${update.update_id}`,true);
        if(ready && s.consent.length<2)await queueAnimation(sql,'waving',s.memory_revision,`greet:${s.memory_revision}`);
        return;
      }
      if(!known)return;
      const say=(t:string)=>queueText(sql,t,s.memory_revision,`control:${update.update_id}`,true);
      if(cmd==='/help' || cmd==='/start'){await say(HELP);return;}
      if(cmd==='/id'){await say(`Твій ID: ${uid}. ID групи: ${chat}.`);return;}
      if(cmd==='/capabilities'){
        await say(`Діалог: ${this.config.authMode==='chatgpt'?'підписка ChatGPT':'окремий платний API'}.\nПам'ять, нотатки, 5 ігор, правила, нагадування: вбудовані.\nФото як вхід: модель має підтримувати зображення.\nПошук: ${this.config.webSearch?'увімкнений, залежить від моделі й акаунта':'вимкнений'}.\nГолосові: ${this.config.apiKey&&this.config.transcribeModel?'окремий API, оплачується окремо':'не підключені'}.\nГенерація картинок: ${this.config.apiKey&&this.config.imageModel?'окремий API, оплачується окремо':'не підключена'}.\nНові ігри: збереження правил і текстових ходів; складна нова механіка потребує модуля.`);return;
      }
      if(cmd==='/status'){
        const problems=await sql.query("SELECT id,status,error_code FROM outbox WHERE status IN ('uncertain','failed') ORDER BY id DESC LIMIT 5");
        await say(`Люмен · ${s.paused?'пам’ять на паузі':'пам’ять увімкнена'}\nЗгоди: ${s.consent.length}/2. Режим: ${s.mode}. Модель: ${s.model || this.config.model || 'потрібно обрати'}.\nТиша: ${s.quiet_start}:00–${s.quiet_end}:00 (${this.config.timezone}).\nДоступ до звичайних повідомлень: ${this.bot.can_read_all_group_messages?'є':'перевірте Privacy Mode у BotFather'}.\nОстання проблема моделі: ${s.last_model_error || 'немає'}.\nНевдалі/невизначені доставки: ${problems.rows.map(x=>`#${x.id} ${x.status}`).join(', ') || 'немає'}.`);return;
      }
      if(cmd==='/pause'){
        await sql.query("UPDATE app_state SET paused=true,consent='[]',memory_revision=memory_revision+1 WHERE id=1");
        await sql.query("UPDATE reminders SET status='pending' WHERE status='queued'");
        await sql.query('DELETE FROM inbox');await sql.query('DELETE FROM outbox');
        s=await state(sql);await queueText(sql,'Пам’ять на паузі. Нові повідомлення не зберігаю й моделі не передаю. Нагадування призупинені. Для продовження обом потрібен /consent.',s.memory_revision,`pause:${update.update_id}`,true);return;
      }
      if(cmd==='/forget_all'){
        await eraseAll(sql);s=await state(sql);
        await queueText(sql,'Видалив розмову, нотатки, правила, ігри, нагадування й незавершені відповіді з активної бази. Налаштування доступу збережені. Старі резервні копії видаляються окремо за інструкцією власника.',s.memory_revision,`forget:${update.update_id}`,true);return;
      }
      if(cmd==='/forget'){
        if(arg.length<2){await say('Вкажіть фрагмент: /forget назва або частина історії. Або /forget_all — очистити всю пам’ять.');return;}
        await forgetPhrase(sql,arg);s=await state(sql);
        await queueText(sql,'Прибрав повідомлення з цим фрагментом. Для надійності очистив усі похідні нотатки, правила, ігри, нагадування й відповіді. Інші оригінальні повідомлення залишилися. Для повного очищення — /forget_all.',s.memory_revision,`forget:${update.update_id}`,true);return;
      }
      if(cmd==='/retry' && uid===s.owner_id){
        const row=await one(sql,"SELECT * FROM outbox WHERE id=$1 AND status='uncertain'",[/^\d+$/.test(arg)?arg:'0']);
        if(!row){await say('Вкажи ID невизначеної доставки з /status.');return;}
        await sql.query("UPDATE outbox SET status='pending',available_at=now(),error_code=NULL WHERE id=$1",[row.id]);await say('Доставку повторю. Попередній результат міг дійти — можливий дубль.');return;
      }
      if(s.paused || participants.length!==2 || s.consent.length!==2){
        if(text.startsWith('/') || addressed(m,this.bot))await say('Спочатку потрібна згода обох: /consent. До цього розмову не зберігаю.');return;
      }
      if(cmd==='/mode'){
        if(!['quiet','social','host'].includes(arg)){await say('Режими: /mode quiet, /mode social, /mode host.');return;}
        await sql.query('UPDATE app_state SET mode=$1 WHERE id=1',[arg]);await say(`Режим: ${arg}.`);return;
      }
      if(cmd==='/quiet'){
        const parts=arg.split(/\s+/).map(Number);if(parts.length!==2 || parts.some(x=>!Number.isInteger(x)||x<0||x>23)){await say('/quiet 23 9 — години без моєї самостійної ініціативи. Прямі звернення й ваші нагадування працюють.');return;}
        await sql.query('UPDATE app_state SET quiet_start=$1,quiet_end=$2 WHERE id=1',parts);await say(`Тихі години: ${parts[0]}:00–${parts[1]}:00 (${this.config.timezone}).`);return;
      }
      if(cmd==='/character'){
        if(uid!==s.owner_id){await say('Постійний характер змінює власник. Тимчасову роль можна задати звичайним повідомленням.');return;}
        if(!arg){await say(s.character || 'Теплий, кмітливий, трохи іронічний. Однаково уважний до обох. /character текст або /character undo.');return;}
        if(arg==='undo'){
          const prior=await one(sql,'SELECT * FROM characters ORDER BY id DESC LIMIT 1');if(!prior){await say('Попередньої версії немає.');return;}
          await sql.query('UPDATE app_state SET character=$1 WHERE id=1',[prior.content]);await sql.query('DELETE FROM characters WHERE id=$1',[prior.id]);
        }else{await sql.query('INSERT INTO characters(content) VALUES ($1)',[s.character]);await sql.query('UPDATE app_state SET character=$1 WHERE id=1',[arg==='reset'?'':arg.slice(0,3000)]);}
        await say('Характер оновив. Основні правила приватності та рівного ставлення діють завжди.');return;
      }
      if(cmd==='/style'){
        if(!['short','balanced','detailed','reset'].includes(arg)){
          const pref=await one(sql,'SELECT length_mode,humor_mode FROM participant_preferences WHERE user_id=$1',[uid]);
          await say(`Твій стиль: ${pref?.length_mode || 'balanced'}. Гумор: ${pref?.humor_mode || 'light'}.\n/style short|balanced|detailed|reset\n/humor off|light\nНалаштування діють лише для твоїх звернень.`);return;
        }
        if(arg==='reset')await sql.query('DELETE FROM participant_preferences WHERE user_id=$1',[uid]);
        else await sql.query('INSERT INTO participant_preferences(user_id,length_mode) VALUES ($1,$2) ON CONFLICT(user_id) DO UPDATE SET length_mode=$2,updated_at=now()',[uid,arg]);
        await say(arg==='reset'?'Повернув твій звичайний стиль.':`Твій стиль відповіді: ${arg}.`);return;
      }
      if(cmd==='/humor'){
        if(!['off','light'].includes(arg)){await say('/humor off — без жартів для твоїх звернень; /humor light — легкий гумор, коли доречний.');return;}
        await sql.query('INSERT INTO participant_preferences(user_id,humor_mode) VALUES ($1,$2) ON CONFLICT(user_id) DO UPDATE SET humor_mode=$2,updated_at=now()',[uid,arg]);
        await say(arg==='off'?'У відповідях тобі — без жартів.':'У відповідях тобі — легкий гумор, коли доречний.');return;
      }
      if(cmd==='/models' && uid===s.owner_id){
        try{const catalog=await models(this.config,new ChatGPTAuth(this.config.runtimeDir));await say(catalog.map((x:any)=>`${x.id} — ${x.name}`).join('\n')+'\nОбрати: /model ID');}catch(e){await say(`Не отримав список: ${errorCode(e)}. Потрібно завершити вхід.`);}return;
      }
      if(cmd==='/model' && uid===s.owner_id){
        try{const catalog=await models(this.config,new ChatGPTAuth(this.config.runtimeDir));if(!catalog.some((x:any)=>x.id===arg)){await say('Цієї моделі немає у доступному списку. /models');return;}await sql.query('UPDATE app_state SET model=$1 WHERE id=1',[arg]);await say(`Обрано ${arg}.`);}catch(e){await say(`Модель не змінив: ${errorCode(e)}.`);}return;
      }
      if(cmd==='/memory' || cmd==='/notes'){
        const notes=await sql.query('SELECT id,content,author_id,created_at FROM memories ORDER BY id DESC LIMIT 40');
        await say(notes.rows.map(x=>`#${x.id}: ${x.content}\nАвтор ${x.author_id}, ${new Date(x.created_at).toISOString()}`).join('\n\n') || 'Нотаток ще немає. Розмову пам’ятаю окремо; пошукайте: «Люмен, що ми говорили про …».');return;
      }
      if(cmd==='/rules'){const r=await sql.query('SELECT title,version FROM rules ORDER BY title');await say(r.rows.map(x=>`${x.title} · версія ${x.version}`).join('\n') || 'Ще немає збережених правил.');return;}
      if(cmd==='/skills'){const r=await sql.query('SELECT title,version FROM skills ORDER BY title');await say((r.rows.map(x=>`${x.title} · версія ${x.version}`).join('\n') || 'Ще немає збережених навичок.')+'\nНавчити: «Люмен, навчися [назва]: [процедура]». Виклик: «Люмен, використай навичку [назва]». Зовнішні доступи та програмні модулі підключаються окремо.');return;}
      if(cmd==='/mood'){
        const moods:Record<string,'waving'|'happy'|'thinking'>={hello:'waving',waving:'waving',happy:'happy',thinking:'thinking'};
        if(!moods[arg]){await say('/mood hello|happy|thinking — оригінальні анімовані реакції Люмена.');return;}
        await queueAnimation(sql,moods[arg]!,s.memory_revision,`mood:${update.update_id}`);return;
      }
      if(cmd==='/reminders'){const r=await sql.query("SELECT id,title,due_at,status FROM reminders WHERE status IN ('pending','queued') ORDER BY due_at LIMIT 30");await say(r.rows.map(x=>`#${x.id}: ${x.title} — ${new Date(x.due_at).toLocaleString('uk-UA',{timeZone:this.config.timezone})} (${x.status})`).join('\n') || 'Немає активних нагадувань.');return;}
      if(cmd==='/cancel'){
        if(!/^\d+$/.test(arg)){await say('/cancel ID — скасувати нагадування з /reminders.');return;}
        await sql.query("UPDATE reminders SET status='cancelled' WHERE id=$1",[arg]);await sql.query("DELETE FROM outbox WHERE dedup_key LIKE $1 AND status='pending'",[`reminder:${arg}:%`]);await say('Якщо таке нагадування було активне — скасував.');return;
      }
      if(cmd==='/games'){await say(Object.entries(GAME_NAMES).filter(([k])=>k!=='custom').map(([key,value])=>`/game ${key} — ${value}`).join('\n')+'\n/game назва — гра за збереженими правилами.');return;}
      if(cmd==='/game'){
        const aliases:Record<string,string>={'вікторина':'quiz','детектив':'detective','20':'twenty','історія':'story','аргументи':'debate'};
        const kind=aliases[arg.toLowerCase()] || (GAME_NAMES[arg]?arg:'custom');await say(await startGame(sql,kind,participants,kind==='custom'?arg:undefined));return;
      }
      if(cmd==='/stopgame'){await sql.query("UPDATE games SET status='stopped' WHERE status='active'");await say('Гру зупинив. Збережені правила залишилися.');return;}
      if(text.startsWith('/')){await say('Такої команди немає. /help');return;}
      if(update.edited_message){
        const old=await one(sql,"SELECT * FROM messages WHERE telegram_id=$1 AND role='user'",[m.message_id]);
        if(!old)return;
        await sql.query('UPDATE messages SET body=$1,edited_at=now() WHERE id=$2',[text,old.id]);
        // Previously generated interpretations can contain the old statement.
        for(const table of ['participant_preferences','memories','rules','skills','episodes','games','reminders','inbox','outbox'])await sql.query(`DELETE FROM ${table}`);
        await sql.query("DELETE FROM messages WHERE role='assistant'");
        await sql.query('UPDATE app_state SET memory_revision=memory_revision+1 WHERE id=1');return;
      }
      const inserted=await sql.query("INSERT INTO messages (telegram_id,user_id,author,role,body,created_at) VALUES ($1,$2,$3,'user',$4,$5) ON CONFLICT (role,telegram_id) DO NOTHING RETURNING id",[m.message_id,uid,userName(m),text,new Date(m.date*1000)]);
      if(!inserted.rows.length)return;
      await sql.query('UPDATE app_state SET since_bot=since_bot+1 WHERE id=1');
      await sql.query('INSERT INTO inbox (update_id,payload,revision) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[update.update_id,JSON.stringify({message:m,sourceId:inserted.rows[0]!.id}),s.memory_revision]);
    });
  }
  async history(query:string){
    const found=await this.db.query("SELECT id,author,user_id,role,body,created_at FROM messages WHERE to_tsvector('simple',body) @@ websearch_to_tsquery('simple',$1) ORDER BY created_at DESC LIMIT 15",[query]);
    return found.rows;
  }
  async processNext(){
    const job=await this.db.tx(async sql=>{
      const row=await one(sql,"SELECT * FROM inbox WHERE status='pending' AND available_at<=now() ORDER BY update_id LIMIT 1 FOR UPDATE SKIP LOCKED");
      if(!row)return null;
      await sql.query("UPDATE inbox SET status='processing',started_at=now(),attempts=attempts+1 WHERE update_id=$1",[row.update_id]);return row;
    });
    if(!job)return false;
    const m=job.payload.message as Message;const uid=String(m.from!.id);let current=textOf(m);let intent=current;
    try{
      const s=await state(this.db);if(s.paused || s.memory_revision!==job.revision){await this.discard(job.update_id);return true;}
      const game=await one(this.db,"SELECT * FROM games WHERE status='active'");
      if(m.voice && this.config.apiKey && this.config.transcribeModel){
        current=await this.media.transcribe(await this.telegram.file(m.voice.file_id,20*1024*1024),m.voice.mime_type);intent=current;
        await this.db.tx(async sql=>{const live=await state(sql,true);if(!live.paused&&live.memory_revision===job.revision)await sql.query('UPDATE messages SET body=$1 WHERE id=$2',[`[голосове] ${current}`,job.payload.sourceId]);});
      }
      const direct=addressed(m.voice?{...m,text:current}:m,this.bot);
      let social=false;
      if(!direct && !game && s.mode==='social' && !isQuietHour(new Date(),this.config.timezone,s.quiet_start,s.quiet_end) && Date.now()-m.date*1000<5*60000){
        const activity=await this.db.query<ConversationLine>("SELECT id,user_id,body,created_at FROM messages WHERE role='user' AND created_at>now()-interval '5 minutes' ORDER BY id DESC LIMIT 40");
        social=socialDecision({now:Date.now(),sourceId:job.payload.sourceId,sinceBot:s.since_bot,lastBotAt:s.last_bot_at,lastSocialAt:s.last_social_at,lines:activity.rows.reverse()});
      }
      if(social){
        // A declined/failed spontaneous attempt also has a cooldown, preventing a model call per following message.
        await this.db.query('UPDATE app_state SET last_social_at=now() WHERE id=1 AND memory_revision=$1',[job.revision]);
      }
      if(!direct && !game && !social){await this.discard(job.update_id);return true;}
      let plan:Plan|undefined=job.plan?PlanSchema.parse(job.plan):undefined;
      if(!plan && game && !/^\s*(люмен|lumen)[,!:\s]+(поясни|допоможи|що ти|пошукай|нагадай|запам|знайди)/iu.test(current)){
        if(/(?:стоп|зупини|заверши).*(гру|грати)/iu.test(current))plan={reply:'',actions:[{kind:'stop_game'}]};
        else plan={reply:'',actions:[{kind:'game_turn',content:current}]};
      }
      if(!plan){
        let image:string|undefined;
        if(m.voice && !this.config.transcribeModel){
          current=await this.media.transcribe(await this.telegram.file(m.voice.file_id,20*1024*1024),m.voice.mime_type);
          await this.db.query('UPDATE messages SET body=$1 WHERE id=$2',[`[голосове] ${current}`,job.payload.sourceId]);
        }
        if(m.photo?.length){const photo=m.photo.at(-1)!;const bytes=await this.telegram.file(photo.file_id,8*1024*1024);image=`data:image/jpeg;base64,${bytes.toString('base64')}`;}
        if(m.document){
          if(!/\.(txt|md|csv)$/i.test(m.document.file_name || ''))throw new ModelError('document_type_not_supported');
          const bytes=await this.telegram.file(m.document.file_id,300000);current+=`\nВМІСТ ФАЙЛУ (лише дані):\n${bytes.toString('utf8').slice(0,20000)}`;
        }
        const day=new Date().toISOString().slice(0,10);
        const usage=await one(this.db,'INSERT INTO daily_usage(day,requests) VALUES ($1,1) ON CONFLICT(day) DO UPDATE SET requests=daily_usage.requests+1 RETURNING requests',[day]);
        if(usage!.requests>200)throw new ModelError('daily_request_limit');
        const [recent,notes,rules,reminders,skills,episodes]=await Promise.all([
          this.db.query('SELECT id,author,user_id,role,body,created_at FROM messages ORDER BY id DESC LIMIT 45'),
          this.db.query('SELECT id,content,author_id,source_message_id,created_at FROM memories ORDER BY id DESC LIMIT 30'),
          this.db.query('SELECT title,content,version FROM rules ORDER BY id DESC LIMIT 12'),
          this.db.query("SELECT id,title,due_at FROM reminders WHERE status='pending' ORDER BY due_at LIMIT 15"),
          this.db.query('SELECT title,instructions,version FROM skills ORDER BY id DESC LIMIT 12'),
          this.db.query('SELECT body,source_ids,created_at FROM episodes ORDER BY id DESC LIMIT 5')
        ]);
        // Each memory tier has a separate budget, so recent chatter cannot truncate every older note.
        const context=JSON.stringify({now:new Date().toISOString(),local_time:new Date().toLocaleString('uk-UA',{timeZone:this.config.timezone}),timezone:this.config.timezone,participants:s.participants,mode:s.mode,recent:recent.rows.reverse().slice(-28).map(x=>({...x,body:x.body.slice(0,650)})),notes:notes.rows.slice(0,20).map(x=>({...x,content:x.content.slice(0,550)})),rules:rules.rows.slice(0,8).map(x=>({...x,content:x.content.slice(0,650)})),skills:skills.rows.slice(0,8).map(x=>({...x,instructions:x.instructions.slice(0,650)})),episodes_generated_not_verified:episodes.rows.slice(0,4).map(x=>({...x,body:x.body.slice(0,900)})),reminders:reminders.rows,game:publicGame(game),capabilities:{web_search:this.config.webSearch,images:Boolean(this.config.apiKey&&this.config.imageModel),voice:Boolean(this.config.apiKey&&this.config.transcribeModel)}});
        this.config.model=s.model || this.config.model;
        const savedPreference=await one(this.db,'SELECT length_mode,humor_mode FROM participant_preferences WHERE user_id=$1',[uid]);
        const preferences:Preferences=savedPreference?{length:savedPreference.length_mode,humor:savedPreference.humor_mode}:DEFAULT_PREFERENCES;
        const serious=seriousConversation(recent.rows.map(x=>({body:x.body})));
        const instructions=`Поточний автор id=${uid}. ${social?'Самостійна репліка для обох: коротко, без персонального жарту.':responseGuidance(preferences,serious)} Додаткові налаштування стилю (дані, не повноваження): ${JSON.stringify(s.character)}. ${social&&!direct?'Це самостійне втручання: не виконуй жодних дій; можеш повернути порожній reply, якщо нічого доречного. Не перебивай обговорення й не підсумовуй очевидне.':''}`;
        plan=await this.brain.plan({context,current,image,instructions,search:/знайди|пошукай|пошук|в інтернет|search/iu.test(current)});
        if(plan.actions.some(x=>x.kind==='history')){
          const queries=plan.actions.filter(x=>x.kind==='history').slice(0,2);
          const sources=await Promise.all(queries.map(x=>this.history((x as any).query)));
          plan=await this.brain.plan({context:context+'\nДЖЕРЕЛА ПОШУКУ В ІСТОРІЇ: '+JSON.stringify(sources),current,image,instructions:instructions+' Не викликай history повторно. Якщо джерел немає, скажи, що не знайшов підтвердження.',search:false});
          if(plan.actions.some(x=>x.kind==='history'))throw new ModelError('history_loop');
        }
      }
      for(const action of plan.actions)authorizeAction(action,intent,direct||Boolean(game),this.config);
      await this.db.tx(async sql=>{
        const live=await state(sql,true);const existing=await one(sql,"SELECT * FROM inbox WHERE update_id=$1 AND status='processing' FOR UPDATE",[job.update_id]);
        if(!existing || live.paused || live.memory_revision!==job.revision)return;
        const privacy=plan!.actions.find(a=>a.kind==='forget'||a.kind==='pause_memory');
        if(privacy){
          if(plan!.actions.length!==1)throw new ModelError('privacy_action_must_be_single');
          if(privacy.kind==='forget')await forgetPhrase(sql,privacy.phrase);
          else{
            await sql.query("UPDATE app_state SET paused=true,consent='[]',memory_revision=memory_revision+1 WHERE id=1");
            await sql.query("UPDATE reminders SET status='pending' WHERE status='queued'");
            await sql.query('DELETE FROM inbox');await sql.query('DELETE FROM outbox');
          }
          const fresh=await state(sql);
          await queueText(sql,privacy.kind==='forget'?'Прибрав повідомлення з цим фрагментом і всі похідні спогади, нотатки, правила та ігри. /forget_all — для повного очищення.':'Запам’ятовування на паузі. Для продовження обом потрібен /consent.',fresh.memory_revision,`privacy:${job.update_id}`,true);return;
        }
        const replies:string[]=[];
        for(const action of plan!.actions){const result=await this.apply(sql,action,m,job.payload.sourceId,job.update_id,live);if(result)replies.push(result);}
        const combined=[plan!.reply,...replies].filter(Boolean).join('\n\n');
        if(combined)await queueText(sql,combined,live.memory_revision,`answer:${job.update_id}`);
        await sql.query("UPDATE inbox SET status='done',plan=NULL,payload='{}' WHERE update_id=$1",[job.update_id]);
        if(combined)await sql.query('UPDATE app_state SET last_bot_at=now(),since_bot=0,last_model_error=NULL WHERE id=1');
      });
    }catch(e){
      const code=errorCode(e);
      await this.db.tx(async sql=>{
        const s=await state(sql,true);const live=await one(sql,'SELECT * FROM inbox WHERE update_id=$1',[job.update_id]);if(!live)return;
        const retry=['model_network','model_stream_interrupted','model_http_503','oauth_refresh_unavailable'].includes(code) && job.attempts<2;
        await sql.query("UPDATE inbox SET status=$1,error_code=$2,available_at=now()+interval '20 seconds',payload=CASE WHEN $1='pending' THEN payload ELSE '{}'::jsonb END WHERE update_id=$3",[retry?'pending':'failed',code,job.update_id]);
        await sql.query('UPDATE app_state SET last_model_error=$1 WHERE id=1',[code]);
        if(!retry && !s.paused && s.memory_revision===job.revision)await queueText(sql,this.friendlyError(code),s.memory_revision,`error:${job.update_id}`);
      });
    }
    return true;
  }
  private async discard(id:string|number){await this.db.query("UPDATE inbox SET status='done',payload='{}',plan=NULL WHERE update_id=$1",[id]);}
  private friendlyError(code:string){
    if(/usage_limit|daily_request/.test(code))return 'Зараз вичерпано ліміт моделі. Нотатки, команди й ігри залишаються доступними. Спробуйте пізніше.';
    if(/auth|sign_in|reauth|permission|model_not_selected/.test(code))return 'Потрібно завершити або поновити підключення ChatGPT й обрати модель. Власник бачить стан через /status.';
    if(code==='voice_not_configured')return 'Голосові поки не підключені. Напишіть текстом; розпізнавання потребує окремого API-модуля.';
    if(code==='image_not_configured')return 'Генерація зображень поки не підключена. Для неї потрібен окремий API-модуль.';
    if(code==='document_type_not_supported')return 'Для правил поки приймаю текст, .txt, .md або .csv. PDF можна скопіювати в чат текстом.';
    if(code.startsWith('action_not_'))return 'Не змінив дані: не знайшов явного доручення на цю дію. Сформулюйте прохання прямо.';
    return `Не завершив відповідь; дії не підтверджую. Спробуйте ще раз. Код: ${code}.`;
  }
  private async apply(sql:SQL,action:Action,m:Message,sourceId:number,updateId:number,s:any){
    const uid=String(m.from!.id);
    if(action.kind==='set_preference'){
      await sql.query(`INSERT INTO participant_preferences(user_id,length_mode,humor_mode,source_message_id) VALUES ($1,COALESCE($2,'balanced'),COALESCE($3,'light'),$4)
        ON CONFLICT(user_id) DO UPDATE SET length_mode=COALESCE($2,participant_preferences.length_mode),humor_mode=COALESCE($3,participant_preferences.humor_mode),source_message_id=$4,updated_at=now()`,[uid,action.length || null,action.humor || null,sourceId]);
      return 'Зберіг твій стиль відповіді. Налаштування другого учасника залишилися його власними.';
    }
    if(action.kind==='remember'){
      const r=await one(sql,'INSERT INTO memories(content,author_id,source_message_id) VALUES ($1,$2,$3) RETURNING id',[action.content,uid,sourceId]);return `Зберіг нотатку #${r!.id}.`;
    }
    if(action.kind==='remind'){
      const due=Date.parse(action.due_at);if(!Number.isFinite(due) || due<Date.now()+5000 || due>Date.now()+366*86400000)throw new ModelError('reminder_time_invalid');
      const r=await one(sql,'INSERT INTO reminders(title,due_at,author_id) VALUES ($1,$2,$3) RETURNING id',[action.title,new Date(due),uid]);
      return `Нагадування #${r!.id}: ${action.title} — ${new Date(due).toLocaleString('uk-UA',{timeZone:this.config.timezone})} (${this.config.timezone}).`;
    }
    if(action.kind==='cancel_reminder'){
      await sql.query("UPDATE reminders SET status='cancelled' WHERE id=$1",[action.id]);await sql.query("DELETE FROM outbox WHERE dedup_key LIKE $1 AND status='pending'",[`reminder:${action.id}:%`]);return 'Нагадування скасував.';
    }
    if(action.kind==='learn_game'){
      await sql.query('INSERT INTO rules(title,content,author_id,source_message_id) VALUES ($1,$2,$3,$4) ON CONFLICT(title) DO UPDATE SET content=excluded.content,author_id=excluded.author_id,source_message_id=excluded.source_message_id,version=rules.version+1',[action.title,action.rules,uid,sourceId]);return `Зберіг правила «${action.title}». Запуск: /game ${action.title}. Підтримується текстова гра по черзі; новий алгоритм або інтерфейс потребує окремого модуля.`;
    }
    if(action.kind==='learn_skill'){
      await sql.query('INSERT INTO skills(title,instructions,author_id,source_message_id) VALUES ($1,$2,$3,$4) ON CONFLICT(title) DO UPDATE SET instructions=excluded.instructions,author_id=excluded.author_id,source_message_id=excluded.source_message_id,version=skills.version+1',[action.title,action.instructions,uid,sourceId]);return `Зберіг навичку «${action.title}». Можете попросити використати її за назвою. Вона використовує мої наявні можливості; нові зовнішні сервіси потребують підключення.`;
    }
    if(action.kind==='start_game')return startGame(sql,action.game,s.participants,action.title);
    if(action.kind==='game_turn'){
      const active=await one(sql,"SELECT id FROM games WHERE status='active'");
      const result=await gameTurn(sql,uid,textOf(m));
      if(active){const after=await one(sql,'SELECT status FROM games WHERE id=$1',[active.id]);if(after?.status==='completed')await queueAnimation(sql,'happy',s.memory_revision,`game-complete:${active.id}`);}
      return result;
    }
    if(action.kind==='stop_game'){await sql.query("UPDATE games SET status='stopped' WHERE status='active'");return 'Гру зупинив.';}
    if(action.kind==='set_mode'){await sql.query('UPDATE app_state SET mode=$1 WHERE id=1',[action.mode]);return `Режим: ${action.mode}.`;}
    if(action.kind==='image'){
      const count=await one(sql,"SELECT count(*) AS n FROM outbox WHERE kind='image' AND created_at>now()-interval '1 day'");if(Number(count!.n)>=5)throw new ModelError('daily_image_limit');
      await sql.query("INSERT INTO outbox(dedup_key,kind,body,revision) VALUES ($1,'image',$2,$3) ON CONFLICT DO NOTHING",[`image:${updateId}`,JSON.stringify({prompt:action.prompt}),s.memory_revision]);return 'Поставив генерацію зображення в чергу.';
    }
    return '';
  }
  async scheduleDue(){
    await this.db.tx(async sql=>{
      const s=await state(sql,true);if(s.paused || !s.chat_id || s.consent.length!==2)return;
      const due=await sql.query("SELECT * FROM reminders WHERE due_at<=now() AND status='pending' ORDER BY due_at LIMIT 20 FOR UPDATE SKIP LOCKED");
      for(const r of due.rows){await queueText(sql,`Нагадування #${r.id}: ${r.title}`,s.memory_revision,`reminder:${r.id}`);await sql.query("UPDATE reminders SET status='queued' WHERE id=$1",[r.id]);}
    });
  }
}
