import {after,before,beforeEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {one} from '../src/db.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {ChatActivity} from '../src/activity-status.js';
import {Delivery} from '../src/delivery.js';
import {outcomeMessage,toolOutcome} from '../src/outcomes.js';
import {TestDB,harness,paired,message} from './helpers.js';

describe('1.13 iteration4 addressed status, expiry and media-copy scopes',()=>{
  const db=new TestDB();let h:ReturnType<typeof harness>;
  before(async()=>{await db.init();});beforeEach(async()=>{await db.reset();h=harness(db);await paired(h);});after(async()=>{await db.close();});
  async function task(title:string,actor='11',topic='7',audience:'group'|'private'='group',result='Уточни місце зустрічі.'){
    const id=randomUUID();await db.query("INSERT INTO agent_tasks(id,dedup_key,actor_id,topic_id,title,goal,status,revision,audience,result,error_code) VALUES($1,$2,$3,$4,$5,'Підготувати відповідь','needs_input',0,$6,$7,'RAW_SECRET_ERROR_777')",[id,'scope:'+id,actor,topic,title,audience,result]);return id;
  }
  it('PM status return: group /tasks and natural status cannot expose private, other-topic or other-actor titles/results',async()=>{
    await task('PRIVATE TITLE','11','7','private','PRIVATE RESULT');await task('OTHER TOPIC','11','9');await task('OTHER ACTOR','22','7');const narrowed=await task('PRIVATE MEDIA TITLE');await db.query("INSERT INTO media_jobs(id,kind,resource_id,resource_version,manifest,manifest_hash,actor_id,topic_id,audience,revision,task_id,goal_version) VALUES($1,'story',$2,1,'{}','hash','11','7','private',0,$3,1)",[randomUUID(),randomUUID(),narrowed]);await task('Публічна справа');
    for(const text of ['/tasks','Люмен, що ти робиш?']){const update=message(text);update.message!.message_thread_id=7;await h.lumen.receive(update);const row=(await db.query("SELECT body,audience FROM outbox WHERE dedup_key LIKE 'fast-status:%' ORDER BY id DESC LIMIT 1")).rows[0]!;assert.equal(row.audience,'group');assert.match(row.body.text,/Публічна справа/u);assert.match(row.body.text,/Уточни місце/u);assert.doesNotMatch(row.body.text,/PRIVATE|OTHER|RAW_SECRET_ERROR/u);assert.equal(String(row.body.scopeTopicId||row.body.threadId),'7');}
    assert.equal(h.brain.calls.length,0);
  });
  it('normal direct private-DM status remains available only to the owner and current topic',async()=>{
    await db.query("UPDATE app_state SET chat_id='11' WHERE id=1");await task('Приватна справа','11','0','private','Підкажи адресу.');await task('HIDDEN OTHER TOPIC','11','7','private');await task('HIDDEN OTHER ACTOR','22','0','private');await h.lumen.receive(message('/tasks',11,11,'private'));
    const row=(await db.query("SELECT body,audience FROM outbox WHERE dedup_key LIKE 'fast-status:%' ORDER BY id DESC LIMIT 1")).rows[0]!;assert.equal(row.audience,'private');assert.match(row.body.text,/Приватна справа/u);assert.doesNotMatch(row.body.text,/HIDDEN|RAW_SECRET_ERROR/u);const d=new Delivery(db,h.tg as any,h.config);for(let i=0;i<4;i++)await d.next();assert.ok(h.tg.sent.some(x=>x.chatId==='11'&&x.text.includes('Приватна справа')));
  });
  it('CTI01: approval expiry preserves exact private/group audience, actor, logical topic and source once',async()=>{
    const approvals:{id:string;source:number;audience:string}[]=[];
    for(const audience of ['private','group']){const id=randomUUID(),source=Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,'11','Автор','user','Погоджена дія','7') RETURNING id",[audience==='private'?77001:77002])).rows[0]!.id);await db.query("INSERT INTO tool_approvals(id,actor_id,tool,arguments,argument_hash,summary,status,revision,topic_id,source_message_id,expires_at,audience) VALUES($1,'11','qa.action','{}','hash','PRIVATE APPROVAL LABEL','pending',0,'7',$2,now()-interval '1 second',$3)",[id,source,audience]);approvals.push({id,source,audience});}
    const runner=new AgentTasks(db,h.config,h.brain);await runner.next();await runner.next();const rows=(await db.query("SELECT dedup_key,body,audience,actor_id,source_message_id FROM outbox WHERE dedup_key LIKE 'approval-expired:%' ORDER BY id")).rows;assert.equal(rows.length,2);
    for(const approval of approvals){const row=rows.find(r=>r.dedup_key.includes(approval.id))!;assert.equal(row.audience,approval.audience);assert.equal(row.actor_id,'11');assert.equal(Number(row.source_message_id),approval.source);assert.equal(String(row.body.scopeTopicId||row.body.threadId),'7');assert.doesNotMatch(row.body.text,/PRIVATE APPROVAL LABEL|approval_expired/u);}
    const d=new Delivery(db,h.tg as any,h.config);for(let i=0;i<6;i++)await d.next();assert.ok(h.tg.sent.some(x=>x.chatId==='11'&&x.text.includes('Час підтвердження')));assert.ok(h.tg.sent.some(x=>x.chatId==='-100'&&x.text.includes('Час підтвердження')));
  });
  it('PM archive-copy: queued album is an album and queued story is a movie',()=>{
    assert.match(outcomeMessage([toolOutcome('archive.manage',{status:'queued',id:'album-job'})]),/альбом/u);assert.doesNotMatch(outcomeMessage([toolOutcome('archive.manage',{status:'queued',id:'album-job'})]),/ролик|MP4/u);assert.match(outcomeMessage([toolOutcome('studio.manage',{status:'queued',id:'story-job'})]),/ролик/u);
  });
  it('actual activity progress uses media job kind instead of calling every job a movie',async()=>{
    for(const [index,kind] of ['album','story','unknown'].entries()){
      const updateId=88000+index,source=Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,'11','Автор','user','Підготуй матеріали','7') RETURNING id",[updateId])).rows[0]!.id);await db.query("INSERT INTO inbox(update_id,payload,revision,status) VALUES($1,$2,0,'processing')",[updateId,JSON.stringify({sourceId:source,message:{from:{id:11},message_thread_id:7}})]);await db.query("INSERT INTO media_jobs(id,kind,resource_id,resource_version,manifest,manifest_hash,actor_id,topic_id,audience,revision,source_message_id) VALUES($1,$2,$3,1,'{}','hash','11','7','group',0,$4)",[randomUUID(),kind,randomUUID(),source]);
      const activity=new ChatActivity(db,h.tg as any,{intervalMs:60000,noticeAfterMs:0,deliveryGraceMs:10});try{await activity.begin({updateId,sourceId:source,revision:0,chatId:'-100',threadId:7,allowNotice:true,serious:false});await (activity as any).tick((activity as any).jobs.get(source));const text=String((await one(db,"SELECT body->>'text' AS text FROM outbox WHERE source_message_id=$1 AND dedup_key LIKE 'progress:%'",[source]))?.text||'');if(kind==='album'){assert.match(text,/Альбом/u);assert.doesNotMatch(text,/Ролик|MP4/u);}else if(kind==='story')assert.match(text,/Ролик/u);else{assert.match(text,/Матеріали/u);assert.doesNotMatch(text,/Ролик|Альбом/u);}}finally{await activity.stopAll();}
    }
  });
});
