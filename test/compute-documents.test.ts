import {it} from 'node:test';
import assert from 'node:assert/strict';
import {compute} from '../src/compute.js';
import {documentText} from '../src/documents.js';
import {monitoredNumber} from '../src/web-monitors.js';

it('WASM helper computes JSON without host globals or imported modules',async()=>{
  assert.deepEqual(await compute('return {sum: input.reduce((a,b)=>a+b,0),process:typeof process,require:typeof require,fetch:typeof fetch};',[2,4,8]),{sum:14,process:'undefined',require:'undefined',fetch:'undefined'});
  assert.equal(await compute('return ({}).constructor.constructor("return typeof process")();',null),'undefined');
});
it('WASM helper stops infinite loops and caps returned data',async()=>{
  await assert.rejects(()=>compute('while(true) {}',null),/compute_timeout/);
  await assert.rejects(()=>compute('return "a".repeat(40000)',null),/compute_output_too_large/);
});
it('WASM exceptions cannot execute Node operations',async()=>{
  await assert.rejects(()=>compute('return require("node:fs").readFileSync("/etc/passwd")',null),/compute_guest_error/);
});
it('monitor uses the requested label instead of a year, SKU or another arbitrary number',()=>{
  assert.equal(monitoredNumber('2026 Phone 16. Ціна: 1 249,50 EUR.','Ціна')?.value,1249.5);
  assert.equal(monitoredNumber('2026 Немає вказаної ціни','Вартість'),undefined);
  assert.equal(monitoredNumber('Ціна: невідомо\n2026 відвідувань','Ціна'),undefined);
});
it('PDF worker extracts actual page text and fails on invalid PDF',async()=>{
  const stream='BT /F1 18 Tf 40 700 Td (Lumen PDF sample) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n',offsets=[0];for(const [i,object] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  assert.match(await documentText(Buffer.from(pdf),'sample.pdf'),/Lumen PDF sample/);
  await assert.rejects(()=>documentText(Buffer.from('not a PDF'),'bad.pdf'),/document_parse_failed/);
});
