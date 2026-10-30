import sharp from 'sharp';
sharp.concurrency(1);sharp.cache({memory:8,files:0,items:16});
import {checkOperation,operationSignal} from './operations.js';
// The 512 MB worker can keep conversations alive while one memory-heavy sandbox runs.
let tail:Promise<void>=Promise.resolve();
let waiting=0,active=0,completed=0,cancelled=0,maxWaitMs=0,maxProcessRss=0;
export function workerMetrics(){return {waiting,active,completed,cancelled,max_queue_wait_ms:maxWaitMs,process_peak_rss_bytes:Math.max(maxProcessRss,process.memoryUsage().rss),rss_scope:'node_process_only_children_excluded'};}
export async function withWorkerSlot<T>(fn:()=>Promise<T>):Promise<T>{
  checkOperation();const signal=operationSignal();let release!:()=>void;const entered=Date.now();waiting++;let acquired=false;
  const owned=new Promise<void>(resolve=>{release=resolve;});const prior=tail;
  tail=prior.then(()=>owned);
  let abort!:()=>void;
  try{
    await Promise.race([prior,new Promise<never>((_,reject)=>{abort=()=>reject(signal?.reason||new Error('operation_cancelled'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();})]);
    signal?.removeEventListener('abort',abort);checkOperation();waiting--;active++;acquired=true;maxWaitMs=Math.max(maxWaitMs,Date.now()-entered);maxProcessRss=Math.max(maxProcessRss,process.memoryUsage().rss);const sample=setInterval(()=>{maxProcessRss=Math.max(maxProcessRss,process.memoryUsage().rss);},250);sample.unref();try{return await fn();}finally{clearInterval(sample);completed++;}
  }finally{signal?.removeEventListener('abort',abort);if(acquired)active--;else{waiting--;cancelled++;}release();}
}
