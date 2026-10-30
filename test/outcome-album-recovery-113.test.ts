import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gateOutcome,outcomeMessage,toolOutcome} from '../src/outcomes.js';
import type {Plan} from '../src/model.js';

test('album failure recovery keeps the requested medium and a usable next step',()=>{
 for(const error_code of ['worker_interrupted','render_time_limit','corrupt_pdf','album_failed','select_materials_first']){
  const fact=toolOutcome('archive.manage',{id:'album-current',kind:'album',status:'repair',error_code});
  const reply=outcomeMessage([fact]);
  assert.match(reply,/альбом/iu,error_code);
  assert.doesNotMatch(reply,/ролик|монтаж|mp4|pdf|worker|error|render/iu,error_code);
  assert.match(reply,/мож|спроб|попрос|надішли|перевір/iu,error_code);
 }
});

test('album recovery replaces false delivery while keeping independently helpful content',()=>{
 const plan={reply:'Готово! Забирай альбом.\nЗустрічаємося біля входу о 10:00.',actions:[]} as unknown as Plan;
 const fact=toolOutcome('archive.manage',{id:'album-current',status:'repair',error_code:'worker_interrupted'});
 const result=gateOutcome(plan,[fact]);
 assert.equal(result.blocked,true);
 assert.match(result.plan.reply,/альбом/iu);
 assert.match(result.plan.reply,/біля входу о 10:00/iu);
 assert.doesNotMatch(result.plan.reply,/готово|забирай|ролик|монтаж/iu);
 assert.equal(result.facts[0]?.status,'failed');
});

test('story, uncertain external delivery and stale sources retain distinct recovery semantics',()=>{
 const story=outcomeMessage([toolOutcome('studio.manage',{kind:'story',status:'repair',error_code:'worker_interrupted'})]);
 assert.match(story,/ролик|монтаж/iu);assert.doesNotMatch(story,/альбом/iu);
 const uncertain=outcomeMessage([toolOutcome('archive.manage',{kind:'album',status:'uncertain',error_code:'delivery_unconfirmed'})]);
 assert.match(uncertain,/перевірити|підтвердити/iu);assert.match(uncertain,/дубль/iu);
 assert.doesNotMatch(uncertain,/попросити зібрати|спробувати ще раз/iu);
 const stale=outcomeMessage([toolOutcome('archive.manage',{kind:'album',status:'stale',error_code:'source_version_changed'})]);
 assert.match(stale,/матеріали змінилися/iu);
 const unknown=outcomeMessage([toolOutcome('other.manage',{status:'failed',error_code:'unavailable'})]);
 assert.doesNotMatch(unknown,/альбом|ролик|монтаж/iu);
});
