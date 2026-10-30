import {it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ChatDatabase,ChatRegistry,schemaForChat,type RuntimeLane} from '../src/registry.js';
import {ChatRouter,type RuntimePolicy} from '../src/router.js';
import {cancelOperations,drainOperations,operationCount,runOperation} from '../src/operations.js';
import {state} from '../src/db.js';
import {TestDB,harness,FakeBrain,message} from './helpers.js';

// Count SQL at PGlite's PostgreSQL protocol boundary, below Database.query/tx.
// Parse (P) and simple-query (Q) frames include BEGIN/COMMIT and SET LOCAL,
// including the nested ChatDatabase/PrivacyFenceDatabase transaction overhead.
class PhysicalDB extends TestDB {
  statements:string[]=[];
  constructor(){
    super();
    const pg=this.pg as any,execute=pg.execProtocolRawSync.bind(pg);
    pg.execProtocolRawSync=(bytes:Uint8Array)=>{
      const frame=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      for(let offset=0;offset+5<=frame.length;){
        const type=String.fromCharCode(frame[offset]!),length=frame.readInt32BE(offset+1),end=offset+1+length;
        if(length<4||end>frame.length)break;
        if(type==='Q'||type==='P'){
          const start=type==='P'?frame.indexOf(0,offset+5)+1:offset+5,endSql=frame.indexOf(0,start);
          if(start>=offset+5&&endSql>=start)this.statements.push(frame.toString('utf8',start,endSql));
        }
        offset=end;
      }
      return execute(bytes);
    };
  }
  clear(){this.statements=[];}
}
const bot={id:999,username:'lumen_test_bot',can_read_all_group_messages:true};
const lanes:RuntimeLane[]=['conversation','delivery','media','automation','maintenance'];
function setup(db:PhysicalDB,policy:RuntimePolicy={}){
  const h=harness(db),registry=new ChatRegistry(db),brains=new Map<string,FakeBrain>();
  const router=new ChatRouter(registry,h.config,h.tg as any,bot,(_config,id)=>{const brain=new FakeBrain();brains.set(id,brain);return brain;},policy);
  return {...h,registry,router,brains};
}

it('1/10/100 idle chats: lazy startup, bounded physical SQL, and zero worker SQL between safety sweeps',async t=>{
  for(const count of [1,10,100])await t.test(String(count),async()=>{
    const db=new PhysicalDB();await db.init();let now=Date.now();
    const h=setup(db,{now:()=>now});await h.registry.init();
    try{
      // Deliberately old, partial tenant schemas: polling must discover their
      // existing durable work without migrating or constructing every tenant.
      for(let index=1;index<=count;index++){
        const chat=String(-1000-index),schema=schemaForChat(chat);
        await db.pg.exec(`CREATE SCHEMA "${schema}";CREATE TABLE "${schema}".app_state(id integer,paused boolean);INSERT INTO "${schema}".app_state VALUES(1,false);CREATE TABLE "${schema}".inbox(status text,available_at timestamptz);CREATE TABLE "${schema}".reminders(status text,due_at timestamptz);CREATE TABLE "${schema}".schema_version(version integer);INSERT INTO "${schema}".schema_version VALUES(1);`);
        await db.query('INSERT INTO public.lumen_chats(chat_id,schema_name,owner_id) VALUES($1,$2,$3)',[chat,schema,'11']);
      }
      db.clear();await h.router.init();
      assert.equal(h.router.all().length,0);assert.equal(h.brains.size,0);
      assert.equal(db.statements.some(sql=>sql.startsWith('SET LOCAL search_path')),false);
      db.clear();for(const lane of lanes)assert.deepEqual(await h.router.ready(lane),[]);
      const cold=db.statements.length;
      assert.equal(cold,1+count*6); // list + (BEGIN, enabled, catalog, SET, work, COMMIT)
      assert.equal(db.statements.filter(sql=>sql==='BEGIN').length,count);
      assert.equal(db.statements.filter(sql=>sql==='COMMIT').length,count);
      assert.equal(db.statements.filter(sql=>sql.startsWith('SET LOCAL')).length,count);
      db.clear();for(let tick=0;tick<20;tick++){for(const lane of lanes)await h.router.ready(lane);await h.router.evictIdle();}
      assert.equal(db.statements.length,0);assert.equal(h.router.all().length,0);
      now+=30001;db.clear();await h.router.sweep();
      const safety=db.statements.length;
      assert.equal(safety,1+count*5); // catalog retained; no hidden tenant transactions
      assert.equal(db.statements.some(sql=>/CREATE TABLE|schema_version WHERE version/.test(sql)),false);
      console.log(JSON.stringify({event:'runtime_lifecycle_112_physical_sql',chats:count,cold_sweep:cold,safety_sweep:safety,worker_ticks:20,between_sweeps:0,warm_runtimes:h.router.all().length,measurement:'PostgreSQL protocol SQL frames including BEGIN COMMIT SET LOCAL'}));
    }finally{await h.router.cancelAll();await db.close();}
  });
});

