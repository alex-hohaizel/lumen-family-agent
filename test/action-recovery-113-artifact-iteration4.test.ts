import {describe,it,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {AgentTools,boundArtifactDelivery} from '../src/agent-tools.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {Delivery} from '../src/delivery.js';
import {one} from '../src/db.js';
import {interactionView} from '../src/interactions.js';
import {TestDB,harness,message} from './helpers.js';

describe('1.13 iteration4 returned artifact delivery and linked approval scope',()=>{
  const db=new TestDB();let h:ReturnType<typeof harness>;
  before(async()=>{await db.init();});beforeEach(async()=>{await db.reset();h=harness(db);await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',open_group=true,participants=$1",[JSON.stringify([{id:'11',name:'Саша'},{id:'22',name:'Олена'}])]);await db.query("INSERT INTO members(user_id,name) VALUES('11','Саша'),('22','Олена')");});after(async()=>{await db.close();});
  const delivery=()=>new Delivery(db,h.tg as any,h.config);
  async function offer(name='artifact.create',args:unknown={name:'Наш_план.txt',content:'Прогулянка. Чай. Спільний вечір.'}){
    h.brain.replies.push({reply:'',actions:[],behavior:{move:'offer',recipient:'bot',relation:'new_request',reason:'Спільний файл збереже узгоджений план.'},offer:{title:'Наш короткий план',reason:'Ви попросили спільну корисну дію.',value:'План залишиться файлом у чаті.',scale:'Один короткий текстовий файл.',first_step:'Створю файл з трьома погодженими пунктами.',scope:'invited',participant_ids:['11','22'],action:{kind:'tool',name,arguments:JSON.stringify(args)}}});
    await h.lumen.receive(message('Люмен, запропонуй нам коротку корисну дію'));await h.lumen.processNext();
    const root=await one(db,"SELECT id FROM interactions WHERE kind='activity'");assert.ok(root);
    await h.lumen.receive(message('Так'));await h.lumen.receive(message('Так',22));
    const seed=await one(db,"SELECT update_id,payload,plan FROM inbox WHERE status='pending'");assert.ok(seed);return {root:root.id,seed};
  }
  it('a consented TXT waits in delivering until the actual file receipt; text cannot finish it',async()=>{
    const {root,seed}=await offer();let enqueuePhase='';
    h.brain.block=async()=>{enqueuePhase=String((await one(db,'SELECT phase FROM commitments WHERE id=$1',[root]))?.phase);return {reply:'Файл надіслано.',actions:[]};};
    await h.lumen.processNext();assert.equal(enqueuePhase,'delivering');assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[root]))?.phase,'delivering');
    const output=await one(db,"SELECT * FROM outbox WHERE kind='artifact'");assert.ok(output);assert.equal(output.status,'pending');assert.equal(output.body.actionId,root);assert.equal((await one(db,'SELECT content FROM agent_artifacts'))?.content,'Прогулянка. Чай. Спільний вечір.');
    const scope={actionId:root,actorId:'11',topicId:'0',revision:0,sourceId:Number(seed.payload.sourceId),audience:'group' as const};assert.ok(await boundArtifactDelivery(db,scope));
    for(const invalid of [{actorId:'22'},{topicId:'7'},{revision:1},{sourceId:scope.sourceId+1},{audience:'private' as const}])assert.equal(await boundArtifactDelivery(db,{...scope,...invalid}),undefined);
    const queued=await one(db,"SELECT body FROM outbox WHERE dedup_key LIKE 'answer:%' ORDER BY id DESC LIMIT 1");assert.match(queued?.body.text,/(?:ще триває|ще готу|очіку|чергу)/u);assert.doesNotMatch(queued?.body.text,/Файл надіслано/u);
    const d=delivery();for(let n=0;n<8;n++)await d.next('text');assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[root]))?.phase,'delivering');
    assert.equal(await d.next('media'),true);assert.equal((await one(db,"SELECT status FROM outbox WHERE kind='artifact'"))?.status,'sent');assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[root]))?.phase,'completed');assert.equal((await interactionView(db,root)).phase,'resolved');
  });
  it('a file delivered during replanning stays completed when the foreground worker finishes',async()=>{
    const {root,seed}=await offer();let deliveredBeforeFinish=false;
    h.brain.block=async()=>{
      assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[root]))?.phase,'delivering');assert.equal((await one(db,'SELECT status FROM action_work WHERE action_id=$1',[root]))?.status,'running');
      assert.equal(await delivery().next('media'),true);assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[root]))?.phase,'completed');deliveredBeforeFinish=true;return {reply:'Файл надіслано.',actions:[]};
    };
    await h.lumen.processNext();assert.equal(deliveredBeforeFinish,true);assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[root]))?.phase,'completed');assert.equal((await one(db,'SELECT status FROM action_work WHERE action_id=$1',[root]))?.status,'done');assert.equal((await one(db,'SELECT status FROM inbox WHERE update_id=$1',[seed.update_id]))?.status,'done');assert.equal((await db.query("SELECT id FROM tool_runs WHERE tool='artifact.create' AND status='succeeded'")).rows.length,1);assert.equal((await db.query('SELECT id FROM agent_artifacts')).rows.length,1);assert.equal(await h.lumen.processNext(),false);
  });
  it('a queued tool string without an actual bound artifact remains executing',async()=>{
    (h.lumen as any).tools.add('qa.queued',{description:'Контроль очікування без файла',schema:z.object({}),run:async()=>({id:'unbound',status:'queued_for_delivery'})});
    const {root}=await offer('qa.queued',{});h.brain.replies.push({reply:'Робота ще триває.',actions:[]});await h.lumen.processNext();assert.equal((await db.query('SELECT id FROM agent_artifacts')).rows.length,0);assert.equal((await db.query("SELECT id FROM outbox WHERE kind='artifact'")).rows.length,0);assert.equal((await one(db,'SELECT phase FROM commitments WHERE id=$1',[root]))?.phase,'executing');
  });
  it('CTI01 legacy group approval for a private task expires only in the owner DM with current task envelope',async()=>{
    const update=message('Люмен, підготуй особисту погоджену дію');update.message!.message_thread_id=7;await h.lumen.receive(update);const source=await one(db,"SELECT id FROM messages WHERE telegram_id=$1 AND role='user'",[update.message!.message_id]);assert.ok(source);
    const tools=new AgentTools(db,h.config,h.brain),ctx={actorId:'11',chatId:'-100',topicId:'7',revision:0,sourceId:Number(source.id),requested:true,audience:'private' as const,updateId:'linked-private-expiry'};let calls=0;
    (tools as any).add('qa.expiring',{description:'Погоджувана особиста дія',effect:true,schema:z.object({value:z.number()}),run:async()=>{calls++;return {status:'completed'};}});
    const task=await tools.execute('tasks.create',{title:'Особиста дія',goal:'Виконати погоджене'},ctx);await db.query("UPDATE agent_tasks SET status='waiting' WHERE id=$1",[task.id]);
    const pending=await tools.execute('qa.expiring',{value:7},{...ctx,taskId:task.id,goalVersion:1});assert.ok(pending.approval_id);await db.query('DELETE FROM outbox');await db.query("UPDATE tool_approvals SET audience='group',expires_at=now()-interval '1 second' WHERE id=$1",[pending.approval_id]);
    const runner=new AgentTasks(db,h.config,h.brain);await runner.next();await runner.next();assert.equal(calls,0);const notices=(await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'approval-expired:%'")).rows;assert.equal(notices.length,1);const notice=notices[0]!;assert.equal(notice.audience,'private');assert.equal(notice.actor_id,'11');assert.equal(notice.revision,0);assert.equal(Number(notice.source_message_id),Number(source.id));assert.equal(notice.body.taskId,task.id);assert.equal(notice.body.goalVersion,1);assert.equal(String(notice.body.scopeTopicId||notice.body.threadId),'7');assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[task.id]))?.status,'needs_input');
    const d=delivery();for(let n=0;n<8;n++)await d.next();const sent=h.tg.sent.filter(row=>row.text.includes('Час підтвердження дії минув'));assert.equal(sent.length,1);assert.equal(sent[0]!.chatId,'11');assert.equal(h.tg.sent.some(row=>row.chatId==='-100'&&row.text.includes('Час підтвердження')),false);
  });
});
