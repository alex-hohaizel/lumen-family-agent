import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TestDB,FakeTelegram,harness} from './helpers.js';
import {one,state,forgetPhrase,type Database} from '../src/db.js';
import {GameResults,forgetGameResultSource,purgeGameResultPhrase} from '../src/game-results.js';
import {MediaBrowser} from '../src/media-browser.js';
import {BrowseQuery} from '../src/media-assets.js';
import {AgentTools} from '../src/agent-tools.js';
import type {ToolContext} from '../src/agent-tools.js';
import type {MediaWorkshop} from '../src/media-workshop.js';

// Legal completed-game fixtures and genuine user messages. No Telegram network.
let db:TestDB,results:GameResults,n=90000;
type Kind='games'|'activity_sessions';
const c=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:String(++n),requested:true,audience:'group',...extra});
const source=async(body:string,actor='11',topic='0')=>Number((await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES($1,$2,$2,'user',$3,$4) RETURNING id",[++n,actor,body,topic]))!.id);
async function game(kind:Kind,baseSource?:number,phase='completed',host='22'){
 const interaction=randomUUID();let key:string;
 if(kind==='games'){await db.query("INSERT INTO interactions(id,actor_id,topic_id,kind,spec,participants,phase,revision) VALUES($1,$2,'0','activity','{}','[]','completed',0)",[interaction,host]);key=String((await one(db,"INSERT INTO games(kind,state,status,source_ids) VALUES('quiz',$1,$2,$3) RETURNING id",[JSON.stringify({title:'Вечірня партія',interaction_id:interaction,players:[{id:'11',name:'Оля'},{id:'22',name:'Іван'}],scores:{'11':2,'22':5},order:[0,1],secret:'SECRET_GAME',answers:{'11':'SECRET_ANSWER'}}),phase,JSON.stringify(baseSource?[baseSource]:[])]))!.id);}
 else{key=randomUUID();await db.query("INSERT INTO activity_sessions(id,actor_id,topic_id,template,title,phase,source_message_id) VALUES($1,$2,'0','tournament','Вечірня партія',$3,$4)",[key,host,phase,baseSource||null]);for(const [id,name,score] of [['11','Оля',2],['22','Іван',5]] as const)await db.query("INSERT INTO activity_players(session_id,user_id,name,role,score,private_state) VALUES($1,$2,$3,'spy',$4,'{\"answer\":\"SECRET_PLAYER\"}')",[key,id,name,score]);}
 return {source_kind:kind,source_key:key};
}
const read=(ref:{source_kind:Kind;source_key:string},extra:Partial<ToolContext>={})=>results.run({operation:'read',...ref},c(extra));
before(async()=>{db=new TestDB();await db.init();results=new GameResults(db);});after(async()=>db.close());
beforeEach(async()=>{await db.reset();await db.pg.exec('TRUNCATE activity_sessions,canonical_outcomes,statistics_preferences,resource_views CASCADE');await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',participants='[{\"id\":\"11\"},{\"id\":\"22\"},{\"id\":\"33\"}]' WHERE id=1");for(const id of ['11','22','33'])await db.query('INSERT INTO members(user_id,name,active) VALUES($1,$2,true)',[id,id==='11'?'Оля':id==='22'?'Іван':'Марко']);});

for(const kind of ['games','activity_sessions'] as const){
 test(`${kind}: owner and canonical host correct real participants with exact version, genuine reason and idempotent history`,async()=>{
  const originalSource=await source('Починаємо вечірню партію'),ref=await game(kind,originalSource),before=await read(ref),reason='У другому раунді пропущено правильну відповідь',proof=await source('Виправ Олі рахунок на 8. '+reason),ctx=c({sourceId:proof,operationKey:'score-correction-'+kind}),args={operation:'correct' as const,...ref,version:before.version,scores:[{user_id:'11',score:8}],reason};
  const changed=await results.run(args,ctx),duplicate=await results.run(args,ctx);assert.deepEqual(duplicate,changed);assert.equal(changed.version,before.version+1);assert.equal(changed.correction_count,1);assert.deepEqual(changed.participants.map((p:any)=>p.score),[8,5]);assert.equal(new Date(changed.finished_at).getTime(),new Date(before.finished_at).getTime());assert.deepEqual(changed.corrections[0]!.before_scores,{'11':2,'22':5});assert.deepEqual(changed.corrections[0]!.after_scores,{'11':8,'22':5});assert.equal(changed.corrections[0]!.source_message_id,proof);assert.deepEqual(new Set(changed.source_ids),new Set([originalSource,proof]));assert.doesNotMatch(JSON.stringify(changed),/SECRET|private_state|answers|order/);
  assert.deepEqual((await one(db,'SELECT source_ids FROM game_result_bases WHERE source_kind=$1 AND source_key=$2',[kind,ref.source_key]))!.source_ids,[originalSource]);
  const hostReason='Ведучий перевірив третій раунд',hostSource=await source('Івану треба 6 балів. '+hostReason,'22');const hosted=await results.run({operation:'correct',...ref,version:changed.version,reason:hostReason,scores:[{user_id:'22',score:6}]},c({actorId:'22',sourceId:hostSource}));assert.deepEqual(hosted.participants.map((p:any)=>p.score),[8,6]);assert.equal(hosted.correction_count,2);
  const browser=new MediaBrowser(db,{} as MediaWorkshop),opened=await browser.open(BrowseQuery.parse({section:'games'}),c()),tg=new FakeTelegram();await browser.callback({id:'history-'+n,data:`lm:${opened.view_id}:0`,from:{id:11,first_name:'Оля'},message:{message_id:1,date:0,chat:{id:-100,type:'supergroup'}}} as any,tg as any);const rendered=tg.calls.filter(x=>x.method==='sendRichMessage').map(x=>JSON.stringify(x.body)).join('');assert.match(rendered,/Виправлення результату/);assert.match(rendered,/У другому раунді/);assert.match(rendered,/2 → 8/);assert.doesNotMatch(rendered,/SECRET/);
  await db.query("INSERT INTO statistics_preferences(user_id,ranking_opt_in) VALUES('11',true),('22',true)");const stats=await browser.statistics({ranking:true},c());assert.equal(stats.corrections.recorded,2);assert.equal(stats.corrections.corrected_results,1);assert.equal(stats.correction_history.length,2);assert.deepEqual((stats.personal_ranking as any[])[0].participants.map((p:any)=>p.score),[8,6]);
 });

 test(`${kind}: stale version, non-host, invented explanation, nonexistent proof and nonparticipants cannot alter a completed result`,async()=>{
  const ref=await game(kind),before=await read(ref),reason='Перевірили другий раунд',proof=await source(reason),args={operation:'correct' as const,...ref,version:before.version,reason,scores:[{user_id:'11',score:9}]};
  await assert.rejects(results.run(args,c({actorId:'33',sourceId:proof})),/owner_or_host/);
  await assert.rejects(results.run({...args,version:before.version+1},c({sourceId:proof})),/version_conflict/);
  await assert.rejects(results.run({...args,reason:undefined},c({sourceId:proof})),/reason_and_scores/);
  await assert.rejects(results.run({...args,reason:'Модель вирішила додати бал'},c({sourceId:proof})),/reason_source_required/);
  await assert.rejects(results.run(args,c()),/correction_source_required/);
  await assert.rejects(results.run(args,c({sourceId:proof,sourceIds:[99999999]})),/correction_source_required/);
  await assert.rejects(results.run({...args,scores:[{user_id:'999',score:9}]},c({sourceId:proof})),/participant_required/);
  await assert.rejects(results.run({...args,scores:[{user_id:'11',score:9},{user_id:'11',score:10}]},c({sourceId:proof})),/duplicate_participant/);
  await assert.rejects(results.run({...args,scores:[{user_id:'11',score:2}]},c({sourceId:proof})),/score_change_required/);
  assert.equal((await read(ref)).correction_count,0);assert.deepEqual((await read(ref)).participants.map((p:any)=>p.score),[2,5]);
  const active=await game(kind,undefined,kind==='games'?'active':'lobby'),current=await read(active);await assert.rejects(results.run({...args,...active,version:current.version},c({sourceId:proof})),/completed_game_result_required/);
  await assert.rejects(read(ref,{topicId:'9'}),/unavailable/);await db.query("UPDATE members SET active=false WHERE user_id='33'");await assert.rejects(read(ref,{actorId:'33'}),/member_required/);
 });

 test(`${kind}: forgetting an earlier correction replays independent immutable patches and clears derived history and cached balance`,async()=>{
  const original=await source('Початкова партія з повним джерелом'),ref=await game(kind,original),a=await source('Перша помилка альфа'),b=await source('Друга помилка бета');let current=await read(ref);
  current=await results.run({operation:'correct',...ref,version:current.version,reason:'Перша помилка альфа',scores:[{user_id:'11',score:12}]},c({sourceId:a}));current=await results.run({operation:'correct',...ref,version:current.version,reason:'Друга помилка бета',scores:[{user_id:'22',score:9}]},c({sourceId:b}));const remainingId=current.corrections[1]!.id,patch=current.corrections[1]!.patch;
  await db.tx(sql=>forgetPhrase(sql,'Перша помилка альфа'));let revision=(await state(db)).memory_revision,restored=await read(ref,{revision});assert.deepEqual(restored.participants.map((p:any)=>p.score),[2,9]);assert.equal(restored.correction_count,1);assert.deepEqual(restored.corrections[0]!.patch,patch);assert.deepEqual(restored.corrections[0]!.before_scores,{'11':2,'22':5});assert.deepEqual(restored.corrections[0]!.after_scores,{'11':2,'22':9});assert.deepEqual(new Set(restored.source_ids),new Set([original,b]));assert.equal(restored.corrections[0]!.id,remainingId);
  const cached=await one(db,'SELECT result FROM domain_commands WHERE id=$1',[remainingId]);assert.deepEqual(cached!.result.participants.map((p:any)=>p.score),[2,9]);assert.doesNotMatch(JSON.stringify(cached!.result),/альфа|:12/);
  await db.tx(sql=>forgetPhrase(sql,'Друга помилка бета'));revision=(await state(db)).memory_revision;restored=await read(ref,{revision});assert.deepEqual(restored.participants.map((p:any)=>p.score),[2,5]);assert.equal(restored.correction_count,0);assert.equal((await db.query('SELECT id FROM game_result_corrections')).rows.length,0);
 });
}

test('later absolute patch of the same participant remains valid after forgetting its predecessor; extra proof dependencies are honored',async()=>{
 const ref=await game('activity_sessions'),a=await source('Помилка першого підрахунку'),b=await source('Заміни рахунок на 15 за уточненням Івана'),proof=await source('Після повторної перевірки має бути 15','22');let current=await read(ref);
 current=await results.run({operation:'correct',...ref,version:current.version,reason:'Помилка першого підрахунку',scores:[{user_id:'11',score:12}]},c({sourceId:a}));current=await results.run({operation:'correct',...ref,version:current.version,reason:'Після повторної перевірки має бути 15',scores:[{user_id:'11',score:15}]},c({sourceId:b,sourceIds:[proof]}));
 await db.tx(async sql=>{await forgetGameResultSource(sql,a);await sql.query('DELETE FROM messages WHERE id=$1',[a]);});let remaining=await read(ref);assert.equal(remaining.participants[0]!.score,15);assert.equal(remaining.corrections[0]!.before_scores['11'],2);assert.equal(remaining.corrections[0]!.patch['11'],15);
 await db.tx(async sql=>{await forgetGameResultSource(sql,proof);await sql.query('DELETE FROM messages WHERE id=$1',[proof]);});remaining=await read(ref);assert.equal(remaining.participants[0]!.score,2);assert.equal(remaining.correction_count,0);assert.ok(await one(db,'SELECT id FROM messages WHERE id=$1',[b]));
});

test('forgetting original result evidence removes its corrected source; literal derived purge replays the base',async()=>{
 for(const kind of ['games','activity_sessions'] as const){const base=await source('Початковий протокол '+kind),ref=await game(kind,base),proof=await source('Виправлення за протоколом '+kind),before=await read(ref);await results.run({operation:'correct',...ref,version:before.version,reason:'Виправлення за протоколом '+kind,scores:[{user_id:'11',score:7}]},c({sourceId:proof}));await db.tx(sql=>forgetGameResultSource(sql,base));await assert.rejects(read(ref),/unavailable/);assert.equal((await db.query("SELECT id FROM domain_commands WHERE result->>'source_kind'=$1 AND result->>'source_key'=$2",[kind,ref.source_key])).rows.length,0);}
 const ref=await game('games'),proof=await source('Локальна арифметична помилка'),before=await read(ref);await results.run({operation:'correct',...ref,version:before.version,reason:'Локальна арифметична помилка',scores:[{user_id:'22',score:7}]},c({sourceId:proof}));await db.tx(sql=>purgeGameResultPhrase(sql,'арифметична'));assert.deepEqual((await read(ref)).participants.map((p:any)=>p.score),[2,5]);assert.equal((await read(ref)).correction_count,0);
});

for(const kind of ['games','activity_sessions'] as const)test(`${kind}: AgentTools statistics cache and identical replay discard a correction forgotten by a source-only phrase`,async()=>{
 const h=harness(db),tools=new AgentTools(db,h.config,h.brain),base=await source('Початкова база статистики '+kind),ref=await game(kind,base),original=await read(ref),reason='Після перевірки другого раунду',unique='b03_source_only_marker_'+kind,proof=await source('Виправ Олі рахунок на 12. '+reason+'. '+unique),preference=await source('Погоджуюся показувати мій рахунок у рейтингу');
 await tools.execute('game.result',{operation:'correct',...ref,version:original.version,scores:[{user_id:'11',score:12}],reason},c({sourceId:proof}));await db.query("INSERT INTO statistics_preferences(user_id,ranking_opt_in,source_message_id) VALUES('11',true,$1)",[preference]);const request=await source('Покажи статистику завершених партій'),ctx=c({sourceId:request}),args={section:'statistics',ranking:true},before=await tools.execute('library.browse',args,ctx);
 assert.equal(before.personal_ranking[0].participants[0].score,12);assert.equal(before.corrections.recorded,1);assert.ok(before.source_ids.includes(base));assert.ok(before.source_ids.includes(proof));assert.ok(before.source_ids.includes(preference));assert.doesNotMatch(JSON.stringify(before),new RegExp(unique));
 const receipt=await one(db,"SELECT * FROM tool_runs WHERE tool='library.browse' AND source_message_id=$1 ORDER BY id DESC LIMIT 1",[request]);assert.equal(receipt!.result.personal_ranking[0].participants[0].score,12);assert.ok(await one(db,"SELECT derived_key FROM provenance_edges WHERE derived_kind='tool_run' AND derived_key=$1 AND source_message_id=$2",[String(receipt!.id),proof]));
 await db.tx(sql=>forgetPhrase(sql,unique));const revision=(await state(db)).memory_revision,current=await read(ref,{revision});assert.equal(current.participants[0]!.score,2);assert.equal(current.correction_count,0);const cached=await one(db,'SELECT result,status FROM tool_runs WHERE id=$1',[receipt!.id]);if(cached?.result){assert.notEqual(cached.result.personal_ranking?.[0]?.participants?.[0]?.score,12);assert.notEqual(cached.result.corrections?.recorded,1);}
 const replay=await tools.execute('library.browse',args,{...ctx,revision});assert.equal(replay.personal_ranking[0].participants[0].score,2);assert.equal(replay.corrections.recorded,0);assert.ok(replay.source_ids.includes(base));assert.equal(replay.source_ids.includes(proof),false);const replayed=await one(db,'SELECT result FROM tool_runs WHERE dedup_key=$1',[receipt!.dedup_key]);assert.equal(replayed!.result.personal_ranking[0].participants[0].score,2);assert.equal(replayed!.result.corrections.recorded,0);assert.ok((await db.query("SELECT body FROM outbox WHERE kind='text'")).rows.every(r=>!String(r.body.text).includes('Оля: 12')));
});

test('statistics and game-result reads include original records and every correction source beyond ten display entries',async()=>{
 const original=await source('Протокол без залежності від виправлень'),ref=await game('activity_sessions',original),otherSource=await source('Протокол класичної гри'),other=await game('games',otherSource),ids:number[]=[];let current=await read(ref);for(let i=0;i<11;i++){const reason='Перевірка раунду номер '+i,proof=await source(reason+' distinct_source_'+i);ids.push(proof);current=await results.run({operation:'correct',...ref,version:current.version,scores:[{user_id:'11',score:20+i}],reason},c({sourceId:proof}));}
 const r=await new MediaBrowser(db,{} as MediaWorkshop).statistics({},c());assert.equal(r.corrections.recorded,11);assert.equal(r.correction_history_total,11);assert.equal(r.correction_history.length,10);assert.equal(r.correction_history.some(x=>Number(x.source_message_id)===ids[0]),false);for(const id of [original,otherSource,...ids])assert.ok(r.source_ids.includes(id));const readAgain=await read(ref);for(const id of [original,...ids])assert.ok(readAgain.source_ids.includes(id));assert.ok((await read(other)).source_ids.includes(otherSource));
});

test('forget between statistics read and queued snapshot cannot persist the erased score in outbox',async()=>{
 const ref=await game('activity_sessions'),before=await read(ref),unique='b03_snapshot_commit_boundary',reason='Перевірений другий раунд',proof=await source(reason+' '+unique);await results.run({operation:'correct',...ref,version:before.version,reason,scores:[{user_id:'11',score:12}]},c({sourceId:proof}));await db.query("INSERT INTO statistics_preferences(user_id,ranking_opt_in) VALUES('11',true)");let intercepted=false;
 const boundary:Database={query:db.query.bind(db),close:async()=>{},tx:async fn=>{if(!intercepted){intercepted=true;await db.tx(sql=>forgetPhrase(sql,unique));}return db.tx(fn);}},browser=new MediaBrowser(boundary,{} as MediaWorkshop);
 await assert.rejects(browser.open(BrowseQuery.parse({section:'statistics',ranking:true}),c()),/context_changed/);assert.equal(intercepted,true);assert.equal((await db.query('SELECT id FROM outbox')).rows.length,0);assert.equal((await read(ref,{revision:(await state(db)).memory_revision})).participants[0]!.score,2);
});
