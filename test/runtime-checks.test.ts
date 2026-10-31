import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publicRuntimeProbes,RUNTIME_DIAGNOSTICS_FILE,runtimeChecks,runtimeDiagnosticsRequested,unrunRuntimeChecks,type RuntimeCheckReport} from '../src/runtime-checks.js';
import {cancelOperations,operationCount,operationSignal,runOperation} from '../src/operations.js';
import type {Database} from '../src/db.js';
import {RELEASE} from '../src/release.js';

test('normal startup never constructs or runs broad probes, even with an old verified report',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lumen-diagnostics-off-'));
  try{
    const old=JSON.stringify({status:'verified',version:'old-release',checks:{native_search:{ok:true}}});
    await writeFile(join(directory,RUNTIME_DIAGNOSTICS_FILE),old);
    await writeFile(join(directory,`checks-${RELEASE}-2.json`),old);
    let created=0;const states:RuntimeCheckReport[]=[];
    const report=await runtimeChecks(directory,runtimeDiagnosticsRequested([]),()=>{created++;throw new Error('must_not_create_probes');},state=>states.push(structuredClone(state)));
    assert.equal(created,0);assert.deepEqual(report,unrunRuntimeChecks());assert.deepEqual(states,[report]);
    assert.equal(report.status,'not_run');assert.equal(report.checked_at,undefined);
    assert.equal(await readFile(join(directory,RUNTIME_DIAGNOSTICS_FILE),'utf8'),old);
    assert.equal((await readdir(directory)).length,2);
    const absent=join(directory,'uncreated');await runtimeChecks(absent,false,()=>{throw new Error('must_not_create_probes');});
    await assert.rejects(stat(absent),{code:'ENOENT'});
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('only the explicit startup diagnostics flag opts in',()=>{
  for(const args of [[],['--diagnostics=false'],['--diagnostic'],['--version','1.13.2']])assert.equal(runtimeDiagnosticsRequested(args),false);
  assert.equal(runtimeDiagnosticsRequested(['--diagnostics']),true);
  assert.equal(runtimeDiagnosticsRequested(['--other','--diagnostics']),true);
});

test('explicit diagnostics run sequentially, expose progress, and do not reuse old release results',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lumen-diagnostics-on-'));
  try{
    await writeFile(join(directory,`checks-${RELEASE}-2.json`),JSON.stringify({first:{ok:true},second:{ok:true}}));
    let calls=0,active=0,maximum=0;const order:string[]=[],states:RuntimeCheckReport[]=[];
    const probe=(name:string)=>async()=>{calls++;active++;maximum=Math.max(maximum,active);order.push(name);await Promise.resolve();active--;return {observed:name};};
    const run=()=>runtimeChecks(directory,true,()=>({first:probe('first'),second:probe('second')}),state=>states.push(structuredClone(state)));
    const report=await run();
    assert.equal(report.status,'verified');assert.equal(report.mode,'on_demand');assert.equal(report.version,RELEASE);assert.ok(report.started_at);assert.ok(report.checked_at);
    assert.deepEqual(report.checks.first,{status:'verified',ok:true,proof:{observed:'first'}});assert.equal(maximum,1);
    assert.ok(states.some(state=>state.status==='running'&&state.checks.first?.status==='running'&&state.checks.second?.status==='not_run'));
    assert.deepEqual(JSON.parse(await readFile(join(directory,RUNTIME_DIAGNOSTICS_FILE),'utf8')),report);
    assert.equal((await stat(join(directory,RUNTIME_DIAGNOSTICS_FILE))).mode&0o777,0o600);
    await run();assert.equal(calls,4);assert.deepEqual(order,['first','second','first','second']);
    assert.deepEqual((await readdir(directory)).sort(),[RUNTIME_DIAGNOSTICS_FILE,`checks-${RELEASE}-2.json`].sort());
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('failed probes stay failed and do not prevent independent checks or expose raw errors',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lumen-diagnostics-failed-'));
  try{
    const report=await runtimeChecks(directory,true,()=>({
      provider:async()=>{throw Object.assign(new Error('secret provider response\nprivate detail'),{code:'provider_unavailable'});},
      semantic:async()=>{throw new Error('synthetic_plan_invalid');},
      after:async()=>({observed:true}),
    }));
    assert.equal(report.status,'failed');
    assert.deepEqual(report.checks.provider,{status:'failed',ok:false,code:'provider_unavailable',error_type:'Error'});
    assert.deepEqual(report.checks.semantic,{status:'failed',ok:false,code:'synthetic_plan_invalid',error_type:'Error'});
    assert.deepEqual(report.checks.after,{status:'verified',ok:true,proof:{observed:true}});
    assert.doesNotMatch(JSON.stringify(report),/secret|private detail/);
    assert.deepEqual(JSON.parse(await readFile(join(directory,RUNTIME_DIAGNOSTICS_FILE),'utf8')),report);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('shutdown cancellation stops later diagnostics and drains the existing operation scope',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lumen-diagnostics-cancel-')),db={} as Database;
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let later=0;
  try{
    const pending=runOperation(db,'runtime_diagnostics',()=>runtimeChecks(directory,true,()=>({
      interrupted:async()=>{const signal=operationSignal()!;entered();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},
      later:async()=>{later++;return true;},
    })));
    await started;assert.equal(operationCount(db),1);cancelOperations(db,'runtime_diagnostics');const report=await pending;
    assert.equal(later,0);assert.equal(operationCount(db),0);assert.equal(report.status,'failed');assert.equal(report.code,'operation_cancelled');
    assert.deepEqual(report.checks.interrupted,{status:'failed',ok:false,code:'operation_cancelled',error_type:'Error'});
    assert.deepEqual(report.checks.later,{status:'not_run'});
  }finally{cancelOperations(db);await rm(directory,{recursive:true,force:true});}
});

test('an empty requested suite cannot report verification',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lumen-diagnostics-empty-'));
  try{const report=await runtimeChecks(directory,true,()=>({}));assert.equal(report.status,'failed');assert.equal(report.code,'no_runtime_probes');}
  finally{await rm(directory,{recursive:true,force:true});}
});

test('the explicit public suite retains every existing capability probe without invoking it',()=>{
  let calls=0;const operation=async()=>{calls++;return true;};
  const probes=publicRuntimeProbes(operation,operation,{documents:operation,interactions:operation,personalization_scheduling_190:operation,behavior_111_r2:operation,companion_113:operation});
  assert.deepEqual(Object.keys(probes),['web_read','public_search','native_search','automatic_freshness_choice','browser','compute','documents','interactions','personalization_scheduling_190','behavior_111_r2','companion_113']);
  assert.equal(calls,0);
});
