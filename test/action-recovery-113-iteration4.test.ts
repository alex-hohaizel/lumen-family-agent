import {after,before,beforeEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {gateOutcome,toolOutcome,type OutcomeFact} from '../src/outcomes.js';
import {taskCompletionCriteria,verifyTask} from '../src/result-verifier.js';
import {AgentTools} from '../src/agent-tools.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {Delivery} from '../src/delivery.js';
import {one} from '../src/db.js';
import type {Action} from '../src/model.js';
import {TestDB,harness,paired,message} from './helpers.js';

const tool=(name:string,args:unknown):Action=>({kind:'tool',name,arguments:JSON.stringify(args)});
const queued=toolOutcome('studio.manage',{status:'queued',id:'qa-job'}),failed=toolOutcome('studio.manage',{error:'soundtrack_required'});
const compound='Зроби ролик із фото і поясни, як його потім зберегти.';

describe('1.13 iteration4 exact QAMR claim and operative-source boundaries',()=>{
  it('QAMR01-R2A/B requires proof for English articles and cross-sentence ready plus collection',()=>{
    for(const facts of [[],[queued],[failed]])for(const reply of ['The video is ready.','The file was sent.','Готово! Забирай ролик.','Done! Here is the video.','Готово! Тримай ролик.','Готово! Ось твій ролик.']){const checked=gateOutcome({reply,actions:[]},facts);assert.equal(checked.blocked,true,reply+JSON.stringify(facts));assert.notEqual(checked.plan.reply,reply);assert.doesNotMatch(checked.plan.reply,/Готово!|Забирай|Here is the video|The video is ready/u);}
  });
  it('keeps genuine reported speech, quotations, fiction, questions, denial and help',()=>{
    const controls=['He said the video is ready.','She said: the video is ready.','She reported that the file was sent.','Ти написав «Готово! Забирай ролик».','He wrote: "Done! Here is the video."','У нашій грі режисер зібрав ролик.','У нашому детективі кур’єр надіслав повідомлення підозрюваному.','Чи готовий ролик?','Is the video ready?','The video is not ready.','Ролик ще не готовий.','I am ready to help make a video.','Я готовий допомогти зібрати ролик.','Якщо ролик готовий, надішли його сюди.','To download a video, use the app menu.'];
    for(const reply of controls)for(const fact of [queued,failed])assert.equal(gateOutcome({reply,actions:[]},[fact]).plan.reply,reply,reply);
  });
  it('preserves a verified partial result and material card facts when the movie claim is rejected',()=>{
    const event=toolOutcome('calendar.write',{id:'event',title:'Зустріч',provider_readback:true,receipt:{uid:'event-uid'}});
    const reply='Подію створено.\n\nГотово! Забирай ролик.';const checked=gateOutcome({reply,actions:[]},[event,failed]);assert.equal(checked.blocked,true);assert.ok(checked.plan.reply.includes('Подію створено.'));assert.doesNotMatch(checked.plan.reply,/Готово!|Забирай ролик/u);assert.match(checked.plan.reply,/аудіофайл/u);
    const card=gateOutcome({reply:'Подію створено.',actions:[],presentation:{card:{title:'Готово',summary:'Забирай ролик.',facts:['Зустріч о 09:30.'],question:''}}},[event,failed]);assert.equal(card.blocked,true);assert.ok(card.plan.reply.includes('Подію створено.'));assert.ok(card.plan.reply.includes('Зустріч о 09:30.'));assert.doesNotMatch(card.plan.reply,/Забирай ролик/u);
  });
  it('matches exact completion/delivery proof without letting another named output certify collection',()=>{
    const completion:OutcomeFact={capability:'studio.output',status:'observed',confirmed:'completion',targetKind:'file',reference:'output',targets:['Спогади'],fileKinds:['video']};
    assert.equal(gateOutcome({reply:'The video «Спогади» is ready.',actions:[]},[completion]).blocked,false);
    const delivered=toolOutcome('artifact.delivery',{id:'output',title:'Спогади',status:'delivered',deliveryReceipt:{message_id:9,output:{id:'output',sha256:'a'.repeat(64),bytes:100,mime:'video/mp4',revision:0}},outputProof:{id:'output',sha256:'a'.repeat(64),bytes:100,mime:'video/mp4',revision:0,readback_verified:true,receipt_message_id:9,kinds:['video']}});
    assert.equal(gateOutcome({reply:'Готово! Забирай ролик «Спогади».',actions:[]},[delivered]).blocked,false);
    assert.equal(gateOutcome({reply:'Готово! Забирай ролик «Інший».',actions:[]},[delivered]).blocked,true);
    assert.equal(gateOutcome({reply:'Готово! Забирай ролик «Спогади».',actions:[]},[completion]).blocked,true);
  });
  it('QAMR02-R2 derives media from the operative create clause with a weak model goal',()=>{
    const positives=[compound,'Створи відео і знайди доречний підпис.','Зроби ролик і поясни різницю між форматами.','Поясни різницю і створи відео.'];
    const negatives=['Поясни, як зробити відео.','Поясни як зробити відео.','Досліди відео.','Порадь музику для відео.','Створи PDF про історію відео.','Зроби сценарій для ролика.','Не роби відео.','Research how to make a video.','Підготуй пояснення про відео.','Зроби огляд відео.'];
    for(const requestText of positives)assert.ok(taskCompletionCriteria({title:'Результат',goal:'Підготувати результат',criteria:['response'],requestText}).includes('media'),requestText);
    for(const requestText of negatives)assert.equal(taskCompletionCriteria({title:'Результат',goal:'Підготувати результат',criteria:['response'],requestText}).includes('media'),false,requestText);
  });
});

describe('1.13 iteration4 actual foreground and task controls',()=>{
  const db=new TestDB();let h:ReturnType<typeof harness>;
  before(async()=>{await db.init();});beforeEach(async()=>{await db.reset();h=harness(db);await paired(h);});after(async()=>{await db.close();});
  const answer=async()=>String((await db.query("SELECT body->>'text' AS text FROM outbox WHERE dedup_key LIKE 'answer:%' ORDER BY id DESC LIMIT 1")).rows[0]?.text||'');
  it('actual invalid studio cannot send Готово! Забирай ролик without a media job',async()=>{
    h.brain.replies=[{reply:'',actions:[tool('studio.manage',{operation:'invalid'})]},{reply:'Готово! Забирай ролик.',actions:[]}];await h.lumen.receive(message('Люмен, зроби ролик із музикою'));await h.lumen.processNext();assert.equal((await db.query('SELECT count(*)::int AS n FROM media_jobs')).rows[0]?.n,0);assert.ok((await db.query("SELECT id FROM tool_runs WHERE status='failed'")).rows.length);assert.doesNotMatch(await answer(),/Готово!|Забирай ролик/u);
  });
  it('actual completed list remains visible while the unsupported movie completion is repaired',async()=>{
    h.brain.replies=[{reply:'',actions:[tool('lists.manage',{operation:'add',category:'shopping',text:'молоко',quote:'додай молоко до покупок'}),tool('studio.manage',{operation:'invalid'})]},{reply:'Додав у покупки: молоко. Готово! Забирай ролик.',actions:[]}];await h.lumen.receive(message('Люмен, додай молоко до покупок і зроби ролик із музикою'));await h.lumen.processNext();assert.equal((await db.query('SELECT count(*)::int AS n FROM simple_list_events')).rows[0]?.n,1);assert.equal((await db.query('SELECT count(*)::int AS n FROM media_jobs')).rows[0]?.n,0);assert.match(await answer(),/Додав у покупки: молоко/u);assert.doesNotMatch(await answer(),/Готово!|Забирай ролик/u);
  });
  it('actual compound create source persists media before execution and cannot complete from saving instructions',async()=>{
    const update=message('Люмен, '+compound);await h.lumen.receive(update);const source=(await db.query("SELECT id FROM messages WHERE role='user' AND telegram_id=$1",[update.message!.message_id])).rows[0]!;
    const tools=new AgentTools(db,h.config,h.brain),created=await tools.execute('tasks.create',{title:'Результат',goal:'Підготувати результат',criteria:['response']},{actorId:'11',chatId:'-100',topicId:'0',revision:0,requested:true,sourceId:Number(source.id),requestText:compound,updateId:'r4-compound'});const admitted=await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[created.id]);assert.ok(admitted?.criteria.includes('media'));
    h.brain.replies=[{reply:'Щоб зберегти відео, натисни кнопку завантаження.',actions:[]}];await new AgentTasks(db,h.config,h.brain).next();const delivery=new Delivery(db,h.tg as any,h.config);for(let i=0;i<12;i++)await delivery.next();const after=await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[created.id]);assert.equal(after?.status,'needs_input');assert.equal((await db.query('SELECT count(*)::int AS n FROM media_jobs')).rows[0]?.n,0);assert.ok((await verifyTask(db,after,'Щоб зберегти відео, натисни кнопку завантаження.')).missing.includes('media_output'));assert.equal(h.tg.sent.some(x=>/^Результат\nЗавершено$/u.test(x.text)),false);
  });
  it('an explanation-only actual source remains a response task and completes with the explanation',async()=>{
    const update=message('Люмен, поясни як зробити відео.');await h.lumen.receive(update);const source=(await db.query("SELECT id FROM messages WHERE role='user' AND telegram_id=$1",[update.message!.message_id])).rows[0]!;
    const created=await new AgentTools(db,h.config,h.brain).execute('tasks.create',{title:'Пояснення',goal:'Поясни як зробити відео',criteria:['response']},{actorId:'11',chatId:'-100',topicId:'0',revision:0,requested:true,sourceId:Number(source.id),updateId:'r4-explain'});assert.equal((await one(db,'SELECT criteria FROM agent_tasks WHERE id=$1',[created.id]))?.criteria.includes('media'),false);
    h.brain.replies=[{reply:'Обери фото, визнач порядок і тривалість, потім додай надану музику.',actions:[]}];await new AgentTasks(db,h.config,h.brain).next();const delivery=new Delivery(db,h.tg as any,h.config);for(let i=0;i<12;i++)await delivery.next();assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[created.id]))?.status,'completed');
  });
});
