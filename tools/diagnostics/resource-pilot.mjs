import {browsers} from '../../dist/src/browser.js';
import {wordDocument} from '../../dist/src/office.js';
import {withWorkerSlot,workerMetrics} from '../../dist/src/work-slots.js';
import {PDFDocument} from 'pdf-lib';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import {spawn} from 'node:child_process';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {diagnosticOptions,report} from './report.mjs';
const {outputDir}=diagnosticOptions();
const dir=await mkdtemp(join(tmpdir(),'lumen-resource-'));
const children=new Set();let cleanupPromise;
const cleanup=()=>cleanupPromise??=(async()=>{
 for(const child of children)child.kill('SIGTERM');
 try{await browsers.close();}finally{await rm(dir,{recursive:true,force:true});}
})();
const stop=code=>{void cleanup().finally(()=>process.exit(code));};
const terminate=()=>stop(143),interrupt=()=>stop(130);
process.once('SIGTERM',terminate);process.once('SIGINT',interrupt);
const deadline=setTimeout(()=>stop(124),110000);deadline.unref();
try{
 const settled=await Promise.allSettled([
  browsers.docxPDF(wordDocument('Перевірка навантаження',Array.from({length:120},(_,i)=>'Абзац '+i+'. '+('Український текст із точними числами 1500 і 25%. ').repeat(5)))).then(async b=>({kind:'docx_pdf',pages:(await PDFDocument.load(b)).getPageCount(),bytes:b.length})),
  withWorkerSlot(async()=>{const b=await sharp({create:{width:3200,height:2400,channels:4,background:'#39745e'}}).png().toBuffer();const out=await sharp(b).rotate().resize(1400,1400,{fit:'inside'}).png().toBuffer();return {kind:'photo_decode',bytes:out.length};}),
  withWorkerSlot(async()=>{const out=join(dir,'clip.mp4');await new Promise((resolve,reject)=>{const p=spawn(ffmpeg,['-v','error','-nostdin','-threads','1','-f','lavfi','-i','testsrc2=size=640x640:rate=24','-t','3','-an','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-threads','1','-filter_threads','1','-movflags','+faststart','-y',out],{stdio:'ignore'});children.add(p);p.once('error',e=>{children.delete(p);reject(e);});p.once('exit',n=>{children.delete(p);n===0?resolve():reject(Error('ffmpeg '+n));});});const b=await readFile(out);if(b.subarray(4,8).toString()!=='ftyp')throw Error('MP4 invalid');return {kind:'h264_mp4',bytes:b.length};})
 ]);
 const failure=settled.find(result=>result.status==='rejected');if(failure)throw failure.reason;
 const jobs=settled.map(result=>result.value);
 await browsers.close();await report('resource-jobs.json',{event:'resource_pilot_finished',jobs,heavy_work:workerMetrics()},outputDir);
}finally{clearTimeout(deadline);process.removeListener('SIGTERM',terminate);process.removeListener('SIGINT',interrupt);await cleanup();}
