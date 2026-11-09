import {describe,it,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {TestDB,harness,paired,message} from './helpers.js';
import {authorizeAction} from '../src/engine.js';
import {one,state,eraseAll,queueText} from '../src/db.js';
import {Delivery} from '../src/delivery.js';
import {Telegram,type Message} from '../src/telegram.js';
import type {Brain,Plan} from '../src/model.js';
import {personalizationContext,PersonalizedBrain,recoverPersonalization} from '../src/personalization.js';
import {OutboundLocalizer} from '../src/localization.js';
import {scheduleDecision,dispatchSchedules} from '../src/scheduling.js';

describe('Постійна персоналізація й відкладені доручення',()=>{
 let db:TestDB,h:ReturnType<typeof harness>;
 beforeEach(async()=>{db=new TestDB();await db.init();h=harness(db);await paired(h);});afterEach(async()=>{await db.close();});
 const future=()=>new Date(Date.now()+3600000).toISOString();
 async function turn(text:string,actions:Plan['actions'],uid=11,extra:Partial<Message>={}){h.brain.replies.push({reply:'',actions,...(actions[0]?.kind==='schedule_decision'?{behavior:{move:'answer',recipient:'bot',relation:'accept_offer',reference_id:actions[0].id,reason:'Автор погоджує точну пропозицію'}}:{})});const u=message(text,uid);Object.assign(u.message!,extra);await h.lumen.receive(u);await db.query("UPDATE inbox SET available_at=now()-interval '1 second' WHERE status='pending'");assert.equal(await h.lumen.processNext(),true);return u;}
 async function deliver(){const d=new Delivery(db,h.tg as unknown as Telegram,h.config);for(let i=0;i<8&&await d.next();i++);return d;}
 it('одне повідомлення зберігає російську мову чату та конкретну дію на майбутній час без слова «нагадай»',async()=>{
   const text='Люмен, когда будет девять, сделай это. И всё в этом чате пиши на русском.';
   await turn(text,[{kind:'personalize',scope:'chat',language:'ru',quote:'всё в этом чате пиши на русском'},{kind:'schedule',title:'Ранковий жарт',instruction:'Придумати й надіслати доброзичливий жарт про ім’я Люмена',mode:'task',due_at:future(),timezone:'Europe/Kyiv',authorization:'explicit',quote:'когда будет девять, сделай это'}]);
   assert.equal((await one(db,'SELECT language FROM chat_preferences'))!.language,'ru');const job=await one(db,'SELECT * FROM scheduled_actions');assert.equal(job!.status,'pending');assert.equal(job!.mode,'task');assert.ok(job!.instruction.includes('ім’я Люмена'));assert.equal((await state(db)).last_model_error,null);assert.equal((await db.query('SELECT * FROM agent_tasks')).rows.length,0);
 });
 it('некоректний час не відкочує окреме коректне налаштування мови',async()=>{
   await turn('Люмен, пиши в чаті російською і зроби це о дев’ятій',[{kind:'personalize',scope:'chat',language:'ru',quote:'пиши в чаті російською'},{kind:'schedule',title:'Жарт',instruction:'Надіслати жарт',mode:'task',due_at:new Date(Date.now()-60000).toISOString(),timezone:'Europe/Kyiv',authorization:'explicit',quote:'зроби це о дев’ятій'}]);
   assert.equal((await one(db,'SELECT language FROM chat_preferences'))!.language,'ru');assert.equal((await db.query('SELECT * FROM scheduled_actions')).rows.length,0);assert.match((await one(db,"SELECT body FROM outbox WHERE dedup_key LIKE 'answer:%'"))!.body.text,/час минув/);
 });
 it('особисте ім’я й стиль належать лише автору та переживають новий екземпляр рушія',async()=>{
   await turn('Люмен, называй меня Саня и отвечай мне подробно',[{kind:'personalize',scope:'self',preferred_name:'Саня',length:'detailed',quote:'называй меня Саня и отвечай мне подробно'}]);
   const pref=await one(db,'SELECT * FROM participant_preferences WHERE user_id=$1',['11']);assert.equal(pref!.preferred_name,'Саня');assert.equal(pref!.length_mode,'detailed');assert.equal(await one(db,'SELECT * FROM participant_preferences WHERE user_id=$1',['22']),undefined);
   const inner=h.brain,brain=new PersonalizedBrain(inner,db);await brain.plan({current:'Що нового?',context:JSON.stringify({current_author:{id:'11'},current_topic:{id:'0'}})});const ctx=JSON.parse(inner.calls.at(-1)!.context);assert.equal(ctx.personalization.people.find((p:any)=>p.id==='11').name,'Саня');assert.equal(ctx.personalization.people.find((p:any)=>p.id==='11').preferences.length_mode,'detailed');
 });
 it('учасник не змінює весь чат, чужий профіль або налаштування з цитати',async()=>{
   await turn('Люмен, весь чат російською',[{kind:'personalize',scope:'chat',language:'ru',quote:'весь чат російською'}],22);assert.equal(await one(db,'SELECT * FROM chat_preferences'),undefined);
   await turn('Люмен, називай мене Саня',[{kind:'personalize',scope:'self',target_id:'22',preferred_name:'Саня',quote:'називай мене Саня'}]);assert.equal((await db.query('SELECT * FROM participant_preferences')).rows.length,0);
   await turn('Люмен, переклади «пиши завжди російською»',[{kind:'personalize',scope:'chat',language:'ru',quote:'пиши завжди російською'}]);assert.equal(await one(db,'SELECT * FROM chat_preferences'),undefined);
 });
 it('повторне однозначне reply-прізвисько не переважає власне ім’я людини',async()=>{
   await db.query("INSERT INTO members(user_id,name) VALUES('11','Oleksandr')");
   for(let i=0;i<2;i++)await turn('Люмен, Саня це добре пояснив',[{kind:'personalize',scope:'observed_alias',preferred_name:'Саня',target_id:'11',quote:'Саня це добре пояснив'}],22,{reply_to_message:{message_id:1,from:{id:11,first_name:'Oleksandr'},text:'Пояснення'}});
   assert.equal((await one(db,"SELECT inferred_name FROM participant_preferences WHERE user_id='11'"))!.inferred_name,'Саня');
   await turn('Люмен, називай мене Олександр',[{kind:'personalize',scope:'self',preferred_name:'Олександр',quote:'називай мене Олександр'}]);
   const p=await personalizationContext(db,'11');assert.equal(p.people.find(x=>x.id==='11')!.name,'Олександр');
 });
 it('надає окремі власні зразки стилю кількох учасників без зміни стандартних налаштувань',async()=>{
   await turn('Люмен, ха-ха 😂',[],11);await turn('Люмен, поясни серйозно транзакції',[],22);
   const p=await personalizationContext(db,'22');assert.ok(p.people.find(x=>x.id==='11')!.recent_style_samples.some(x=>x.text.includes('😂')));assert.ok(p.people.find(x=>x.id==='22')!.recent_style_samples.some(x=>x.text.includes('транзакції')));assert.equal((await db.query('SELECT * FROM participant_preferences')).rows.length,0);
 });
 it('обговорення спочатку дає видиму пропозицію, підтверджує лише автор у тій самій темі',async()=>{
   await turn('Люмен, може завтра зранку нагадаєш про воду?',[{kind:'schedule',title:'Вода',instruction:'Випити воду',mode:'reminder',due_at:future(),timezone:'Europe/Kyiv',authorization:'ask',quote:'може завтра зранку нагадаєш про воду?'}]);
   let row=(await one(db,'SELECT * FROM scheduled_actions'))!;assert.equal(row.status,'awaiting_confirmation');assert.equal(await dispatchSchedules(db),0);
   await deliver();row=(await one(db,'SELECT * FROM scheduled_actions'))!;assert.ok(row.confirmation_message_id);
   const yes=message('Так, підтверджую',22).message!;await assert.rejects(db.tx(sql=>scheduleDecision(sql,{kind:'schedule_decision',id:row.id,decision:'confirm',quote:'Так, підтверджую'},yes,0)),/schedule_confirmation_unbound/);
   await turn('Так, підтверджую',[{kind:'schedule_decision',id:row.id,decision:'confirm',quote:'Так, підтверджую'}]);assert.equal((await one(db,'SELECT status FROM scheduled_actions'))!.status,'pending');assert.equal((await db.query('SELECT * FROM scheduled_actions')).rows.length,1);
 });
 it('явне ім’я зберігається одразу, а непевне нагадування чекає власного підтвердження',async()=>{
   const text='Люмен, називай мене Саня. А може завтра о дев’ятій нагадаєш мені випити воду?';
   await turn(text,[{kind:'personalize',scope:'self',preferred_name:'Саня',quote:'називай мене Саня'},{kind:'schedule',title:'Вода',instruction:'Випити воду',mode:'reminder',due_at:new Date(Date.now()+86400000).toISOString(),timezone:'Europe/Kyiv',authorization:'ask',quote:'може завтра о дев’ятій нагадаєш мені випити воду?'}]);
   assert.equal((await one(db,"SELECT preferred_name FROM participant_preferences WHERE user_id='11'"))!.preferred_name,'Саня');
   assert.equal((await one(db,'SELECT status FROM scheduled_actions'))!.status,'awaiting_confirmation');
   assert.equal((await db.query('SELECT id FROM interactions')).rows.length,0);assert.equal((await db.query('SELECT id FROM reminders')).rows.length,0);
   const visible=JSON.stringify((await db.query("SELECT body FROM outbox WHERE kind='text'")).rows);assert.match(visible,/Саня/);assert.match(visible,/Підтвер/);
 });
 it('пропозиція або її недоступна можливість не губить незалежне явне налаштування',async()=>{
   const offer:NonNullable<Plan['offer']>={title:'Коротка спільна історія',reason:'Є час на спільну творчу паузу',value:'Кожен додає свою подію',scale:'П’ять хвилин',first_step:'Перший гравець обирає місце',scope:'invited',participant_ids:['11','22'],action:{kind:'start_game',game:'story'}};
   h.brain.replies.push({reply:'',actions:[{kind:'personalize',scope:'self',preferred_name:'Саня',quote:'називай мене Саня'},{kind:'start_game',game:'story'}],offer});
   await h.lumen.receive(message('Люмен, називай мене Саня. Можеш запропонувати нам гру?'));await h.lumen.processNext();
   assert.equal((await one(db,"SELECT preferred_name FROM participant_preferences WHERE user_id='11'"))!.preferred_name,'Саня');
   assert.equal((await one(db,'SELECT phase FROM interactions'))!.phase,'collecting');assert.equal((await db.query('SELECT id FROM games')).rows.length,0);
   h.brain.replies.push({reply:'',actions:[{kind:'personalize',scope:'self',preferred_name:'Олександр',quote:'називай мене Олександр'}],offer:{...offer,action:{kind:'tool',name:'missing.capability',arguments:'{}'}}});
   await h.lumen.receive(message('Люмен, називай мене Олександр і запропонуй нову активність'));await h.lumen.processNext();
   assert.equal((await one(db,"SELECT preferred_name FROM participant_preferences WHERE user_id='11'"))!.preferred_name,'Олександр');assert.equal((await db.query('SELECT id FROM interactions')).rows.length,1);
   const visible=JSON.stringify((await db.query("SELECT body FROM outbox WHERE dedup_key LIKE 'answer-independent:%'")).rows);assert.match(visible,/Олександр/);assert.match(visible,/інструмент, якого немає в поточному каталозі/);assert.equal((await db.query('SELECT id FROM games')).rows.length,0);
 });
 it('дубль запропонованого інструмента не виконується до згоди й не губить ім’я',async()=>{
   const proposed:Plan['actions'][number]={kind:'tool',name:'artifact.create',arguments:JSON.stringify({name:'Proposal.txt',content:'Ще не погоджений файл'})};
   h.brain.replies.push({reply:'',actions:[{kind:'personalize',scope:'self',preferred_name:'Алекс',quote:'називай мене Алекс'},proposed],offer:{title:'Короткий файл для тебе',reason:'Дані зручно зберегти окремо',value:'Легко повернутися до результату',scale:'Один короткий файл',first_step:'Зберу текст після твого погодження',scope:'personal',participant_ids:['11'],action:proposed}});
   await h.lumen.receive(message('Люмен, називай мене Алекс і запропонуй файл'));await h.lumen.processNext();
   assert.equal((await one(db,"SELECT preferred_name FROM participant_preferences WHERE user_id='11'"))!.preferred_name,'Алекс');
   assert.equal((await one(db,'SELECT phase FROM interactions'))!.phase,'collecting');
   assert.equal((await db.query('SELECT id FROM agent_artifacts')).rows.length,0);assert.equal((await db.query('SELECT id FROM tool_runs')).rows.length,0);
   assert.equal((await db.query("SELECT id FROM outbox WHERE kind='artifact'")).rows.length,0);assert.equal(h.brain.calls.length,1);
 });
 it('випадкове «так» після іншої відповіді або в іншій темі не погоджує стару пропозицію',async()=>{
   await turn('Люмен, може нагадаєш про воду?',[{kind:'schedule',title:'Вода',instruction:'Випити воду',mode:'reminder',due_at:future(),timezone:'Europe/Kyiv',authorization:'ask',quote:'може нагадаєш про воду?'}]);await deliver();const row=(await one(db,'SELECT * FROM scheduled_actions'))!;
   await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES(9999,'lumen','Люмен','assistant','Інше запитання?')");
   const m=message('Так, підтверджую').message!;await assert.rejects(db.tx(sql=>scheduleDecision(sql,{kind:'schedule_decision',id:row.id,decision:'confirm',quote:'Так, підтверджую'},m,0)),/schedule_confirmation_unbound/);
   m.message_thread_id=5;await assert.rejects(db.tx(sql=>scheduleDecision(sql,{kind:'schedule_decision',id:row.id,decision:'confirm',quote:'Так, підтверджую'},m,0)),/schedule_confirmation_unbound/);
 });
 it('виконує нагадування один раз у належній темі та завершує лише після доставки',async()=>{
   await turn('Люмен, через годину нагадай випити воду',[{kind:'schedule',title:'Вода',instruction:'Випити воду',mode:'reminder',due_at:future(),timezone:'Europe/Kyiv',authorization:'explicit',quote:'через годину нагадай випити воду'}],11,{message_thread_id:7});
   const row=(await one(db,'SELECT * FROM scheduled_actions'))!;assert.equal(await dispatchSchedules(db),0);await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 second' WHERE id=$1",[row.id]);assert.equal(await dispatchSchedules(db),1);assert.equal(await dispatchSchedules(db),0);
   const out=(await one(db,"SELECT * FROM outbox WHERE dedup_key LIKE 'scheduled:%'"))!;assert.equal(out.body.threadId,7);assert.equal(out.actor_id,'11');assert.equal((await one(db,'SELECT status FROM scheduled_actions'))!.status,'queued');await deliver();assert.equal((await one(db,'SELECT status FROM scheduled_actions'))!.status,'completed');assert.equal(h.tg.sent.filter(x=>x.text==='Нагадування: Випити воду').length,1);
 });
 it('довге нагадування завершується після всіх частин, а збій другої частини потребує уваги',async()=>{
   const text='Люмен, через годину нагадай прочитати список';await turn(text,[{kind:'schedule',title:'Список',instruction:'Пункт списку. '.repeat(400),mode:'reminder',due_at:future(),timezone:'Europe/Kyiv',authorization:'explicit',quote:'через годину нагадай прочитати список'}]);await deliver();await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 second'");await dispatchSchedules(db);const d=new Delivery(db,h.tg as unknown as Telegram,h.config);await d.next();assert.equal((await one(db,'SELECT status FROM scheduled_actions'))!.status,'queued');h.tg.text=async()=>{throw Error('delivery_failed');};await d.next();assert.equal((await one(db,'SELECT status FROM scheduled_actions'))!.status,'needs_input');
 });
 it('майбутнє виконання створює справжню задачу лише в потрібний час із новим строком виконання',async()=>{
   await turn('Люмен, о дев’ятій зроби це',[{kind:'schedule',title:'Огляд',instruction:'Знайти актуальну погоду в Києві та коротко описати її в цій темі',mode:'task',due_at:future(),timezone:'Europe/Kyiv',authorization:'explicit',quote:'о дев’ятій зроби це'}]);
   assert.equal((await db.query('SELECT * FROM agent_tasks')).rows.length,0);await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 second'");await dispatchSchedules(db);await dispatchSchedules(db);const tasks=(await db.query('SELECT * FROM agent_tasks')).rows;assert.equal(tasks.length,1);assert.equal(tasks[0]!.actor_id,'11');assert.ok(tasks[0]!.goal.includes('погоду в Києві'));assert.ok(new Date(tasks[0]!.deadline).getTime()>Date.now()+25*60000);await db.query("UPDATE agent_tasks SET status='completed'");await dispatchSchedules(db);assert.equal((await one(db,'SELECT status FROM scheduled_actions'))!.status,'completed');
 });
 it('пауза й очищення пам’яті блокують майбутні дії та видаляють профілі',async()=>{
   await turn('Люмен, нагадай воду через годину',[{kind:'schedule',title:'Вода',instruction:'Випити воду',mode:'reminder',due_at:future(),timezone:'Europe/Kyiv',authorization:'explicit',quote:'нагадай воду через годину'}]);await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 second'");await db.query('UPDATE app_state SET paused=true');assert.equal(await dispatchSchedules(db),0);await db.tx(eraseAll);assert.equal((await db.query('SELECT * FROM scheduled_actions')).rows.length,0);assert.equal((await db.query('SELECT * FROM participant_preferences')).rows.length,0);
 });
 it('відновлює явну давню мову тільки з повідомлення власника в межах цього чату',async()=>{
   await turn('Люмен, абсолютно всё в этом чате на русском',[]);const source=(await one(db,"SELECT id FROM messages WHERE body=$1",['Люмен, абсолютно всё в этом чате на русском']))!;
   const brain:Brain={plan:async()=>({reply:'',actions:[]}),text:async()=>JSON.stringify({settings:[{source_id:Number(source.id),action:{kind:'personalize',scope:'chat',language:'ru',quote:'абсолютно всё в этом чате на русском'}}]})};await recoverPersonalization(db,brain);assert.equal((await one(db,'SELECT language FROM chat_preferences'))!.language,'ru');assert.equal((await state(db)).personalization_recovered,true);
 });
 it('те саме ім’я учасника в іншому чаті не переносить мову, стиль або прізвисько',async()=>{
   await turn('Люмен, называй меня Саня и всегда говори со мной по-русски',[{kind:'personalize',scope:'self',language:'ru',preferred_name:'Саня',quote:'называй меня Саня и всегда говори со мной по-русски'}]);
   const other=new TestDB();await other.init();try{const p=await personalizationContext(other,'11');assert.equal(p.language,'uk');assert.equal(p.people.find(x=>x.id==='11')!.name,'');assert.equal(p.people.find(x=>x.id==='11')!.recent_style_samples.length,0);}finally{await other.close();}
 });
 it('явне скасування прізвиська прибирає і попереднє спостереження',async()=>{
   await db.query("INSERT INTO participant_preferences(user_id,preferred_name,inferred_name) VALUES('11','Саня','Саня')");
   await turn('Люмен, не называй меня больше Саня',[{kind:'personalize',scope:'self',preferred_name:'',quote:'не называй меня больше Саня'}]);
   const p=(await one(db,"SELECT * FROM participant_preferences WHERE user_id='11'"))!;assert.equal(p.preferred_name,'');assert.equal(p.inferred_name,'');
 });
 it('семантичне доручення працює без українського ключового слова, але не з цитати перекладу',async()=>{
   const action={kind:'remember' as const,content:'Вода'};assert.doesNotThrow(()=>authorizeAction(action,'Люмен, сохрани это на будущее',true,h.config,[],{quote:'сохрани это на будущее',actions:['remember']}));
   assert.throws(()=>authorizeAction(action,'Люмен, переклади «сохрани это на будущее»',true,h.config,[],{quote:'переклади «сохрани это на будущее»',actions:['remember']}),/action_not_explicit/);
 });
 it('помилковий UTC offset не підміняє вказаний місцевий час',async()=>{
   await turn('Люмен, о дев’ятій нагадай воду',[{kind:'schedule',title:'Вода',instruction:'Випити воду',mode:'reminder',due_at:future(),local_time:'2099-01-01T09:00',timezone:'Europe/Kyiv',authorization:'explicit',quote:'о дев’ятій нагадай воду'}]);
   assert.equal((await db.query('SELECT * FROM scheduled_actions')).rows.length,0);assert.match((await one(db,"SELECT body FROM outbox WHERE dedup_key LIKE 'answer:%'"))!.body.text,/Місцевий час не відповідає/);
 });
 it('майбутній запис не дозволяє тексту моделі оголосити дію вже виконаною',async()=>{
   const text='Люмен, через годину нагадай воду';h.brain.replies.push({reply:'Я вже виконав дію!',actions:[{kind:'schedule',title:'Вода',instruction:'Випити воду',mode:'reminder',due_at:future(),timezone:'Europe/Kyiv',authorization:'explicit',quote:'через годину нагадай воду'}]});await h.lumen.receive(message(text));await h.lumen.processNext();
   const body=(await one(db,"SELECT body FROM outbox WHERE dedup_key LIKE 'answer:%'"))!.body.text;assert.ok(!body.includes('вже виконав'));assert.match(body,/Запланував/);
 });
 it('звичайний учасник не скасовує чуже нагадування',async()=>{
   const row=(await one(db,"INSERT INTO reminders(title,due_at,author_id) VALUES('Вода',now()+interval '1 hour','11') RETURNING id"))!;
   const request=message('Люмен, скасуй нагадування',22);await h.lumen.receive(request);assert.equal((await one(db,'SELECT status FROM reminders'))!.status,'pending');assert.equal(h.brain.calls.length,0);
   assert.match((await one(db,"SELECT body FROM outbox WHERE dedup_key LIKE $1",['control:'+request.update_id+':%']))!.body.text,/яким ти можеш керувати.*не знайшов/);await h.lumen.receive(message('/cancel '+row.id,22));assert.equal((await one(db,'SELECT status FROM reminders'))!.status,'pending');
 });
});

describe('Єдина мова всіх вихідних повідомлень',()=>{
 let db:TestDB;beforeEach(async()=>{db=new TestDB();await db.init();await db.query("INSERT INTO chat_preferences(id,language) VALUES(1,'ru')");});afterEach(async()=>{await db.close();});
 function translator(map:(text:string,language:string)=>string):Brain{return {plan:async()=>({reply:'',actions:[]}),text:async input=>{const data=JSON.parse(input[0].content);return JSON.stringify({texts:data.texts.map((s:string)=>map(s,data.language))});}};}
 it('перекладає текст, запитання, варіанти й кнопки, зберігаючи callback та URL',async()=>{
   const localizer=new OutboundLocalizer(db,translator((t)=>({'Привіт':'Привет','Так':'Да','Ні':'Нет','Додати':'Добавить'}[t]||t)));
   const body=await localizer.transform('sendMessage',{chat_id:'-100',text:'Привіт',reply_markup:{inline_keyboard:[[{text:'Додати',callback_data:'lumen:42',url:'https://t.me/lumen_family_agent'}]]},entities:[{offset:0,length:6,type:'bold'}]});assert.equal(body.text,'Привет');assert.equal(body.reply_markup.inline_keyboard[0][0].text,'Добавить');assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data,'lumen:42');assert.equal(body.reply_markup.inline_keyboard[0][0].url,'https://t.me/lumen_family_agent');assert.equal(body.entities,undefined);
   const poll=await localizer.transform('sendPoll',{question:'Привіт',options:[{text:'Так'},{text:'Ні'}]});assert.deepEqual(poll.options,[{text:'Да'},{text:'Нет'}]);assert.equal(poll.question,'Привет');
 });
 it('перекладає пояснення помилки, зберігаючи весь регістрозалежний LM-код і кеш без додаткового виклику моделі',async()=>{
   const code='LM-01JBA123450123456789ABCDEF',text='Помилка. Код для розробників: '+code+'.';let calls=0;
   const brain:Brain={plan:async()=>({reply:'',actions:[]}),text:async input=>{calls++;const data=JSON.parse(input[0].content);assert.ok(data.preserve[0].includes(code));return JSON.stringify({texts:['Error. Developer reference: '+code+'.']});}};
   const localizer=new OutboundLocalizer(db,brain),request={chat_id:'-100',text,_lumen_output_language:'en'};
   assert.equal((await localizer.transform('sendMessage',request)).text,'Error. Developer reference: '+code+'.');
   assert.equal((await localizer.transform('editMessageText',{...request,message_id:1})).text,'Error. Developer reference: '+code+'.');assert.equal(calls,1);
   assert.equal((await one(db,'SELECT language FROM chat_preferences'))!.language,'ru');
 });
 it('відхиляє зміну літери, регістру або вилучення LM-коду навіть зі збереженими числовими фрагментами',async()=>{
   const code='LM-01JBA123450123456789ABCDEF',text='Помилка. Код для розробників: '+code+'.';
   for(const translated of ['Error. Developer reference: '+code.slice(0,-1)+'G.','Error. Developer reference: '+code.toLowerCase()+'.','Error. Reference parts: 01 and 123450123456789.']){
    let calls=0;const brain=translator(()=>{calls++;return translated;}),localizer=new OutboundLocalizer(db,brain);
    await assert.rejects(localizer.transform('sendMessage',{chat_id:'-100',text}),/localization_unavailable/);assert.equal(calls,1);
   }
 });
 it('перевіряє реальний транспорт send/edit та multipart-підписи, а не лише підказку моделі',async()=>{
   const sent:any[]=[];const tg=new Telegram('test',async(_url,options)=>{const body=options!.body instanceof FormData?Object.fromEntries(options!.body.entries()):JSON.parse(String(options!.body));sent.push(body);return new Response(JSON.stringify({ok:true,result:{message_id:1,text:body.text,caption:body.caption}}),{status:200,headers:{'Content-Type':'application/json'}});});const localizer=new OutboundLocalizer(db,translator(t=>t==='Нагадування'?'Напоминание':t));tg.setOutboundTransform((m,b)=>localizer.transform(m,b));await tg.text('-100','Нагадування',{actorId:'11'});await tg.call('editMessageText',{chat_id:'-100',message_id:1,text:'Нагадування'});await tg.upload('sendPhoto','-100',Buffer.from('image'),'Нагадування','image/png');assert.equal(sent.length,3);assert.equal(sent[0].text,'Напоминание');assert.equal(sent[1].text,'Напоминание');assert.equal(sent[2].caption,'Напоминание');assert.equal(sent[0]._lumen_actor_id,undefined);
 });
 it('поточна мова чату переважає особисту; виняток перекладу діє лише для однієї відповіді',async()=>{
   await db.query("INSERT INTO participant_preferences(user_id,language) VALUES('11','en')");const localizer=new OutboundLocalizer(db,translator((_,language)=>language==='ru'?'Русский ответ':'English answer'));assert.equal((await localizer.transform('sendMessage',{text:'Відповідь',_lumen_actor_id:'11'})).text,'Русский ответ');assert.equal((await localizer.transform('sendMessage',{text:'Відповідь',_lumen_actor_id:'11',_lumen_output_language:'en'})).text,'English answer');assert.equal((await one(db,'SELECT language FROM chat_preferences'))!.language,'ru');
 });
 it('разовий переклад зберігає мову під час заміни повідомлення про підготовку відповіддю',async()=>{
   const h=harness(db);await paired(h);await db.query('DELETE FROM outbox');const calls:any[]=[];const tg=new Telegram('test',async(_url,options)=>{const body=JSON.parse(String(options!.body));calls.push(body);return new Response(JSON.stringify({ok:true,result:{message_id:55,text:body.text}}),{status:200,headers:{'Content-Type':'application/json'}});});const localizer=new OutboundLocalizer(db,translator((_,lang)=>lang==='en'?'English answer':'Русский ответ'));tg.setOutboundTransform((m,b)=>localizer.transform(m,b));await db.tx(sql=>queueText(sql,'Відповідь',0,'answer:123',false,{actorId:'11',outputLanguage:'en'}));await db.query("INSERT INTO outbox(kind,body,revision,dedup_key,status,telegram_id) VALUES('text','{}',0,'progress:123:0','sent',55)");await new Delivery(db,tg,h.config).next();assert.equal(calls[0].message_id,55);assert.equal(calls[0].text,'English answer');assert.equal((await one(db,'SELECT language FROM chat_preferences'))!.language,'ru');
 });
 it('зміна мови під час перекладу не випускає повідомлення зі старим налаштуванням',async()=>{
   let calls=0;const brain=translator((_,lang)=>lang==='ru'?'Русский':'English');const old=brain.text;brain.text=async(...args)=>{calls++;const result=await old(...args);if(calls===1)await db.query("UPDATE chat_preferences SET language='en',version=version+1");return result;};const localizer=new OutboundLocalizer(db,brain);assert.equal((await localizer.transform('sendMessage',{text:'Привіт'})).text,'English');assert.equal(calls,2);
 });
 it('збій перекладу не надсилає неправильну мову або незворотний повтор',async()=>{
   const brain:Brain={plan:async()=>({reply:'',actions:[]}),text:async()=> 'не JSON'};let sends=0;const tg=new Telegram('test',async()=>{sends++;return new Response('{}');});const localizer=new OutboundLocalizer(db,brain);tg.setOutboundTransform((m,b)=>localizer.transform(m,b));await assert.rejects(tg.text('-100','Привіт'),/localization_unavailable/);assert.equal(sends,0);
 });
 it('заборона емодзі поширюється на службові рядки та підписи альбому',async()=>{
   await db.query("UPDATE chat_preferences SET emoji_mode='off'");const localizer=new OutboundLocalizer(db,translator(t=>t));const body=await localizer.transform('sendMediaGroup',{media:[{caption:'Готово 🎉'}]});assert.equal(body.media[0].caption,'Готово');
 });
 it('підтримує перевірений JSON-формат відповіді моделі для вихідних текстів',async()=>{
   const brain:Brain={plan:async()=>({reply:'',actions:[]}),text:async()=>{throw Error('unstructured path used');},structured:async()=>({texts:['Привет']})};const localizer=new OutboundLocalizer(db,brain);assert.equal((await localizer.transform('sendMessage',{text:'Привіт'})).text,'Привет');
 });
 it('пауза під час перекладу зупиняє повідомлення перед викликом Telegram',async()=>{
   const brain=translator(t=>t);const original=brain.text;brain.text=async(...args)=>{const result=await original(...args);await db.query('UPDATE app_state SET paused=true,memory_revision=memory_revision+1');return result;};let sent=0;const tg=new Telegram('test',async()=>{sent++;return new Response('{}');});const localizer=new OutboundLocalizer(db,brain);tg.setOutboundTransform((m,b)=>localizer.transform(m,b));await assert.rejects(tg.text('-100','Привіт'),/outbound_cancelled/);assert.equal(sent,0);
 });
});
