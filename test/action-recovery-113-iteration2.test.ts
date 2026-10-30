import {after,before,beforeEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gateOutcome,toolOutcome} from '../src/outcomes.js';
import {independentAction,withoutScheduleClaims} from '../src/engine.js';
import {taskCompletionCriteria,verifyTask} from '../src/result-verifier.js';
import {AgentTools} from '../src/agent-tools.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {Delivery} from '../src/delivery.js';
import {layoutMessage} from '../src/message-layout.js';
import {stableId} from '../src/operations.js';
import {one} from '../src/db.js';
import {ModelError} from '../src/auth.js';
import type {Action} from '../src/model.js';
import {TestDB,harness,paired,message} from './helpers.js';

const tool=(name:string,args:unknown):Action=>({kind:'tool',name,arguments:JSON.stringify(args)});
const schedule=(quote:string):Extract<Action,{kind:'schedule'}>=>({kind:'schedule',title:'Аптека',instruction:'Зайти в аптеку',mode:'reminder',authorization:'explicit',timezone:'UTC',due_at:new Date(Date.now()+3600000).toISOString(),quote});
const explanation='Список покупок зберігає те, що ти хочеш купити. Запаси показують те, що вже є вдома. Кількість у списку може бути відсутня, а для точного обліку запасів потрібна одиниця виміру.';

describe('1.13 iteration2 independent QA completion counterexamples',()=>{
  it('QAMR01 rejects ready/assembled media claims for every unverified state and without a job',()=>{
    const facts=[[],[toolOutcome('studio.manage',{status:'queued',id:'qa-job'})],[toolOutcome('studio.manage',{error:'invalid_tool_arguments'})],[toolOutcome('studio.manage',{error:'soundtrack_required'})]];
    for(const reply of ['Ролик готовий.','Відео готове, забирай!','Ролик успішно зібрано.','Movie ready.','Видео готово.'])for(const evidence of facts){const result=gateOutcome({reply,actions:[]},evidence);assert.equal(result.blocked,true,reply+JSON.stringify(evidence));assert.notEqual(result.plan.reply,reply);}
  });
  it('keeps questions, denials, quotations, fictional narrative and an offer of help',()=>{
    for(const reply of ['Ролик не готовий. Надішли фото, які беремо.','Відео ще не готове.','Ролик готовий?','Він сказав: «Ролик готовий».','У нашій грі режисер зібрав ролик.','У нашому детективі відео готове.','Коли ролик буде готовий, надішли його.','Я готовий зібрати ролик.'])assert.equal(gateOutcome({reply,actions:[]},[toolOutcome('studio.manage',{status:'queued',id:'qa'})]).plan.reply,reply,reply);
    const proof=toolOutcome('artifact.delivery',{id:'file',name:'Подорож',status:'delivered',deliveryReceipt:{message_id:1,output:{id:'file',sha256:'a'.repeat(64),bytes:100,mime:'video/mp4',revision:0}},outputProof:{id:'file',sha256:'a'.repeat(64),bytes:100,mime:'video/mp4',revision:0,readback_verified:true,receipt_message_id:1,kinds:['video']}});assert.equal(gateOutcome({reply:'Ролик «Подорож» готовий.',actions:[]},[proof]).blocked,false);
  });
  it('UC03/16 binds a dependency to the actual reminder clause, even if the supplied quote omits its condition',()=>{
    const unrelated='Люмен, додай молоко до покупок; якщо буде потрібно, пізніше розберемо запаси. Також через годину нагадай про аптеку';
    assert.equal(independentAction(schedule('через годину нагадай про аптеку'),unrelated),true);
    for(const intent of ['Люмен, коли ролик буде готовий, нагадай про аптеку','Люмен, якщо ролик збереться, нагадай про аптеку','Люмен, нагадай про аптеку, якщо ролик буде готовий'])assert.equal(independentAction(schedule('нагадай про аптеку'),intent),false,intent);
  });
  it('UC02 strips unsupported schedule confirmations while preserving substantive and quoted content',()=>{
    assert.equal(withoutScheduleClaims(explanation+' Нагадаю завтра о 12:00.'),explanation);
    assert.equal(withoutScheduleClaims(explanation+' Нагадування створено на завтра.'),explanation);
    assert.equal(withoutScheduleClaims('Що означає «Нагадування створено»?'), 'Що означає «Нагадування створено»?');
    assert.equal(withoutScheduleClaims('Нагадування не створено. Уточни час.'),'Нагадування не створено. Уточни час.');
    const paragraphs='Список містить бажані покупки.\n\n- Запаси описують те, що є вдома.\n- Кількість можна уточнити пізніше.';assert.equal(withoutScheduleClaims(paragraphs),paragraphs);
  });
  it('QAMR02 requires a physical video result before execution without imposing it on informational tasks',()=>{
    for(const goal of ['Зроби ролик з наданою музикою','Збери відео з цих фото','Створи фільм','Make a video clip','Сделай ролик'])assert.ok(taskCompletionCriteria({title:'Робота',goal}).includes('media'),goal);
    for(const goal of ['Поясни, як створити відео','Досліди, як зробити ролик','Знайди готовий ролик','Порівняй два відео','Підготуй сценарій ролика','Recommend a video editor','Research video encoding','Створи зображення','Створи документ','Створи PDF документ про історію відео','Створи картинку про відео','Створи зображення для ролика'])assert.equal(taskCompletionCriteria({title:'Довідка',goal}).includes('media'),false,goal);
    assert.deepEqual(taskCompletionCriteria({title:'Довідка',goal:'Поясни відео',criteria:['response','research','media']}),['response','research','media']);
  });
  it('rejected list mutations cannot become model confirmations and retain the concrete input request',()=>{
    const fact=toolOutcome('lists.manage',{operation:'add',status:'needs_input',question:'Напиши мені в особистий чат, щоб зберегти особистий список.'});
    for(const reply of ['Додав у покупки: банани.','Додав у твій особистий список: ліки.','Прибрав зі списку: яйця.','Позначив молоко як зроблене.']){const checked=gateOutcome({reply,actions:[]},[fact]);assert.equal(checked.blocked,true,reply);assert.equal(checked.plan.reply,fact.detail);}
    for(const reply of ['Не додав у покупки: банани.','Ти сказав: «Додав у покупки: банани».','Який пункт додати до покупок?'])assert.equal(gateOutcome({reply,actions:[]},[fact]).plan.reply,reply,reply);
  });
});

