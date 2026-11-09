import {describe,it,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {gateOutcome,toolOutcome,withoutUnconfirmedExecutionClaims} from '../src/outcomes.js';
import {withoutScheduleClaims} from '../src/engine.js';
import {one} from '../src/db.js';
import {TestDB,harness,paired,message} from './helpers.js';
import type {Action} from '../src/model.js';

describe('1.13 iteration4 addendum: generic execution is not future or failed work',()=>{
  it('removes a generic completion assertion while retaining independent material',()=>{
    for(const claim of ['Я вже виконав дію!','Дію вже виконано.','Завдання завершено.','I already completed the task.','The action was executed.']){
      const text='Тримай воду поруч, щоб легше пам’ятати про неї. '+claim;
      assert.equal(withoutScheduleClaims(text),'Тримай воду поруч, щоб легше пам’ятати про неї.',claim);
    }
  });
  it('keeps questions, reported text, quotes, fiction, denial and independent help',()=>{
    const controls=['Чи я вже виконав дію?','Я ще не виконав дію.','I have not yet completed the task.','Ти написав «Я вже виконав дію!».','He said I already completed the task.','Він сказав: я вже виконав дію.','У нашій грі робот вже виконав дію.','Якщо дію виконано, перевір результат.','Я готовий допомогти виконати дію.','Воду зручно тримати поруч із робочим місцем.'];
    for(const text of controls){assert.equal(withoutUnconfirmedExecutionClaims(text),text,text);assert.equal(withoutScheduleClaims(text),text,text);}
  });
  it('failed and queued work cannot certify a generic completion or erase a real partial result',()=>{
    const calendar=toolOutcome('calendar.write',{id:'event',title:'Зустріч',provider_readback:true,receipt:{uid:'event-uid'}});
    for(const fact of [toolOutcome('studio.manage',{status:'queued'}),toolOutcome('studio.manage',{error:'invalid_operation'}),toolOutcome('studio.manage',{error:'soundtrack_required'})]){
      const checked=gateOutcome({reply:'Подію створено. Я вже виконав дію! Корисно тримати воду поруч.',actions:[]},[calendar,fact]);
      assert.equal(checked.blocked,true);assert.doesNotMatch(checked.plan.reply,/вже виконав/u);assert.match(checked.plan.reply,/Подію створено/u);assert.match(checked.plan.reply,/Корисно тримати воду поруч/u);
      for(const reply of ['Чи я вже виконав дію?','Ти написав «Я вже виконав дію!».','У нашій грі робот виконав дію.','Він сказав: я вже виконав дію.'])assert.equal(gateOutcome({reply,actions:[]},[fact]).plan.reply,reply,reply);
    }
  });
});

describe('1.13 iteration4 addendum actual future and failed execution',()=>{
  const db=new TestDB();let h:ReturnType<typeof harness>;
  before(async()=>{await db.init();});beforeEach(async()=>{await db.reset();h=harness(db);await paired(h);});after(async()=>{await db.close();});
  const answer=async()=>String((await one(db,"SELECT body FROM outbox WHERE dedup_key LIKE 'answer:%' ORDER BY id DESC LIMIT 1"))?.body.text||'');
  const schedule=(due_at:string):Action=>({kind:'schedule',title:'Вода',instruction:'Випити воду',mode:'reminder',due_at,timezone:'Europe/Kyiv',authorization:'explicit',quote:'через годину нагадай воду'});
  it('exact full-suite source has one pending reminder and only factual planned confirmation',async()=>{
    h.brain.replies.push({reply:'Я вже виконав дію!',actions:[schedule(new Date(Date.now()+3600000).toISOString())]});
    await h.lumen.receive(message('Люмен, через годину нагадай воду'));await h.lumen.processNext();
    const rows=(await db.query('SELECT status FROM scheduled_actions')).rows;assert.equal(rows.length,1);assert.equal(rows[0]?.status,'pending');assert.doesNotMatch(await answer(),/вже виконав/u);assert.match(await answer(),/Запланував/u);
  });
  it('invalid time retains the independent answer and one real question without generic completion',async()=>{
    h.brain.replies.push({reply:'Тримай воду поруч із робочим місцем. Я вже виконав дію!',actions:[schedule(new Date(Date.now()-60000).toISOString())]});
    await h.lumen.receive(message('Люмен, поясни як пам’ятати про воду, і через годину нагадай воду'));await h.lumen.processNext();
    assert.equal((await db.query('SELECT id FROM scheduled_actions')).rows.length,0);const text=await answer();assert.match(text,/Тримай воду поруч із робочим місцем/u);assert.doesNotMatch(text,/вже виконав|Запланував/u);assert.match(text,/час минув|коректною датою/u);assert.match(text,/LM-[0-9A-Z]{26}/u);assert.equal((text.match(/\?/g)||[]).length,1);
  });
  it('an actual failed studio cannot be rewritten as a generic executed action',async()=>{
    h.brain.replies=[{reply:'',actions:[{kind:'tool',name:'studio.manage',arguments:JSON.stringify({operation:'invalid'})}]},{reply:'Я вже виконав дію! Корисно визначити порядок фото.',actions:[]}];
    await h.lumen.receive(message('Люмен, зроби ролик із фото'));await h.lumen.processNext();
    assert.equal((await db.query('SELECT id FROM media_jobs')).rows.length,0);assert.ok((await db.query("SELECT id FROM tool_runs WHERE status='failed'")).rows.length);const text=await answer();assert.doesNotMatch(text,/вже виконав/u);assert.match(text,/Корисно визначити порядок фото/u);assert.match(text,/Параметри вибраного інструмента не відповідають його контракту/u);assert.match(text,/LM-[0-9A-Z]{26}/u);
  });
});
