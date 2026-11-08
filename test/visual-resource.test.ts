import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {TestDB,harness,paired} from './helpers.js';
import {VisualMemory} from '../src/visual.js';
import {ToolError} from '../src/safe-http.js';
import {one} from '../src/db.js';
import type {Telegram} from '../src/telegram.js';
import {mediaFailureNotice} from '../src/media-workshop.js';
import {outcomeMessage,toolOutcome} from '../src/outcomes.js';

test('resource denial preserves an attachment without consuming decode attempts or hot retry',async()=>{
  const db=new TestDB();await db.init();
  try{
    const h=harness(db);await paired(h);
    const source=await one(db,"INSERT INTO messages(user_id,author,role,body) VALUES('11','Synthetic','user','Synthetic attachment') RETURNING id");
    const row=await one(db,"INSERT INTO attachments(source_message_id,kind,file_id,revision) VALUES($1,'photo','synthetic-file',0) RETURNING id",[source!.id]);
    const visual=new VisualMemory(db,h.tg as unknown as Telegram,h.brain);let calls=0;
    visual.frames=async()=>{calls++;throw new ToolError('worker_memory_busy');};
    assert.equal(await visual.next(),true);
    const attachment=await one(db,'SELECT status,attempts FROM attachments WHERE id=$1',[row!.id]);
    assert.equal(attachment!.status,'pending');assert.equal(attachment!.attempts,0);
    assert.equal(await visual.next(),false);assert.equal(calls,1);assert.equal(h.brain.calls.length,0);
    mock.method(Date,'now',()=>Date.parse('2099-01-01T00:00:00Z'));
    try{visual.frames=async()=>{calls++;return {images:[],mode:'image'};};assert.equal(await visual.next(),true);assert.equal(calls,2);}
    finally{mock.restoreAll();}
  }finally{await db.close();}
});

test('resource refusals explain temporary capacity without diagnosing broken user files or promising retries',()=>{
  for(const code of ['worker_memory_busy','worker_queue_busy','worker_queue_timeout']){
    for(const kind of ['album','story'])assert.match(mediaFailureNotice(code,kind),/ресурсів/);
    const message=outcomeMessage([toolOutcome('document.preview_pdf',{error:code})]);
    assert.match(message,/ресурсів/);assert.doesNotMatch(message,/пошкоджен|автоматично спробую/i);
  }
  const uncertain=outcomeMessage([toolOutcome('browser.commit',{status:'uncertain',error:'worker_memory_busy'})]);
  assert.match(uncertain,/перевірити|підтвердити/);
});
