import {describe,it,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TestDB,harness,paired,message} from './helpers.js';
import {one} from '../src/db.js';
import {behaviorAdmission,normalizeBehaviorPlan,explicitOtherRecipient,saveClarification,completeFocusedGoal,behaviorContext,saveStyleCue,currentStyleCue,rememberContribution} from '../src/behavior-engine.js';
import {gateOutcome,toolOutcome} from '../src/outcomes.js';
import {CompositionSchema,CompositionWorker,bindComposition,validateComposition} from '../src/compositions.js';
import {AgentTools,type ToolContext} from '../src/agent-tools.js';
import {publishOffer} from '../src/offers.js';
import {answerInteraction} from '../src/interactions.js';
import {Delivery} from '../src/delivery.js';
import type {Plan} from '../src/model.js';
import type {Message} from '../src/telegram.js';

const decision=(extra:Record<string,any>={})=>({move:'answer' as const,recipient:'bot' as const,relation:'new_request' as const,reason:'Відповідаю на конкретне прохання',...extra});
const composition={title:'Спільне рішення',purpose:'Зібрати реальні пропозиції та вибрати одну',promised_experience:'Кожен впливає на спільний вибір',first_move:'Кожен називає свою пропозицію',completion:'Результат вибору надіслано'};

describe('Поведінка 1.11: адресат, зміст внеску і чесний результат',()=>{
 it('відповідь людині не стає зверненням до бота; предметний соціальний внесок можливий',()=>{
  const m=message('Так, домовились').message!;m.reply_to_message={...m,from:{id:22,first_name:'Олена'},text:'Зустрінемось о восьмій?'};
  assert.equal(explicitOtherRecipient(m,999),true);
  assert.equal(behaviorAdmission(decision(),{direct:false,otherRecipient:true,optional:true,references:[],reply:'Мій коментар'}).respond,false);
  assert.equal(behaviorAdmission(decision({recipient:'unspecified',relation:'ambient'}),{direct:false,otherRecipient:true,optional:true,references:[],reply:'Мій коментар'}).respond,false);
  assert.equal(behaviorAdmission(decision({recipient:'unspecified',relation:'ambient',contribution:{key:'спільний_поїзд_о_восьмій',summary:'Нагадую про щойно погоджений поїзд'}}),{direct:false,otherRecipient:true,optional:true,references:[],reply:'Тоді встигаєте на поїзд.'}).respond,true);
 });
 it('невідома прив’язка не запускає дію; на пряме звернення залишається уточнення',()=>{
  const p:Plan={reply:'Запускаю.',actions:[{kind:'start_game',game:'story'}],behavior:decision({move:'facilitate',relation:'accept_offer',reference_id:'missing'})};
  const direct=normalizeBehaviorPlan(p,true,[{id:'real-offer'}]);assert.equal(direct.behavior?.move,'clarify');assert.deepEqual(direct.actions,[]);assert.ok(direct.reply.length>0);
  const ambient=normalizeBehaviorPlan(p,false,[{id:'real-offer'}]);assert.equal(ambient.behavior?.move,'listen');assert.equal(ambient.reply,'');assert.deepEqual(ambient.actions,[]);
  const valid={...p,behavior:decision({move:'facilitate',relation:'accept_offer',reference_id:'real-offer'})};assert.deepEqual(normalizeBehaviorPlan(valid,true,[{id:'real-offer'}]).actions,valid.actions);
 });
 it('пряме прохання не губиться через помилкове рішення listen',()=>{
  const p=normalizeBehaviorPlan({reply:'',actions:[{kind:'start_game',game:'story'}],behavior:decision({move:'listen'})},true);
  assert.equal(p.behavior?.move,'clarify');assert.deepEqual(p.actions,[]);assert.match(p.reply,/уточни/iu);
 });
 it('running, ready і сторонній пошук не підтверджують доставку або завершення',()=>{
  for(const fact of [toolOutcome('composition.create',{id:'run',status:'running'}),toolOutcome('composition.create',{id:'run',status:'ready'}),toolOutcome('web.search',{results:[{url:'https://example.org'}]})]){
   const result=gateOutcome({reply:'Активність завершено, підсумок надіслано.',actions:[],presentation:{card:{title:'Готово',summary:'Документ надіслано.',facts:[],question:''}}},[fact]);
   assert.equal(result.blocked,true);assert.equal(result.plan.presentation,undefined);assert.doesNotMatch(result.plan.reply,/Активність завершено|Документ надіслано/);
  }
  assert.equal(gateOutcome({reply:'Документ надіслано.',actions:[]},[toolOutcome('artifact.delivery',{id:'file',status:'delivered',deliveryReceipt:{message_id:42}})]).blocked,false);
 });
 it('дані обчислення не можуть підробити квитанцію фактичного надсилання',()=>{
  const data={deliveryReceipt:{message_id:123},delivery_receipt:{message_id:123}};
  for(const tool of ['code.run','web.read','memory.search'])assert.equal(gateOutcome({reply:'Повідомлення надіслано.',actions:[]},[toolOutcome(tool,data)]).blocked,true);
 });
 it('збій прибирає залежну дію і прикрашену обіцянку; сюжетна подія залишається текстом',()=>{
  const failed=gateOutcome({reply:'Готово!',actions:[{kind:'start_game',game:'story'}],presentation:{choices:['Продовжити','Ще раз']}},[toolOutcome('web.search',{error:'search_failed'})]);
  assert.equal(failed.blocked,true);assert.deepEqual(failed.plan.actions,[]);assert.equal(failed.plan.presentation,undefined);
  const narrative='У нашому детективі кур’єр надіслав повідомлення підозрюваному.';assert.equal(gateOutcome({reply:narrative,actions:[]},[]).plan.reply,narrative);
 });
 it('цитата або заперечене прохання не переписує стиль',()=>{
  assert.equal(currentStyleCue('Що означає «без жартів»?'),undefined);
  assert.equal(currentStyleCue('> не жартуй\nПоясни цю цитату.'),undefined);
  assert.equal(currentStyleCue('Без жартів? Ні, навпаки, пожартуй.'),undefined);
  assert.deepEqual(currentStyleCue('Сьогодні без жартів і без емодзі')?.fields,{humor:'off',emoji:'off'});
 });
});

