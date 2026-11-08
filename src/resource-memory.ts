import {readFile,readdir} from 'node:fs/promises';

export interface MemorySnapshot {
  timestamp:string;
  source:'cgroup_v2'|'cgroup_v1'|'node_process_only';
  current_bytes:number;
  limit_bytes:number|null;
  node_rss_bytes:number;
  node_heap_used_bytes:number;
  node_heap_total_bytes:number;
  node_external_bytes:number;
  node_array_buffers_bytes:number;
  oom_kill_count:number|null;
  child_process_count:number|null;
}
export interface MemoryDependencies {
  readText:(path:string)=>Promise<string>;
  readDirectory:(path:string)=>Promise<string[]>;
  memoryUsage:()=>NodeJS.MemoryUsage;
  platform:string;
  now:()=>Date;
  pid:number;
}
const defaults:MemoryDependencies={readText:path=>readFile(path,'utf8'),readDirectory:path=>readdir(path),memoryUsage:()=>process.memoryUsage(),platform:process.platform,now:()=>new Date(),pid:process.pid};
export const MEMORY_ADMISSION_RATIO=.9;
const maximumProcesses=256,maximumAncestors=16;
type CgroupSample=Pick<MemorySnapshot,'source'|'current_bytes'|'limit_bytes'|'oom_kill_count'>;

