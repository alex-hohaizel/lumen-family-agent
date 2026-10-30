import {describe,it,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {TestDB,harness,message,FakeBrain} from './helpers.js';
import {ChatRegistry,ChatDatabase,schemaForChat} from '../src/registry.js';
import {ChatRouter,type ChatRuntime} from '../src/router.js';
import {state,one,migrate} from '../src/db.js';
import {Telegram,type Update} from '../src/telegram.js';
import {AgentTools} from '../src/agent-tools.js';
import {addressed} from '../src/engine.js';
import {Memory} from '../src/memory.js';
import {setupPayload,callbackCommand} from '../src/ui.js';
import {stickerAssets,STICKER_SET,STICKER_COUNT,STICKER_TITLE} from '../src/sticker-pack.js';

describe('Окремі групи, природні звернення та теми Telegram',()=>{
  const root=new TestDB();let h:ReturnType<typeof harness>,registry:ChatRegistry,router:ChatRouter;
  const brains=new Map<string,FakeBrain>();let seq=50000;
  const bot={id:999,username:'lumen_test_bot',can_read_all_group_messages:true};
  before(async()=>{await root.init();});after(async()=>{await root.close();});
  beforeEach(async()=>{
    const tables=await root.query("SELECT to_regclass('public.lumen_chats') AS present");
    if(tables.rows[0]?.present){
      for(const chat of (await root.query('SELECT schema_name FROM public.lumen_chats')).rows)if(chat.schema_name!=='public')await root.pg.exec(`DROP SCHEMA "${chat.schema_name}" CASCADE;`);
      await root.pg.exec('DROP TABLE public.lumen_chats,public.lumen_transport_state;');
    }
    await root.reset();h=harness(root);brains.clear();registry=new ChatRegistry(root);
    router=new ChatRouter(registry,h.config,h.tg as unknown as Telegram,bot,(_c,id)=>{const b=new FakeBrain();brains.set(id,b);return b;});await router.init();
  });
  async function add(id=-200,uid=11){
    await router.receive({update_id:seq++,my_chat_member:{chat:{id,type:'supergroup',title:`Група ${id}`},from:{id:uid,first_name:'Власник'},date:Math.floor(Date.now()/1000),old_chat_member:{status:'left'},new_chat_member:{status:'member'}}});
    const c=await registry.find(String(id));assert.ok(c);const runtime=await router.runtime(c);await runtime.db.query('DELETE FROM outbox');return runtime;
  }
  function msg(text:string,chat=-200,uid=11,thread?:number){const u=message(text,uid,chat);u.message!.message_thread_id=thread;return u;}
  async function ask(runtime:ChatRuntime,u:Update){await router.receive(u);await runtime.engine.processNext();}
  it('ім’я працює в будь-якій частині фрази, з кличним відмінком і точними @згадками',()=>{
    for(const text of ['А як думаєш, Люмен?','Дякую, Люмене, поясни','hello Lumen!','@lumen_test_bot скажи'])assert.equal(addressed(msg(text).message!,bot),true,text);
    for(const text of ['люменометр','@lumen_test_bot_other','alumen'])assert.equal(addressed(msg(text).message!,bot),false,text);
    const u=msg('Поясни');u.message!.entities=[{type:'text_mention',offset:0,length:3,user:{id:999,first_name:'Люмен'}}];assert.equal(addressed(u.message!,bot),true);
  });
  it('додавання вітає один раз і не вимагає команд чи двох згод',async()=>{
    await router.receive({update_id:seq++,message:{...msg('').message!,new_chat_members:[{id:999,first_name:'Люмен',is_bot:true}]}});
    const c=(await registry.find('-200'))!;const r=await router.runtime(c);
    await router.receive({update_id:seq++,message:{...msg('').message!,new_chat_members:[{id:999,first_name:'Люмен',is_bot:true}]}});
    const rows=(await r.db.query('SELECT body FROM outbox')).rows;assert.equal(rows.length,1);assert.match(rows[0]!.body.text,/Привіт, я Люмен/);assert.equal(rows[0]!.body.replyMarkup,undefined);
    const s=await state(r.db);assert.equal(s.open_group,true);assert.equal(s.mention_only,true);assert.equal(s.paused,false);
  });
  it('перезапуск оголошує нову версію в наявній групі один раз, навіть без старого onboarding',async()=>{
    const a=await add();await a.db.query('DELETE FROM onboarding_chats');await a.db.query('DELETE FROM release_notices');await a.db.query('DELETE FROM outbox');
    const assets=await stickerAssets();
    const restart=()=>{const r=new ChatRouter(registry,h.config,h.tg as unknown as Telegram,bot,()=>brains.get('-200')!);r.setStickerPack({name:STICKER_SET,title:STICKER_TITLE,stickers:assets.map((x,i)=>({file_id:'verified-'+i,file_unique_id:'verified-unique-'+i,is_video:true,set_name:STICKER_SET,emoji:x.emoji}))});return r;};
    const firstRestart=restart();await firstRestart.init();await firstRestart.runtime((await registry.find('-200'))!);const secondRestart=restart();await secondRestart.init();await secondRestart.runtime((await registry.find('-200'))!);const rows=(await a.db.query('SELECT * FROM outbox')).rows;assert.equal(rows.length,1);assert.match(rows[0]!.body.text,/Люмен 1\.13/);assert.equal(rows[0]!.service,true);
  });
  it('не підключає чужу групу чи чужий приватний акаунт за підробленим посиланням',async()=>{
    await router.receive({update_id:seq++,message:{...msg('',-300,22).message!,new_chat_members:[{id:999,first_name:'Люмен'}]}});
    await router.receive(message(`/start ${setupPayload(h.config)}`,22,22,'private'));
    assert.equal(await registry.find('-300'),undefined);assert.equal((await registry.transport()).owner_user_id,'11');assert.equal((await registry.list()).length,0);
  });
  it('більше двох учасників можуть знайомитися; звичайна розмова зберігається мовчки',async()=>{
    const a=await add();await a.db.query('UPDATE app_state SET quiet_start=0,quiet_end=0');for(let i=0;i<24;i++)await router.receive(msg(`Розмова ${i}`,-200,11+i%4));
    assert.equal((await a.db.query('SELECT * FROM messages')).rows.length,24);assert.equal((await a.db.query("SELECT * FROM inbox WHERE payload->'engagement'->>'reason'<>'ambient'")).rows.length,0);assert.equal(brains.get('-200')!.calls.length,0);assert.equal((await a.db.query('SELECT * FROM outbox')).rows.length,0);
    await ask(a,msg('А що скажеш, Люмен?',-200,44));assert.equal(brains.get('-200')!.calls.length,1);assert.equal((await state(a.db)).participants.length,5);
  });
  it('два чати з однаковими учасниками не обмінюються повідомленнями, нотатками чи стилями',async()=>{
    const a=await add(),b=await add(-300);
    await router.receive(msg('Секрет альфа',-200));await router.receive(msg('Секрет бета',-300));
    await a.db.query("INSERT INTO memories(content,author_id) VALUES('Нотатка альфа','11')");await b.db.query("INSERT INTO memories(content,author_id) VALUES('Нотатка бета','11')");
    await router.receive(msg('/style short',-200));await router.receive(msg('/style detailed',-300));
    await Promise.all([ask(a,msg('Люмен, що пам’ятаєш?',-200)),ask(b,msg('Люмен, що пам’ятаєш?',-300))]);
    const ac=brains.get('-200')!.calls[0]!,bc=brains.get('-300')!.calls[0]!;
    assert.match(ac.context,/альфа/);assert.doesNotMatch(ac.context,/бета/);assert.match(bc.context,/бета/);assert.doesNotMatch(bc.context,/альфа/);
    assert.match(ac.instructions!,/корот/);assert.match(bc.instructions!,/послідовно з конкретними прикладами/);assert.equal((await one(a.db,'SELECT length_mode FROM participant_preferences'))!.length_mode,'short');assert.equal((await one(b.db,'SELECT length_mode FROM participant_preferences'))!.length_mode,'detailed');assert.ok(!ac.context.includes(h.config.token));assert.ok(!ac.context.includes(h.config.pairCodeHash));
    assert.equal((await a.engine.history('бета')).length,0);assert.equal((await b.engine.history('альфа')).length,0);
  });
  it('самостійна оцінка повернення до старої теми не читає сусідню групу',async()=>{
    const a=await add(),b=await add(-300);
    for(const [runtime,secret,id] of [[a,'Таємниця альфа',90101],[b,'Таємниця бета',90102]] as const){await runtime.db.query('UPDATE app_state SET quiet_start=0,quiet_end=0');await runtime.db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,created_at) VALUES($1,'999','Люмен','assistant',$2,now()-interval '2 days')",[id,secret+' про зефір']);}
    await router.receive(msg('Знову обговорюємо зефір',-200));await router.receive(msg('Знову обговорюємо зефір',-300));
    for(const runtime of [a,b]){await runtime.db.query('UPDATE inbox SET available_at=now()');await runtime.engine.processNext();}
    const ac=brains.get('-200')!.calls[0]!.context,bc=brains.get('-300')!.calls[0]!.context;assert.match(ac,/Таємниця альфа/);assert.doesNotMatch(ac,/Таємниця бета/);assert.match(bc,/Таємниця бета/);assert.doesNotMatch(bc,/Таємниця альфа/);
  });
  it('людська реакція стає контекстом правильної теми, а не обов’язковим зверненням',async()=>{
    const a=await add(),b=await add(-300);await a.db.query('UPDATE app_state SET quiet_start=0,quiet_end=0');await b.db.query('UPDATE app_state SET quiet_start=0,quiet_end=0');const original=msg('Ось наша кумедна історія',-200,11,101);await router.receive(original);
    const reaction:Update={update_id:seq++,message_reaction:{chat:original.message!.chat,message_id:original.message!.message_id,date:Math.floor(Date.now()/1000),user:{id:22,first_name:'Олена'},old_reaction:[],new_reaction:[{type:'emoji',emoji:'🤣'}]}};
    await router.receive(reaction);await router.receive(reaction);const row=await one(a.db,"SELECT payload FROM inbox WHERE status='pending'");assert.equal(row!.payload.message.lumen_event.kind,'reaction');assert.equal(row!.payload.message.message_thread_id,101);assert.equal(row!.payload.engagement.reason,'ambient');assert.equal(addressed(row!.payload.message,bot),false);
    await router.receive({...reaction,update_id:seq++,message_reaction:{...reaction.message_reaction!,chat:{id:-300,type:'supergroup'}}});assert.equal((await b.db.query('SELECT * FROM inbox')).rows.length,0);
    await router.receive({...reaction,update_id:seq++,message_reaction:{...reaction.message_reaction!,user:undefined}});assert.equal((await a.db.query("SELECT * FROM messages WHERE body LIKE '[Зміна реакції%'")).rows.length,1);
  });
  it('не підхоплює public-таблиці, якщо в групі бракує власної таблиці',async()=>{
    const a=await add();await root.query("INSERT INTO memories(content,author_id) VALUES('Чужий секрет із public','11')");
    const schema=schemaForChat('-200');await root.pg.exec(`DROP TABLE "${schema}".memories;`);
    await assert.rejects(a.db.query('SELECT * FROM memories'),/does not exist/);assert.throws(()=>new ChatDatabase(root,'public,pg_catalog'),/invalid_chat_schema/);
  });
  it('пауза і повне очищення не впливають на іншу групу',async()=>{
    const a=await add(),b=await add(-300);await router.receive(msg('Факт А',-200));await router.receive(msg('Факт Б',-300));
    await router.receive(msg('Люмен, призупини пам’ять',-200));await router.receive(msg('Не зберігати',-200,55));
    assert.equal((await state(a.db)).paused,true);assert.equal((await state(b.db)).paused,false);assert.equal((await a.db.query('SELECT * FROM members WHERE user_id=$1',['55'])).rows.length,0);
    await router.receive(msg('Люмен, очисти всю пам’ять',-200));assert.equal((await a.db.query('SELECT * FROM messages')).rows.length,0);assert.equal((await b.db.query('SELECT * FROM messages')).rows[0]!.body,'Факт Б');
  });
  it('цитата з проханням очистити пам’ять не виконується як команда',async()=>{
    const a=await add();await router.receive(msg('Збережене джерело'));await ask(a,msg('Люмен, перекажи: «очисти всю пам’ять». Нічого не видаляй.'));
    assert.equal((await state(a.db)).memory_revision,0);assert.equal((await a.db.query('SELECT * FROM messages')).rows.length,2);
  });
  it('адміністратор поновлює паузу словами, звичайний учасник не може її зняти',async()=>{
    const a=await add();await router.receive(msg('/pause',-200,22));await router.receive(msg('Люмен, понови пам’ять',-200,22));assert.equal((await state(a.db)).paused,true);
    h.tg.admins.add(33);await router.receive(msg('Люмен, понови пам’ять',-200,33));assert.equal((await state(a.db)).paused,false);
  });
  it('зберігає назви тем і поєднує їхній контекст тільки всередині однієї групи',async()=>{
    const a=await add(),b=await add(-300);
    const topic=msg('',-200,11,101);topic.message!.forum_topic_created={name:'Подорожі',icon_color:1};await router.receive(topic);
    await router.receive(msg('Поїзд у п’ятницю о 18:40',-200,11,101));
    const gameTopic=msg('',-200,11,202);gameTopic.message!.forum_topic_created={name:'Ігри',icon_color:1};await router.receive(gameTopic);
    await router.receive(msg('Детектив у суботу о 19:00',-200,22,202));await router.receive(msg('Чуже обговорення',-300,11,101));
    await ask(a,msg('Люмен, коли поїзд і коли гра?',-200,11,202));const ctx=JSON.parse(brains.get('-200')!.calls[0]!.context);
    assert.equal(ctx.current_topic.id,'202');assert.equal(ctx.current_topic.name,'Ігри');assert.equal(ctx.topics.length,2);assert.match(JSON.stringify(ctx),/18:40/);assert.match(JSON.stringify(ctx),/19:00/);assert.doesNotMatch(JSON.stringify(ctx),/Чуже обговорення/);
    await a.delivery.next();assert.equal(h.tg.sent.at(-1)!.chatId,'-200');assert.equal(h.tg.options.at(-1)!.threadId,202);
    assert.equal((await one(a.db,"SELECT topic_id FROM messages WHERE role='assistant'"))!.topic_id,'202');assert.equal((await b.db.query('SELECT * FROM topics')).rows.length,1);
  });
  it('давніший контекст поточної теми не витісняється активною сусідньою темою',async()=>{
    const a=await add();await router.receive(msg('Домовленість старої теми',-200,11,101));for(let i=0;i<40;i++)await router.receive(msg(`Балаканина ${i}`,-200,22,202));
    await ask(a,msg('Люмен, що тут домовлялися?',-200,11,101));assert.match(brains.get('-200')!.calls[0]!.context,/Домовленість старої теми/);
  });
  it('окремі теми ведуть дві гри; стороння репліка не стає ходом',async()=>{
    const a=await add();await router.receive(msg('/game twenty',-200,11,101));await router.receive(msg('/game story',-200,11,202));
    await migrate(a.db);assert.equal((await a.db.query("SELECT * FROM games WHERE status='active'")).rows.length,2);
    await router.receive(msg('Це тварина?',-200,11,101));assert.equal((await a.db.query("SELECT * FROM inbox WHERE payload->'engagement'->>'reason'<>'ambient'")).rows.length,0);assert.equal(brains.get('-200')!.calls.length,0);
    await router.receive(msg('/stopgame',-200,11,101));assert.equal((await one(a.db,"SELECT status FROM games WHERE topic_id='101'"))!.status,'stopped');assert.equal((await one(a.db,"SELECT status FROM games WHERE topic_id='202'"))!.status,'active');
  });
  it('можна попросити нагадування під час гри без перетворення прохання на хід',async()=>{
    const a=await add();await router.receive(msg('/game story',-200,11,202));await a.db.query('DELETE FROM outbox');
    brains.get('-200')!.replies.push({reply:'',actions:[{kind:'remind',title:'Квитки',due_at:new Date(Date.now()+3600000).toISOString()}]});
    await ask(a,msg('Люмен, нагадай за годину про квитки',-200,11,202));assert.equal((await one(a.db,'SELECT state FROM games'))!.state.turn,0);assert.equal((await one(a.db,'SELECT topic_id FROM reminders'))!.topic_id,'202');
    await a.db.query("UPDATE reminders SET due_at=now()-interval '1 minute'");await a.engine.scheduleDue();const row=await one(a.db,"SELECT body FROM outbox WHERE dedup_key LIKE 'reminder:%'");assert.equal(row!.body.threadId,202);
  });
  it('нативне опитування надсилається в початкову тему та не в інший чат',async()=>{
    const a=await add(),b=await add(-300);brains.get('-200')!.replies.push({reply:'',actions:[{kind:'poll',question:'Куди їдемо?',options:['Львів','Карпати']}]});
    await ask(a,msg('Люмен, створи опитування: Львів чи Карпати?',-200,22,101));await a.delivery.next();assert.deepEqual(h.tg.polls,[{chatId:'-200',question:'Куди їдемо?',options:['Львів','Карпати'],threadId:101}]);assert.equal((await b.db.query('SELECT * FROM outbox')).rows.length,0);
  });
  it('кнопки перевіряються і виконують дію від імені того, хто натиснув',async()=>{
    const a=await add();const menu=msg('',-200,11,202).message!;menu.from={id:999,first_name:'Люмен',is_bot:true};
    const cb={update_id:seq++,callback_query:{id:'cb1',from:{id:22,first_name:'Олена'},data:'lumen:style:short',message:menu}};
    await router.receive(cb);await router.receive(cb);assert.equal((await one(a.db,'SELECT user_id,length_mode FROM participant_preferences'))!.user_id,'22');assert.equal((await a.db.query('SELECT * FROM outbox')).rows.length,1);assert.equal((await one(a.db,'SELECT body FROM outbox'))!.body.threadId,202);
    assert.equal(callbackCommand('lumen:arbitrary:delete'),undefined);assert.equal(callbackCommand('lumen:mode:evil'),undefined);assert.ok(h.tg.calls.some(x=>x.method==='answerCallbackQuery'));
  });
  it('приватний чат не показує пам’ять жодної групи',async()=>{
    const a=await add();await router.receive(msg('Груповий секрет'));await router.receive(message('/start',11,11,'private'));await router.receive(message('Люмен, груповий секрет?',11,11,'private'));
    assert.doesNotMatch(JSON.stringify(h.tg.sent),/Груповий секрет/);assert.equal((await a.db.query('SELECT * FROM messages')).rows.length,1);assert.equal(brains.get('-200')!.calls.length,0);
  });
  it('перезапуск і міграція групи зберігають її простір пам’яті',async()=>{
    const a=await add();await router.receive(msg('До перезапуску'));const schema=a.chat.schema_name;
    const restart=new ChatRouter(registry,h.config,h.tg as unknown as Telegram,bot,()=>new FakeBrain());await restart.init();
    const migrated=msg('');migrated.message!.migrate_to_chat_id=-100200;await restart.receive(migrated);
    const c=(await registry.find('-100200'))!;assert.equal(c.schema_name,schema);assert.equal(await registry.find('-200'),undefined);assert.equal((await one(registry.database(c),'SELECT body FROM messages'))!.body,'До перезапуску');
  });
  it('видалення бота з групи зупиняє її черги і не зупиняє інші групи',async()=>{
    const a=await add();await add(-300);await router.receive(msg('Люмен, привіт'));
    await router.receive({update_id:seq++,my_chat_member:{chat:{id:-200,type:'supergroup'},from:{id:11,first_name:'Олег'},date:Math.floor(Date.now()/1000),old_chat_member:{status:'member'},new_chat_member:{status:'kicked'}}});
    assert.equal((await state(a.db)).paused,true);assert.equal((await a.db.query('SELECT * FROM inbox')).rows.length,0);assert.deepEqual((await router.active()).map(x=>x.chat.chat_id),['-300']);
  });
  it('очищення під час відповіді однієї групи не відновлює її дані та не скасовує відповідь іншої',async()=>{
    const a=await add(),b=await add(-300);let resolve!:(p:any)=>void;brains.get('-200')!.block=()=>new Promise(r=>{resolve=r;});
    await router.receive(msg('Люмен, запам’ятай таємницю',-200));const pending=a.engine.processNext();while(!resolve)await new Promise(r=>setTimeout(r,1));
    await router.receive(msg('/forget_all',-200));await ask(b,msg('Люмен, привіт',-300));resolve({reply:'Таємниця',actions:[{kind:'remember',content:'Таємниця'}]});await pending;
    assert.equal((await a.db.query('SELECT * FROM memories')).rows.length,0);assert.doesNotMatch(JSON.stringify((await a.db.query('SELECT body FROM outbox')).rows),/Таємниця/);assert.match(JSON.stringify((await b.db.query('SELECT body FROM outbox')).rows),/На зв’язку/);
  });
  it('окремий вибір моделі та конфігурація не переходять в іншу групу',async()=>{
    const a=await add(),b=await add(-300);await a.db.query("UPDATE app_state SET model='local-selection' WHERE id=1");
    await Promise.all([ask(a,msg('Люмен, привіт',-200)),ask(b,msg('Люмен, привіт',-300))]);assert.equal(a.engine.config.model,'local-selection');assert.equal(b.engine.config.model,h.config.model);assert.equal(h.config.model,'account-model');
  });
  it('фоновий підсумок отримує тільки джерела своєї групи з позначками тем',async()=>{
    const a=await add(),b=await add(-300);for(let i=0;i<60;i++)await router.receive(msg(`Подія Альфа ${i}`,-200,11,101));await router.receive(msg('Чужа подія Бета',-300));
    let input='';const brain=brains.get('-200')!;brain.text=async (...args:any[])=>{input=JSON.stringify(args);return JSON.stringify({summary:'Тема 101: події Альфа.',source_ids:[1,2]});};
    assert.equal(await new Memory(a.db,brain).compact(),true);assert.match(input,/Подія Альфа/);assert.match(input,/topic_id/);assert.doesNotMatch(input,/Бета/);assert.equal((await b.db.query('SELECT * FROM episodes')).rows.length,0);
  });
  it('зазвичай відповідає простим текстом без постійного меню',async()=>{
    const a=await add();await ask(a,msg('Люмен, привіт'));await a.delivery.next();assert.equal(h.tg.options.at(-1)!.replyMarkup,undefined);assert.equal(h.tg.stickers.length,0);
  });
  it('форматує потрібний фрагмент через Telegram entities зі збереженням Unicode',async()=>{
    const a=await add();brains.get('-200')!.replies.push({reply:'🙂 Ключова думка: відпочинь.',actions:[],presentation:{formatting:[{text:'Ключова думка',style:'bold'}]}});
    await ask(a,msg('Люмен, коротка порада',-200,11,101));await a.delivery.next();assert.equal(h.tg.options.at(-1)!.entities![0]!.offset,3);assert.equal(h.tg.options.at(-1)!.entities![0]!.type,'bold');assert.equal(h.tg.options.at(-1)!.threadId,101);
  });
  it('підхоплює стікери лише у своєму чаті та не відправляє їх під час фонового читання',async()=>{
    const a=await add(),b=await add(-300);const incoming=msg('',-200,22,101);incoming.message!.sticker={file_id:'group_alpha_sticker',file_unique_id:'alpha_unique',emoji:'🙂',type:'regular'};await router.receive(incoming);
    assert.equal((await a.db.query('SELECT * FROM stickers')).rows.length,1);assert.equal((await b.db.query('SELECT * FROM stickers')).rows.length,0);assert.equal((await a.db.query('SELECT * FROM outbox')).rows.length,0);assert.equal(brains.get('-200')!.calls.length,0);
    const sticker=(await one(a.db,'SELECT id FROM stickers'))!;brains.get('-200')!.replies.push({reply:'',actions:[],presentation:{sticker_id:Number(sticker.id),sticker_purpose:'requested'}});await ask(a,msg('Люмен, надішли цей стікер',-200,11,101));await a.delivery.next();assert.deepEqual(h.tg.stickers,[{chatId:'-200',fileId:'group_alpha_sticker',threadId:101}]);
  });
  it('не допускає частих реакцій та стримує їх у серйозних темах',async()=>{
    const a=await add();for(let i=0;i<2;i++){brains.get('-200')!.replies.push({reply:'Добре.',actions:[],presentation:{reaction:'👍'}});await ask(a,msg('Люмен, дякую'));}
    assert.equal((await a.db.query("SELECT * FROM outbox WHERE kind='reaction'")).rows.length,1);
    await a.db.query('DELETE FROM outbox');brains.get('-200')!.replies.push({reply:'Поговорімо спокійно.',actions:[],presentation:{reaction:'😁'}});await ask(a,msg('Люмен, мені дуже важко після смерті близької людини'));assert.equal((await a.db.query("SELECT * FROM outbox WHERE kind='reaction'")).rows.length,0);
  });
  it('модель бачить усі 120 власних сцен навіть серед багатьох чужих стікерів',async()=>{
    const a=await add();const {stickerAssets,seedStickerPack,STICKER_SET}=await import('../src/sticker-pack.js');const assets=await stickerAssets();
    await seedStickerPack(a.db,{name:STICKER_SET,stickers:assets.map((x,i)=>({file_id:'own-'+i,file_unique_id:'own-unique-'+i,is_video:true,emoji:x.emoji}))});
    for(let i=0;i<60;i++)await a.db.query("INSERT INTO stickers(file_id,file_unique_id,set_name) VALUES($1,$2,'OtherSet')",['foreign-'+i,'foreign-unique-'+i]);
    await ask(a,msg('Люмене, які твої емоції є в наборі?'));const catalog=JSON.parse(brains.get('-200')!.calls.at(-1)!.context).available_stickers;
    assert.equal(catalog.filter((x:any)=>x.set_name===STICKER_SET).length,STICKER_COUNT);assert.equal(new Set(catalog.filter((x:any)=>x.set_name===STICKER_SET).map((x:any)=>x.emoji)).size,STICKER_COUNT);assert.ok(catalog.some((x:any)=>x.emoji==='🤖'));
  });
  it('реакція надходить лише на поточне повідомлення у своїй групі',async()=>{
    const a=await add();brains.get('-200')!.replies.push({reply:'',actions:[],presentation:{reaction:'👍'}});const u=msg('Люмен, дякую');await ask(a,u);await a.delivery.next();
    const call=h.tg.calls.find(x=>x.method==='setMessageReaction')!;assert.equal(call.body.chat_id,'-200');assert.equal(call.body.message_id,u.message!.message_id);assert.deepEqual(call.body.reaction,[{type:'emoji',emoji:'👍'}]);assert.equal(call.body.is_big,false);
  });
  it('контекстний вибір означає видимий текст і не переноситься в інший чат чи тему',async()=>{
    const a=await add();await add(-300);brains.get('-200')!.replies.push({reply:'Що обговоримо?',actions:[],presentation:{choices:['Подорожі','Кіно']}});await ask(a,msg('Люмен, запропонуй тему',-200,11,101));
    const queued=(await one(a.db,'SELECT body FROM outbox'))!.body;const data=queued.replyMarkup.inline_keyboard[0][0].callback_data;
    const botMessage={...msg('Що обговоримо?',-200,11,101).message!,from:{id:999,first_name:'Люмен',is_bot:true}};
    const callback=(chat:number,thread:number)=>({update_id:seq++,callback_query:{id:'ctx'+seq,from:{id:22,first_name:'Олена'},data,message:{...botMessage,chat:{id:chat,type:'supergroup'},message_thread_id:thread}}});
    await router.receive(callback(-300,101));await router.receive(callback(-200,202));assert.equal((await a.db.query("SELECT * FROM inbox WHERE status='pending'")).rows.length,0);
    await router.receive(callback(-200,101));const stage=await one(a.db,'SELECT * FROM interactions');const vote=await one(a.db,'SELECT * FROM interaction_responses');assert.equal(stage!.spec.question,'Що обговоримо?');assert.equal(stage!.spec.options[vote!.choices[0]],'Подорожі');assert.equal(vote!.user_id,'22');assert.equal(brains.get('-200')!.calls.length,1);
  });
  it('нативна вікторина передає правильний індекс Telegram, а не підказує його в тексті',async()=>{
    const a=await add();brains.get('-200')!.replies.push({reply:'',actions:[{kind:'quiz',question:'Столиця Японії?',options:['Токіо','Осака'],correct:0,explanation:'Столиця Японії — Токіо.'}]});await ask(a,msg('Люмен, проведи вікторину',-200,11,202));await a.delivery.next();assert.equal(h.tg.polls[0]!.quiz.correct,0);assert.equal(h.tg.polls[0]!.threadId,202);assert.equal((await a.db.query("SELECT * FROM outbox WHERE kind='text'")).rows.length,0);
  });
  it('після уточнення часу не вимагає повторити прохання і не приймає чуже уточнення',async()=>{
    const a=await add();brains.get('-200')!.replies.push({behavior:{move:'clarify',recipient:'bot',relation:'new_request',reason:'Потрібен час нагадування',clarification:{question:'О котрій годині?',missing_slot:'time',why:'Щоб поставити нагадування у потрібний час'}},reply:'О котрій годині завтра?',actions:[]});await ask(a,msg('Люмен, нагадай завтра купити квитки',-200,11,101));assert.equal((await a.db.query('SELECT * FROM pending_intents')).rows.length,1);
    brains.get('-200')!.replies.push({behavior:{move:'answer',recipient:'bot',relation:'answer_to_question',reference_id:(await one(a.db,'SELECT id FROM conversation_goals'))!.id,reason:'Уточнення часу поточного прохання'},reply:'',actions:[{kind:'remind',title:'Квитки',due_at:new Date(Date.now()+3600000).toISOString()}]});await ask(a,msg('Люмен, о 08:30',-200,22,101));assert.equal((await a.db.query('SELECT * FROM reminders')).rows.length,0);
    brains.get('-200')!.replies.push({behavior:{move:'answer',recipient:'bot',relation:'answer_to_question',reference_id:(await one(a.db,'SELECT id FROM conversation_goals'))!.id,reason:'Автор уточнює свою справу'},reply:'',actions:[{kind:'remind',title:'Квитки',due_at:new Date(Date.now()+3600000).toISOString()}]});await ask(a,msg('Люмен, о 08:30',-200,11,101));assert.equal((await a.db.query('SELECT * FROM reminders')).rows.length,1);assert.equal((await a.db.query('SELECT * FROM pending_intents')).rows.length,0);
  });
  it('придумує й починає вільну активність на живе прохання без назви гри чи команди',async()=>{
    const a=await add();brains.get('-200')!.replies.push({reply:'Давайте асоціації! Почну зі слова «море».',actions:[{kind:'start_activity',title:'Асоціації',rules:'Наступний учасник називає асоціацію до попереднього слова; повтори не використовуємо.',summary:'Перше слово — море. Чекаємо асоціацію будь-кого з компанії.'}]});await ask(a,msg('Люмен, нам нудно, придумай щось',-200,11,101));assert.equal((await a.db.query('SELECT id FROM games')).rows.length,0);await router.receive(msg('Долучаюсь',-200,11,101));await router.receive(msg('Долучаюсь',-200,22,101));const stage=await one(a.db,'SELECT id FROM interactions');const close=msg('Завершити набір',-200,11,101);close.message!.lumen_interaction_event={id:stage!.id,version:1,action:'close'};await router.receive(close);await a.engine.processNext();const row=await one(a.db,'SELECT * FROM games');assert.equal(row!.kind,'freeform');assert.equal(row!.topic_id,'101');assert.match(row!.state.rules,/асоціаці/);assert.equal((await one(a.db,'SELECT status FROM inbox'))!.status,'done');
  });
  it('вільна активність зберігає стан, приймає добровільних учасників і не має межі у 20 ходів',async()=>{
    const a=await add();brains.get('-200')!.replies.push({reply:'Починаємо.',actions:[{kind:'start_activity',title:'Пригода',rules:'Разом досліджуємо острів; Люмен реагує на рішення учасників і веде історію.',summary:'Команда висадилася на острів.'}]});await ask(a,msg('Люмен, почни пригоду',-200,11,101));
    const gameRoot=(await one(a.db,'SELECT id FROM interactions'))!.id,tools=new AgentTools(a.db,a.engine.config,brains.get('-200')!);
    for(const uid of [12,13]){await router.receive(msg('Хочу долучитися до пригоди',-200,uid,101));await tools.execute('interaction.join',{id:gameRoot},{actorId:String(uid),chatId:'-200',topicId:'101',revision:0,updateId:'join-'+uid,requested:true});}
    for(let i=0;i<24;i++){const uid=i%3+11;brains.get('-200')!.replies.push({reply:`Подія ${i}.`,actions:[{kind:'activity_turn',summary:`Герої дійшли до етапу ${i}.`,score_changes:[{user_id:String(uid),delta:1}]}]});await ask(a,msg(`Люмен, досліджую місце ${i}`,-200,uid,101));}
    const row=await one(a.db,'SELECT * FROM games');assert.equal(row!.status,'active');assert.equal(row!.state.turn,24);assert.equal(row!.state.players.length,3);assert.equal(row!.state.scores['11'],8);assert.match(row!.state.summary,/23/);
    const fresh=new ChatRouter(registry,h.config,h.tg as unknown as Telegram,bot,()=>new FakeBrain());await fresh.init();assert.equal((await one((await fresh.runtime((await registry.find('-200'))!)).db,'SELECT state FROM games'))!.state.turn,24);
  });
  it('активність не додає балів учаснику з іншої групи й не змінює стан при помилці',async()=>{
    const a=await add(),b=await add(-300);await router.receive(msg('Повідомлення іншої групи',-300,77));
    brains.get('-200')!.replies.push({reply:'Почали.',actions:[{kind:'start_activity',title:'Гра',rules:'За змістовний хід додаємо бал, потім продовжуємо.',summary:'Очікуємо перший хід.'}]});await ask(a,msg('Люмен, починай гру',-200,11,101));
    brains.get('-200')!.replies.push({reply:'',actions:[{kind:'activity_turn',summary:'Стан, який не можна зберегти.',score_changes:[{user_id:'77',delta:5}]}]});await ask(a,msg('Люмен, ось мій хід',-200,11,101));const row=await one(a.db,'SELECT state FROM games');assert.equal(row!.state.turn,0);assert.equal(row!.state.scores['77'],undefined);assert.match(row!.state.summary,/перший/);assert.equal((await b.db.query('SELECT * FROM games')).rows.length,0);
  });
  it('звичайне прохання показати нотатки викликає перегляд лише своєї групи',async()=>{
    const a=await add(),b=await add(-300);await a.db.query("INSERT INTO memories(content,author_id) VALUES('Наші квитки','11')");await b.db.query("INSERT INTO memories(content,author_id) VALUES('Чужий пароль','11')");brains.get('-200')!.replies.push({reply:'',actions:[{kind:'inspect',subject:'notes'}]},{reply:'Наші квитки — ось що зберегли.',actions:[]});await ask(a,msg('Люмен, покажи наші нотатки'));const sources=brains.get('-200')!.calls[1]!.context;assert.match(sources,/Наші квитки/);assert.doesNotMatch(sources,/Чужий пароль/);const replies=JSON.stringify((await a.db.query('SELECT body FROM outbox')).rows);assert.match(replies,/Наші квитки/);assert.doesNotMatch(replies,/Чужий пароль/);
  });
  it('постійний характер змінюється живою мовою лише власником',async()=>{
    const a=await add();brains.get('-200')!.replies.push({reply:'',actions:[{kind:'set_character',character:'Стриманий гумор і короткі пояснення.'}]});await ask(a,msg('Люмен, зміни постійний характер: стриманий гумор',-200,11));assert.match((await state(a.db)).character,/Стриманий/);
    brains.get('-200')!.replies.push({reply:'',actions:[{kind:'set_character',character:'Змінити чужі правила.'}]});await ask(a,msg('Люмен, зміни характер',-200,22));assert.match((await state(a.db)).character,/Стриманий/);assert.doesNotMatch((await state(a.db)).character,/чужі/);
  });
  it('група зі 120 учасниками не відхиляє звернення через робочу вибірку контексту',async()=>{
    const a=await add();for(let i=0;i<120;i++)await router.receive(msg(`Репліка ${i}`,-200,1000+i));await ask(a,msg('Люмен, привіт',-200,1000));assert.equal((await a.db.query('SELECT * FROM members')).rows.length,120);assert.equal(brains.get('-200')!.calls.length,1);assert.ok(JSON.parse(brains.get('-200')!.calls[0]!.context).participants.some((p:any)=>p.id==='1000'));
  });
  it('ChatGPT не має штучної межі 200 звернень, а явний бюджет власника діє',async()=>{
    const a=await add();const day=new Date().toISOString().slice(0,10);await a.db.query('INSERT INTO daily_usage(day,requests) VALUES($1,200)',[day]);await ask(a,msg('Люмен, привіт'));assert.equal(brains.get('-200')!.calls.length,1);
    a.engine.config.dailyTurnLimit=201;await ask(a,msg('Люмен, ще одне питання'));assert.equal(brains.get('-200')!.calls.length,1);assert.equal((await state(a.db)).last_model_error,'daily_request_limit');
  });
  it('правила вільної гри адаптуються на прохання й стан зберігає нову версію',async()=>{
    const a=await add();brains.get('-200')!.replies.push({reply:'Граємо.',actions:[{kind:'start_activity',title:'Командна історія',rules:'Учасники розповідають історію по одному реченню.',summary:'Починаємо історію.'}]});await ask(a,msg('Люмен, почни гру'));
    brains.get('-200')!.replies.push({reply:'Тепер граємо командами.',actions:[{kind:'activity_turn',rules:'Об’єднуємося у дві команди; кожна додає абзац по черзі.',summary:'Перейшли до командного формату. Першою пише перша команда.'}]});await ask(a,msg('Люмен, підлаштуй правила під дві команди'));const row=await one(a.db,'SELECT state FROM games');assert.match(row!.state.rules,/дві команди/);assert.equal(row!.state.turn,1);
  });
  it('підтвердити зовнішню дію може тільки її автор у тій самій темі',async()=>{
    const a=await add();const id='10203040-1020-4020-8020-102030405060';
    await a.db.query("INSERT INTO tool_approvals(id,actor_id,tool,arguments,argument_hash,summary,revision,topic_id) VALUES($1,'11','browser.commit','{}','hash','Підтвердити дію',0,'77')",[id]);
    const click=async(uid:number,topic:number)=>router.receive({update_id:seq++,callback_query:{id:'approval'+seq,from:{id:uid,first_name:'Учасник'},data:'lumen:approve:'+id,message:{message_id:123,chat:{id:-200,type:'supergroup'},from:{...bot,first_name:'Люмен'},date:Math.floor(Date.now()/1000),message_thread_id:topic}}});
    await click(22,77);assert.equal((await one(a.db,'SELECT status FROM tool_approvals'))!.status,'pending');
    await click(11,88);assert.equal((await one(a.db,'SELECT status FROM tool_approvals'))!.status,'pending');
    await click(11,77);assert.equal((await one(a.db,'SELECT status FROM tool_approvals'))!.status,'approved');
  });

});
