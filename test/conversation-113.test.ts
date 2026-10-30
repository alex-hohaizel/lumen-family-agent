import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TestDB,harness,paired,message} from './helpers.js';
import {contextualKeyboard} from '../src/presentation.js';
import {layoutMessage} from '../src/message-layout.js';
import {OutboundLocalizer} from '../src/localization.js';
import {SessionEngine} from '../src/session-engine.js';
import {PrivateInbox} from '../src/private-inbox.js';
import {one} from '../src/db.js';
import type {Brain} from '../src/model.js';
import type {ToolContext} from '../src/agent-tools.js';
import type {Telegram} from '../src/telegram.js';

test('переклад зберігає весь файл із числовою назвою, його формат і URL',async()=>{
  const db=new TestDB();await db.init();try{
    await db.query("INSERT INTO chat_preferences(id,language) VALUES(1,'en')");
    const source='Завантаж 2026.pdf і 12.5.csv: https://example.com/2026.pdf';
    const translator=(rewrite:(s:string)=>string):Brain=>({plan:async()=>({reply:'',actions:[]}),structured:async input=>({texts:JSON.parse(input[0].content).texts.map(rewrite)}),text:async()=>{throw Error('structured translation required');}});
    const correct=await new OutboundLocalizer(db,translator(s=>s.replace('Завантаж','Download').replace(' і ',' and '))).transform('sendMessage',{chat_id:'-100',text:source});
    assert.equal(correct.text,'Download 2026.pdf and 12.5.csv: https://example.com/2026.pdf');
    for(const [from,to] of [['2026.pdf','2026.docx'],['12.5.csv','12.5.xlsx']]){
      await assert.rejects(new OutboundLocalizer(db,translator(s=>s.replace(from!,to!))).transform('sendMessage',{chat_id:'-100',text:source}),/localization_unavailable/);
    }
  }finally{await db.close();}
});

test('довгі схожі варіанти залишаються різними на кнопках і в збереженому особистому виборі',async()=>{
  const db=new TestDB();await db.init();try{
    const labels=['Забрати ліки завтра до дев’ятої','Забрати ліки завтра після дев’ятої'];
    const p={choices:labels,audience:'personal' as const},m=message('Люмен, коли забрати ліки?').message!;
    const keys=await contextualKeyboard(db,p,m,0,'Коли забрати ліки?');
    assert.deepEqual(keys!.inline_keyboard.flat().map(x=>x.text),labels);
    const rows=(await db.query('SELECT label,target_user_id,audience FROM choices ORDER BY label')).rows;
    assert.deepEqual(rows.map(x=>x.label).sort(),[...labels].sort());
    assert.ok(rows.every(x=>x.audience==='personal'&&x.target_user_id==='11'));
    assert.equal(new Set(keys!.inline_keyboard.flat().map(x=>x.callback_data)).size,2);
    const output=await layoutMessage(db,'Обери зручний час.',p,{actorId:'11',topicId:'0',revision:0,key:'choices'},keys);
    for(const label of labels)assert.ok(output.text.includes(label));
  }finally{await db.close();}
});

test('переклад власного тексту не змінює код, назву файла й процитований оригінал',async()=>{
  const db=new TestDB();await db.init();try{
    await db.query("INSERT INTO chat_preferences(id,language) VALUES(1,'en')");
    const source='Олю, відкрий plan_v3.docx. Код: x = false. Оригінал: Не змінюй цю фразу.';
    const code='x = false',quote='Не змінюй цю фразу.';
    const request={chat_id:'-100',text:source,entities:[{type:'code',offset:source.indexOf(code),length:code.length},{type:'blockquote',offset:source.indexOf(quote),length:quote.length}],reply_markup:{inline_keyboard:[[{text:'Відкрити файл',callback_data:'file:original',url:'https://example.com/plan_v3.docx'}]]}};
    const translator=(rewrite:(s:string)=>string):Brain=>({plan:async()=>({reply:'',actions:[]}),structured:async input=>({texts:JSON.parse(input[0].content).texts.map(rewrite)}),text:async()=>{throw Error('structured translation required');}});
    const translated=await new OutboundLocalizer(db,translator(s=>s.replace('Олю, відкрий','Olia, open').replace('Код:','Code:').replace('Оригінал:','Original:').replace('Відкрити файл','Open file'))).transform('sendMessage',request);
    assert.ok(translated.text.includes('plan_v3.docx'));assert.ok(translated.text.includes(code));assert.ok(translated.text.includes(quote));
    assert.equal(translated.reply_markup.inline_keyboard[0][0].callback_data,'file:original');
    assert.equal(translated.reply_markup.inline_keyboard[0][0].url,'https://example.com/plan_v3.docx');
    for(const [from,to] of [['plan_v3.docx','plan_v3.pdf'],[code,'x = true'],[quote,'This quote was changed.']]){
      await assert.rejects(new OutboundLocalizer(db,translator(s=>s.replace(from!,to!))).transform('sendMessage',request),/localization_unavailable/);
    }
    await db.query("UPDATE chat_preferences SET emoji_mode='off'");
    const original='Сумно 😢',emojiSource='Готово 🎉\n'+original;
    const withoutOwnEmoji=await new OutboundLocalizer(db,translator(s=>s)).transform('sendMessage',{text:emojiSource,entities:[{type:'blockquote',offset:emojiSource.indexOf(original),length:original.length}]});
    assert.ok(!withoutOwnEmoji.text.includes('🎉'));assert.ok(withoutOwnEmoji.text.includes(original));
  }finally{await db.close();}
});