async function text(deps:MemoryDependencies,path:string){
  try{const value=await deps.readText(path);return value.length<=65536?value:undefined;}catch{return;}
}
function count(value:string|undefined){
  if(value===undefined||!/^\d+$/.test(value.trim()))return;
  const number=Number(value.trim());return Number.isSafeInteger(number)&&number>=0?number:undefined;
}
function limit(value:string|undefined,v1:boolean):number|null|undefined {
  const trimmed=value?.trim();if(!v1&&trimmed==='max')return null;
  if(!trimmed||trimmed.length>24||!/^\d+$/.test(trimmed))return;
  const bytes=BigInt(trimmed);
  // cgroup v1 represents unlimited memory with a very large, page-aligned sentinel.
  if(v1&&bytes>=(1n<<60n))return null;
  const number=Number(bytes);return Number.isSafeInteger(number)&&number>0?number:undefined;
}
function safePath(value:string){
  return value.startsWith('/')&&value.length<=4096&&value.split('/').every(part=>!part||part!=='.'&&part!=='..'&&/^[A-Za-z0-9_.:@-]+$/.test(part));
}
function hierarchy(cgroup:string|undefined,mountinfo:string|undefined,v1:boolean){
  const conventional=v1?'/sys/fs/cgroup/memory':'/sys/fs/cgroup';
  const membership=cgroup?.split('\n').find(line=>v1?line.split(':')[1]?.split(',').includes('memory'):line.startsWith('0::'))?.split(':').slice(2).join(':');
  if(!membership||!safePath(membership))return [conventional];
  let mount=conventional,root='/';
  for(const line of mountinfo?.split('\n')??[]){
    const [before,after]=line.split(' - '),fields=before?.split(' '),kind=after?.split(' ');
    if(!fields||!kind||!(v1?kind[0]==='cgroup'&&kind[2]?.split(',').includes('memory'):kind[0]==='cgroup2'))continue;
    const candidate=fields[4],candidateRoot=fields[3];
    if(candidate&&candidateRoot&&safePath(candidate)&&safePath(candidateRoot)&&(candidate==='/sys/fs/cgroup'||candidate.startsWith('/sys/fs/cgroup/'))){mount=candidate;root=candidateRoot;break;}
  }
  const relative=membership===root?'':root==='/'?membership:membership.startsWith(root+'/')?membership.slice(root.length):undefined;
  if(relative===undefined)return [conventional];
  const parts=relative.split('/').filter(Boolean),paths:string[]=[];
  // Inspect a bounded number of ancestors. Usage and limit always come from the same cgroup.
  for(let n=parts.length;n>=0&&paths.length<maximumAncestors;n--)paths.push(mount+(n?'/'+parts.slice(0,n).join('/'):''));
  if(!paths.includes(mount))paths.push(mount);
  if(!paths.includes(conventional))paths.push(conventional);
  return paths;
}
async function cgroupMemory(deps:MemoryDependencies):Promise<CgroupSample|undefined>{
  const [membership,mounts]=await Promise.all([text(deps,'/proc/self/cgroup'),text(deps,'/proc/self/mountinfo')]);
  let unlimited:CgroupSample|undefined;
  for(const v1 of [false,true]){
   let constrained:CgroupSample|undefined;
   for(const path of hierarchy(membership,mounts,v1)){
    const [rawCurrent,rawLimit]=await Promise.all([text(deps,path+(v1?'/memory.usage_in_bytes':'/memory.current')),text(deps,path+(v1?'/memory.limit_in_bytes':'/memory.max'))]);
    const current=count(rawCurrent),maximum=limit(rawLimit,v1);if(current===undefined||maximum===undefined)continue;
    let kills:number|null=null;
    if(!v1){const events=await text(deps,path+'/memory.events');kills=count(/^oom_kill\s+(\d+)$/m.exec(events??'')?.[1])??null;}
    // v1 memory.failcnt counts limit hits, not OOM kills; never report it as kills.
    const sample:CgroupSample={source:v1?'cgroup_v1':'cgroup_v2',current_bytes:current,limit_bytes:maximum,oom_kill_count:kills};
    // An ancestor can constrain this process even when its own subgroup has a
    // finite, larger limit. Select the tightest admission headroom, with matching usage.
    if(maximum!==null){if(!constrained||maximum*MEMORY_ADMISSION_RATIO-current<constrained.limit_bytes!*MEMORY_ADMISSION_RATIO-constrained.current_bytes)constrained=sample;}
    else unlimited??=sample;
   }
   if(constrained)return constrained;
  }
  return unlimited;
}
async function children(deps:MemoryDependencies):Promise<number|null>{
  try{
    const names=(await deps.readDirectory('/proc')).filter(name=>/^\d+$/.test(name));
    if(names.length>maximumProcesses||!Number.isSafeInteger(deps.pid)||deps.pid<=0)return null;
    const parents=new Map<number,number>();
    for(const name of names){
      let status:string;
      try{status=await deps.readText('/proc/'+name+'/status');}
      catch(error){if(['ENOENT','ESRCH'].includes(String((error as NodeJS.ErrnoException).code)))continue;return null;}
      if(status.length>65536)return null;
      const parent=count(/^PPid:\s*(\d+)$/m.exec(status)?.[1]),pid=count(name);
      if(parent===undefined||pid===undefined)return null;
      parents.set(pid,parent);
    }
    if(!parents.has(deps.pid))return null;
    const descendants=new Set([deps.pid]);let previous=0;
    while(previous!==descendants.size){previous=descendants.size;for(const [pid,parent]of parents)if(descendants.has(parent))descendants.add(pid);}
    return descendants.size-1;
  }catch{return null;}
}

/** Read-only content-free snapshot. arrayBuffers is already included in external; do not sum them. */
export async function sampleMemory(dependencies:Partial<MemoryDependencies>={}):Promise<MemorySnapshot>{
  const deps={...defaults,...dependencies},usage=deps.memoryUsage();
  const [aggregate,childCount]=deps.platform==='linux'?await Promise.all([cgroupMemory(deps),children(deps)]):[undefined,null];
  return {
    timestamp:deps.now().toISOString(),
    source:aggregate?.source??'node_process_only',current_bytes:aggregate?.current_bytes??usage.rss,limit_bytes:aggregate?.limit_bytes??null,
    node_rss_bytes:usage.rss,node_heap_used_bytes:usage.heapUsed,node_heap_total_bytes:usage.heapTotal,node_external_bytes:usage.external,node_array_buffers_bytes:usage.arrayBuffers,
    oom_kill_count:aggregate?.oom_kill_count??null,child_process_count:childCount,
  };
}
