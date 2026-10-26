import { describe,it,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TestDB,harness,paired,message,FakeBrain } from './helpers.js';
import { one,state } from '../src/db.js';
import { startGame,gameTurn,publicGame } from '../src/games.js';
import { Memory } from '../src/memory.js';

describe('Ігри, навички й довга пам’ять',()=>{
  const db=new TestDB();const players=[{id:'11',name:'А'},{id:'22',name:'Б'}];let h:ReturnType<typeof harness>;
  before(async()=>{await db.init();});after(async()=>{await db.close();});beforeEach(async()=>{await db.reset();h=harness(db);await paired(h);});
  it('не допускає двох одночасних ігор',async()=>{
    await db.tx(sql=>startGame(sql,'quiz',players));const response=await db.tx(sql=>startGame(sql,'story',players));assert.match(response,/вже триває/);assert.equal((await db.query("SELECT * FROM games WHERE status='active'")).rows.length,1);
  });
  it('вікторина не приймає повторну відповідь і завершується за п’ять раундів',async()=>{
    await db.tx(sql=>startGame(sql,'quiz',players));await db.tx(sql=>gameTurn(sql,'11','пас'));const again=await db.tx(sql=>gameTurn(sql,'11','інша'));assert.match(again,/вже є/);await db.tx(sql=>gameTurn(sql,'22','пас'));
    for(let i=0;i<4;i++){await db.tx(sql=>gameTurn(sql,'11','пас'));await db.tx(sql=>gameTurn(sql,'22','пас'));}
    const row=await one(db,'SELECT * FROM games');assert.equal(row!.status,'completed');assert.equal(row!.state.round,5);assert.equal(row!.state.scores['11'],0);
  });
  it('вікторина нараховує бали за обидві правильні відповіді',async()=>{
    await db.tx(sql=>startGame(sql,'quiz',players));const row=await one(db,'SELECT * FROM games');row!.state.order=[0,1,2,3,4];await db.query('UPDATE games SET state=$1',[JSON.stringify(row!.state)]);
    await db.tx(sql=>gameTurn(sql,'11','Меркурій'));await db.tx(sql=>gameTurn(sql,'22','Меркурій'));const s=(await one(db,'SELECT state FROM games'))!.state;assert.equal(s.scores['11'],1);assert.equal(s.scores['22'],1);
  });
  it('детектив відкриває підказки послідовно й перевіряє розв’язок',async()=>{
    await db.tx(sql=>startGame(sql,'detective',players));const row=await one(db,'SELECT * FROM games');row!.state.caseIndex=0;await db.query('UPDATE games SET state=$1',[JSON.stringify(row!.state)]);
    assert.match(await db.tx(sql=>gameTurn(sql,'11','підказка')),/олив/);assert.match(await db.tx(sql=>gameTurn(sql,'22','підказка')),/рукава/);assert.match(await db.tx(sql=>gameTurn(sql,'11','Тарас')),/Справу закрито/);assert.equal((await one(db,'SELECT status FROM games'))!.status,'completed');
  });
  it('20 запитань не передає секрет у загальний контекст і рахує лише розпізнані ознаки',async()=>{
    await db.tx(sql=>startGame(sql,'twenty',players));const row=await one(db,'SELECT * FROM games');row!.state.secret=0;await db.query('UPDATE games SET state=$1',[JSON.stringify(row!.state)]);
    assert.ok(!('secret' in publicGame(row)));assert.match(await db.tx(sql=>gameTurn(sql,'11','це тварина?')),/Так/);assert.match(await db.tx(sql=>gameTurn(sql,'22','абракадабра?')),/не рахую/);assert.equal((await one(db,'SELECT state FROM games'))!.state.questions,1);assert.match(await db.tx(sql=>gameTurn(sql,'22','кіт')),/Вгадали/);
  });
  it('історія зберігає порядок, відхиляє позачерговий хід і має завершення',async()=>{
    await db.tx(sql=>startGame(sql,'story',players));assert.match(await db.tx(sql=>gameTurn(sql,'22','рано')),/Зараз хід/);
    for(let i=0;i<12;i++)await db.tx(sql=>gameTurn(sql,i%2?'22':'11',`Речення ${i+1}.`));const row=await one(db,'SELECT * FROM games');assert.equal(row!.status,'completed');assert.equal(row!.state.segments.length,13);
  });
  it('аргументи дають кожному рівно два ходи',async()=>{
    await db.tx(sql=>startGame(sql,'debate',players));for(let i=0;i<4;i++)await db.tx(sql=>gameTurn(sql,i%2?'22':'11',`Аргумент ${i+1}`));assert.equal((await one(db,'SELECT status FROM games'))!.status,'completed');
  });
  it('вікторина приймає понад двадцять гравців без штучної межі',async()=>{
    const many=Array.from({length:31},(_,i)=>({id:String(100+i),name:`Гравець ${i}`}));await db.tx(sql=>startGame(sql,'quiz',many));for(const p of many)await db.tx(sql=>gameTurn(sql,p.id,'пас'));const row=await one(db,'SELECT state FROM games');assert.equal(row!.state.players.length,31);assert.equal(row!.state.round,1);
  });
  it('аргументи працюють для компанії й дають кожному два ходи',async()=>{
    const company=Array.from({length:5},(_,i)=>({id:String(100+i),name:`Гравець ${i}`}));await db.tx(sql=>startGame(sql,'debate',company));for(let i=0;i<10;i++)await db.tx(sql=>gameTurn(sql,company[i%5]!.id,`Аргумент ${i}`));const row=await one(db,'SELECT * FROM games');assert.equal(row!.state.players.length,5);assert.equal(row!.status,'completed');assert.equal(row!.state.turn,10);
  });
  it('відкрита партія приймає нового гравця під час гри',async()=>{
    await db.tx(sql=>startGame(sql,'quiz',players,undefined,'0',true));await db.tx(sql=>gameTurn(sql,'33','пас','0',{id:'33',name:'Новий гравець'}));await db.tx(sql=>gameTurn(sql,'11','пас'));await db.tx(sql=>gameTurn(sql,'22','пас'));const row=await one(db,'SELECT state FROM games');assert.equal(row!.state.players.length,3);assert.equal(row!.state.round,1);
  });
  it('гра за збереженими правилами не закінчується примусово після 20 ходів',async()=>{
    await db.query("INSERT INTO rules(title,content,author_id) VALUES('Без кінця','Додаємо по слову, поки не вирішимо завершити.','11')");await db.tx(sql=>startGame(sql,'custom',players,'Без кінця'));for(let i=0;i<24;i++)await db.tx(sql=>gameTurn(sql,players[i%2]!.id,`Слово ${i}`));const row=await one(db,'SELECT * FROM games');assert.equal(row!.status,'active');assert.equal(row!.state.turn,24);
  });
  it('зберігає нові правила та запускає саме збережену гру',async()=>{
    h.brain.replies.push({reply:'',actions:[{kind:'learn_game',title:'Одне слово',rules:'По черзі додаємо по слову до спільної історії. Після 20 ходів читаємо її разом.'}]});await h.lumen.receive(message('Люмен, вивчи гру «Одне слово»: додаємо слова по черзі.'));await h.lumen.processNext();await h.lumen.receive(message('/game Одне слово'));
    const row=await one(db,'SELECT * FROM games');assert.equal(row!.kind,'custom');assert.equal(row!.state.title,'Одне слово');assert.match(row!.state.rules,/По черзі/);
  });
  it('нова навичка потрапляє в наступний контекст і переживає перезапуск',async()=>{
    h.brain.replies.push({reply:'',actions:[{kind:'learn_skill',title:'Наш вечір',instructions:'Запитай кожного про одну добру подію дня, потім запропонуй маленьку спільну активність.'}]});await h.lumen.receive(message('Люмен, навчися навички «Наш вечір»: коротке обговорення дня.'));await h.lumen.processNext();
    const fresh=harness(db);await fresh.lumen.receive(message('Люмен, використай навичку «Наш вечір».'));await fresh.lumen.processNext();assert.match(fresh.brain.calls[0]!.context,/Наш вечір/);assert.equal((await one(db,'SELECT author_id FROM skills'))!.author_id,'11');
  });
  async function enoughMessages(){for(let i=0;i<60;i++)await db.query("INSERT INTO messages(user_id,author,role,body) VALUES ($1,$2,'user',$3)",[i%2?'11':'22',i%2?'А':'Б',`Спільна подія ${i}`]);}
  it('підсумок посилається на справжні джерела, а оригінали залишаються',async()=>{
    await enoughMessages();const brain=new FakeBrain();brain.text=async()=>JSON.stringify({summary:'Учасники обговорили спільні події.',source_ids:[1,2,3]});const memory=new Memory(db,brain);assert.equal(await memory.compact(),true);assert.equal((await db.query('SELECT * FROM messages')).rows.length,60);assert.equal((await one(db,'SELECT source_ids FROM episodes'))!.source_ids.length,3);assert.equal(await memory.compact(),false);
  });
  it('підсумок із вигаданими посиланнями не зберігається',async()=>{
    await enoughMessages();const brain=new FakeBrain();brain.text=async()=>JSON.stringify({summary:'Вигадка',source_ids:[999999]});assert.equal(await new Memory(db,brain).compact(),false);assert.equal((await db.query('SELECT * FROM episodes')).rows.length,0);
  });
  it('забування під час формування підсумку не дозволяє відновити стерту пам’ять',async()=>{
    await enoughMessages();const brain=new FakeBrain();let resolve!:(v:string)=>void;brain.text=()=>new Promise(r=>{resolve=r;});const compact=new Memory(db,brain).compact();while(!resolve)await new Promise(r=>setTimeout(r,1));await h.lumen.receive(message('/forget_all'));resolve(JSON.stringify({summary:'Старий підсумок',source_ids:[1]}));assert.equal(await compact,false);assert.equal((await db.query('SELECT * FROM episodes')).rows.length,0);assert.equal((await state(db)).memory_revision,1);
  });
});
