import assert from 'node:assert/strict';
import {BrowserTools} from '../dist/src/browser.js';

let writes=0;
const fixture=async(url,options={})=>{
  if(options.method==='POST')writes++;
  return {url,status:200,headers:{'content-type':'text/html; charset=utf-8'},body:Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Люмен: перевірка</title></head><body><h1>${options.method==='POST'?'Підтверджено тестову дію':'Тестова форма'}</h1><form method="post" action="/confirm"><label>Ім’я<input name="name" aria-label="Ім’я"></label><label>Вибір<select name="choice" aria-label="Вибір"><option value="a">А</option><option value="b">Б</option></select></label><button type="submit">Підтвердити</button></form></body></html>`)};
};
const browser=new BrowserTools(fixture);
try{
  const first=await browser.run('A','open',{url:'https://example.com'});assert.equal(first.title,'Люмен: перевірка');assert.ok(first.text.includes('Тестова форма'));
  const input=first.controls.find(c=>c.tag==='input');const second=await browser.run('A','fill',{id:input.id,value:'Олександр'});assert.equal(second.controls.find(c=>c.tag==='input').value,'Олександр');
  const selected=await browser.run('A','select',{id:second.controls.find(c=>c.tag==='select').id,value:'b'});assert.equal(selected.controls.find(c=>c.tag==='select').value,'b');
  const other=await browser.run('B','open',{url:'https://example.com'});assert.equal(other.controls.find(c=>c.tag==='input').value,'');
  await assert.rejects(()=>browser.run('B','click',{id:other.controls.find(c=>c.tag==='button').id}),/browser_operation_failed/);assert.equal(writes,0);
  const before=await browser.run('A','inspect',{});const committed=await browser.run('A','commit',{id:before.controls.find(c=>c.tag==='button').id},'https://example.com');assert.equal(writes,1);assert.ok(committed.text.includes('Підтверджено тестову дію'));
  console.log(JSON.stringify({passed:true,checks:['UTF-8 page','read controls','fill','select','session isolation','unapproved POST blocked','confirmed POST'],writes,node_rss_mb:Math.round(process.memoryUsage().rss/1048576)}));
}finally{await browser.close();}
