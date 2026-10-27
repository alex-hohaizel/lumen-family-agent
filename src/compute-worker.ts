import {parentPort,workerData} from 'node:worker_threads';
import {getQuickJS} from 'quickjs-emscripten';

if(parentPort){
  const quick=await getQuickJS(),runtime=quick.newRuntime();
  runtime.setMemoryLimit(32*1024*1024);runtime.setMaxStackSize(512*1024);
  const deadline=Date.now()+1000;runtime.setInterruptHandler(()=>Date.now()>deadline);
  const context=runtime.newContext();
  try{
    const code=`JSON.stringify((function(input){"use strict";\n${workerData.code}\n})(JSON.parse(${JSON.stringify(workerData.input)})))`;
    const outcome=context.evalCode(code,'helper.js');
    if(outcome.error){outcome.error.dispose();parentPort.postMessage({error:Date.now()>deadline?'compute_timeout':'compute_guest_error'});}
    else{const value=context.dump(outcome.value);outcome.value.dispose();if(value!==undefined&&typeof value!=='string')parentPort.postMessage({error:'compute_json_result_required'});else if(value&&value.length>30000)parentPort.postMessage({error:'compute_output_too_large'});else parentPort.postMessage({result:value?JSON.parse(value):null});}
  }catch{parentPort.postMessage({error:'compute_guest_error'});}finally{context.dispose();runtime.dispose();}
}
