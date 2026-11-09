import {describeFailure} from '../src/incidents.js';
import {after,afterEach,before,beforeEach,describe,it,test} from 'node:test';
import assert from 'node:assert/strict';
import {addressed} from '../src/engine.js';
import {behaviorAdmission} from '../src/behavior-engine.js';
import type {Action,Plan} from '../src/model.js';
import {PrivateInbox} from '../src/private-inbox.js';
import {ChatRegistry} from '../src/registry.js';
import {ChatRouter,type ChatRuntime} from '../src/router.js';
import {TransportQueue} from '../src/transport-queue.js';
import {eraseAll} from '../src/db.js';
import type {Update} from '../src/telegram.js';
import {TestDB,harness,paired,message} from './helpers.js';

const bot={id:999,username:'lumen_test_bot'};
const otherReply=(text:string)=>{
 const m=message(text).message!;
 m.reply_to_message={...message('Зустрінемось о восьмій?',22).message!,from:{id:22,first_name:'Олена'}};
 return m;
};
test('reported names stay weak and quoted vocatives do not become a direct request',()=>{
 for(const text of ['Олено, Люмен казав о восьмій — ти встигаєш?','Люмен казав о восьмій.','Люмен, здається, тобі казав о восьмій.']){
  assert.equal(addressed(otherReply(text),bot),true,text);assert.equal(addressed(otherReply(text),bot,true),false,text);
  assert.equal(addressed(message(text).message!,bot),true,text);assert.equal(addressed(message(text).message!,bot,true),false,text);
 }
 for(const text of ['Олено, «Люмен, допоможи» — це його ім’я у прикладі.','У прикладі написано: `Люмен, допоможи`']){
  assert.equal(addressed(otherReply(text),bot),false,text);assert.equal(addressed(message(text).message!,bot),false,text);
 }
});

