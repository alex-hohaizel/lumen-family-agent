import {it} from 'node:test';
import assert from 'node:assert/strict';
import {textEntities} from '../src/presentation.js';
import {Telegram} from '../src/telegram.js';
import {queueText,one} from '../src/db.js';
import {TestDB} from './helpers.js';

it('форматування відхиляє небезпечні посилання, перетини та відсутні фрагменти',()=>{
  const text='abcd текст';const entities=textEntities(text,[{text:'abc',style:'bold'},{text:'bcd',style:'italic'},{text:'текст',style:'text_link',url:'javascript:alert(1)'},{text:'немає',style:'pre'}]);assert.deepEqual(entities,[{type:'bold',offset:0,length:3}]);
  assert.deepEqual(textEntities('1 < 2 & 3',undefined),[]);
});
it('довгий форматований текст ділиться без зламаних Unicode і меж entities',async()=>{
  const db=new TestDB();await db.init();try{
    const text='🙂'.repeat(1800);await queueText(db,text,0,'long',false,{entities:[{type:'bold',offset:0,length:text.length}]});const rows=(await db.query('SELECT body FROM outbox ORDER BY id')).rows;
    assert.equal(rows.length,2);assert.equal(rows.map(x=>x.body.text).join(''),text);for(const row of rows){assert.equal(row.body.entities[0].offset,0);assert.equal(row.body.entities[0].length,row.body.text.length);assert.ok(row.body.text.length<=3500);}
  }finally{await db.close();}
});
it('Telegram отримує entities, нативну вікторину й стікер без платних параметрів',async()=>{
  const requests:{method:string;body:any}[]=[];const tg=new Telegram('fake-test-token',(async(url:any,init:any)=>{requests.push({method:String(url).split('/').at(-1)!,body:JSON.parse(init.body)});return Response.json({ok:true,result:{message_id:42}});}) as typeof fetch);
  await tg.text('-200','Привіт',{entities:[{type:'bold',offset:0,length:6}],threadId:101});await tg.poll('-200','Питання',['А','Б'],101,{correct:1,explanation:'Б'});await tg.sticker('-200','verified_file_id',101);
  assert.deepEqual(requests[0]!.body.entities,[{type:'bold',offset:0,length:6}]);assert.equal(requests[1]!.body.type,'quiz');assert.deepEqual(requests[1]!.body.correct_option_ids,[1]);assert.equal(requests[2]!.body.sticker,'verified_file_id');for(const request of requests){assert.equal(request.body.message_thread_id,101);assert.equal(request.body.allow_paid_broadcast,undefined);}
});
