import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {TestDB} from './helpers.js';
import {normalizeBehaviorPlan,behaviorAdmission,currentStyleCue} from '../src/behavior-engine.js';
import {gateOutcome} from '../src/outcomes.js';
import {formatText,validEntities,removeEmoji} from '../src/text-document.js';
import {layoutMessage} from '../src/message-layout.js';
import {queueText,one,forgetPhrase} from '../src/db.js';
import {applyPersonalization} from '../src/personalization.js';
import {packContext} from '../src/context-pack.js';
import type {Plan} from '../src/model.js';
const db=new TestDB();const ready=db.init();after(async()=>db.close());
test('explicit silence wins over addressed model actions; quoted silence does not',()=>{
 const plan={reply:'Відповідь',actions:[],behavior:{move:'answer',recipient:'bot',relation:'new_request',reason:'Запит'}} as Plan;
 const silent=normalizeBehaviorPlan(plan,true,[],'Люмен, не відповідай, я допишу');assert.equal(silent.reply,'');assert.deepEqual(silent.actions,[]);assert.equal(behaviorAdmission(silent.behavior,{direct:true,optional:false,otherRecipient:false,reply:silent.reply}).respond,false);
 assert.equal(normalizeBehaviorPlan(plan,true,[],'Переклади «не відповідай».').reply,'Відповідь');assert.equal(currentStyleCue('Переклади “без жартів”'),undefined);
});
test('completion claims cannot hide in cards or behind an unrelated personalization action',()=>{
 const plan={reply:'Ок',actions:[{kind:'personalize',scope:'self',quote:'Називай мене Оля',preferred_name:'Оля'}],presentation:{card:{title:'Документ надіслано',summary:'Є файл'}}} as Plan;assert.equal(gateOutcome(plan,[]).blocked,true);
});
test('large conversational state cannot remove existing tools from discovery',()=>{
 const tools=Array.from({length:200},(_,i)=>({name:'known.tool_'+i,description:'Відома можливість із повним адресним описом',effect:i%2===0})),packed=JSON.parse(packContext({current_author:{id:'11'},behavior_context:{large:'Подробиці справи '.repeat(9000)},personalization:{samples:'Стиль автора '.repeat(5000)},available_tools:tools}));
 assert.deepEqual(packed.available_tools.map((x:any)=>x.name),tools.map(x=>x.name));assert.ok(packed.context_coverage.omitted.behavior_context>0);assert.ok(Buffer.byteLength(JSON.stringify(packed))<=72000);
});
test('formatting preserves code and rejects code/bold overlap; emoji is removed by complete graphemes',()=>{
 const doc=formatText('**Заголовок**\n`x`\n```js\nlet x = 1;\n```');assert.equal(doc.text,'Заголовок\nx\nlet x = 1;\n');assert.equal(doc.entities.filter(e=>['code','pre'].includes(e.type)).length,2);
 assert.equal(validEntities('code',[{type:'bold',offset:0,length:4},{type:'code',offset:0,length:4}]).length,1);assert.equal(removeEmoji('Привіт 👨‍👩‍👧‍👦 🇺🇦!'),'Привіт  !');
});
test('cards retain verified IDs, time and conditions, details retain formatting; keyboard follows complete choices',async()=>{
 await ready;await db.query('DELETE FROM outbox');const required='Нагадування #abc — 12:00 Europe/Kyiv. Ціна 600 грн.';
 const card=await layoutMessage(db,required,{card:{title:'Домовились',summary:'Коротко',facts:[],question:'',details:'**Умови**\nБез повернення.'}},{actorId:'11',topicId:'0',revision:0,key:'test'});assert.ok(card.text.includes(required));const panel=await one(db,'SELECT pages FROM message_panels ORDER BY created_at DESC LIMIT 1');assert.equal(panel!.pages[0].entities[0].type,'bold');
 const family='👨‍👩‍👧‍👦';await queueText(db,family.repeat(600)+'\nПовні варіанти',0,'split',false,{replyMarkup:{inline_keyboard:[[{text:'Обрати',callback_data:'x'}]]}});const rows=(await db.query('SELECT body FROM outbox ORDER BY id')).rows;assert.ok(rows.length>1);assert.equal(rows[0]!.body.replyMarkup,undefined);assert.ok(rows.at(-1)!.body.replyMarkup);assert.equal(rows.map(r=>r.body.text).join(''),family.repeat(600)+'\nПовні варіанти');
});
test('temporary style never becomes durable; forgetting one field retains independent preferences',async()=>{
 await ready;const first=Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES(701,'11','A','user','Називай мене Оля, а сьогодні без жартів') RETURNING id")).rows[0]!.id);
 const m={message_id:701,date:0,chat:{id:-100,type:'supergroup'},from:{id:11,first_name:'A'},text:'Називай мене Оля, а сьогодні без жартів'};
 await applyPersonalization(db,{kind:'personalize',scope:'self',quote:m.text,preferred_name:'Оля',humor:'off'},m,first,true);let pref=await one(db,"SELECT * FROM participant_preferences WHERE user_id='11'");assert.equal(pref!.preferred_name,'Оля');assert.equal(pref!.humor_mode,'');
 const text='Завжди відповідай українською',second=Number((await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES(702,'11','A','user',$1) RETURNING id",[text])).rows[0]!.id);await applyPersonalization(db,{kind:'personalize',scope:'self',quote:text,language:'uk'},{...m,text},second,true);await db.tx(sql=>forgetPhrase(sql,'Називай мене Оля'));pref=await one(db,"SELECT * FROM participant_preferences WHERE user_id='11'");assert.equal(pref!.preferred_name,'');assert.equal(pref!.language,'uk');
});
