import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sampleMemory,MEMORY_ADMISSION_RATIO,type MemoryDependencies} from '../src/resource-memory.js';

const MiB=1024*1024;
const nodeMemory={rss:64*MiB,heapTotal:40*MiB,heapUsed:20*MiB,external:8*MiB,arrayBuffers:2*MiB};
function fixture(files:Record<string,string>={},extra:Partial<MemoryDependencies>={}){
  const reads:string[]=[];
  const deps:MemoryDependencies={
    platform:'linux',pid:10,now:()=>new Date('2026-11-02T02:32:00Z'),memoryUsage:()=>({...nodeMemory}),readDirectory:async()=>[],
    readText:async path=>{reads.push(path);if(files[path]===undefined)throw Object.assign(Error('unavailable'),{code:'ENOENT'});return files[path];},...extra,
  };
  return {deps,reads};
}
const v2=(current='300000000',maximum='536870912')=>({'/sys/fs/cgroup/memory.current':current,'/sys/fs/cgroup/memory.max':maximum,'/sys/fs/cgroup/memory.events':'low 0\nhigh 0\nmax 2\noom 1\noom_kill 1\n'});

test('v2 reports aggregate memory separately from Node buffers and only bounded technical fields',async()=>{
  const {deps}=fixture(v2());const snapshot=await sampleMemory(deps);
  assert.equal(snapshot.source,'cgroup_v2');assert.equal(snapshot.current_bytes,300000000);assert.equal(snapshot.limit_bytes,512*MiB);assert.equal(snapshot.oom_kill_count,1);
  assert.equal(snapshot.node_rss_bytes,nodeMemory.rss);assert.equal(snapshot.node_external_bytes,8*MiB);assert.equal(snapshot.node_array_buffers_bytes,2*MiB);
  assert.deepEqual(Object.keys(snapshot).sort(),['timestamp','source','current_bytes','limit_bytes','node_rss_bytes','node_heap_used_bytes','node_heap_total_bytes','node_external_bytes','node_array_buffers_bytes','oom_kill_count','child_process_count'].sort());
  assert.equal(snapshot.timestamp,'2026-11-02T02:32:00.000Z');
});

test('v1 fallback never mistakes memory.failcnt for OOM kills',async()=>{
  const {deps}=fixture({'/sys/fs/cgroup/memory/memory.usage_in_bytes':'123456789','/sys/fs/cgroup/memory/memory.limit_in_bytes':String(512*MiB),'/sys/fs/cgroup/memory/memory.failcnt':'99'});
  const snapshot=await sampleMemory(deps);assert.equal(snapshot.source,'cgroup_v1');assert.equal(snapshot.current_bytes,123456789);assert.equal(snapshot.limit_bytes,512*MiB);assert.equal(snapshot.oom_kill_count,null);
});

test('unlimited v2 and v1 limits are null instead of fabricated service limits',async()=>{
  for(const files of [v2('123','max'),{'/sys/fs/cgroup/memory/memory.usage_in_bytes':'456','/sys/fs/cgroup/memory/memory.limit_in_bytes':'9223372036854771712'}]){
    const {deps}=fixture(files);const snapshot=await sampleMemory(deps);assert.notEqual(snapshot.source,'node_process_only');assert.equal(snapshot.limit_bytes,null);
  }
});

test('missing and malformed cgroup values fall back honestly to Node RSS',async()=>{
  for(const files of [{},v2('NaN'),v2('-1'),v2('1e9'),v2('1.5'),v2('9007199254740992'),v2('123','0'),v2('123','-4'),v2('123','garbage'),v2('123','9007199254740992')]){
    const {deps}=fixture(files);const snapshot=await sampleMemory(deps);assert.equal(snapshot.source,'node_process_only');assert.equal(snapshot.limit_bytes,null);assert.equal(snapshot.current_bytes,nodeMemory.rss);assert.equal(snapshot.oom_kill_count,null);
  }
});

test('a malformed v2 sample can still use a valid v1 sample',async()=>{
  const {deps}=fixture({...v2('invalid'),'/sys/fs/cgroup/memory/memory.usage_in_bytes':'42','/sys/fs/cgroup/memory/memory.limit_in_bytes':'1024'});
  assert.equal((await sampleMemory(deps)).source,'cgroup_v1');
});

test('an effective parent limit uses its parent usage, not smaller child usage',async()=>{
  const {deps}=fixture({...v2('999','max'),'/proc/self/cgroup':'0::/worker/child\n','/sys/fs/cgroup/worker/child/memory.current':'100','/sys/fs/cgroup/worker/child/memory.max':'max','/sys/fs/cgroup/worker/memory.current':'400000000','/sys/fs/cgroup/worker/memory.max':String(512*MiB)});
  const snapshot=await sampleMemory(deps);assert.equal(snapshot.current_bytes,400000000);assert.equal(snapshot.limit_bytes,512*MiB);
});

test('mount roots map process memberships into the mounted cgroup namespace',async()=>{
  const {deps}=fixture({'/proc/self/cgroup':'0::/host.slice/container/worker\n','/proc/self/mountinfo':'29 23 0:26 /host.slice/container /sys/fs/cgroup rw - cgroup2 cgroup rw\n','/sys/fs/cgroup/worker/memory.current':'12','/sys/fs/cgroup/worker/memory.max':'1024'});
  const snapshot=await sampleMemory(deps);assert.equal(snapshot.source,'cgroup_v2');assert.equal(snapshot.current_bytes,12);assert.equal(snapshot.limit_bytes,1024);
});

