import {describe,it,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TestDB,harness,message} from './helpers.js';
import {one,state,queueText,forgetPhrase,eraseAll,type Database} from '../src/db.js';
import {createCommitment,cancelCommitment,reserveEffect,claimEffect,claimActionWork,recoverActionWork,recoverDispatches} from '../src/commitments.js';
import {openInteraction,answerInteraction,interactionView,finishInteraction,enqueueInteraction,launchConsent} from '../src/interactions.js';
import {AgentTools,type ToolContext} from '../src/agent-tools.js';
import {CompositionWorker} from '../src/compositions.js';
import {Delivery} from '../src/delivery.js';
import {Telegram,TelegramError} from '../src/telegram.js';
import {layoutMessage} from '../src/message-layout.js';
import {queueResultView} from '../src/result-views.js';
import {PrivacyFenceDatabase} from '../src/privacy-fence.js';

describe('Поведінка 1.11: згода, доставка, скасування та приватність',()=>{
  let db:TestDB,h:ReturnType<typeof harness>,dir:string,c:ToolContext;
  before(async()=>{db=new TestDB();await db.init();dir=await mkdtemp(join(tmpdir(),'lumen-state111-'));});
  after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
  beforeEach(async()=>{
    await db.reset();h=harness(db);h.config.runtimeDir=dir;
    await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',open_group=true,participants=$1",[JSON.stringify([{id:'11',name:'Саша'},{id:'22',name:'Олена'}])]);
    await db.query("INSERT INTO members(user_id,name) VALUES('11','Саша'),('22','Олена')");
    const source=await one(db,"INSERT INTO messages(user_id,author,role,body) VALUES('11','Саша','user','Почни коротку пригоду') RETURNING id");
    c={actorId:'11',chatId:'-100',topicId:'0',revision:0,sourceId:Number(source!.id),updateId:randomUUID(),requested:true,requestText:'Почни коротку пригоду'};
  });
  const delivery=()=>new Delivery(db,h.tg as unknown as Telegram,h.config);
  const launch=async()=>{
    const v=await db.tx(sql=>openInteraction(sql,{title:'Коротка пригода',kind:'activity',scope:'invited',participant_ids:['11','22'],question:'Почнемо?',options:[]},c,{launch:{kind:'start_game',game:'story'},autoAccept:true}));
    return db.tx(sql=>answerInteraction(sql,{id:v.id,version:v.version,decision:'agree'},{...c,actorId:'22'}));
  };
  const compositionPlan=(first:any)=>({title:'Наш вибір',purpose:'Разом обрати напрям пригоди',promised_experience:'Кожен вплине на наступний крок',first_move:'Зробіть власний вибір',completion:'Підсумок доставлений учасникам',steps:[first,...(first.kind==='result'?[]:[{id:'finish',kind:'result',depends_on:[first.id],instruction:'Результат збережено.'}])]});
  const composition=async(first:any)=>{
    const tools=new AgentTools(db,h.config,h.brain);
    const run=await tools.execute('composition.create',compositionPlan(first),{...c,personal:true});
    assert.equal(run.status,'running');
    const worker=new CompositionWorker(db,h.config,h.brain,(name,args,context)=>tools.execute(name,args,context),()=>tools.catalog());
    return {tools,run,worker};
  };
  const cancelRun=(tools:AgentTools,id:string)=>tools.execute('composition.cancel',{id},{...c,updateId:randomUUID()});

  it('скасована дія не надсилається й не блокує незалежну відповідь у черзі',async()=>{
    const owner=await db.tx(sql=>createCommitment(sql,{...c,kind:'document',spec:{name:'Чернетка.txt'},expectedResult:'telegram_receipt',phase:'executing'}));
    await queueText(db,'Скасований текст',0,'cancelled-first',false,{actorId:'11',actionId:owner.id});
    await queueText(db,'Актуальна відповідь',0,'valid-later',false,{actorId:'11'});
    await db.tx(sql=>cancelCommitment(sql,owner.id,'11',0));
    const d=delivery();await d.next();await d.next();
    assert.deepEqual(h.tg.sent.map(x=>x.text),['Актуальна відповідь']);
    assert.equal((await one(db,"SELECT status FROM outbox WHERE dedup_key='valid-later:0'"))!.status,'sent');
    assert.notEqual((await one(db,"SELECT status FROM outbox WHERE dedup_key='cancelled-first:0'"))!.status,'pending');
  });

  it('429 і незалежне забування зберігають безпечний повтор без дублів та блокування',async()=>{
    await queueText(db,'Збережений результат',0,'safe-retry',false,{actorId:'11'});
    h.tg.failure=new TelegramError('telegram_429',30);const d=delivery();await d.next();
    assert.equal((await one(db,'SELECT phase FROM effect_operations'))!.phase,'reserved');
    await db.tx(sql=>forgetPhrase(sql,'зовсім сторонній фрагмент'));
    await db.query('UPDATE outbox SET available_at=now()');h.tg.failure=undefined;
    await queueText(db,'Наступна відповідь',1,'after-forget',false,{actorId:'11'});
    await d.next();await d.next();await d.next();
    assert.deepEqual(h.tg.sent.map(x=>x.text),['Збережений результат','Наступна відповідь']);
    assert.ok((await db.query('SELECT phase,revision FROM effect_operations')).rows.every(x=>x.phase==='observed'&&x.revision===1));
  });

  it('після скасування композиції її підготовлене опитування не запускається',async()=>{
    const {tools,run,worker}=await composition({id:'vote',kind:'poll',question:'Куди рушимо?',options:['Міст','Ліс']});
    await worker.next();assert.equal((await one(db,"SELECT status FROM outbox WHERE kind='poll'"))!.status,'pending');
    assert.equal((await cancelRun(tools,run.id)).changed,true);
    await delivery().next();
    assert.equal(h.tg.polls.length,0);
    assert.equal((await one(db,'SELECT phase FROM composition_runs WHERE id=$1',[run.id]))!.phase,'cancelled');
    await queueText(db,'Продовжуємо розмову',0,'after-composition-cancel');await delivery().next();
    assert.equal(h.tg.sent.at(-1)!.text,'Продовжуємо розмову');
  });

  it('підготовлений підсумок не доходить після скасування і не оголошує успіх',async()=>{
    const {tools,run,worker}=await composition({id:'finish',kind:'result',instruction:'Цей підсумок уже скасований.'});
    await worker.next();assert.equal((await one(db,'SELECT phase FROM composition_runs WHERE id=$1',[run.id]))!.phase,'delivering');
    await cancelRun(tools,run.id);await delivery().next();
    assert.equal(h.tg.sent.length,0);
    assert.equal((await one(db,'SELECT phase FROM composition_runs WHERE id=$1',[run.id]))!.phase,'cancelled');
    assert.equal((await one(db,"SELECT phase FROM commitments WHERE kind='activity_launch'"))!.phase,'cancelled');
  });

  it('незалежне забування не залишає живу композицію в недосяжній ревізії',async()=>{
    const {run,worker}=await composition({id:'finish',kind:'result',instruction:'Безпечний підсумок.'});
    await db.tx(sql=>forgetPhrase(sql,'стороння тема для видалення'));
    const live=await state(db),saved=await one(db,'SELECT revision FROM composition_runs WHERE id=$1',[run.id]);
    assert.equal(saved!.revision,live.memory_revision);
    assert.equal(await worker.next(),true);await delivery().next();
    assert.deepEqual(h.tg.sent.map(x=>x.text),['Безпечний підсумок.']);
    assert.equal((await one(db,'SELECT phase FROM composition_runs WHERE id=$1',[run.id]))!.phase,'completed');
  });

  it('погоджена пропозиція інструмента виконує збережений крок і завершується лише після доставки',async()=>{
    h.brain.replies.push({reply:'',actions:[],behavior:{move:'offer',recipient:'bot',relation:'new_request',reason:'Спільний файл збереже узгоджений план.'},offer:{title:'Наш короткий план',reason:'Ви попросили спільну корисну дію.',value:'План залишиться файлом у чаті.',scale:'Один короткий текстовий файл.',first_step:'Створю файл з трьома погодженими пунктами.',scope:'invited',participant_ids:['11','22'],action:{kind:'tool',name:'artifact.create',arguments:JSON.stringify({name:'Наш_план.txt',content:'Прогулянка. Чай. Спільний вечір.'})}}});
    await h.lumen.receive(message('Люмен, запропонуй нам коротку корисну дію'));await h.lumen.processNext();
    const root=await one(db,"SELECT id FROM interactions WHERE kind='activity'");assert.ok(root);
    assert.equal((await db.query('SELECT id FROM agent_artifacts')).rows.length,0);
    await h.lumen.receive(message('Так'));await h.lumen.receive(message('Так',22));
    const seed=await one(db,"SELECT plan FROM inbox WHERE status='pending'");assert.equal(seed!.plan.actions[0].name,'artifact.create');
    h.brain.replies.push({reply:'Файл надіслано.',actions:[],behavior:{move:'answer',recipient:'bot',relation:'accept_offer',reference_id:root!.id,reason:'Підготовлений файл очікує реальної доставки.'}});
    await h.lumen.processNext();
    assert.equal((await one(db,'SELECT content FROM agent_artifacts'))!.content,'Прогулянка. Чай. Спільний вечір.');
    assert.equal((await db.query("SELECT id FROM tool_runs WHERE tool='artifact.create' AND status='succeeded'")).rows.length,1);
    assert.equal(h.brain.calls.length,2);
    assert.equal(JSON.parse(h.brain.calls[1]!.context).tool_results_untrusted[0].result.status,'queued_for_delivery');
    const queued=await one(db,"SELECT body FROM outbox WHERE dedup_key LIKE 'answer:%' ORDER BY id DESC LIMIT 1");
    assert.match(queued!.body.text,/чергу/);assert.doesNotMatch(queued!.body.text,/Файл надіслано/);
    assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[root!.id]))!.phase,'delivering');
    const d=delivery();await d.next('media');
    for(let i=0;i<10;i++)await d.next('text');
    assert.equal((await one(db,"SELECT status FROM outbox WHERE kind='artifact'"))!.status,'sent');
    assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[root!.id]))!.phase,'completed');
    assert.equal((await interactionView(db,root!.id)).phase,'resolved');
  });

  it('повторне надходження готового етапу й відновлення створюють одне виконання',async()=>{
    const ready=await launch();
    await db.tx(sql=>enqueueInteraction(sql,ready,c));await db.tx(sql=>enqueueInteraction(sql,ready,c));
    assert.equal((await db.query('SELECT id FROM action_work')).rows.length,1);
    assert.equal((await db.query('SELECT update_id FROM inbox')).rows.length,1);
    await db.query('DELETE FROM inbox');
    await recoverActionWork(db);await recoverActionWork(db);
    assert.equal((await db.query('SELECT update_id FROM inbox')).rows.length,1);
    const work=await one(db,'SELECT * FROM action_work');
    assert.equal((await one(db,'SELECT payload FROM inbox'))!.payload.actionWorkId,work!.id);
  });

  it('відкликана остання згода зупиняє виконання, повторна згода поновлює той самий дозвіл',async()=>{
    const ready=await launch();await db.tx(sql=>enqueueInteraction(sql,ready,c));
    const work=await one(db,'SELECT id FROM action_work');await db.tx(sql=>claimActionWork(sql,work!.id,0));
    await db.tx(sql=>answerInteraction(sql,{id:ready.id,version:1,decision:'decline'},{...c,actorId:'22'}));
    const revoked=await interactionView(db,ready.id);assert.equal(revoked.phase,'collecting');assert.deepEqual(revoked.pending,['22']);
    await assert.rejects(()=>db.tx(async sql=>{const op=await reserveEffect(sql,{...c,key:'revoked-launch',arguments:{kind:'start_game'},actionId:ready.id});await claimEffect(sql,op.id,0);}),/action_unavailable|task_cancelled/);
    const renewed=await db.tx(sql=>answerInteraction(sql,{id:ready.id,version:1,decision:'agree'},{...c,actorId:'22'}));
    await db.tx(sql=>enqueueInteraction(sql,renewed,c));
    assert.equal((await db.query('SELECT id FROM action_work')).rows.length,1);
    assert.equal((await one(db,'SELECT status FROM action_work'))!.status,'pending');
  });

  it('модель не завершує незапущену гру й згода не переноситься на іншу дію',async()=>{
    const ready=await launch();
    await assert.rejects(()=>db.tx(sql=>finishInteraction(sql,ready.id,1,c,'Гру завершено.')),/activity_result_requires_adapter_proof/);
    assert.equal((await db.query('SELECT id FROM games')).rows.length,0);
    const another=await db.tx(sql=>launchConsent(sql,{kind:'start_game',game:'debate'},{...c,interactionId:ready.id},'Дебати'));
    assert.equal(another.allowed,false);assert.notEqual(another.interaction!.id,ready.id);
  });

  it('невизначений зовнішній результат після рестарту не надсилається повторно',async()=>{
    const owner=await db.tx(sql=>createCommitment(sql,{...c,kind:'file',spec:{name:'A.txt'},expectedResult:'telegram_receipt',phase:'executing'}));
    const op=await db.tx(async sql=>{const r=await reserveEffect(sql,{...c,key:'outbox:interrupted:0',arguments:{kind:'text',body:{text:'Можливо вже доставлено',actionId:owner.id}},actionId:owner.id});await claimEffect(sql,r.id,0);return r;});
    await queueText(db,'Можливо вже доставлено',0,'interrupted',false,{actorId:'11',actionId:owner.id});
    await db.tx(recoverDispatches);await delivery().next();
    assert.equal(h.tg.sent.length,0);
    assert.equal((await one(db,'SELECT phase FROM effect_operations WHERE id=$1',[op.id]))!.phase,'uncertain');
    assert.notEqual((await one(db,"SELECT status FROM outbox WHERE dedup_key='interrupted:0'"))!.status,'pending');
    await queueText(db,'Нове питання',0,'independent');await delivery().next();assert.equal(h.tg.sent.at(-1)!.text,'Нове питання');
  });

  it('явна команда власника повторює невизначену доставку окремою спробою',async()=>{
    await queueText(db,'Результат для повтору',0,'manual-retry',false,{actorId:'11'});
    const d=delivery();h.tg.failure=new TelegramError('telegram_network',0,true);await d.next();h.tg.failure=undefined;
    const original=await one(db,"SELECT id,operation_id FROM outbox WHERE dedup_key='manual-retry:0'");
    await h.lumen.receive(message('/retry '+original!.id));
    for(let i=0;i<6;i++)await d.next();
    assert.equal(h.tg.sent.filter(x=>x.text==='Результат для повтору').length,1);
    assert.equal((await one(db,'SELECT phase FROM effect_operations WHERE id=$1',[original!.operation_id]))!.phase,'uncertain');
  });

  it('доставка службового тексту не завершує дію, якщо сам файл не доставлений',async()=>{
    const owner=await db.tx(sql=>createCommitment(sql,{...c,kind:'file',spec:{name:'План.txt'},expectedResult:'delivery_confirmed',phase:'executing'}));
    const tools=new AgentTools(db,h.config,h.brain);
    const artifact=await tools.execute('artifact.create',{name:'План.txt',content:'Погоджений план.'},{...c,actionId:owner.id});
    await queueText(db,'Файл підготовлено, доставка ще очікується.',0,'file-queue-status',false,{actorId:'11',actionId:owner.id});
    await db.query("UPDATE commitments SET phase='delivering' WHERE id=$1",[owner.id]);
    const d=delivery();h.tg.failure=new TelegramError('telegram_403');await d.next('media');h.tg.failure=undefined;
    assert.equal((await one(db,"SELECT status FROM outbox WHERE kind='artifact' AND body->>'id'=$1",[artifact.id]))!.status,'failed');
    await d.next('text');
    assert.notEqual((await one(db,'SELECT phase FROM commitments WHERE id=$1',[owner.id]))!.phase,'completed');
  });

  it('Докладніше зберігає приватність при відмові ephemeral API і не викликає модель',async()=>{
    const panelId=randomUUID();await db.query("INSERT INTO message_panels(id,actor_id,audience,topic_id,pages,revision,provenance_version) VALUES($1,'11','private','0',$2,0,2)",[panelId,JSON.stringify(['Особистий збережений матеріал'])]);
    const request={panelId,index:0,actorId:'11',topicId:'0',callbackId:'private-detail',updateId:1001};
    await db.tx(sql=>queueResultView(sql,request));await db.tx(sql=>queueResultView(sql,request));
    assert.equal((await db.query("SELECT id FROM outbox WHERE kind='panel'")).rows.length,1);
    h.tg.call=async(method:string,body:any={})=>{h.tg.calls.push({method,body});throw new TelegramError('telegram_400',0,false);};
    await delivery().next();
    assert.deepEqual(h.tg.sent,[{chatId:'11',text:'Особистий збережений матеріал'}]);
    assert.equal(h.brain.calls.length,0);
    assert.equal((await db.query("SELECT id FROM messages WHERE role='assistant'")).rows.length,0);
  });

  it('невизначена доставка Докладніше не породжує запасної публічної копії',async()=>{
    const panelId=randomUUID();await db.query("INSERT INTO message_panels(id,actor_id,audience,topic_id,pages,revision,provenance_version) VALUES($1,'11','private','0',$2,0,2)",[panelId,JSON.stringify(['Особистий матеріал'])]);
    await db.tx(sql=>queueResultView(sql,{panelId,index:0,actorId:'11',topicId:'0',callbackId:'uncertain-detail',updateId:1002}));
    h.tg.call=async(method:string,body:any={})=>{h.tg.calls.push({method,body});throw new TelegramError('telegram_network',0,true);};
    const d=delivery();await d.next();await d.next();
    assert.equal(h.tg.sent.length,0);assert.equal(h.tg.calls.length,1);
    assert.equal((await one(db,"SELECT status FROM outbox WHERE kind='panel'"))!.status,'uncertain');
  });

  it('втрата доступу між кнопкою і доставкою пояснюється без розкриття вмісту',async()=>{
    const panelId=randomUUID();await db.query("INSERT INTO message_panels(id,actor_id,audience,topic_id,pages,revision,provenance_version) VALUES($1,'11','private','0',$2,0,2)",[panelId,JSON.stringify(['Цей секрет показувати не можна'])]);
    await db.tx(sql=>queueResultView(sql,{panelId,index:0,actorId:'11',topicId:'0',callbackId:'expired-after-click',updateId:1003}));
    await db.query("UPDATE message_panels SET expires_at=now()-interval '1 second' WHERE id=$1",[panelId]);await delivery().next();
    const payload=JSON.stringify({sent:h.tg.sent,calls:h.tg.calls});assert.match(payload,/недоступний/);assert.doesNotMatch(payload,/Цей секрет/);
    assert.equal(h.brain.calls.length,0);
  });

  it('фрагмент лише у згенерованих деталях видаляється разом із доступом старої кнопки',async()=>{
    await db.tx(sql=>layoutMessage(sql,'Короткий виклад',{card:{title:'Дослідження',summary:'Короткий виклад',facts:[],question:'',details:'Унікальний згенерований фрагмент'}},{actorId:'11',topicId:'0',revision:0,key:'derived-only',sourceId:c.sourceId}));
    const panel=await one(db,'SELECT id FROM message_panels');assert.ok(panel);
    await db.tx(sql=>forgetPhrase(sql,'згенерований фрагмент'));
    assert.equal((await db.query('SELECT id FROM message_panels')).rows.length,0);
    assert.equal((await db.query('SELECT id FROM messages WHERE id=$1',[c.sourceId])).rows.length,1);
    const read=await db.tx(sql=>queueResultView(sql,{panelId:panel!.id,index:0,actorId:'11',topicId:'0',callbackId:'forgotten-detail',updateId:1004}));
    assert.equal(read.notice,true);await delivery().next();assert.doesNotMatch(JSON.stringify(h.tg.calls),/Унікальний/);
  });

  it('старіша резервна копія не повертає забуті дані перед наступним читанням',async()=>{
    const directory=join(dir,randomUUID()),namespace='group-test-fence';
    const fenced=await PrivacyFenceDatabase.open(db,directory,namespace);
    await fenced.tx(eraseAll);const epoch=(await state(fenced)).memory_revision;
    // Restore old rows through the underlying database, as a backup restore would.
    await db.query('UPDATE app_state SET memory_revision=0,paused=false');
    await db.query("INSERT INTO messages(user_id,author,role,body) VALUES('11','Саша','user','Забутий секрет зі старої копії')");
    await queueText(db,'Старий підготовлений секрет',0,'restored-outbox');
    const reopened=await PrivacyFenceDatabase.open(db,directory,namespace);
    assert.equal((await reopened.query('SELECT id FROM messages')).rows.length,0);
    assert.equal((await reopened.query('SELECT id FROM outbox')).rows.length,0);
    const restoredState=await state(reopened);assert.equal(restoredState.paused,true);assert.equal(restoredState.memory_revision,epoch);
    const files=await readdir(join(directory,'privacy-fences'));const manifest=await readFile(join(directory,'privacy-fences',files[0]!), 'utf8');
    assert.deepEqual(JSON.parse(manifest),{version:1,epoch});assert.doesNotMatch(manifest,/секрет|Саша|group-test-fence/);
  });

  it('збій commit після запису privacy fence повторно очищує стару БД перед доступом',async()=>{
    let rejectCommit=false;
    const failpoint:Database={query:(q,a)=>db.query(q,a),close:async()=>{},tx:fn=>db.tx(async sql=>{const result=await fn(sql);if(rejectCommit){rejectCommit=false;throw Error('simulated_commit_failure');}return result;})};
    const fenced=await PrivacyFenceDatabase.open(failpoint,join(dir,randomUUID()),'commit-failpoint');
    rejectCommit=true;await assert.rejects(()=>fenced.tx(eraseAll),/simulated_commit_failure/);
    assert.equal((await db.query('SELECT id FROM messages')).rows.length,1);
    // The write-ahead fence survived; the next public database read repairs the rollback.
    assert.equal((await fenced.query('SELECT id FROM messages')).rows.length,0);
    assert.equal((await state(fenced)).paused,true);assert.equal((await state(fenced)).memory_revision,1);
  });
});