test('повна пояснювальна відповідь зберігає сім умов у чаті та додаткові подробиці',async()=>{
  const db=new TestDB();await db.init();try{
    const conditions=['Виїзд 07:30.','Квиток коштує 420 грн.','Пересадка триває 18 хвилин.','Повернення до 20:00.','Одна валіза до 10 кг.','Повернення квитка за 24 години.','Джерело: https://example.com/timetable.'];
    const reply='Обирай ранковий потяг.\n\n'+conditions.join('\n'),details='Пояснення вибору: запас часу дає змогу спокійно перейти між платформами.';
    const output=await layoutMessage(db,reply,{card:{title:'Поїздка',summary:'Ранковий потяг.',facts:[],question:'',details}},{actorId:'11',topicId:'0',revision:0,key:'seven-conditions',fullRequested:true});
    for(const condition of conditions)assert.ok(output.text.includes(condition));
    assert.ok(output.text.includes(details));assert.ok(output.text.includes('Обирай ранковий потяг.'));
    const panel=await one(db,'SELECT pages FROM message_panels');assert.equal(panel!.pages.map((p:any)=>p.text).join(''),details);
  }finally{await db.close();}
});

test('таємна умова історії пояснює публічний хід без внутрішньої команди й лишається особистою',async()=>{
  const db=new TestDB();await db.init();try{
    const h=harness(db);await paired(h);
    const c:ToolContext={actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:'story-copy',requested:true};
    const sessions=new SessionEngine(db,h.config.runtimeDir),game=await sessions.create({template:'story',title:'Вечірня історія',rounds:1},c);
    await sessions.join(game.id,'22','Оля');await sessions.start(game.id,c);
    const requests=(await db.query('SELECT * FROM private_requests ORDER BY recipient_id')).rows;assert.equal(requests.length,2);
    const own=requests[0]!,inbox=new PrivateInbox(db,h.config.runtimeDir);
    assert.equal(await inbox.open(own.token,'22',h.tg as unknown as Telegram),false);
    await inbox.open(own.token,'11',h.tg as unknown as Telegram);
    const dm=h.tg.sent.at(-1)!;assert.equal(dm.chatId,'11');assert.match(dm.text,/речення.*груп|груп.*речення/iu);assert.match(dm.text,/черг/iu);assert.doesNotMatch(dm.text,/activity\.turn/);
    assert.ok(dm.text.includes(own.question));assert.equal(h.tg.sent.length,1);
    assert.equal(h.tg.options.at(-1)!.replyMarkup,undefined);assert.equal(await inbox.pending('11'),undefined);
    assert.equal(await inbox.choose({id:'old-story-button',from:{id:11,first_name:'Гравець'},data:'lumen:pv:'+own.token+':reveal'},h.tg as unknown as Telegram),true);
    assert.equal(await inbox.pending('11'),undefined);assert.equal(h.tg.options.at(-1)!.replyMarkup,undefined);
    assert.match(h.tg.sent.at(-1)!.text,/Відповідати тут.*не потрібно/);
    assert.ok((await db.query('SELECT audience FROM outbox')).rows.every(x=>x.audience==='private'));
    await sessions.turn(game.id,'На вокзалі згас останній ліхтар.',c);
    assert.equal((await one(db,'SELECT public_state FROM activity_sessions WHERE id=$1',[game.id]))!.public_state.story[0].text,'На вокзалі згас останній ліхтар.');
  }finally{await db.close();}
});

