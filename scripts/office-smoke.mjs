import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {wordDocument,workbook,officeText,unzipFiles} from '../dist/src/office.js';
import {browsers} from '../dist/src/browser.js';
import {documentText} from '../dist/src/documents.js';
import {scannedPages} from '../dist/src/document-workshop.js';
const docx=wordDocument('Люмен 1.6',['Українська ї є ґ: перевірка 31415']);
const xlsx=workbook([['Назва','Сума'],['Квиток',12.3],['=NOT_A_FORMULA',false]],'Перевірка');
assert.ok(officeText(docx,'sample.docx').includes('ї є ґ'));
assert.ok(officeText(xlsx,'sample.xlsx').includes('12.3'));
const sheet=unzipFiles(xlsx)['xl/worksheets/sheet1.xml'].toString();
assert.ok(sheet.includes('=NOT_A_FORMULA'));assert.equal(sheet.includes('<f>'),false);
try{
 const pdf=await browsers.pdf('<!doctype html><meta charset="utf-8"><h1>Люмен 1.6</h1><p>Українська ї є ґ. Перевірка 31415.</p>');
 await browsers.trim();const text=await documentText(pdf,'sample.pdf');assert.ok(text.includes('31415'));assert.ok(text.includes('ї є ґ'));
 const pages=await scannedPages(pdf);assert.equal(pages.length,1);assert.ok(pages[0].dataUrl.startsWith('data:image/png;base64,'));
 console.log(JSON.stringify({passed:true,checked_at:new Date().toISOString(),checks:['DOCX Unicode readback','XLSX numeric readback','XLSX literal formula text','Chromium PDF generation','PDF Unicode readback','PDF scan rendering'],files:[['docx',docx],['xlsx',xlsx],['pdf',pdf]].map(([format,bytes])=>({format,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})),scan_pages:pages.length,node_rss_mb:Math.round(process.memoryUsage().rss/1048576)}));
}finally{await browsers.close();}
