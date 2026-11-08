import {withWorkerSlot} from './work-slots.js';
import {operationSignal,checkOperation} from './operations.js';
import {Worker} from 'node:worker_threads';
import {ToolError} from './safe-http.js';

/** Guest JavaScript runs in WASM, with no Node, filesystem, sockets or host callbacks. */
export async function compute(code:string,input:unknown){
  checkOperation();const json=JSON.stringify(input??null);
  if(code.length>16000||json.length>64000)throw new ToolError('compute_input_too_large');
  return withWorkerSlot(async()=>{
  const worker=new Worker(new URL('./compute-worker.js',import.meta.url),{execArgv:[],workerData:{code,input:json},resourceLimits:{maxOldGenerationSizeMb:96}});
  return new Promise<unknown>((resolve,reject)=>{
    let settled=false;const signal=operationSignal();const abort=()=>finish('compute_cancelled');
    const finish=(error?:string,result?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();error?reject(new ToolError(error)):resolve(result);};
    const timer=setTimeout(()=>finish('compute_timeout'),5000);timer.unref();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    worker.once('message',m=>finish(m?.error,m?.result));
    worker.once('error',()=>finish('compute_failed'));
    worker.once('exit',()=>{if(!settled)finish('compute_failed');});
  });
  },'compute');
}