test('інший особистий запит залишає вибір видимості та приймає відповідь лише від адресата',async()=>{
  const db=new TestDB();await db.init();try{
    const h=harness(db);await paired(h);
    const inbox=new PrivateInbox(db,h.config.runtimeDir),c:ToolContext={actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:'private-copy',requested:true};
    const request=await inbox.ask(c,'22','Які дати тобі підходять?','Поїздка компанією');
    const row=(await one(db,'SELECT token FROM private_requests WHERE id=$1',[request.id]))!;
    assert.equal(await inbox.open(row.token,'11',h.tg as unknown as Telegram),false);
    assert.equal(await inbox.open(row.token,'22',h.tg as unknown as Telegram),true);
    assert.match(h.tg.sent.at(-1)!.text,/Обери спосіб використання, потім напиши відповідь/);
    const buttons=h.tg.options.at(-1)!.replyMarkup!.inline_keyboard.flat();assert.equal(buttons.length,3);
    assert.equal(await inbox.choose({id:'private-choice',from:{id:22,first_name:'Оля'},data:'lumen:pv:'+row.token+':task'},h.tg as unknown as Telegram),true);
    assert.equal((await inbox.pending('22'))!.sharing,'task');assert.match(h.tg.sent.at(-1)!.text,/Надішли відповідь одним повідомленням/);
    let saved='';await inbox.answer((await inbox.pending('22'))!,message('Субота після 11:00',22).message!,async(_r,text)=>{saved=text;});assert.equal(saved,'Субота після 11:00');
    assert.equal((await one(db,'SELECT status FROM private_requests WHERE id=$1',[request.id]))!.status,'answered');
  }finally{await db.close();}
});

test('старий story prompt звільняє наступну DM, зберігаючи іншу приватну задачу й стару відповідь',async()=>{
  const db=new TestDB();await db.init();try{
    const h=harness(db);await paired(h);
    const c:ToolContext={actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:'legacy-story',requested:true};
    const sessions=new SessionEngine(db,h.config.runtimeDir),game=await sessions.create({template:'story',title:'Стара історія',rounds:1},c);
    await sessions.join(game.id,'22','Оля');await sessions.start(game.id,c);
    const own=(await one(db,"SELECT id,token FROM private_requests WHERE recipient_id='11' AND session_id=$1",[game.id]))!;
    const inbox=new PrivateInbox(db,h.config.runtimeDir),independent=await inbox.ask({...c,updateId:'independent-private'},'11','Коли тобі зручно зустрітися?','Планування зустрічі');
    const other=(await one(db,'SELECT token FROM private_requests WHERE id=$1',[independent.id]))!;
    await inbox.choose({id:'independent-choice',from:{id:11,first_name:'Гравець'},data:'lumen:pv:'+other.token+':task'},h.tg as unknown as Telegram);
    await db.query("UPDATE private_requests SET status='answering',sharing='quote',answer='private_legacy_answer' WHERE id=$1",[own.id]);
    assert.equal(await inbox.open(own.token,'11',h.tg as unknown as Telegram),true);
    assert.equal((await one(db,'SELECT status FROM private_requests WHERE id=$1',[own.id]))!.status,'offered');
    assert.equal((await inbox.pending('11'))!.id,independent.id);
    await db.query("UPDATE private_requests SET status='answering' WHERE id=$1",[own.id]);
    assert.equal(await inbox.choose({id:'legacy-choice',from:{id:11,first_name:'Гравець'},data:'lumen:pv:'+own.token+':quote'},h.tg as unknown as Telegram),true);
    assert.equal((await one(db,'SELECT status,answer FROM private_requests WHERE id=$1',[own.id]))!.answer,'private_legacy_answer');
    assert.equal((await inbox.pending('11'))!.id,independent.id);assert.ok(h.tg.sent.every(x=>!x.text.includes('private_legacy_answer')));
    let saved='';await inbox.answer((await inbox.pending('11'))!,message('У суботу о 12:00').message!,async(r,text)=>{assert.equal(r.id,independent.id);saved=text;});assert.equal(saved,'У суботу о 12:00');
    await db.query('UPDATE app_state SET paused=true,memory_revision=memory_revision+1');
    assert.equal(await inbox.open(own.token,'11',h.tg as unknown as Telegram),false);
  }finally{await db.close();}
});
