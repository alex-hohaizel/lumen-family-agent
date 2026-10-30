import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {packContext} from '../src/context-pack.js';
import {STICKER_SET} from '../src/sticker-pack.js';

test('long scene catalogue retains all own stickers and discoverable tools within the same context cap',async()=>{
 const assets=JSON.parse(await readFile(new URL('../../assets/stickers/manifest.json',import.meta.url),'utf8')) as any[];
 const own=assets.map((asset,i)=>({id:i,emoji:asset.emoji,set_name:STICKER_SET,description:asset.label+'. '+asset.description,keywords:asset.label+', Люмен'}));
 const tools=Array.from({length:143},(_,i)=>({name:'known.tool_'+i,description:'Доступна можливість із повним адресним описом і параметрами виконання для потреб учасників чату.',effect:i%2===0,available:true}));
 const foreign=Array.from({length:32},(_,i)=>({id:1000+i,emoji:'x',set_name:'OtherSet',description:'Інший стікер '.repeat(10),keywords:'інше'}));
 const input={now:new Date(0).toISOString(),current_author:{id:'11'},available_tools:tools,behavior_context:{reference:'Актуальне прохання '.repeat(100)},available_stickers:[...own,...foreign]};
 const packed=packContext(input),result=JSON.parse(packed),catalog=result.available_stickers.filter((x:any)=>x.set_name===STICKER_SET);
 assert.equal(catalog.length,120);assert.equal(new Set(catalog.map((x:any)=>x.emoji)).size,120);
 assert.deepEqual(catalog,own.map(x=>({...x,description:x.description.slice(0,100)})));
 assert.deepEqual(result.available_tools.map((x:any)=>x.name),tools.map(x=>x.name));
 assert.deepEqual(result.available_tools.map((x:any)=>[x.effect,x.available]),tools.map(x=>[x.effect,x.available]));
 assert.ok(Buffer.byteLength(packed)<=72000);
 assert.ok(result.context_coverage.tool_description_max_chars<90);
 assert.equal(result.context_coverage.omitted.available_stickers||0,foreign.length-result.available_stickers.filter((x:any)=>x.set_name==='OtherSet').length);
});

test('replanning preserves honest omission counts instead of replacing them with coverage metadata',()=>{
 const first=JSON.parse(packContext({current_author:{id:'11'},recent:Array.from({length:30},(_,id)=>({id,body:'Розмова '.repeat(100)}))},5000));
 const missing=first.context_coverage.omitted.recent;
 assert.ok(missing>0);
 const secondText=packContext({...first,tool_results_untrusted:[{result:'Результат '.repeat(500)}]},5000),second=JSON.parse(secondText);
 assert.ok(second.context_coverage.omitted.recent>=missing);
 assert.equal('context_coverage' in second.context_coverage.omitted,false);
 assert.ok(Buffer.byteLength(secondText)<=5000);
 assert.equal(second.current_author.id,'11');
});
