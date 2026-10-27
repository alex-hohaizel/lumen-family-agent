import {checkOperation,operationSignal} from './operations.js';
// The 512 MB worker can keep conversations alive while one memory-heavy sandbox runs.
let tail:Promise<void>=Promise.resolve();
export async function withWorkerSlot<T>(fn:()=>Promise<T>):Promise<T>{
  checkOperation();const signal=operationSignal();let release!:()=>void;
  const owned=new Promise<void>(resolve=>{release=resolve;});const prior=tail;
  tail=prior.then(()=>owned);
  let abort!:()=>void;
  try{
    await Promise.race([prior,new Promise<never>((_,reject)=>{abort=()=>reject(signal?.reason||new Error('operation_cancelled'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();})]);
    signal?.removeEventListener('abort',abort);checkOperation();return await fn();
  }finally{signal?.removeEventListener('abort',abort);release();}
}
