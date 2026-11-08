import {withWorkerSlot} from './work-slots.js';
import {operationSignal} from './operations.js';
import {officeText} from './office.js';
import {Worker} from 'node:worker_threads';
import {ToolError} from './safe-http.js';

export async function documentText(bytes:Uint8Array,name:string){
  if(bytes.byteLength>3000000)throw new ToolError('document_too_large');
  if(/\.(txt|md|csv|json|ics)$/i.test(name))return Buffer.from(bytes).toString('utf8').slice(0,30000);
  if(/\.(docx|xlsx)$/i.test(name))return officeText(bytes,name);
  if(!/\.pdf$/i.test(name))throw new ToolError('document_type_not_supported');
  return withWorkerSlot(async()=>{
  const worker=new Worker(new URL('./document-worker.js',import.meta.url),{execArgv:[],workerData:Uint8Array.from(bytes),resourceLimits:{maxOldGenerationSizeMb:128}});
  return new Promise<string>((resolve,reject)=>{
    let received=false;const signal=operationSignal();const abort=()=>{received=true;clearTimeout(timer);void worker.terminate();reject(new ToolError('document_cancelled'));};signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{void worker.terminate();reject(new ToolError('document_timeout'));},20000);timer.unref();
    worker.once('message',message=>{received=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();if(typeof message?.text==='string')resolve(message.text.slice(0,30000));else reject(new ToolError('document_parse_failed'));});
    worker.once('error',()=>{signal?.removeEventListener('abort',abort);clearTimeout(timer);reject(new ToolError('document_parse_failed'));});
    worker.once('exit',()=>{signal?.removeEventListener('abort',abort);clearTimeout(timer);if(!received)reject(new ToolError('document_parse_failed'));});
  });
  },'document_read');
}
