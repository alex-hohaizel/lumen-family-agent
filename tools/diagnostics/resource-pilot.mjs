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
try{
 const jobs=await Promise.all([
  browsers.docxPDF(wordDocument('Перевірка навантаження',Array.from({length:120},(_,i)=>'Абзац '+i+'. '+('Український текст із точними числами 1500 і 25%. ').repeat(5)))).then(async b=>({kind:'docx_pdf',pages:(await PDFDocument.load(b)).getPageCount(),bytes:b.length})),
  withWorkerSlot(async()=>{const b=await sharp({create:{width:3200,height:2400,channels:4,background:'#39745e'}}).png().toBuffer();const out=await sharp(b).rotate().resize(1400,1400,{fit:'inside'}).png().toBuffer();return {kind:'photo_decode',bytes:out.length};}),
  withWorkerSlot(async()=>{const out=join(dir,'clip.mp4');await new Promise((resolve,reject)=>{const p=spawn(ffmpeg,['-v','error','-nostdin','-threads','1','-f','lavfi','-i','testsrc2=size=640x640:rate=24','-t','3','-an','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-threads','1','-filter_threads','1','-movflags','+faststart','-y',out],{stdio:'ignore'});p.on('error',reject);p.on('exit',n=>n===0?resolve():reject(Error('ffmpeg '+n)));});const b=await readFile(out);if(b.subarray(4,8).toString()!=='ftyp')throw Error('MP4 invalid');return {kind:'h264_mp4',bytes:b.length};})
 ]);
 await browsers.close();await report('resource-jobs.json',{jobs,heavy_work:workerMetrics()},outputDir);
}finally{await browsers.close();await rm(dir,{recursive:true,force:true});}