test('a finite subgroup limit does not hide tighter ancestor headroom',async()=>{
  const {deps}=fixture({...v2('490000000',String(512*MiB)),'/proc/self/cgroup':'0::/worker\n','/sys/fs/cgroup/worker/memory.current':'100000000','/sys/fs/cgroup/worker/memory.max':String(1024*MiB)});
  const snapshot=await sampleMemory(deps);assert.equal(snapshot.current_bytes,490000000);assert.equal(snapshot.limit_bytes,512*MiB);
});

test('v1 process memberships select the memory controller hierarchy',async()=>{
  const {deps}=fixture({'/proc/self/cgroup':'2:cpu,cpuacct:/irrelevant\n3:memory:/worker\n','/sys/fs/cgroup/memory/worker/memory.usage_in_bytes':'12','/sys/fs/cgroup/memory/worker/memory.limit_in_bytes':'2048'});
  assert.equal((await sampleMemory(deps)).limit_bytes,2048);
});

test('unsafe memberships and mount locations never become filesystem reads',async()=>{
  for(const membership of ['/../../private','/safe/../private','/safe/./private','/safe with spaces']){
    const {deps,reads}=fixture({...v2(),'/proc/self/cgroup':'0::'+membership,'/proc/self/mountinfo':'29 23 0:26 / /private rw - cgroup2 cgroup rw'});
    assert.equal((await sampleMemory(deps)).source,'cgroup_v2');assert.ok(reads.every(path=>path.startsWith('/proc/')||path.startsWith('/sys/fs/cgroup/')));assert.ok(reads.every(path=>!path.includes('/../')&&!path.includes('/./')&&!path.includes('private')));
  }
});

test('descendant count includes grandchildren and excludes unrelated processes without exposing status data',async()=>{
  const files={...v2(),'/proc/10/status':'Name:\tprivate-name\nPPid:\t1\nUid:\t123\n','/proc/11/status':'PPid:\t10\n','/proc/12/status':'PPid:\t11\n','/proc/13/status':'PPid:\t1\n'};
  const {deps}=fixture(files,{readDirectory:async()=>['10','11','12','13','self','net']});const snapshot=await sampleMemory(deps);assert.equal(snapshot.child_process_count,2);assert.doesNotMatch(JSON.stringify(snapshot),/private-name|Uid|\/proc/);
});

test('process sampling is bounded and unreadable roots report unknown',async()=>{
  let reads=0;
  const {deps}=fixture(v2(),{readDirectory:async()=>Array.from({length:257},(_,i)=>String(i+1)),readText:async()=>{reads++;throw Error('denied');}});
  assert.equal((await sampleMemory(deps)).child_process_count,null);assert.ok(reads<15);
  const missing=fixture(v2(),{readDirectory:async()=>['99']});assert.equal((await sampleMemory(missing.deps)).child_process_count,null);
});

test('non-Linux fallback does not probe cgroups or procfs',async()=>{
  const {deps,reads}=fixture({}, {platform:'darwin',readDirectory:async()=>{throw Error('must_not_read');}});const snapshot=await sampleMemory(deps);
  assert.equal(snapshot.source,'node_process_only');assert.equal(snapshot.child_process_count,null);assert.deepEqual(reads,[]);
});


test('nested limits select the tightest90-percent admission budget for both memory controllers',async()=>{
  for(const version of ['v2','v1'] as const){
    const v1=version==='v1',mount=v1?'/sys/fs/cgroup/memory':'/sys/fs/cgroup',usage=v1?'/memory.usage_in_bytes':'/memory.current',limit=v1?'/memory.limit_in_bytes':'/memory.max';
    const {deps}=fixture({'/proc/self/cgroup':v1?'3:memory:/worker':'0::/worker',[mount+'/worker'+usage]:String(260*MiB),[mount+'/worker'+limit]:String(512*MiB),[mount+usage]:String(765*MiB),[mount+limit]:String(1024*MiB)});
    const snapshot=await sampleMemory(deps);assert.equal(snapshot.current_bytes,765*MiB);assert.equal(snapshot.limit_bytes,1024*MiB);
    assert.ok(260*MiB+192*MiB<=512*MiB*MEMORY_ADMISSION_RATIO,'the child alone would admit');
    assert.ok(snapshot.current_bytes+192*MiB>snapshot.limit_bytes!*MEMORY_ADMISSION_RATIO,'the effective parent must refuse');
  }
});

test('unreadable process status makes child count unknown; a process that exited is skipped',async()=>{
  for(const code of ['EACCES','EPERM','ENOENT','ESRCH']){
    const {deps}=fixture(v2(),{readDirectory:async()=>['10','11'],readText:async path=>{
      if(path==='/proc/10/status')return 'PPid:1\n';
      if(path==='/proc/11/status')throw Object.assign(Error('synthetic'),{code});
      const value=v2()[path as keyof ReturnType<typeof v2>];if(value!==undefined)return value;throw Object.assign(Error('missing'),{code:'ENOENT'});
    }});
    assert.equal((await sampleMemory(deps)).child_process_count,['ENOENT','ESRCH'].includes(code)?0:null);
  }
});
