import {after,before,beforeEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {independentAction} from '../src/engine.js';
import {ModelError} from '../src/auth.js';
import {one} from '../src/db.js';
import type {Action} from '../src/model.js';
import {TestDB,harness,paired,message} from './helpers.js';

const exactCommaRequest='Люмен, додай молоко до покупок, а якщо буде потрібно, потім розберемо запаси, і через годину нагадай про аптеку';
const exactExplanation='Список покупок зберігає потрібні товари. Запаси показують наявні вдома продукти. Для запасів важливі кількості та одиниці виміру.';
const schedule=(quote='через годину нагадай про аптеку'):Extract<Action,{kind:'schedule'}>=>({kind:'schedule',title:'Аптека',instruction:'Зайти в аптеку',mode:'reminder',authorization:'explicit',timezone:'UTC',due_at:new Date(Date.now()+3600000).toISOString(),quote});
const listTool:Action={kind:'tool',name:'lists.manage',arguments:JSON.stringify({operation:'add',category:'shopping',text:'молоко',quote:'додай молоко до покупок'})};

describe('1.13 iteration3 exact returned causal boundaries',()=>{
  it('R2-C03 ends a detached discussion condition before a fresh independent reminder',()=>{
    assert.equal(independentAction(schedule(),exactCommaRequest),true);
    assert.equal(independentAction(schedule(exactCommaRequest),exactCommaRequest),true);
    const variant='Люмен, додай молоко до покупок, а якщо буде потрібно, пізніше обговоримо запаси, і через годину нагадай про аптеку';assert.equal(independentAction(schedule(),variant),true);
  });
  it('R2-C04 retains prefix, suffix and genuinely shared reminder conditions',()=>{
    for(const request of [
      'Люмен, нагадай про аптеку, якщо ролик буде готовий',
      'Люмен, якщо ролик буде готовий, через годину нагадай про аптеку',
      'Люмен, коли ролик буде готовий, нагадай про аптеку',
      'Люмен, якщо буде потрібно, потім розберемо запаси і через годину нагадай про аптеку',
      'Люмен, додай молоко, а якщо буде потрібно, потім розберемо аптеку, і через годину нагадай про аптеку',
      'Люмен, додай молоко, а якщо буде потрібно, потім розберемо запаси, і через годину нагадай про аптеку, якщо ролик буде готовий'
    ])assert.equal(independentAction(schedule('нагадай про аптеку'),request),false,request);
  });
});

describe('1.13 iteration3 real engine preservation',()=>{
  const db=new TestDB();let h:ReturnType<typeof harness>;
  before(async()=>{await db.init();});beforeEach(async()=>{await db.reset();h=harness(db);await paired(h);});after(async()=>{await db.close();});
  const answer=async()=>String((await db.query("SELECT body->>'text' AS text FROM outbox WHERE dedup_key LIKE 'answer:%' ORDER BY id DESC LIMIT 1")).rows[0]?.text||'');
  const schedules=async()=>Number((await db.query('SELECT count(*)::int AS n FROM scheduled_actions')).rows[0]?.n||0);

  it('R2-C14 preserves every substantive sentence and asks for the invalid time once without storing a schedule',async()=>{
    const invalid={...schedule(),due_at:new Date(Date.now()-3600000).toISOString()};h.brain.replies=[{reply:exactExplanation,actions:[invalid]}];await h.lumen.receive(message('Люмен, поясни різницю між списком і запасами. Також через годину нагадай про аптеку'));await h.lumen.processNext();
    const visible=await answer();assert.ok(visible.includes(exactExplanation));assert.equal(await schedules(),0);assert.equal((visible.match(/На яку дату й годину запланувати дію\?/gu)||[]).length,1);assert.doesNotMatch(visible,/Запланував|Заплановано|Нагадаю|schedule_time_invalid/u);
  });
  it('invalid schedule keeps independent presentation facts and strips a false scheduling promise',async()=>{
    const facts=['У списку кількість може бути відсутня.','Для запасів, наприклад, важливі 2 літри молока.'];h.brain.replies=[{reply:exactExplanation+' Нагадаю про аптеку завтра о 19:00.',actions:[{...schedule(),due_at:new Date(Date.now()-3600000).toISOString()}],presentation:{card:{title:'Покупки й запаси',summary:'Це різні побутові задачі.',facts,question:'Показати ще приклад?'}}}];await h.lumen.receive(message('Люмен, поясни докладно різницю між списком і запасами. Також через годину нагадай про аптеку'));await h.lumen.processNext();
    const visible=await answer();assert.ok(visible.includes(exactExplanation));for(const fact of facts)assert.ok(visible.includes(fact));assert.equal(await schedules(),0);assert.equal((visible.match(/\?/gu)||[]).length,1);assert.match(visible,/На яку дату й годину/u);assert.doesNotMatch(visible,/завтра о 19:00|Нагадаю|Запланував|Показати ще приклад/u);
  });
  it('R2-C03 actual committed list plus empty replan retains the comma-coordinated reminder once',async()=>{
    h.brain.replies=[{reply:'',actions:[listTool,schedule()]},{reply:'Додав у покупки: молоко.',actions:[]}];await h.lumen.receive(message(exactCommaRequest));await h.lumen.processNext();assert.equal((await db.query('SELECT count(*)::int AS n FROM simple_list_events')).rows[0]?.n,1);assert.equal(await schedules(),1);assert.match(await answer(),/молоко/u);assert.match(await answer(),/аптеку/u);
  });
  it('the same explicit comma-coordinated reminder survives a restart after the list committed',async()=>{
    h.brain.replies=[{reply:'',actions:[listTool,schedule()]}];const original=h.brain.plan.bind(h.brain);let calls=0;h.brain.plan=async input=>{if(++calls===2)throw new ModelError('model_network');return original(input);};const update=message(exactCommaRequest);await h.lumen.receive(update);await h.lumen.processNext();assert.equal((await one(db,'SELECT payload FROM inbox WHERE update_id=$1',[update.update_id]))?.payload.pendingIndependent.length,1);
    const restarted=harness(db);restarted.brain.replies=[{reply:'Покупки додав.',actions:[]}];await db.query('UPDATE inbox SET available_at=now() WHERE update_id=$1',[update.update_id]);await restarted.lumen.processNext();assert.equal(await schedules(),1);assert.equal((await db.query('SELECT count(*)::int AS n FROM simple_list_events')).rows[0]?.n,1);
  });
  it('a failed attempt does not authorize a genuinely conditional reminder returned again by the model',async()=>{
    for(const request of ['Люмен, якщо ролик буде готовий, через годину нагадай про аптеку','Люмен, через годину нагадай про аптеку, якщо ролик буде готовий']){
      const conditional=schedule('нагадай про аптеку');h.brain.replies=[{reply:'',actions:[{kind:'tool',name:'studio.manage',arguments:'{"operation":"invalid"}'},conditional]},{reply:'Нагадування залежить від готовності ролика.',actions:[conditional]}];await h.lumen.receive(message(request));await h.lumen.processNext();assert.equal(await schedules(),0,request);
    }
  });
});
