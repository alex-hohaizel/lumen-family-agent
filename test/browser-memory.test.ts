import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BrowserTools} from '../src/browser.js';
import type {withWorkerSlot} from '../src/work-slots.js';

const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function latch(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
function fixture(idleMs=5,heavy:typeof withWorkerSlot=async fn=>fn()){
  const tools=new BrowserTools(undefined,idleMs,heavy),internal=tools as any;
  let closed=0;
  const browser={close:async()=>{closed++;},isConnected:()=>true};
  internal.start=async()=>{internal.browser=browser;return browser;};
  return {tools,internal,browser,closed:()=>closed};
}

test('closing the final context releases Chromium immediately, even when heavy admission is denied',async()=>{
  const f=fixture(60000,async()=>{throw Error('heavy_must_not_run_for_close');});
  f.internal.browser=f.browser;
  f.internal.sessions.set('synthetic',{context:{close:async()=>{},pages:()=>[]},page:{},last:Date.now()});
  assert.deepEqual(await f.tools.run('synthetic','close',{}),{closed:true});
  assert.equal(f.closed(),1);assert.equal(f.internal.browser,undefined);
});

test('idle timer cannot close Chromium during a long next operation',async()=>{
  const f=fixture(),gate=latch(),entered=latch();
  f.internal.perform=async(_scope:string,operation:string)=>{
    f.internal.browser=f.browser;f.internal.sessions.set('synthetic',{context:{close:async()=>{}},page:{}});
    if(operation==='hold'){entered.release();await gate.promise;}return {};
  };
  try{
    await f.tools.run('synthetic','open',{});
    const next=f.tools.run('synthetic','hold',{});await entered.promise;
    await sleep(15);assert.equal(f.closed(),0);
    gate.release();await next;await sleep(15);assert.equal(f.closed(),1);
  }finally{gate.release();await f.tools.close();}
});

test('browser queue rejects overflow before capturing more waiting work',async()=>{
  const f=fixture(),gate=latch(),entered=latch();let calls=0;
  f.internal.perform=async()=>{calls++;if(calls===1){entered.release();await gate.promise;}return {};};
  const first=f.tools.run('synthetic','open',{});await entered.promise;
  const waiting=Array.from({length:3},()=>f.tools.run('synthetic','inspect',{}));
  try{await assert.rejects(f.tools.run('synthetic','inspect',{}),{code:'browser_busy'});assert.equal(calls,1);}
  finally{gate.release();await first;await Promise.all(waiting);await f.tools.close();}
  assert.equal(calls,4);
});

test('pressure cleanup does not wait on queued browser work or close a live session',async()=>{
  const f=fixture(),gate=latch(),entered=latch();
  f.internal.browser=f.browser;
  f.internal.perform=async()=>{entered.release();await gate.promise;return {};};
  const active=f.tools.run('synthetic','open',{});await entered.promise;
  try{await f.tools.releaseIdleMemory();assert.equal(f.closed(),0);}
  finally{gate.release();await active;}
  assert.equal(f.closed(),1);
  f.internal.browser=f.browser;f.internal.sessions.set('synthetic',{context:{close:async()=>{}},page:{}});
  await f.tools.releaseIdleMemory();assert.equal(f.closed(),1);
  await f.tools.closeScope('synthetic');assert.equal(f.closed(),2);await turn();
});
