import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkerSlots,type HeavyWorkKind} from '../src/work-slots.js';
import type {MemorySnapshot} from '../src/resource-memory.js';
import {cancelOperations,runOperation} from '../src/operations.js';
import type {Database} from '../src/db.js';

const MiB=1024*1024;
function memory(current=200*MiB,limit:number|null=512*MiB):MemorySnapshot{
  return {timestamp:'2026-11-02T00:00:00.000Z',source:'cgroup_v2',current_bytes:current,limit_bytes:limit,
    node_rss_bytes:120*MiB,node_heap_used_bytes:40*MiB,node_heap_total_bytes:64*MiB,
    node_external_bytes:12*MiB,node_array_buffers_bytes:8*MiB,oom_kill_count:0,child_process_count:0};
}
function latch(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function idle(slots:WorkerSlots){assert.equal(slots.metrics().active,0);assert.equal(slots.metrics().waiting,0);assert.equal(slots.metrics().active_kind,null);}

describe('Heavy work memory admission and queue lifecycle without external resources',()=>{
  it('admits below the known 512 MiB headroom boundary and denies before callback above it',async()=>{
    let current=330*MiB,calls=0;
    const slots=new WorkerSlots({sample:async()=>memory(current),emit:()=>{}});
    assert.equal(await slots.run(async()=>{calls++;assert.equal(slots.metrics().active,1);return 7;},'compute'),7);
    current=340*MiB;
    await assert.rejects(slots.run(async()=>{calls++;},'compute'),{code:'worker_memory_busy'});
    assert.equal(calls,1);assert.equal(slots.metrics().denied,1);assert.equal(slots.metrics().completed,1);idle(slots);
  });

  it('reserves more headroom for browser than for a small compute operation',async()=>{
    const slots=new WorkerSlots({sample:async()=>memory(280*MiB),emit:()=>{}});
    for(const kind of ['browser','document_pdf','document_preview'] as const)await assert.rejects(slots.run(async()=>assert.fail('Chromium must not launch under pressure'),kind),{code:'worker_memory_busy'});
    assert.equal(await slots.run(async()=>true,'compute'),true);idle(slots);
  });

  it('reclaims once and resamples before admission, without repeating the callback',async()=>{
    let reclaimed=0,calls=0,samples=0;
    const slots=new WorkerSlots({sample:async()=>{samples++;return memory((reclaimed?200:400)*MiB);},emit:()=>{},reclaim:async()=>{reclaimed++;}});
    assert.equal(await slots.run(async()=>{calls++;return 'done';},'media_render'),'done');
    assert.equal(reclaimed,1);assert.equal(calls,1);assert.equal(samples,3);idle(slots);
  });

  it('denies if reclaim does not create headroom and never spins or launches work',async()=>{
    let reclaimed=0,samples=0;
    const slots=new WorkerSlots({sample:async()=>{samples++;return memory(400*MiB);},emit:()=>{},reclaim:async()=>{reclaimed++;}});
    await assert.rejects(slots.run(async()=>assert.fail('Pressure denial precedes callback')),{code:'worker_memory_busy'});
    assert.equal(reclaimed,1);assert.equal(samples,2);assert.equal(slots.metrics().completed,0);idle(slots);
  });

  it('does not start a callback cancelled during the post-reclaim memory sample',async()=>{
    const db={} as Database,resampling=latch(),releaseSample=latch();let samples=0,reclaims=0,calls=0;
    const slots=new WorkerSlots({emit:()=>{},reclaim:async()=>{reclaims++;},sample:async()=>{
      samples++;
      if(samples===1)return memory(400*MiB);
      if(samples===2){resampling.release();await releaseSample.promise;}
      return memory();
    }});
    const cancelled=runOperation(db,'cancel-during-resample',()=>slots.run(async()=>{calls++;}));
    try{
      await resampling.promise;cancelOperations(db,'cancel-during-resample');releaseSample.release();
      await assert.rejects(cancelled,/operation_cancelled/);
      assert.equal(calls,0);assert.equal(reclaims,1);idle(slots);
      assert.equal(await slots.run(async()=>{calls++;return 'later';}),'later');
      assert.equal(calls,1);assert.equal(slots.metrics().denied,0);idle(slots);
    }finally{releaseSample.release();await cancelled.catch(()=>{});}
  });

  it('labels an unknown limit honestly and keeps the callback available',async()=>{
    const events:Record<string,unknown>[]=[];
    const slots=new WorkerSlots({sample:async()=>memory(900*MiB,null),emit:event=>events.push(event)});
    assert.equal(await slots.run(async()=>3),3);
    assert.equal(events.find(event=>event.reason==='heavy_start')?.admission,'limit_unknown');
    assert.ok(events.every(event=>event.limit_bytes===null));idle(slots);
  });

  it('releases the slot after a callback throws and preserves the original failure',async()=>{
    const error=new Error('synthetic_callback_failure');
    const slots=new WorkerSlots({sample:async()=>memory(),emit:()=>{}});
    await assert.rejects(slots.run(async()=>{throw error;}),actual=>actual===error);
    assert.equal(await slots.run(async()=>11),11);assert.equal(slots.metrics().completed,2);idle(slots);
  });

  it('cancels before admission and while queued without retaining a waiter or overtaking work',async()=>{
    const db={} as Database,slots=new WorkerSlots({sample:async()=>memory(),emit:()=>{}});
    await assert.rejects(runOperation(db,'cancel-before',async()=>{
      cancelOperations(db,'cancel-before');return slots.run(async()=>assert.fail('Cancelled work cannot run'));
    }),/operation_cancelled/);
    idle(slots);
    const gate=latch(),entered=latch();let laterStarted=false;
    const first=slots.run(async()=>{entered.release();await gate.promise;});await entered.promise;
    try{
      const cancelled=runOperation(db,'cancel-wait',()=>slots.run(async()=>assert.fail('Cancelled waiter cannot run')));
      cancelOperations(db,'cancel-wait');await assert.rejects(cancelled,/operation_cancelled/);
      assert.equal(slots.metrics().waiting,0);assert.equal(slots.metrics().active,1);
      const later=slots.run(async()=>{laterStarted=true;});
      await turn();assert.equal(laterStarted,false);
      gate.release();await first;await later;
      assert.equal(slots.metrics().cancelled,1);idle(slots);
    }finally{gate.release();await first;}
  });

  it('bounds the default waiting queue at eight without disturbing the active predecessor',async()=>{
    const slots=new WorkerSlots({sample:async()=>memory(),emit:()=>{}}),gate=latch(),entered=latch();
    const order:number[]=[],first=slots.run(async()=>{entered.release();await gate.promise;order.push(-1);});await entered.promise;
    const queued=Array.from({length:8},(_,index)=>slots.run(async()=>{order.push(index);}));
    try{
      assert.equal(slots.metrics().waiting,8);
      await assert.rejects(slots.run(async()=>assert.fail('Ninth waiter must be refused')),{code:'worker_queue_busy'});
      assert.deepEqual(order,[]);assert.equal(slots.metrics().active,1);
    }finally{gate.release();await first;await Promise.all(queued);}
    assert.deepEqual(order,[-1,0,1,2,3,4,5,6,7]);idle(slots);
  });

  it('times out a waiter without letting its successor overtake the active predecessor',async()=>{
    const slots=new WorkerSlots({sample:async()=>memory(),emit:()=>{},waitTimeoutMs:30}),gate=latch(),entered=latch();
    const keepAlive=setTimeout(()=>{},1000);let laterStarted=false;
    const first=slots.run(async()=>{entered.release();await gate.promise;});await entered.promise;
    try{
      await assert.rejects(slots.run(async()=>assert.fail('Timed out work cannot run')),{code:'worker_queue_timeout'});
      const later=slots.run(async()=>{laterStarted=true;});
      await turn();assert.equal(laterStarted,false);assert.equal(slots.metrics().active,1);
      gate.release();await first;await later;
      assert.equal(slots.metrics().cancelled,1);idle(slots);
    }finally{clearTimeout(keepAlive);gate.release();await first;}
  });

  it('emits only resource facts and finite labels, without callback content or return data',async()=>{
    const events:Record<string,unknown>[]=[],privateText='synthetic private task https://private.invalid/chat/123';
    const slots=new WorkerSlots({sample:async()=>memory(),emit:event=>events.push(event)});
    const result=await slots.run(async()=>({body:privateText}),privateText as HeavyWorkKind);
    assert.equal(result.body,privateText);assert.equal(events.length,2);
    assert.ok(events.every(event=>event.kind==='other'&&event.event==='runtime_memory'));
    assert.ok(!JSON.stringify(events).includes(privateText));
    const allowed=new Set([...Object.keys(memory()),'event','reason','kind','active','waiting','admission','ok','duration_ms','observed_peak_bytes']);
    for(const event of events)for(const key of Object.keys(event))assert.ok(allowed.has(key),key);
    idle(slots);
  });

  it('ignores telemetry sink failures for both success and original callback failure',async()=>{
    const slots=new WorkerSlots({sample:async()=>memory(),emit:()=>{throw new Error('synthetic_sink_failure');}});
    assert.equal(await slots.run(async()=>42),42);
    const failure=new Error('synthetic_operation_failure');
    await assert.rejects(slots.run(async()=>{throw failure;}),actual=>actual===failure);
    assert.ok(await slots.observe());idle(slots);
  });

  it('starts periodic sampling once, prevents overlap, and stops future samples',async()=>{
    const sampling=latch(),releaseSample=latch(),events:Record<string,unknown>[]=[];let calls=0,inFlight=0,maximum=0;
    const slots=new WorkerSlots({emit:event=>events.push(event),sample:async()=>{
      calls++;inFlight++;maximum=Math.max(maximum,inFlight);sampling.release();
      try{await releaseSample.promise;return memory();}finally{inFlight--;}
    }});
    const stop=slots.startTelemetry(5);
    try{
      await sampling.promise;await delay(20);assert.equal(calls,1);assert.equal(maximum,1);
      stop();releaseSample.release();await turn();await delay(20);
      assert.equal(calls,1);assert.equal(inFlight,0);assert.equal(events.length,1);
      assert.equal(events[0]!.reason,'periodic');assert.equal(events[0]!.kind,null);idle(slots);
    }finally{stop();releaseSample.release();}
  });
});