it('a new chat has one migration owner; concurrent lazy activation reuses its runtime',async()=>{
  const db=new PhysicalDB();await db.init();const h=setup(db);await h.router.init();
  try{
    db.clear();const chat=await h.registry.ensure('-2100','11','One group');
    const [a,b]=await Promise.all([h.router.runtime(chat),h.router.runtime(chat)]);
    assert.equal(a,b);assert.equal(h.router.all().length,1);
    assert.equal(db.statements.filter(sql=>sql.includes("to_regclass('schema_version')")).length,1);
    assert.equal((await state(a.db)).chat_id,'-2100');
    assert.equal((await a.db.query('SELECT count(*)::integer AS n FROM schema_version WHERE version BETWEEN 1 AND 15')).rows[0]!.n,15);
    db.clear();await new ChatDatabase(db,chat.schema_name).query('SELECT id FROM app_state WHERE id=1');
    assert.deepEqual(db.statements.map(sql=>sql==='BEGIN'||sql==='COMMIT'?sql:sql.split(' ')[0]),['BEGIN','SET','SELECT','COMMIT']);
  }finally{await h.router.cancelAll();await db.close();}
});

it('cache limits and inactivity evict drained runtimes, while operation leases and durable queues pin them',async()=>{
  const db=new PhysicalDB();await db.init();let now=Date.now();const h=setup(db,{maxWarm:2,idleMs:300000,now:()=>now});await h.router.init();
  try{
    const runtimes=[];
    for(const id of ['-2201','-2202','-2203']){now++;runtimes.push(await h.router.runtime(await h.registry.ensure(id,'11')));}
    await h.router.evictIdle();assert.equal(h.router.all().length,2);assert.equal(h.router.all().includes(runtimes[0]!),false);
    const held=runtimes[1]!;let release!:()=>void,started!:()=>void;
    const admitted=new Promise<void>(resolve=>{started=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
    const job=h.router.operate(held,'fixture',async()=>{started();await blocked;});await admitted;
    assert.equal(operationCount(held.db),1);now+=300001;await h.router.evictIdle();
    assert.equal(h.router.all().includes(held),true);assert.equal(h.router.all().length,1);
    let drained=false;const drain=drainOperations(held.db).then(()=>{drained=true;});cancelOperations(held.db);await Promise.resolve();assert.equal(drained,false);
    release();await job;await drain;assert.equal(operationCount(held.db),0);assert.equal(drained,true);
    await held.db.query("INSERT INTO outbox(dedup_key,kind,body,revision,available_at) VALUES('future-queue','text','{}',0,now()+interval '1 hour')");
    now+=300001;await h.router.evictIdle();assert.equal(h.router.all().includes(held),true);
    await held.db.query('DELETE FROM outbox');await held.db.query("INSERT INTO inbox(update_id,payload,revision,available_at) VALUES(900,'{}',0,now()+interval '1 hour')");
    await h.router.evictIdle();assert.equal(h.router.all().includes(held),true);
    await held.db.query('DELETE FROM inbox');
    let unblock!:()=>void;const external=runOperation(held.db,'external',()=>new Promise<void>(resolve=>{unblock=resolve;}));
    await h.router.evictIdle();assert.equal(h.router.all().includes(held),true);unblock();await external;
    now+=30001;await h.router.evictIdle();assert.equal(h.router.all().length,0);
  }finally{await h.router.cancelAll();await db.close();}
});

it('an evicted future timer wakes at its recorded deadline; restart discovers overdue work and delivers it once',async()=>{
  const db=new PhysicalDB();await db.init();let now=Date.now();const h=setup(db,{maxWarm:0,now:()=>now});await h.router.init();
  try{
    const chat=await h.registry.ensure('-2300','11'),runtime=await h.router.runtime(chat),due=new Date(Date.now()+2000);
    await runtime.db.query("INSERT INTO reminders(title,due_at,author_id) VALUES('durable timer',$1,'11')",[due]);
    await h.router.evictIdle();assert.equal(h.router.all().length,0);
    db.clear();assert.deepEqual(await h.router.ready('delivery'),[]);now=due.getTime()+1;
    const waking=await h.router.ready('delivery',1);assert.equal(waking.length,1);assert.equal(waking[0]!.chat.chat_id,chat.chat_id);
    await waking[0]!.db.query("UPDATE reminders SET due_at=now()-interval '1 second'");await h.router.evictIdle();
    const restarted=setup(db,{maxWarm:0});await restarted.router.init();assert.equal(restarted.router.all().length,0);
    const ready=await restarted.router.ready('delivery',1);assert.equal(ready.length,1);
    await restarted.router.operate(ready[0]!,'delivery',async()=>{await ready[0]!.engine.scheduleDue();await ready[0]!.delivery.next('text');});
    await restarted.router.operate(ready[0]!,'delivery',async()=>{await ready[0]!.engine.scheduleDue();await ready[0]!.delivery.next('text');});
    assert.equal(restarted.tg.sent.filter(sent=>sent.text.includes('durable timer')).length,1);
    assert.equal((await ready[0]!.db.query("SELECT status FROM reminders WHERE title='durable timer'")).rows[0]!.status,'sent');
    await restarted.router.evictIdle();assert.equal(restarted.router.all().length,0);
  }finally{await h.router.cancelAll();await db.close();}
});

it('a borrowed personal runtime stays pinned until the group operation finishes',async()=>{
  const db=new PhysicalDB();await db.init();let now=Date.now();const h=setup(db,{maxWarm:0,now:()=>now});await h.router.init();
  try{
    const group=await h.router.runtime(await h.registry.ensure('-2350','11')),personal=await h.registry.ensure('11','11');
    let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),admitted=new Promise<void>(resolve=>{started=resolve;});
    let borrowed:Awaited<ReturnType<ChatRouter['runtime']>>|undefined;
    const operation=runOperation(group.db,'group_calendar',async()=>{borrowed=await h.router.runtime(personal);started();await gate;});
    await admitted;assert.equal(operationCount(borrowed!.db),1);now+=300001;
    await h.router.evictIdle();assert.equal(h.router.all().length,2);
    release();await operation;assert.equal(operationCount(borrowed!.db),0);
    await h.router.evictIdle();assert.equal(h.router.all().length,0);
  }finally{await h.router.cancelAll();await db.close();}
});

it('cold private inbox routes survive eviction; disabled namespaces are not scanned and re-enable precedes schema reads',async()=>{
  const db=new PhysicalDB();await db.init();const h=setup(db,{maxWarm:0});await h.router.init();
  try{
    const chat=await h.registry.ensure('-2400','11'),disabled=await h.registry.ensure('-2401','11');
    const runtime=await h.router.runtime(chat),token='123456789012345678901234',id=randomUUID();
    await runtime.db.query("INSERT INTO private_requests(id,token,recipient_id,requester_id,topic_id,question,purpose,revision,expires_at) VALUES($1,$2,'22','11','0','Choose a quiet time','fixture',0,now()+interval '1 day')",[id,token]);
    await h.registry.disable(disabled.chat_id);await h.router.evictIdle();assert.equal(h.router.all().length,0);
    db.clear();await assert.rejects(h.router.runtime(disabled),/chat_disabled/);
    await h.router.receive(message('/start p_'+token,22,22,'private'));
    assert.equal(h.tg.sent.some(sent=>sent.text.includes('Choose a quiet time')),true);
    assert.equal(db.statements.some(sql=>sql.includes('SET LOCAL')&&sql.includes(disabled.schema_name)),false);
    await h.router.receive({update_id:700001,callback_query:{id:'private-choice',from:{id:22,first_name:'B'},data:'lumen:pv:'+token+':task',message:{message_id:700,date:Math.floor(Date.now()/1000),from:{id:999,first_name:'Lumen',is_bot:true},chat:{id:22,type:'private'},text:'Choose a quiet time'}}});
    await h.router.receive(message('After lunch',22,22,'private'));
    assert.equal((await h.registry.database(chat).query('SELECT status FROM private_requests WHERE id=$1',[id])).rows[0]!.status,'answered');
    db.clear();await h.registry.ensure(disabled.chat_id,'11','enabled again');await h.router.runtime((await h.registry.find(disabled.chat_id))!);
    const enable=db.statements.findIndex(sql=>sql.startsWith('UPDATE public.lumen_chats SET enabled=true'));
    const read=db.statements.findIndex(sql=>sql.startsWith('SET LOCAL')&&sql.includes(disabled.schema_name));
    assert.ok(enable>=0&&read>enable);
  }finally{await h.router.cancelAll();await db.close();}
});

it('chat-id migration drains work and preserves the runtime; disabled migration only updates public metadata',async()=>{
  const db=new PhysicalDB();await db.init();const h=setup(db);await h.router.init();
  try{
    const registered=await h.registry.ensure('-2500','11'),runtime=await h.router.runtime(registered);
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const operation=runOperation(runtime.db,'migration-fixture',()=>gate);
    const update=message('',11,-2500);update.message!.migrate_to_chat_id=-2501;
    let migrated=false;const migration=h.router.receive(update).then(()=>{migrated=true;});
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(migrated,false);
    release();await operation;await migration;
    assert.equal(await h.registry.find('-2500'),undefined);assert.equal(h.router.all()[0],runtime);
    assert.equal(runtime.chat.chat_id,'-2501');assert.equal((await state(runtime.db)).chat_id,'-2501');
    await h.registry.disable('-2501');db.clear();await h.registry.migrateChat('-2501','-2502');
    assert.equal(db.statements.some(sql=>sql.startsWith('SET LOCAL')),false);
    await h.registry.ensure('-2502','11');assert.equal((await state(h.registry.database((await h.registry.find('-2502'))!))).chat_id,'-2502');
  }finally{await h.router.cancelAll();await db.close();}
});
