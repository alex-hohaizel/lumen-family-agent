import {parentPort,workerData} from 'node:worker_threads';
import {PDFParse} from 'pdf-parse';

if(parentPort){
 const parser=new PDFParse({data:Uint8Array.from(workerData.data||workerData),isEvalSupported:false});
 try{if(workerData.screenshots){const result=await parser.getScreenshot({first:3,desiredWidth:1200,imageDataUrl:true,imageBuffer:false});parentPort.postMessage({pages:result.pages.map(p=>({page:p.pageNumber,dataUrl:p.dataUrl}))});}else{const result=await parser.getText({first:12});parentPort.postMessage({text:result.text.slice(0,30000)});}}catch{parentPort.postMessage({error:'document_parse_failed'});}finally{await parser.destroy();}
}