describe('1.13 iteration2 actual engine and task acceptance',()=>{
  const db=new TestDB();let h:ReturnType<typeof harness>;
  before(async()=>{await db.init();});beforeEach(async()=>{await db.reset();await db.query('TRUNCATE media_publications,media_jobs,studio_projects,media_assets CASCADE');h=harness(db);await paired(h);});after(async()=>{await db.close();});
  const answer=async()=>String((await db.query("SELECT body->>'text' AS text FROM outbox WHERE dedup_key LIKE 'answer:%' ORDER BY id DESC LIMIT 1")).rows[0]?.text||'');

  it('QAMR01 actual failed studio -> ready reply cannot claim a nonexistent job',async()=>{
    h.brain.replies=[{reply:'',actions:[tool('studio.manage',{operation:'invalid'})]},{reply:'Ролик готовий.',actions:[]}];await h.lumen.receive(message('Люмен, зроби відео з музикою'));await h.lumen.processNext();
    assert.doesNotMatch(await answer(),/Ролик готовий/u);assert.equal((await db.query('SELECT count(*)::int AS n FROM media_jobs')).rows[0]?.n,0);assert.ok((await db.query("SELECT id FROM tool_runs WHERE status='failed'")).rows.length);
  });
  it('QAMR01 actual queued task without media output cannot claim the video is ready',async()=>{
    h.brain.replies=[{reply:'',actions:[tool('tasks.create',{title:'Ролик з музикою',goal:'Зроби ролик з наданою музикою'})]},{reply:'Відео готове, забирай!',actions:[]}];await h.lumen.receive(message('Люмен, зроби ролик з музикою'));await h.lumen.processNext();assert.doesNotMatch(await answer(),/Відео готове|забирай/u);assert.equal((await db.query('SELECT count(*)::int AS n FROM media_jobs')).rows[0]?.n,0);
  });
  it('UC02 keeps every requested explanatory sentence plus the actual independent schedule confirmation',async()=>{
    h.brain.replies=[{reply:explanation+' Нагадаю завтра о 12:00.',actions:[schedule('через годину нагадай про аптеку')]}];await h.lumen.receive(message('Люмен, поясни докладно різницю між списком і запасами. Також через годину нагадай про аптеку'));await h.lumen.processNext();
    assert.ok((await answer()).includes(explanation));assert.match(await answer(),/Запланував нагадування/u);assert.doesNotMatch(await answer(),/завтра о 12:00/u);assert.equal((await db.query('SELECT count(*)::int AS n FROM scheduled_actions')).rows[0]?.n,1);
  });
  it('UC03 keeps the explicit reminder through list replan despite an unrelated conditional sentence',async()=>{
    const intent='Люмен, додай молоко до покупок; якщо буде потрібно, пізніше розберемо запаси. Також через годину нагадай про аптеку';
    h.brain.replies=[{reply:'',actions:[tool('lists.manage',{operation:'add',category:'shopping',text:'молоко',quote:'додай молоко до покупок'}),schedule('через годину нагадай про аптеку')]},{reply:'Додав у покупки: молоко.',actions:[]}];await h.lumen.receive(message(intent));await h.lumen.processNext();
    assert.equal((await db.query('SELECT count(*)::int AS n FROM simple_list_events')).rows[0]?.n,1);assert.equal((await db.query('SELECT count(*)::int AS n FROM scheduled_actions')).rows[0]?.n,1);assert.match(await answer(),/молоко/u);assert.match(await answer(),/аптеку/u);
  });
  it('UC03 restart retains the independently quoted reminder after a committed list and model error',async()=>{
    const intent='Люмен, додай молоко до покупок; якщо буде потрібно, пізніше розберемо запаси. Також через годину нагадай про аптеку';h.brain.replies=[{reply:'',actions:[tool('lists.manage',{operation:'add',category:'shopping',text:'молоко',quote:'додай молоко до покупок'}),schedule('через годину нагадай про аптеку')]}];const original=h.brain.plan.bind(h.brain);let calls=0;h.brain.plan=async input=>{if(++calls===2)throw new ModelError('model_network');return original(input);};
    const update=message(intent);await h.lumen.receive(update);await h.lumen.processNext();assert.equal((await one(db,'SELECT payload FROM inbox WHERE update_id=$1',[update.update_id]))?.payload.pendingIndependent.length,1);const restarted=harness(db);restarted.brain.replies=[{reply:'Покупки додав.',actions:[]}];await db.query('UPDATE inbox SET available_at=now() WHERE update_id=$1',[update.update_id]);await restarted.lumen.processNext();assert.equal((await db.query('SELECT count(*)::int AS n FROM scheduled_actions')).rows[0]?.n,1);assert.equal((await db.query('SELECT count(*)::int AS n FROM simple_list_events')).rows[0]?.n,1);
  });
  it('UC04 keeps all card facts, numbers and conditions in a full answer and preserves concise optional details',async()=>{
    const facts=['Виїзд о 07:30.','Пересадка триває 18 хвилин.','Одна валіза до 10 кг.'],presentation={card:{title:'Поїздка',summary:'Порівняння двох варіантів.',facts,question:'Потрібна допомога з квитком?',details:'Для пересадки обери сусідню платформу. Якщо валіза важча, доплати за багаж.'}};
    const full=await layoutMessage(db,'Ось повне порівняння.',presentation,{actorId:'11',topicId:'0',revision:0,key:'r2-full',fullRequested:true});for(const fact of facts)assert.ok(full.text.includes(fact));assert.ok(full.text.includes(presentation.card.details));assert.ok(full.text.includes(presentation.card.question));
    const interactiveFull=await layoutMessage(db,'Ось повне порівняння.',presentation,{actorId:'11',topicId:'0',revision:0,key:'r2-interactive-full',fullRequested:true,interactive:true});for(const fact of facts)assert.ok(interactiveFull.text.includes(fact));
    const concise=await layoutMessage(db,'Ось порівняння.',presentation,{actorId:'11',topicId:'0',revision:0,key:'r2-short'});for(const fact of facts)assert.ok(concise.text.includes(fact));assert.equal(concise.text.includes(presentation.card.details),false);assert.ok(concise.replyMarkup?.inline_keyboard.some(row=>row.some(b=>b.text==='Докладніше')));
    h.brain.replies=[{reply:'Ось повне порівняння.',actions:[],presentation}];await h.lumen.receive(message('Люмен, покажи порівняння повністю без скорочень'));await h.lumen.processNext();for(const fact of facts)assert.ok((await answer()).includes(fact));assert.ok((await answer()).includes('сусідню платформу'));
  });
  it('UC05/06 actual rejected target and personal-list route cannot be rewritten as completed mutations',async()=>{
    h.brain.replies=[{reply:'',actions:[tool('lists.manage',{operation:'add',category:'shopping',text:'банани'})]},{reply:'Додав у покупки: банани.',actions:[]}];await h.lumen.receive(message('Люмен, додай молоко до покупок'));await h.lumen.processNext();assert.equal((await db.query('SELECT count(*)::int AS n FROM simple_list_events')).rows[0]?.n,0);assert.doesNotMatch(await answer(),/Додав у покупки: банани/u);
    h.brain.replies=[{reply:'',actions:[tool('lists.manage',{operation:'add',category:'shopping',text:'ліки'})]},{reply:'Додав у твій особистий список: ліки.',actions:[]}];await h.lumen.receive(message('Люмен, додай особисто мені до покупок ліки, це мій особистий список'));await h.lumen.processNext();assert.equal((await db.query('SELECT count(*)::int AS n FROM simple_list_events')).rows[0]?.n,0);assert.doesNotMatch(await answer(),/Додав у твій особистий список/u);
  });

  it('QAMR04 verifies immutable logical topic independently of private Telegram routing',async()=>{
    for(const [audience,topic] of [['private','7'],['group','7'],['private','0']] as const){
      const taskId=randomUUID(),project=randomUUID(),jobId=randomUUID(),output=stableId('render-output:'+jobId),publication=stableId('render-publication:'+jobId),sha='b'.repeat(64);
      await db.query("INSERT INTO agent_tasks(id,dedup_key,actor_id,topic_id,title,goal,status,revision,criteria,audience) VALUES($1,$2,'11',$3,'Ролик','Зроби ролик','verifying',0,'[\"response\",\"media\"]',$4)",[taskId,'scope:'+taskId,topic,audience]);
      await db.query("INSERT INTO studio_projects(id,owner_id,title,audience,topic_id) VALUES($1,'11','Подорож',$2,$3)",[project,audience,topic]);
      await db.query("INSERT INTO media_assets(id,owner_id,title,mime,path,sha256,bytes,audience,topic_id) VALUES($1,'11','Подорож','video/mp4','/test/scope.mp4',$2,10,$3,$4)",[output,sha,audience,topic]);
      await db.query("INSERT INTO media_jobs(id,kind,resource_id,resource_version,manifest,manifest_hash,status,stage,actor_id,topic_id,audience,revision,task_id,goal_version,output_id,verification) VALUES($1,'story',$2,1,'{}','hash','ready','verified','11',$3,$4,0,$5,1,$6,$7)",[jobId,project,topic,audience,taskId,output,JSON.stringify({video:{decoded:true}})]);
      await db.query("INSERT INTO tool_runs(dedup_key,task_id,actor_id,tool,arguments,status,result,revision,goal_version) VALUES($1,$2,'11','studio.manage',$3,'succeeded',$4,0,1)",['scope:'+jobId,taskId,JSON.stringify({operation:'export',id:project,version:1}),JSON.stringify({id:jobId,status:'queued',resource_id:project,version:1})]);
      const manifest={id:output,version:1,sha256:sha,audience},receipt={provider:'telegram',chat_id:audience==='private'?'11':'-100',message_ids:[8801],scope_topic_id:topic,actor_id:'11',audience,task_id:taskId,goal_version:1};
      await db.query("INSERT INTO media_publications(id,asset_id,actor_id,manifest,status,receipts) VALUES($1,$2,'11',$3,'delivered',$4)",[publication,output,JSON.stringify(manifest),JSON.stringify([receipt])]);
      const body={...manifest,mediaJobId:jobId,publicationId:publication,taskId,goalVersion:1,scopeTopicId:topic,...(audience==='group'?{threadId:Number(topic)}:{})};await db.query("INSERT INTO outbox(dedup_key,kind,body,revision,actor_id,audience,status,telegram_id) VALUES($1,'media_asset',$2,0,'11',$3,'sent',8801)",['scope:'+jobId,JSON.stringify(body),audience]);
      const task=await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[taskId]);assert.equal((await verifyTask(db,{...task,chatId:'-100'},'Ролик готовий.')).ok,true,audience+topic);
      if(audience==='private'){const before=h.tg.sent.length;await (new AgentTasks(db,h.config,h.brain) as any).finish({...task,chatId:'-100'},'completed','Ролик «Подорож» готовий.');const notices=(await db.query("SELECT audience FROM outbox WHERE body->>'taskId'=$1 AND kind IN ('text','task_status')",[taskId])).rows;assert.ok(notices.length);assert.ok(notices.every(n=>n.audience==='private'));const delivery=new Delivery(db,h.tg as any,h.config);for(let i=0;i<8;i++)await delivery.next();assert.ok(h.tg.sent.slice(before).length);assert.ok(h.tg.sent.slice(before).every(m=>m.chatId==='11'));}
      await db.query('UPDATE media_publications SET receipts=$2 WHERE id=$1',[publication,JSON.stringify([{...receipt,scope_topic_id:'8'}])]);assert.equal((await verifyTask(db,{...task,chatId:'-100'},'Ролик готовий.')).ok,false);
      await db.query('UPDATE media_publications SET receipts=$2 WHERE id=$1',[publication,JSON.stringify([receipt])]);if(audience==='private'){const {scopeTopicId,...oldBody}=body;await db.query('UPDATE outbox SET body=$2 WHERE dedup_key=$1',['scope:'+jobId,JSON.stringify(oldBody)]);assert.equal((await verifyTask(db,{...task,chatId:'-100'},'Ролик готовий.')).ok,false);}
    }
  });

  it('QAMR02 actual media task has its contract before tools and cannot complete from text delivery without export',async()=>{
    const tools=new AgentTools(db,h.config,h.brain),created=await tools.execute('tasks.create',{title:'Ролик з музикою',goal:'Зроби ролик з наданою музикою'},{actorId:'11',chatId:'-100',topicId:'0',revision:0,requested:true,updateId:'r2-media-create',requestText:'Зроби ролик з наданою музикою'});let task=await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[created.id]);assert.ok(task?.criteria.includes('media'));
    h.brain.replies=[{reply:'Ролик готовий.',actions:[]}];await new AgentTasks(db,h.config,h.brain).next();task=await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[created.id]);assert.equal(task?.status,'needs_input');assert.doesNotMatch(task?.result||'',/Ролик готовий/u);const d=new Delivery(db,h.tg as any,h.config);for(let i=0;i<10;i++)await d.next();assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[created.id]))?.status,'needs_input');assert.equal((await db.query('SELECT count(*)::int AS n FROM media_jobs')).rows[0]?.n,0);
    await db.query("UPDATE agent_tasks SET criteria='[\"response\"]' WHERE id=$1",[created.id]);const legacy=await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[created.id]);assert.ok((await verifyTask(db,legacy,'Готово.')).missing.includes('media_output'));
  });
  it('a no-export media task retains a truthful decisive clarification while staying incomplete',async()=>{
    const tools=new AgentTools(db,h.config,h.brain),created=await tools.execute('tasks.create',{title:'Ролик',goal:'Збери ролик з моїх фото'},{actorId:'11',chatId:'-100',topicId:'0',revision:0,requested:true,updateId:'r2-clarify'});h.brain.replies=[{reply:'Які фото беремо для ролика?',actions:[]}];await new AgentTasks(db,h.config,h.brain).next();const task=await one(db,'SELECT status,result FROM agent_tasks WHERE id=$1',[created.id]);assert.equal(task?.status,'needs_input');assert.equal(task?.result,'Які фото беремо для ролика?');
  });
});