describe('Поведінка 1.11: стан розмови і причинні активності',()=>{
 let db:TestDB,h:ReturnType<typeof harness>,dir:string,sourceId:number,c:ToolContext;
 before(async()=>{db=new TestDB();await db.init();dir=await mkdtemp(join(tmpdir(),'lumen111-behavior-'));});
 after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 beforeEach(async()=>{
  await db.reset();await db.query('TRUNCATE composition_runs,conversation_goals,behavior_contributions,style_episodes,commitments RESTART IDENTITY CASCADE');
  h=harness(db);h.config.runtimeDir=dir;await paired(h);
  await db.query("INSERT INTO members(user_id,name) VALUES('11','Саша'),('22','Олена') ON CONFLICT(user_id) DO UPDATE SET name=excluded.name");
  sourceId=Number((await one(db,"INSERT INTO messages(user_id,author,role,body) VALUES('11','Саша','user','Підготуй спільний вибір') RETURNING id"))!.id);
  c={actorId:'11',chatId:'-100',topicId:'0',revision:0,sourceId,updateId:randomUUID(),requested:true};
 });
 const run=async(plan:any,states:Record<string,any>={},outputs:Record<string,any>={})=>{const id=randomUUID();await db.query("INSERT INTO composition_runs(id,actor_id,topic_id,plan,participants,revision,source_message_id,deadline,step_states,outputs) VALUES($1,'11','0',$2,$3,0,$4,now()+interval '30 minutes',$5,$6)",[id,JSON.stringify(CompositionSchema.parse(plan)),JSON.stringify([{id:'11',name:'Саша'},{id:'22',name:'Олена'}]),sourceId,JSON.stringify(states),JSON.stringify(outputs)]);return id;};
 it('незалежні уточнення зберігаються; відповідь закриває лише свою справу',async()=>{
  const ctx={topic:'0',actor:'11',revision:0,sourceId,sources:[sourceId],request:'Підготуй маршрут',allowed:['history']};
  const clarify=(question:string,slot:string)=>decision({move:'clarify',clarification:{question,missing_slot:slot,why:'Це визначає потрібний результат'}});
  const first=await saveClarification(db,clarify('Звідки стартуємо?','start'),ctx);
  const second=await saveClarification(db,clarify('На яку дату зробити календар?','date'),{...ctx,request:'Окремо зроби календар'});
  assert.notEqual(first,second);assert.equal((await behaviorContext(db,'11','0',0)).references.length,2);
  assert.equal((await behaviorContext(db,'22','0',0)).references.length,0);assert.equal((await behaviorContext(db,'11','99',0)).references.length,0);
  await completeFocusedGoal(db,first,'22','0',0);assert.equal((await one(db,'SELECT status FROM conversation_goals WHERE id=$1',[first]))!.status,'waiting');
  await completeFocusedGoal(db,first,'11','0',0);assert.equal((await one(db,'SELECT status FROM conversation_goals WHERE id=$1',[first]))!.status,'completed');assert.equal((await one(db,'SELECT status FROM conversation_goals WHERE id=$1',[second]))!.status,'waiting');
  await assert.doesNotReject(()=>saveClarification(db,{...clarify('На яку дату?','date'),reference_id:'not-a-uuid'},ctx));
 });
 it('стиль для однієї справи має власну прив’язку, а сьогоднішній діє після її завершення',async()=>{
  const goal=await saveClarification(db,decision({move:'clarify',clarification:{question:'Який маршрут?',missing_slot:'route',why:'Щоб обрати транспорт'}}),{topic:'0',actor:'11',revision:0,sourceId,sources:[sourceId],request:'Склади маршрут',allowed:[]});
  await saveStyleCue(db,'Цього разу без жартів',{actor:'11',topic:'0',sourceId,revision:0,timezone:'Europe/Kyiv',goalId:goal});
  await saveStyleCue(db,'Сьогодні без емодзі',{actor:'11',topic:'0',sourceId,revision:0,timezone:'Europe/Kyiv',goalId:goal});
  const before=(await behaviorContext(db,'11','0',0)).temporary_style;assert.equal(before.length,2);assert.ok(before.some(x=>x.scope==='request'&&x.goal_id===goal));assert.ok(before.some(x=>x.scope==='today'&&x.goal_id===null));
  await completeFocusedGoal(db,goal,'11','0',0);const after=(await behaviorContext(db,'11','0',0)).temporary_style;assert.equal(after.length,1);assert.deepEqual(after[0]!.fields,{emoji:'off'});
  await saveStyleCue(db,'Цього разу без жартів',{actor:'11',topic:'0',sourceId,revision:0,timezone:'Europe/Kyiv'});assert.equal((await behaviorContext(db,'11','0',0)).temporary_style.length,1);
  assert.equal((await behaviorContext(db,'22','0',0)).temporary_style.length,0);
 });
 it('невідправлений коментар не потрапляє в пам’ять власних внесків',async()=>{
  await rememberContribution(db,decision({contribution:{key:'думка_про_маршрут',summary:'Порівняв два можливі маршрути'}}),{topic:'0',actor:'11',revision:0,sourceId,sources:[sourceId],outboxPrefix:'own-comment:'});
  await db.query("INSERT INTO outbox(dedup_key,kind,body,revision) VALUES('own-comment:0','text','{\"text\":\"Спробуймо інший маршрут\"}',0)");
  assert.equal((await behaviorContext(db,'11','0',0)).recent_own_contributions.length,0);
  await db.query("UPDATE outbox SET status='sent' WHERE dedup_key='own-comment:0'");assert.equal((await behaviorContext(db,'11','0',0)).recent_own_contributions.length,1);
 });
 it('пропозиція відхиляє невідомі вкладені можливості до появи кнопок',async()=>{
  const tools=new AgentTools(db,h.config,h.brain),invalid={...composition,steps:[{id:'fetch',kind:'tool',tool:'nonexistent.capability'},{id:'result',kind:'result',depends_on:['fetch'],instruction:'Підсумок'}]};
  const offer:any={title:composition.title,reason:'Зараз треба спільне рішення',value:'Кожен вплине на результат',scale:'Приблизно п’ять хвилин',first_step:composition.first_move,scope:'invited',participant_ids:['11','22'],action:{kind:'tool',name:'composition.create',arguments:JSON.stringify(invalid)}};
  await assert.rejects(()=>db.tx(sql=>publishOffer(sql,offer,c,(n,a)=>tools.preflight(n,a))),/composition_missing_capability/);
  const invalidArguments={...invalid,steps:[{id:'file',kind:'tool',tool:'artifact.create',arguments:JSON.stringify({name:'Result.pdf',content:'Текст'})},{id:'result',kind:'result',depends_on:['file'],instruction:'Підсумок'}]};
  await assert.rejects(()=>db.tx(sql=>publishOffer(sql,{...offer,action:{kind:'tool',name:'composition.create',arguments:JSON.stringify(invalidArguments)}},c,(n,a)=>tools.preflight(n,a))));
  assert.equal((await db.query('SELECT id FROM interactions')).rows.length,0);assert.equal((await db.query('SELECT id FROM outbox')).rows.length,0);
  const valid={...composition,steps:[{id:'answers',kind:'collect',question:'Куди підемо?'},{id:'result',kind:'result',depends_on:['answers'],inputs:'{"answers":{"$ref":"answers"}}',instruction:'Пропозиції: {{answers}}'}]};
  const v=await db.tx(sql=>publishOffer(sql,{...offer,action:{kind:'tool',name:'composition.create',arguments:JSON.stringify(valid)}},c,(n,a)=>tools.preflight(n,a)));assert.ok(v.id);assert.equal(v.phase,'collecting');assert.equal(v.responses.length,0);assert.ok((await one(db,"SELECT body FROM outbox WHERE kind='interaction'"))!.body.text.includes(composition.first_move));
 });
 it('погоджена пропозиція реально запускає збережений інструмент без повторного прохання',async()=>{
  const plan={...composition,steps:[{id:'answers',kind:'collect',question:'Куди підемо?'},{id:'result',kind:'result',depends_on:['answers'],inputs:'{"answers":{"$ref":"answers"}}',instruction:'Пропозиції: {{answers}}'}]};
  h.brain.replies.push({reply:'',actions:[],behavior:decision({move:'offer'}),offer:{title:composition.title,reason:'Потрібно обрати спільний план',value:'Кожен зможе вплинути на вибір',scale:'П’ять хвилин для двох',first_step:composition.first_move,scope:'invited',participant_ids:['11','22'],action:{kind:'tool',name:'composition.create',arguments:JSON.stringify(plan)}}});
  await h.lumen.receive(message('Люмен, запропонуй нам спосіб обрати план'));await h.lumen.processNext();
  assert.equal((await db.query('SELECT id FROM composition_runs')).rows.length,0);
  const root=(await one(db,"SELECT id FROM interactions WHERE kind='activity'"))!.id;
  await h.lumen.receive(message('Так',11));assert.equal((await db.query('SELECT id FROM composition_runs')).rows.length,0);
  await h.lumen.receive(message('Так',22));h.brain.replies.push({reply:'Підготовлено наступний етап.',actions:[],behavior:decision({move:'facilitate',relation:'activity_move',reference_id:root})});await h.lumen.processNext();
  const active=(await one(db,'SELECT * FROM composition_runs'))!;assert.ok(active);assert.equal(active.phase,'running');assert.equal(active.interaction_id,root);assert.deepEqual(active.participants.map((p:any)=>p.id).sort(),['11','22']);assert.equal((await one(db,'SELECT phase FROM interactions WHERE id=$1',[root]))!.phase,'active');assert.equal((await one(db,'SELECT status FROM action_work WHERE action_id=$1',[root]))!.status,'done');assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[root]))!.phase,'executing');
  await h.lumen.processNext();assert.ok(await one(db,"SELECT id FROM interactions WHERE parent_id=$1 AND kind='planning' AND spec->>'continuation_owner'='composition'",[root]));
 });
 it('дані завершених кроків змінюють результат; помилкові залежності не маскуються',()=>{
  const input={summary:{$ref:'answer',path:'text'}};
  assert.deepEqual(bindComposition(input,{answer:{text:'Їдемо потягом'}},{answer:{phase:'completed'}}),{summary:'Їдемо потягом'});
  assert.deepEqual(bindComposition(input,{answer:{text:'Йдемо пішки'}},{answer:{phase:'completed'}}),{summary:'Йдемо пішки'});
  assert.throws(()=>bindComposition(input,{},{answer:{phase:'failed'}}),/composition_dependency_unavailable/);
  assert.deepEqual(bindComposition(input,{},{answer:{phase:'failed'}},true),{summary:{status:'failed',result:null}});
  assert.throws(()=>validateComposition({...composition,steps:[{id:'a',kind:'join',depends_on:['b']},{id:'b',kind:'result',depends_on:['a'],instruction:'Текст'}]},[]),/composition_cycle/);
 });
 it('помилка обов’язкової залежності зупиняє продовження без вічного running',async()=>{
  const id=await run({...composition,steps:[{id:'lookup',kind:'tool',tool:'web.search',arguments:'{"query":"план"}',on_failure:'continue'},{id:'result',kind:'result',depends_on:['lookup'],inputs:'{"data":{"$ref":"lookup"}}',instruction:'{{data}}'}]});
  const worker=new CompositionWorker(db,h.config,h.brain,async()=>{throw new Error('forced_failure');},()=>[{name:'web.search',available:true,effect:false}]);
  await worker.next();await worker.next();const result=(await one(db,'SELECT phase,step_states FROM composition_runs WHERE id=$1',[id]))!;assert.equal(result.phase,'blocked');assert.equal(result.step_states.lookup.phase,'failed');assert.equal((await db.query("SELECT id FROM outbox WHERE dedup_key LIKE 'composition-result:%'")).rows.length,0);
 });
 it('втрата можливості зупиняє свою активність і не викидає виняток у цикл чату',async()=>{
  const id=await run({...composition,steps:[{id:'lookup',kind:'tool',tool:'web.search',arguments:'{"query":"план"}'},{id:'result',kind:'result',depends_on:['lookup'],instruction:'Результат'}]});
  const worker=new CompositionWorker(db,h.config,h.brain,async()=>{assert.fail('Unavailable tool must not be invoked');},()=>[{name:'web.search',available:false,effect:false}]);
  await assert.doesNotReject(()=>worker.next());const result=(await one(db,'SELECT phase,error_code,lease_until FROM composition_runs WHERE id=$1',[id]))!;assert.equal(result.phase,'blocked');assert.ok(result.error_code);assert.equal(result.lease_until,null);
 });
 it('поновлення після збою генерації зберігає реальну відповідь; невизначену або скасовану дію не повторює',async()=>{
  let fail=true,calls=0;const inputs:any[]=[];
  const brain={...h.brain,plan:h.brain.plan.bind(h.brain),text:async(messages:any[])=>{calls++;const input=JSON.parse(messages[0].content).inputs;inputs.push(input);if(fail)throw new Error('forced_generation_failure');return 'Обраний маршрут: '+input.answers[0].content;}};
  const tools=new AgentTools(db,h.config,brain),ctx={...c,personal:true,requestText:'Збери відповідь і зроби маршрут для мене'};
  const plan={...composition,steps:[{id:'answers',kind:'collect',question:'Куди хочеш піти?'},{id:'draft',kind:'generate',depends_on:['answers'],inputs:'{"answers":{"$ref":"answers"}}',instruction:'Створи маршрут із відповіді'},{id:'end',kind:'result',depends_on:['draft'],inputs:'{"draft":{"$ref":"draft"}}',instruction:'{{draft}}'}]};
  const created=await tools.execute('composition.create',plan,ctx),worker=new CompositionWorker(db,h.config,brain,(n,a,context)=>tools.execute(n,a,context),()=>tools.catalog());await worker.next();
  const child=(await one(db,'SELECT step_states FROM composition_runs WHERE id=$1',[created.id]))!.step_states.answers.interaction_id;
  await db.tx(sql=>answerInteraction(sql,{id:child,version:1,decision:'answer',content:'Парк біля озера',submit:true},c));await worker.next();await worker.next();
  const failed=(await one(db,'SELECT * FROM composition_runs WHERE id=$1',[created.id]))!;assert.equal(failed.phase,'blocked');assert.equal(failed.step_states.answers.phase,'completed');assert.equal(failed.step_states.draft.phase,'failed');assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[failed.interaction_id]))!.phase,'blocked');
  await db.query("INSERT INTO outbox(dedup_key,kind,body,revision,status) VALUES($1,'text',$2,0,'uncertain')",['resume-uncertain',JSON.stringify({compositionId:created.id,text:'Непідтверджена доставка'})]);
  await assert.rejects(()=>tools.execute('composition.resume',{id:created.id},{...ctx,updateId:randomUUID()}),/previous_tool_result_uncertain/);assert.equal((await one(db,'SELECT phase FROM composition_runs WHERE id=$1',[created.id]))!.phase,'blocked');assert.equal(calls,1);
  await db.query("UPDATE outbox SET status='cleared' WHERE dedup_key='resume-uncertain'");
  const resumed=await tools.execute('composition.resume',{id:created.id},{...ctx,updateId:randomUUID()});assert.equal(resumed.resumed,true);assert.deepEqual(resumed.completed_steps,['answers']);
  const preserved=(await one(db,'SELECT * FROM composition_runs WHERE id=$1',[created.id]))!;assert.deepEqual(preserved.outputs.answers,failed.outputs.answers);assert.deepEqual(preserved.step_states.answers,failed.step_states.answers);assert.equal(preserved.resume_version,failed.resume_version+1);assert.equal(preserved.step_states.draft,undefined);
  fail=false;await worker.next();await worker.next();assert.equal(calls,2);assert.deepEqual(inputs[0],inputs[1]);assert.match((await one(db,"SELECT body FROM outbox WHERE dedup_key LIKE 'composition-result:%'"))!.body.text,/Парк біля озера/);
  await tools.execute('composition.cancel',{id:created.id},{...ctx,updateId:randomUUID()});await assert.rejects(()=>tools.execute('composition.resume',{id:created.id},{...ctx,updateId:randomUUID()}),/composition_unavailable/);assert.equal(calls,2);assert.equal((await one(db,'SELECT phase FROM composition_runs WHERE id=$1',[created.id]))!.phase,'cancelled');
 });
 it('скасування композиції закриває вже створене питання і його стару картку',async()=>{
  const tools=new AgentTools(db,h.config,h.brain),ctx={...c,personal:true,requestText:'Збери відповіді для мене'};
  const plan={...composition,steps:[{id:'answers',kind:'collect',question:'Куди хочеш піти?'},{id:'end',kind:'result',depends_on:['answers'],inputs:'{"answers":{"$ref":"answers"}}',instruction:'{{answers}}'}]};
  const created=await tools.execute('composition.create',plan,ctx);const worker=new CompositionWorker(db,h.config,h.brain,(n,a,context)=>tools.execute(n,a,context),()=>tools.catalog());await worker.next();
  const child=(await one(db,'SELECT id FROM interactions WHERE parent_id=(SELECT interaction_id FROM composition_runs WHERE id=$1)',[created.id]))!.id;
  await tools.execute('composition.cancel',{id:created.id},{...ctx,updateId:randomUUID()});assert.equal((await one(db,'SELECT phase FROM interactions WHERE id=$1',[child]))!.phase,'cancelled');
  await assert.rejects(()=>db.tx(sql=>answerInteraction(sql,{id:child,version:1,decision:'answer',content:'Парк',submit:true},c)));
  await new Delivery(db,h.tg as any,h.config).next();assert.ok(h.tg.sent.every(x=>/скасован/iu.test(x.text)));
 });
 it('скасування між захопленням кроку та створенням файлу блокує пізній результат',async()=>{
  const tools=new AgentTools(db,h.config,h.brain),ctx={...c,personal:true,requestText:'Зроби для мене файл'};
  const plan={...composition,steps:[{id:'file',kind:'tool',tool:'artifact.create',arguments:JSON.stringify({name:'Late.txt',content:'Цей файл скасовано до створення'})},{id:'end',kind:'result',depends_on:['file'],instruction:'Підсумок'}]};
  const created=await tools.execute('composition.create',plan,ctx);
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),released=new Promise<void>(r=>{release=r;});
  const worker=new CompositionWorker(db,h.config,h.brain,async(name,args,context)=>{enter();await released;return tools.execute(name,args,context);},()=>tools.catalog());
  const running=worker.next();await entered;const cancelled=await tools.execute('composition.cancel',{id:created.id},{...ctx,updateId:randomUUID()});assert.equal(cancelled.changed,true);release();await running;
  assert.equal((await one(db,'SELECT phase FROM composition_runs WHERE id=$1',[created.id]))!.phase,'cancelled');assert.equal((await db.query('SELECT id FROM agent_artifacts')).rows.length,0);assert.equal((await db.query("SELECT id FROM outbox WHERE kind='artifact'")).rows.length,0);
 });
 it('реальні відповіді обох людей формують варіанти, а їхні голоси формують підсумок',async()=>{
  const plan={...composition,steps:[{id:'answers',kind:'collect',question:'Куди хочеться піти?'},{id:'draft',kind:'generate',depends_on:['answers'],inputs:'{"answers":{"$ref":"answers"}}',instruction:'Побудуй варіанти з відповідей',output_type:'json'},{id:'vote',kind:'poll',depends_on:['draft'],inputs:'{"choices":{"$ref":"draft"}}',question:'Обираємо: {{choices.first}} чи {{choices.second}}?',options:['{{choices.first}}','{{choices.second}}']},{id:'result',kind:'result',depends_on:['vote'],inputs:'{"vote":{"$ref":"vote"}}',instruction:'Погоджені варіанти: {{vote.options}}. Голоси: {{vote.counts}}.'}]};
  const id=await run(plan),generated:any[]=[];
  const brain={...h.brain,plan:h.brain.plan.bind(h.brain),text:async(messages:any[])=>{const inputs=JSON.parse(messages[0].content).inputs;generated.push(inputs);return JSON.stringify({first:inputs.answers.find((a:any)=>a.user_id==='11').content,second:inputs.answers.find((a:any)=>a.user_id==='22').content});}};
  const worker=new CompositionWorker(db,h.config,brain,async()=>({}),()=>[]);
  await worker.next();const child=(await one(db,'SELECT step_states FROM composition_runs WHERE id=$1',[id]))!.step_states.answers.interaction_id;
  await db.tx(sql=>answerInteraction(sql,{id:child,version:1,decision:'answer',content:'Парк',submit:true},c));await db.tx(sql=>answerInteraction(sql,{id:child,version:1,decision:'answer',content:'Кіно',submit:true},{...c,actorId:'22'}));
  await worker.next();await worker.next();assert.equal(generated.length,1);assert.deepEqual(generated[0].answers.map((a:any)=>a.content).sort(),['Кіно','Парк']);
  await worker.next();const queued=(await one(db,"SELECT body FROM outbox WHERE kind='poll'"))!.body;assert.deepEqual(queued.options,['Парк','Кіно']);assert.match(queued.question,/Парк.*Кіно/);assert.doesNotMatch(queued.question,/\{\{/);
  (h.tg as any).poll=async(_chat:string,question:string,options:string[])=>({message_id:71111,poll:{id:'poll-111',question,options:options.map(text=>({text}))}});const delivery=new Delivery(db,h.tg as any,h.config);for(let i=0;i<5;i++)if((await one(db,"SELECT status FROM outbox WHERE kind='poll'"))!.status!=='sent')await delivery.next();
  assert.equal((await one(db,"SELECT status FROM outbox WHERE kind='poll'"))!.status,'sent',JSON.stringify((await db.query("SELECT status,error_code,body FROM outbox WHERE kind='poll'")).rows));assert.ok(await one(db,"SELECT poll_id FROM polls WHERE poll_id='poll-111'"));
  await db.query("INSERT INTO poll_votes(poll_id,user_id,name,option_ids) VALUES('poll-111','11','Саша','[1]'),('poll-111','22','Олена','[1]')");
  await worker.next();await worker.next();const summary=(await one(db,"SELECT body FROM outbox WHERE dedup_key LIKE 'composition-result:%'"))!.body.text;assert.match(summary,/Парк/);assert.match(summary,/Кіно/);assert.match(summary,/\[0,2\]/);assert.equal((await one(db,'SELECT phase FROM composition_runs WHERE id=$1',[id]))!.phase,'delivering');
  for(let i=0;i<5;i++)if((await one(db,'SELECT phase FROM composition_runs WHERE id=$1',[id]))!.phase!=='completed')await delivery.next();assert.equal((await one(db,'SELECT phase FROM composition_runs WHERE id=$1',[id]))!.phase,'completed');
 });
});
