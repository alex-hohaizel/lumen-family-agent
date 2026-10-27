import {parentPort,workerData} from 'node:worker_threads';
import {PDFParse} from 'pdf-parse';

if(parentPort){
 const parser=new PDFParse({data:Uint8Array.from(workerData),isEvalSupported:false});
 try{const result=await parser.getText({first:12});parentPort.postMessage({text:result.text.slice(0,30000)});}catch{parentPort.postMessage({error:'document_parse_failed'});}finally{await parser.destroy();}
}