describe('V3 actual private sharing-button continuity',()=>{
 let db:TestDB,h:ReturnType<typeof harness>,registry:ChatRegistry,router:ChatRouter,runtime:ChatRuntime;
 let sequence=898000;
 beforeEach(async()=>{
  db=new TestDB();await db.init();h=harness(db);await paired(h);registry=new ChatRegistry(db);
  router=new ChatRouter(registry,h.config,h.tg as any,bot,()=>h.brain);await router.init();runtime=await router.runtime((await registry.find('-100'))!);
 });
 afterEach(async()=>{await router.cancelAll();await router.drainAll();await db.close();});
 const callback=(data:string,actor=11,chat=actor,type='private'):Update=>({update_id:sequence++,callback_query:{id:'private-choice-'+sequence,from:{id:actor,first_name:'Адресат'},data,message:{...message('',999,chat,type).message!,from:{id:999,first_name:'Люмен',is_bot:true}}}});
 async function request(){
  const inbox=new PrivateInbox(runtime.db,h.config.runtimeDir),value=await inbox.ask({actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:'private-v3-'+sequence++,requested:true},'11','Особисте питання: о котрій ти вдома?','ПРИВАТНА_МЕТА');
  const row=(await runtime.db.query('SELECT * FROM private_requests WHERE id=$1',[value.id])).rows[0]!;
  assert.equal(await inbox.open(row.token,'11',h.tg as any),true);
  const data=h.tg.options.at(-1)!.replyMarkup!.inline_keyboard[0]![0]!.callback_data!;
  h.tg.sent.length=0;h.tg.calls.length=0;await runtime.db.query('DELETE FROM outbox');
  return {id:String(row.id),token:String(row.token),data};
 }
 it('JIC-V2-01 explains an expired generated owner button, preserves other work and deduplicates the update',async()=>{
  const r=await request(),other=await new PrivateInbox(runtime.db,h.config.runtimeDir).ask({actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:'other-private-'+sequence++,requested:true},'11','Інше особисте питання','Інша задача');
  await runtime.db.query("UPDATE private_requests SET status='answering' WHERE id=$1",[other.id]);
  await runtime.db.query("UPDATE private_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[r.id]);
  const before=(await runtime.db.query('SELECT * FROM private_requests WHERE id=$1',[r.id])).rows[0]!;
  h.tg.sent.length=0;h.tg.calls.length=0;await runtime.db.query('DELETE FROM outbox');
  const update=callback(r.data);await router.receive(update);await router.receive(update);
  assert.equal(h.tg.calls.filter(x=>x.method==='answerCallbackQuery').length,2);assert.equal(h.tg.sent.length,1);assert.equal(h.tg.sent[0]!.chatId,'11');
  assert.match(h.tg.sent[0]!.text,/час.*минув/iu);assert.match(h.tg.sent[0]!.text,/повернися.*попроси надіслати нове/iu);assert.doesNotMatch(h.tg.sent[0]!.text,/о котрій|ПРИВАТНА_МЕТА/u);
  assert.deepEqual((await runtime.db.query('SELECT * FROM private_requests WHERE id=$1',[r.id])).rows[0],before);
  assert.equal((await runtime.db.query('SELECT status FROM private_requests WHERE id=$1',[other.id])).rows[0]!.status,'answering');
  assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM outbox')).rows[0]!.n,0);assert.equal(await registry.find('11'),undefined);assert.equal(h.brain.calls.length,0);
 });
 it('a current generated owner button prompts once and the next private answer is saved once',async()=>{
  const r=await request(),update=callback(r.data);await router.receive(update);await router.receive(update);
  assert.equal(h.tg.sent.length,1);assert.match(h.tg.sent[0]!.text,/Обрано: використання лише для цієї задачі/u);
  assert.equal((await runtime.db.query('SELECT status FROM private_requests WHERE id=$1',[r.id])).rows[0]!.status,'answering');
  const answer=message('Приватна відповідь: після 18:30',11,11,'private');await router.receive(answer);await router.receive(answer);
  const saved=(await runtime.db.query('SELECT status,answer FROM private_requests WHERE id=$1',[r.id])).rows[0]!;
  assert.equal(saved.status,'answered');assert.ok(saved.answer);assert.equal(h.tg.sent.filter(x=>/Відповідь збережено/u.test(x.text)).length,1);
  assert.equal((await runtime.db.query("SELECT count(*)::int AS n FROM messages WHERE body LIKE '%Приватна відповідь%'")).rows[0]!.n,0);assert.equal(h.brain.calls.length,0);
 });
 it('an expired exact owner token reaches a cold namespace without warming another group',async()=>{
  const r=await request();await runtime.db.query("UPDATE private_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[r.id]);await registry.ensure('-555','11','Інша група');
  const cold=new ChatRouter(registry,h.config,h.tg as any,bot,()=>h.brain);await cold.init();assert.equal(cold.all().length,0);await cold.receive(callback(r.data));
  assert.equal(h.tg.sent.length,1);assert.equal(h.tg.sent[0]!.chatId,'11');assert.deepEqual(cold.all().map(x=>x.chat.chat_id),['-100']);
  assert.equal((await runtime.db.query('SELECT status FROM private_requests WHERE id=$1',[r.id])).rows[0]!.status,'offered');await cold.cancelAll();await cold.drainAll();
 });
 it('production TransportQueue uses the expired token’s owner scope and acknowledges a replay once',async()=>{
  const r=await request();await runtime.db.query("UPDATE private_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[r.id]);const update=callback(r.data);
  assert.deepEqual(await db.tx(sql=>router.ingressScopes(update,sql)),['-100']);
  const queue=new TransportQueue(db,h.config.runtimeDir,u=>router.receive(u),(u,sql)=>router.ingressScopes(u,sql));await queue.init();await queue.enqueue(update);assert.equal(await queue.next(),true);await queue.enqueue(update);assert.equal(await queue.next(),false);
  assert.equal(h.tg.sent.length,1);assert.equal(h.tg.sent[0]!.chatId,'11');assert.equal((await db.query('SELECT status FROM public.lumen_ingress WHERE update_id=$1',[update.update_id])).rows[0]!.status,'done');
 });
 it('foreign actors, another DM audience and a group copy cannot select or reveal the owner request',async()=>{
  const r=await request();await runtime.db.query("UPDATE private_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[r.id]);
  for(const update of [callback(r.data,22),callback(r.data,11,22),callback(r.data,11,-100,'supergroup')])await router.receive(update);
  assert.equal(h.tg.sent.length,0);assert.equal((await runtime.db.query('SELECT status FROM private_requests WHERE id=$1',[r.id])).rows[0]!.status,'offered');assert.equal(h.brain.calls.length,0);
 });
 it('missing, revoked, stale revision, paused and departed-member buttons disclose no old question or expiry context',async()=>{
  for(const condition of ['missing','revoked','revision','paused','departed']){
   await runtime.db.query('UPDATE app_state SET paused=false');await runtime.db.query("UPDATE members SET active=true WHERE user_id='11'");const r=await request();
   await runtime.db.query("UPDATE private_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[r.id]);
   if(condition==='missing')await runtime.db.query('DELETE FROM private_requests WHERE id=$1',[r.id]);
   if(condition==='revoked')await runtime.db.query("UPDATE private_requests SET status='revoked' WHERE id=$1",[r.id]);
   if(condition==='revision')await runtime.db.query('UPDATE private_requests SET revision=-1 WHERE id=$1',[r.id]);
   if(condition==='paused')await runtime.db.query('UPDATE app_state SET paused=true');
   if(condition==='departed')await runtime.db.query("INSERT INTO members(user_id,name,active) VALUES('11','Адресат',false) ON CONFLICT(user_id) DO UPDATE SET active=false");
   await router.receive(callback(r.data));assert.equal(h.tg.sent.length,0,condition);assert.equal(h.brain.calls.length,0,condition);
  }
 });
 it('a forgotten queued purpose cannot recover an old callback into private text or another question',async()=>{
  const r=await request(),queue=new TransportQueue(db,h.config.runtimeDir,u=>router.receive(u),(u,sql)=>router.ingressScopes(u,sql));await queue.init();const update=callback(r.data);await queue.enqueue(update);await runtime.db.tx(eraseAll);h.tg.sent.length=0;await queue.next();
  assert.equal(h.tg.sent.length,0);assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM private_requests')).rows[0]!.n,0);assert.equal(await registry.privateConsumed(update.update_id,'11'),true);assert.equal(await registry.find('11'),undefined);assert.equal(h.brain.calls.length,0);
 });
});
test('genuine lead, end and mid-clause vocatives and Telegram direct signals still address the bot',()=>{
 for(const text of ['Люмен, допоможи','Люмен допоможи','Що скажеш, Люмен?','До речі, Люмен, підкажи','Привіт Люмен','А Люмен, ти як?']){
  assert.equal(addressed(message(text).message!,bot),true,text);
  assert.equal(addressed(otherReply(text),bot),true,text);
 }
 assert.equal(addressed(otherReply('Підкажи @lumen_test_bot, будь ласка'),bot),true);
 const reply=otherReply('Тоді поясни докладніше');reply.reply_to_message!.from={id:999,first_name:'Люмен',is_bot:true};assert.equal(addressed(reply,bot),true);
 const mention=otherReply('А ти що думаєш?');mention.entities=[{type:'text_mention',offset:2,length:2,user:{id:999,first_name:'Люмен',is_bot:true}}];assert.equal(addressed(mention,bot),true);
});
test('non-direct names still permit a grounded optional ambient contribution',()=>{
 const m=otherReply('Олено, Люмен казав о восьмій — ти встигаєш?');
 const decision={move:'answer',recipient:'unspecified',relation:'ambient',reason:'Є доречне уточнення',contribution:{key:'час_поїзда_о_восьмій',summary:'Попереджаю про щойно узгоджений час'}} as const;
 assert.equal(addressed(m,bot,true),false);
 assert.equal(behaviorAdmission(decision,{direct:false,otherRecipient:true,optional:true,reply:'Якщо це про поїзд, виходьте заздалегідь.'}).respond,true);
 assert.equal(behaviorAdmission({...decision,contribution:undefined},{direct:false,otherRecipient:true,optional:true,reply:'Я теж тут.'}).respond,false);
});

describe('V3 actual foreground context, simple confirmations and recovery copy',()=>{
 const db=new TestDB();let h:ReturnType<typeof harness>;
 before(async()=>db.init());beforeEach(async()=>{await db.reset();h=harness(db);await paired(h);});after(async()=>db.close());
 const texts=async()=>String((await db.query("SELECT string_agg(body->>'text',E'\\n' ORDER BY id) AS text FROM outbox WHERE kind='text'")).rows[0]?.text||'');
 const list=(text:string,quote:string,items?:string[]):Action=>({kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',...(items?{items}:{text}),quote})});
 const add=async(request:string,ack:string,entries:string[],extraReply='',extra:Partial<Plan>={})=>{
  h.brain.replies=[{reply:'',actions:[list(entries[0]!,request.replace(/^(?:Люмен|Lumen)[, ]*/iu,''),entries.length>1?entries:undefined)]},{reply:ack+extraReply,actions:[],...extra}];
  await h.lumen.receive(message(request));await h.lumen.processNext();return texts();
 };
 it('JCR-V2-01 leaves a reported name addressed to Olena without forced clarification in reply and plain text',async()=>{
  await db.query("UPDATE app_state SET mention_only=true,proactive_mode='off'");
  for(const reply of [true,false]){
   const update=message('Олено, Люмен казав о восьмій — ти встигаєш?');if(reply)update.message=otherReply(update.message!.text!);
   h.brain.replies=[{reply:'',actions:[],behavior:{move:'listen',recipient:'other',relation:'reply',reason:'Це звернення до Олени'}}];
   await h.lumen.receive(update);await h.lumen.processNext();
  }
  assert.equal(h.brain.calls.length,2);assert.equal(await texts(),'');
 });
 it('a weak unpunctuated name reaches planning without overriding a planned listen/other',async()=>{
  await db.query("UPDATE app_state SET mention_only=true,proactive_mode='off'");
  for(const reply of [true,false]){
   const update=message('Олено, Люмен допоможе тобі з вечерею — ти вже з ним домовилася?');if(reply)update.message=otherReply(update.message!.text!);
   h.brain.replies=[{reply:'',actions:[],behavior:{move:'listen',recipient:'other',relation:'reply',reason:'Це звернення до Олени'}}];
   await h.lumen.receive(update);await h.lumen.processNext();
  }
  assert.equal(h.brain.calls.length,2);assert.equal(await texts(),'');
 });
 it('a reported name can still receive the model’s grounded ambient contribution',async()=>{
  await db.query("UPDATE app_state SET mention_only=true,proactive_mode='off'");
  const update=message('Олено, Люмен допоможе тобі з вечерею — ти вже з ним домовилася?');update.message=otherReply(update.message!.text!);
  h.brain.replies=[{reply:'Якщо це про поїзд, виходьте заздалегідь.',actions:[],behavior:{move:'answer',recipient:'unspecified',relation:'ambient',reason:'Доречне уточнення часу',contribution:{key:'час_поїзда_о_восьмій',summary:'Нагадую закласти час на дорогу'}}}];
  await h.lumen.receive(update);await h.lumen.processNext();
  assert.equal(h.brain.calls.length,1);assert.match(await texts(),/виходьте заздалегідь/u);
 });
 it('direct bot requests still reach planning and answer despite replying to a person',async()=>{
  await db.query("UPDATE app_state SET mention_only=true,proactive_mode='off'");
  for(const request of ['Люмен, допоможи','Що скажеш, Люмен?','До речі, Люмен, підкажи','@lumen_test_bot, допоможи','Люмен допоможи','Допоможи Люмен']){
   h.brain.replies=[{reply:'Так, ось моя думка.',actions:[],behavior:{move:'answer',recipient:'bot',relation:'new_request',reason:'Пряме прохання автора'}}];const update=message(request);update.message=otherReply(request);await h.lumen.receive(update);await h.lumen.processNext();
  }
  assert.equal(h.brain.calls.length,6);assert.equal((await texts()).match(/ось моя думка/gu)?.length,6);
 });
 it('clear vocatives, greetings and Telegram bot signals preserve direct clarification',async()=>{
  await db.query("UPDATE app_state SET mention_only=true,proactive_mode='off'");
  const requests=['Люмен, допоможи','Що скажеш, Люмен?','До речі, Люмен, підкажи','@lumen_test_bot, допоможи','Привіт Люмен','Люмен'];
  const updates=requests.map(request=>{const update=message(request);update.message=otherReply(request);return update;});
  const botReply=message('Тоді поясни докладніше');botReply.message!.reply_to_message={...message('Маю думку',999).message!,from:{id:999,first_name:'Люмен',is_bot:true}};updates.push(botReply);
  const mention=message('А ти що думаєш?');mention.message!.entities=[{type:'text_mention',offset:2,length:2,user:{id:999,first_name:'Люмен',is_bot:true}}];updates.push(mention);
  for(const update of updates){
   h.brain.replies=[{reply:'',actions:[],behavior:{move:'listen',recipient:'other',relation:'reply',reason:'Перевірка явного звернення'}}];
   await h.lumen.receive(update);await h.lumen.processNext();
  }
  assert.equal(h.brain.calls.length,updates.length);assert.equal((await texts()).match(/Уточни, будь ласка/gu)?.length,updates.length);
 });
 it('a paraphrased added-list acknowledgment appears once, keeping the independent explanation',async()=>{
  const result=await add('Люмен, додай молоко до покупок','Додав молоко до покупок.',['молоко'],' Кількість можна уточнити пізніше.');
  assert.match(result,/Додав молоко до покупок/u);assert.doesNotMatch(result,/Додав у покупки/u);assert.match(result,/Кількість можна уточнити пізніше/u);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM simple_list_events')).rows[0]?.n,1);
 });
 it('English and Russian simple confirmations can replace only their equivalent verified echo',async()=>{
  const first=await add('Lumen, add milk to the shopping list','Added milk to the shopping list.',['milk'],' We can check the quantities later.');
  assert.match(first,/We can check the quantities later/);assert.doesNotMatch(first,/Додав у покупки: milk/u);
  await db.reset();h=harness(db);await paired(h);
  const second=await add('Люмен, добавь молоко в покупки','Добавил молоко в покупки.',['молоко'],' Количество можно уточнить позже.');
  assert.match(second,/Количество можно уточнить позже/u);assert.doesNotMatch(second,/Додав у покупки/u);
 });
 it('complete multi-item bindings match independently rather than redistributing item adjectives',async()=>{
  const request='Люмен, додай дитяче молоко і вівсяне печиво до покупок';
  const result=await add(request,'Додав дитяче молоко і вівсяне печиво до покупок.',['дитяче молоко','вівсяне печиво']);
  assert.doesNotMatch(result,/Додав у покупки/u);
  await db.reset();h=harness(db);await paired(h);
  const altered=await add(request,'Додав вівсяне молоко і дитяче печиво до покупок.',['дитяче молоко','вівсяне печиво']);
  assert.match(altered,/Додав у покупки: дитяче молоко, вівсяне печиво/u);
 });
 it('quoted or differently qualified acknowledgments do not hide the actual result',async()=>{
  const result=await add('Люмен, додай молоко до покупок','Олена написала «Додав молоко до покупок».',['молоко'],' Це її приклад.');
  assert.match(result,/Олена написала/u);assert.match(result,/Це її приклад/u);assert.match(result,/Додав у покупки: молоко/u);
  await db.reset();h=harness(db);await paired(h);
  const mismatched=await add('Люмен, додай молоко до покупок','Додав молоко до справ.',['молоко']);assert.match(mismatched,/Додав у покупки: молоко/u);
 });
 it('a later multiline example cannot stand in for the current list confirmation',async()=>{
  const result=await add('Люмен, додай молоко до покупок','Олена написала приклад:\nДодав молоко до покупок.',['молоко'],'\nЦе її формулювання.');
  assert.match(result,/Олена написала приклад/u);assert.match(result,/Це її формулювання/u);assert.match(result,/Додав у покупки: молоко/u);
 });
 it('already-present status and exact quantities are not collapsed into an inaccurate added claim',async()=>{
  await add('Люмен, додай молоко до покупок','Добре.',['молоко']);await db.query('DELETE FROM outbox');
  const repeated=await add('Люмен, додай молоко до покупок','Додав молоко до покупок.',['молоко']);assert.match(repeated,/Уже в списку: молоко/u);
  await db.reset();h=harness(db);await paired(h);
  const quantity=await add('Люмен, додай молоко 2 л до покупок','Додав молоко 3 л до покупок.',['молоко 2 л']);assert.match(quantity,/Додав у покупки: молоко 2 л/u);
 });
 it('simple confirmation dedup keeps every explanation condition and the independent invalid-time question',async()=>{
  const explanation='У списку кількість може бути відсутня. Для запасів потрібні кількості. Зустріч о 09:30. Квиток коштує 420 грн. Повернення до 20:00. Одна валіза до 10 кг. Повернення за 24 години.';
  const request='Люмен, додай молоко до покупок, поясни різницю між списком і запасами та через годину нагадай про аптеку';
  const schedule:Action={kind:'schedule',title:'Аптека',instruction:'Зайти в аптеку',authorization:'explicit',mode:'reminder',timezone:'UTC',due_at:new Date(Date.now()-60000).toISOString(),quote:'через годину нагадай про аптеку'};
  h.brain.replies=[{reply:'',actions:[list('молоко','додай молоко до покупок'),schedule]},{reply:'Додав молоко до покупок. '+explanation,actions:[]}];
  await h.lumen.receive(message(request));await h.lumen.processNext();const result=await texts();
  for(const condition of explanation.split(/(?<=[.!?])\s+/u))assert.ok(result.includes(condition),condition);
  assert.equal((result.match(/На яку дату й годину/gu)||[]).length,1);assert.doesNotMatch(result,/Додав у покупки: молоко/u);assert.equal((await db.query('SELECT count(*)::int AS n FROM scheduled_actions')).rows[0]?.n,0);
 });
 it('dedup preserves card facts, details, questions and other item advice in a full response',async()=>{
  const card={title:'Покупки на вихідні',summary:'Молоко є у списку, решту можна обдумати окремо.',facts:['Бюджет на тиждень: 650 грн.','Для випічки потрібно 3 яйця.'],question:'Додати ще хліб?',details:'Якщо гостей буде більше чотирьох, спершу перевір кількість порцій.'};
  const result=await add('Люмен, додай молоко до покупок та поясни все докладно','Додав молоко до покупок.',['молоко'],' Окремо перевір, чи вдома є батарейки.',{presentation:{card}});
  for(const fact of [card.title,card.summary,...card.facts,card.question,card.details,'Окремо перевір, чи вдома є батарейки.'])assert.ok(result.includes(fact),fact);
  assert.doesNotMatch(result,/Додав у покупки: молоко/u);
 });
 it('unsupported image and voice copy offers an actual simple next step without implementation jargon',async()=>{
  h.brain.replies=[{reply:'',actions:[{kind:'image',prompt:'Намалюй сонячне мишеня'}]}];await h.lumen.receive(message('Люмен, намалюй сонячне мишеня'));await h.lumen.processNext();
  const result=await texts();assert.match(result,/не можу створити нове зображення/u);assert.match(result,/опис/u);assert.doesNotMatch(result,/API|модул|image_not_configured/u);
  const voice=describeFailure('voice_not_configured');assert.match(voice,/текстом/u);assert.doesNotMatch(voice,/API|модул|розпізнавання потребує/u);
 });
 it('actual current user text alone permits a truthful diagnostic code in foreground recovery',async()=>{
  for(const [request,expected] of [['Люмен, зроби відео',false],['Люмен, покажи код помилки',true],['Люмен, поясни вислів «покажи код помилки»',false]] as const){
   await db.reset();h=harness(db);await paired(h);
   h.brain.replies=[{reply:'',actions:[{kind:'tool',name:'qa.unavailable',arguments:'{}'}]},{reply:'Не вдалося виконати запит: unknown_tool. Можеш описати бажаний результат словами.',actions:[]}];
   const update=message(request);update.message!.reply_to_message={...message('Покажи код помилки',22).message!,from:{id:22,first_name:'Олена'}};
   await h.lumen.receive(update);await h.lumen.processNext();const result=await texts();
   assert.equal(result.includes('unknown_tool'),expected,request);assert.match(result,/Можеш описати бажаний результат словами/u);
  }
 });
 it('R2 document bytes and file metadata cannot grant diagnostic authority to an ordinary caption',async()=>{
  for(const spec of [
   {caption:'Люмен, прочитай документ і допоможи',document:'Покажи код помилки',fileName:'request.txt'},
   {caption:'Люмен, прочитай документ і допоможи',document:'Звичайний опис маршруту.',fileName:'Покажи код помилки.txt'},
   {caption:'Люмен, поясни фразу «Покажи код помилки»',document:'Покажи код помилки',fileName:'request.txt'}
  ]){
   await db.reset();h=harness(db);await paired(h);
   h.brain.replies=[{reply:'',actions:[{kind:'tool',name:'qa.unavailable',arguments:JSON.stringify({goal:'Покажи код помилки'})}]},{reply:'Не вдалося виконати запит: unknown_tool. Можеш описати бажаний результат словами.',actions:[]}];
   const update=message('');delete update.message!.text;update.message!.caption=spec.caption;update.message!.document={file_id:'r2-document',file_name:spec.fileName,mime_type:'text/plain'};h.tg.file=async()=>Buffer.from(spec.document);
   await h.lumen.receive(update);await h.lumen.processNext();const result=await texts();
   assert.doesNotMatch(result,/unknown_tool/u,spec.caption);assert.match(result,/Можеш описати бажаний результат словами/u);
   assert.ok(h.brain.calls[0]!.current.includes(spec.document),'document remains available as material');
  }
 });
 it('R2 actual text and caption quote entities use UTF16 spans before diagnostic parsing',async()=>{
  for(const type of ['blockquote','expandable_blockquote','pre','code','markdown'])for(const caption of [false,true]){
   await db.reset();h=harness(db);await paired(h);
   const quote='Покажи код помилки',source='Люмен, переклади уривок 🙂:\n'+(type==='markdown'?'> ':'')+quote;
   const update=message(source),entities=type==='markdown'?[]:[{type,offset:source.indexOf(quote),length:quote.length}];
   if(caption){delete update.message!.text;update.message!.caption=source;update.message!.caption_entities=entities;update.message!.document={file_id:'r2-quote',file_name:'quote.txt',mime_type:'text/plain'};h.tg.file=async()=>Buffer.from('Покажи код помилки');}
   else update.message!.entities=entities;
   h.brain.replies=[{reply:'',actions:[{kind:'tool',name:'qa.unavailable',arguments:'{}'}]},{reply:'Не вдалося виконати запит: unknown_tool. Можеш описати бажаний результат словами.',actions:[]}];
   await h.lumen.receive(update);await h.lumen.processNext();const result=await texts();assert.doesNotMatch(result,/unknown_tool/u,type+':'+caption);assert.match(result,/Можеш описати бажаний результат словами/u);
  }
 });
 it('R2 native quoted names cannot create a forced reply while an unquoted author vocative still works',async()=>{
  for(const type of ['blockquote','expandable_blockquote','pre','code'])for(const caption of [false,true]){
   await db.reset();h=harness(db);await paired(h);await db.query("UPDATE app_state SET mention_only=true,proactive_mode='off'");
   const quote='Люмен, допоможи',source='Олено, прочитай уривок 🙂:\n'+quote,update=message(source),entities=[{type,offset:source.indexOf(quote),length:quote.length}];
   if(caption){delete update.message!.text;update.message!.caption=source;update.message!.caption_entities=entities;update.message!.document={file_id:'r2-recipient',file_name:'quote.txt',mime_type:'text/plain'};}
   else update.message!.entities=entities;
   h.brain.replies=[{reply:'',actions:[],behavior:{move:'listen',recipient:'other',relation:'reply',reason:'Це цитата для Олени'}}];
   await h.lumen.receive(update);await h.lumen.processNext();assert.equal(h.brain.calls.length,0,type+':'+caption);assert.equal(await texts(),'');
  }
  await db.reset();h=harness(db);await paired(h);await db.query("UPDATE app_state SET mention_only=true,proactive_mode='off'");
  const quote='Люмен, допоможи',source='Люмен, переклади уривок 🙂:\n'+quote,update=message(source);update.message!.entities=[{type:'blockquote',offset:source.lastIndexOf(quote),length:quote.length}];
  h.brain.replies=[{reply:'Це цитоване прохання про допомогу.',actions:[],behavior:{move:'answer',recipient:'bot',relation:'new_request',reason:'Автор прямо просить переклад'}}];await h.lumen.receive(update);await h.lumen.processNext();assert.equal(h.brain.calls.length,1);assert.match(await texts(),/цитоване прохання/u);
 });
 it('R2 quoted usernames and text mentions do not address the bot; unquoted signals and actual bot replies stay hard',async()=>{
  for(const kind of ['username','text_mention'])for(const type of ['blockquote','expandable_blockquote','pre','code','text_quote'])for(const caption of [false,true]){
   await db.reset();h=harness(db);await paired(h);await db.query("UPDATE app_state SET mention_only=true,proactive_mode='off'");
   const quote=kind==='username'?'@lumen_test_bot допоможи':'Ти допоможи',source='Олено, прочитай уривок 🙂:\n'+(type==='text_quote'?'«'+quote+'»':quote),offset=source.indexOf(quote),update=message(source);
   const entities=[...(type==='text_quote'?[]:[{type,offset,length:quote.length}]),...(kind==='text_mention'?[{type:'text_mention',offset,length:2,user:{id:999,first_name:'Люмен',is_bot:true}}]:[])];
   if(caption){delete update.message!.text;update.message!.caption=source;update.message!.caption_entities=entities;update.message!.document={file_id:'r2-quoted-direct',file_name:'quote.txt',mime_type:'text/plain'};}
   else update.message!.entities=entities;
   h.brain.replies=[{reply:'',actions:[],behavior:{move:'listen',recipient:'other',relation:'reply',reason:'Це цитата для Олени'}}];await h.lumen.receive(update);await h.lumen.processNext();assert.equal(h.brain.calls.length,0,kind+':'+type+':'+caption);assert.equal(await texts(),'');
  }
  for(const kind of ['username','text_mention','bot_reply']){
   await db.reset();h=harness(db);await paired(h);await db.query("UPDATE app_state SET mention_only=true,proactive_mode='off'");
   const quote=kind==='bot_reply'?'@lumen_test_bot допоможи':'Привіт',source=(kind==='username'?'@lumen_test_bot, переклади уривок 🙂:\n':kind==='text_mention'?'Ти, переклади уривок 🙂:\n':'Ось цитата 🙂:\n')+quote,update=message(source);update.message!.entities=[{type:'blockquote',offset:source.lastIndexOf(quote),length:quote.length},...(kind==='text_mention'?[{type:'text_mention',offset:0,length:2,user:{id:999,first_name:'Люмен',is_bot:true}}]:[])];
   update.message!.reply_to_message={...message('Попередня репліка',kind==='bot_reply'?999:22).message!,from:{id:kind==='bot_reply'?999:22,first_name:kind==='bot_reply'?'Люмен':'Олена'}};
   h.brain.replies=[{reply:'',actions:[],behavior:{move:'listen',recipient:'other',relation:'reply',reason:'Контроль справжнього звернення'}}];await h.lumen.receive(update);await h.lumen.processNext();assert.equal(h.brain.calls.length,1,kind);assert.match(await texts(),/Уточни, будь ласка/u,kind);
  }
  for(const entity of [{type:'text_mention',offset:-1,length:2,user:{id:999,first_name:'Люмен'}},{type:'text_mention',offset:0,length:9999,user:{id:999,first_name:'Люмен'}}]){
   await db.reset();h=harness(db);await paired(h);await db.query("UPDATE app_state SET mention_only=true,proactive_mode='off'");const update=message('Ти поясниш?');update.message!.entities=[entity];await h.lumen.receive(update);await h.lumen.processNext();assert.equal(h.brain.calls.length,0);assert.equal(await texts(),'');
  }
 });
 it('R2 an explicit authored diagnostic outside a native quote still permits the known code with a document',async()=>{
  for(const before of [true,false]){
   await db.reset();h=harness(db);await paired(h);
   const quote='Не показуй код помилки',source=before?'Люмен, покажи код помилки.\n🙂 '+quote:'Люмен, переклади уривок 🙂:\n'+quote+'\nПокажи код помилки.';
   const update=message('');delete update.message!.text;update.message!.caption=source;update.message!.caption_entities=[{type:'blockquote',offset:source.indexOf(quote),length:quote.length}];update.message!.document={file_id:'r2-explicit',file_name:'request.txt',mime_type:'text/plain'};h.tg.file=async()=>Buffer.from('Не показуй код помилки.');
   h.brain.replies=[{reply:'',actions:[{kind:'tool',name:'qa.unavailable',arguments:'{}'}]},{reply:'Не вдалося виконати запит: unknown_tool. Можеш описати бажаний результат словами.',actions:[]}];
   await h.lumen.receive(update);await h.lumen.processNext();assert.match(await texts(),/unknown_tool/u);assert.ok(h.brain.calls[0]!.current.includes('ВМІСТ ФАЙЛУ'));
  }
 });
 it('R2 malformed native quote metadata fails diagnostic permission closed in actual foreground',async()=>{
  const update=message('Люмен, покажи код помилки');update.message!.entities=[{type:'blockquote',offset:0,length:9999}];
  h.brain.replies=[{reply:'',actions:[{kind:'tool',name:'qa.unavailable',arguments:'{}'}]},{reply:'Не вдалося виконати запит: unknown_tool. Можеш описати бажаний результат словами.',actions:[]}];
  await h.lumen.receive(update);await h.lumen.processNext();assert.doesNotMatch(await texts(),/unknown_tool/u);
 });
 it('R2 numeric punctuation never hides the canonical receipt and pure numeric conflicts use the actual value',async()=>{
  for(const [actual,claimed,replace] of [
   ['вода 2.5 л','вода 2/5 л',true],['вода 1-2 л','вода 1/2 л',true],['вода 2,5 л','вода 2/5 л',true],['чай на 09:30','чай на 09.30',true],['прилад 2 м/с','прилад 2 мс',false],['лампа 2 мВт','лампа 2 МВт',false],['кабель #2','кабель ##',false]
  ] as const){
   await db.reset();h=harness(db);await paired(h);const quote='додай '+actual+' до покупок';
   h.brain.replies=[{reply:'',actions:[list(actual,quote,[actual])]},{reply:'Додав '+claimed+' до покупок. Умови доставки обговоримо окремо.',actions:[]}];
   await h.lumen.receive(message('Люмен, '+quote));await h.lumen.processNext();const result=await texts();
   assert.ok(result.includes('Додав у покупки: '+actual+'.'),actual);assert.match(result,/Умови доставки обговоримо окремо/u);
   assert.equal(result.includes('Додав '+claimed+' до покупок.'),!replace,actual);assert.equal((await db.query('SELECT count(*)::int AS n FROM simple_list_events')).rows[0]!.n,1);
  }
 });
 it('R2 exactly equal decimals, fractions, ranges, time and units still deduplicate once',async()=>{
  for(const actual of ['вода 2.5 л','вода 2,5 л','вода 1/2 л','вода 1-2 л','чай на 09:30','прилад 2 м/с']){
   await db.reset();h=harness(db);await paired(h);const quote='додай '+actual+' до покупок';
   h.brain.replies=[{reply:'',actions:[list(actual,quote,[actual])]},{reply:'Додав '+actual+' до покупок. Кількість можна перевірити пізніше.',actions:[]}];
   await h.lumen.receive(message('Люмен, '+quote));await h.lumen.processNext();const result=await texts();
   assert.ok(result.includes('Додав '+actual+' до покупок.'),actual);assert.doesNotMatch(result,/Додав у покупки/u,actual);assert.match(result,/Кількість можна перевірити пізніше/u);
  }
 });
 it('R2 numeric correction preserves every card field and its independent follow-up question',async()=>{
  const card={title:'Покупки на вихідні',summary:'Решту можна обдумати окремо.',facts:['Бюджет: 650 грн.','Потрібні ще 3 яйця.'],question:'Додати хліб?',details:'Якщо гостей більше чотирьох, уточни порції.'};
  h.brain.replies=[{reply:'',actions:[list('вода 2.5 л','додай вода 2.5 л до покупок',['вода 2.5 л'])]},{reply:'Додав вода 2/5 л до покупок. Окремо перевір, чи вдома є батарейки. Зустріч о 17:40.',actions:[],presentation:{card}}];
  await h.lumen.receive(message('Люмен, додай вода 2.5 л до покупок та поясни все докладно'));await h.lumen.processNext();const result=await texts();
  assert.match(result,/Додав у покупки: вода 2\.5 л/u);assert.doesNotMatch(result,/Додав вода 2\/5 л/u);
  for(const fact of [card.title,card.summary,...card.facts,card.question,card.details,'Окремо перевір, чи вдома є батарейки.','Зустріч о 17:40.'])assert.ok(result.includes(fact),fact);
 });
 it('R2 numeric correction preserves seven conditions, card facts and independent reminder recovery',async()=>{
  const explanation='У списку кількість може бути відсутня. Для запасів потрібні кількості. Зустріч о 09:30. Квиток коштує 420 грн. Повернення до 20:00. Одна валіза до 10 кг. Повернення за 24 години.';
  const card={title:'План на вихідні',summary:'Умови можна перевірити окремо.',facts:['Бюджет: 650 грн.','Потрібні ще 3 яйця.'],question:'',details:'Якщо гостей більше чотирьох, уточни порції.'};
  const schedule:Action={kind:'schedule',title:'Аптека',instruction:'Зайти в аптеку',authorization:'explicit',mode:'reminder',timezone:'UTC',due_at:new Date(Date.now()-60000).toISOString(),quote:'через годину нагадай про аптеку'};
  h.brain.replies=[{reply:'',actions:[list('вода 2.5 л','додай вода 2.5 л до покупок',['вода 2.5 л']),schedule]},{reply:'Додав вода 2/5 л до покупок. '+explanation,actions:[],presentation:{card}}];
  await h.lumen.receive(message('Люмен, додай вода 2.5 л до покупок, поясни всі умови докладно та через годину нагадай про аптеку'));await h.lumen.processNext();const result=await texts();
  assert.match(result,/Додав у покупки: вода 2\.5 л/u);assert.doesNotMatch(result,/Додав вода 2\/5 л/u);
  for(const fact of [...explanation.split(/(?<=[.!?])\s+/u),card.title,card.summary,...card.facts,card.question,card.details])assert.ok(result.includes(fact),fact);
  assert.equal((result.match(/На яку дату й годину/gu)||[]).length,1);assert.equal((await db.query('SELECT count(*)::int AS n FROM scheduled_actions')).rows[0]!.n,0);
 });
});
