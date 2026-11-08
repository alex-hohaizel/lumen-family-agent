import {afterEach,beforeEach,describe,it,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {TestDB,harness,paired} from './helpers.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {one} from '../src/db.js';
import {ToolError} from '../src/safe-http.js';
import type {ToolContext} from '../src/agent-tools.js';

describe('Durable task handling after bounded resource refusal',()=>{
  let db:TestDB,h:ReturnType<typeof harness>,worker:AgentTasks;
  beforeEach(async()=>{db=new TestDB();await db.init();h=harness(db);await paired(h);worker=new AgentTasks(db,h.config,h.brain);});
  afterEach(async()=>{mock.restoreAll();await db.close();});

  async function task(audience:'group'|'private'='private'){
    const id=randomUUID(),source=await one(db,"INSERT INTO messages(user_id,author,role,body,topic_id) VALUES('11','Synthetic','user','Synthetic request without external work','7') RETURNING id");
    await db.query("INSERT INTO agent_tasks(id,dedup_key,actor_id,topic_id,title,goal,revision,source_message_id,available_at,deadline,criteria,audience) VALUES($1,$2,'11','7','Synthetic private title','Synthetic goal',0,$3,now()-interval '1 second',now()+interval '30 minutes','[]',$4)",[id,'task:'+id,source!.id,audience]);
    return {id,sourceId:Number(source!.id)};
  }
  function definition(name:string,run:()=>Promise<unknown>,effect=false){
    // Only the tool implementation is fake; real AgentTools auditing/claims and task lifecycle run.
    (worker.tools as any).definitions.set(name,{description:'Synthetic local resource control',schema:z.object({}),effect,run});
  }
  const action=(name:string)=>({kind:'tool' as const,name,arguments:'{}'});
  async function taskResults(id:string){return (await db.query("SELECT * FROM outbox WHERE dedup_key LIKE $1",['task-result:'+id+':%'])).rows;}

  for(const code of ['worker_memory_busy','worker_queue_busy','worker_queue_timeout','browser_busy']){
    it(`${code} retains the task, stops remaining tools and does not auto-plan another step`,async()=>{
      const job=await task();let refused=0,following=0;
      definition('qa.refuse',async()=>{refused++;throw new ToolError(code);});
      definition('qa.following',async()=>{following++;return {ok:true};});
      h.brain.replies.push({reply:'',actions:[action('qa.refuse'),action('qa.following')]});
      const logs=mock.method(console,'log',()=>{});
      assert.equal(await worker.next(),true);
      const saved=(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[job.id]))!;
      assert.equal(saved.status,'needs_input');assert.equal(saved.error_code,code);assert.equal(saved.step,0);
      assert.match(saved.result,/Призупинив завдання.*брак вільних ресурсів/u);assert.match(saved.result,/автоматично не повторюватиму/u);
      assert.equal(refused,1);assert.equal(following,0);assert.equal(h.brain.calls.length,1);
      assert.equal(await worker.next(),false);assert.equal(h.brain.calls.length,1);assert.equal(refused,1);
      const runs=(await db.query('SELECT status,error_code FROM tool_runs WHERE task_id=$1',[job.id])).rows;
      assert.deepEqual(runs,[{status:'failed',error_code:code}]);
      const outbound=await taskResults(job.id);assert.ok(outbound.length>0);assert.ok(outbound.every(row=>row.audience==='private'&&row.actor_id==='11'));
      const events=logs.mock.calls.map(call=>JSON.parse(String(call.arguments[0]))).filter(event=>event.event==='background_task_step');
      assert.deepEqual(events,[{event:'background_task_step',phase:'started',step:0},{event:'background_task_step',phase:'resource_blocked',step:0}]);
      assert.ok(!JSON.stringify(events).includes(job.id));assert.ok(!JSON.stringify(events).includes('Synthetic'));
    });
  }

  for(const change of ['cancel','new_goal','pause','revision'] as const){
    it(`does not overwrite the ${change} fence when a resource refusal arrives late`,async()=>{
      const job=await task();definition('qa.refuse',async()=>{
        if(change==='cancel')await db.query("UPDATE agent_tasks SET status='cancelled' WHERE id=$1",[job.id]);
        if(change==='new_goal')await db.query("UPDATE agent_tasks SET goal_version=goal_version+1,status='pending',goal='New synthetic goal' WHERE id=$1",[job.id]);
        if(change==='pause')await db.query('UPDATE app_state SET paused=true');
        if(change==='revision')await db.query('UPDATE app_state SET memory_revision=memory_revision+1');
        throw new ToolError('worker_memory_busy');
      });h.brain.replies.push({reply:'',actions:[action('qa.refuse')]});mock.method(console,'log',()=>{});
      assert.equal(await worker.next(),true);
      const saved=(await one(db,'SELECT * FROM agent_tasks WHERE id=$1',[job.id]))!;
      assert.notEqual(saved.status,'needs_input');assert.equal(saved.error_code,null);assert.equal((await taskResults(job.id)).length,0);
      assert.equal((await db.query("SELECT * FROM task_events WHERE task_id=$1 AND kind='needs_input'",[job.id])).rows.length,0);
      if(change==='cancel')assert.equal(saved.status,'cancelled');
      if(change==='new_goal'){assert.equal(saved.status,'pending');assert.equal(saved.goal_version,2);assert.equal(saved.goal,'New synthetic goal');}
    });
  }

  it('uses newly narrowed private audience for the resource notice',async()=>{
    const job=await task('group');definition('qa.refuse',async()=>{await db.query("UPDATE agent_tasks SET audience='private' WHERE id=$1",[job.id]);throw new ToolError('worker_memory_busy');});
    h.brain.replies.push({reply:'',actions:[action('qa.refuse')]});mock.method(console,'log',()=>{});
    await worker.next();const results=await taskResults(job.id);assert.ok(results.length>0);assert.ok(results.every(row=>row.audience==='private'));
  });

  it('preserves an approval and claimed effect as uncertain after resource refusal',async()=>{
    const job=await task();definition('qa.effect',async()=>{throw new ToolError('worker_memory_busy');},true);
    const context:ToolContext={actorId:'11',chatId:'-100',topicId:'7',revision:0,sourceId:job.sourceId,updateId:'synthetic-approval',requested:true,taskId:job.id,goalVersion:1,audience:'private'};
    const pending=await worker.tools.execute('qa.effect',{},context);assert.equal(pending.needs_approval,true);
    await db.query("UPDATE tool_approvals SET status='approved' WHERE id=$1",[pending.approval_id]);
    await db.query("UPDATE agent_tasks SET status='waiting' WHERE id=$1",[job.id]);mock.method(console,'log',()=>{});
    assert.equal(await worker.next(),true);
    assert.equal((await one(db,'SELECT status FROM tool_approvals WHERE id=$1',[pending.approval_id]))!.status,'uncertain');
    assert.equal((await one(db,'SELECT status FROM tool_runs WHERE task_id=$1',[job.id]))!.status,'uncertain');
    const effects=(await db.query("SELECT phase FROM effect_operations WHERE operation_key LIKE 'tool:%'")).rows;
    assert.ok(effects.length>0);assert.ok(effects.every(row=>row.phase==='uncertain'));
    assert.equal((await one(db,'SELECT status FROM agent_tasks WHERE id=$1',[job.id]))!.status,'needs_input');
    assert.equal(await worker.next(),false);assert.equal(h.brain.calls.length,0);
  });

  it('keeps ordinary non-resource tool-error recovery unchanged',async()=>{
    const job=await task();let following=0;
    definition('qa.fail',async()=>{throw new ToolError('synthetic_read_failed');});definition('qa.following',async()=>{following++;return {ok:true};});
    h.brain.replies.push({reply:'',actions:[action('qa.fail'),action('qa.following')]});mock.method(console,'log',()=>{});
    await worker.next();const saved=(await one(db,'SELECT status,step FROM agent_tasks WHERE id=$1',[job.id]))!;
    assert.equal(saved.status,'pending');assert.equal(saved.step,1);assert.equal(following,1);
  });

  it('does not let a broken telemetry logger change durable resource handling',async()=>{
    const job=await task();definition('qa.refuse',async()=>{throw new ToolError('worker_memory_busy');});h.brain.replies.push({reply:'',actions:[action('qa.refuse')]});
    mock.method(console,'log',()=>{throw Error('synthetic_logger_failure');});
    assert.equal(await worker.next(),true);assert.equal((await one(db,'SELECT status,error_code FROM agent_tasks WHERE id=$1',[job.id]))!.status,'needs_input');
  });
});
