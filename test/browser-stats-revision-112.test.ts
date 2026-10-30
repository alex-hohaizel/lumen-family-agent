import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TestDB,FakeTelegram} from './helpers.js';
import {one,migrate} from '../src/db.js';
import {MediaBrowser} from '../src/media-browser.js';
import {BrowseQuery} from '../src/media-assets.js';
import {MediaWorkshop,CollectionCommand,StudioCommand} from '../src/media-workshop.js';
import {ConfigSchema} from '../src/config.js';
import {ChatRegistry} from '../src/registry.js';
import type {ToolContext} from '../src/agent-tools.js';

// Lumen-1.12-no-audio/2026-10-30-R3.1 §§7–8. Local database/provider fixtures;
// these tests do not exercise a live Telegram client.
let db:TestDB,browser:MediaBrowser,n=0;
const context=(extra:Partial<ToolContext>={}):ToolContext=>({actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:String(++n),requested:true,audience:'group',...extra});
const callback=(view:string,action='0',actor=11,chat=-100)=>({id:'browser-'+(++n),data:`lm:${view}:${action}`,from:{id:actor,first_name:'Учасник'},message:{message_id:1,date:0,chat:{id:chat,type:chat<0?'supergroup':'private'}}});
const rendered=(tg:FakeTelegram)=>tg.calls.filter(c=>['sendMessage','sendRichMessage'].includes(c.method)).map(c=>JSON.stringify(c.body)).join('\n');
async function session(template:string,score=0,extra:{phase?:string;settings?:any;title?:string;topic?:string;rounds?:number;publicState?:any;players?:string[]}={}){
 const id=randomUUID();await db.query('INSERT INTO activity_sessions(id,actor_id,topic_id,template,title,phase,max_rounds,settings,public_state) VALUES($1,\'11\',$2,$3,$4,$5,$6,$7,$8)',[id,extra.topic||'0',template,extra.title||'Партія '+template,extra.phase||'completed',extra.rounds||3,JSON.stringify(extra.settings||{}),JSON.stringify(extra.publicState||{})]);
 for(const actor of extra.players||['11'])await db.query("INSERT INTO activity_players(session_id,user_id,name,role,score,private_state) VALUES($1,$2,$3,'spy',$4,$5)",[id,actor,'Учасник '+actor,score,JSON.stringify({word:'SECRET_PLAYER_WORD',answer:'SECRET_PLAYER_ANSWER'})]);
 return id;
}
async function legacy(title:string,extra:any={},status='completed',created='2026-10-15T12:00:00Z',topic='0'){
 return (await one(db,'INSERT INTO games(kind,state,status,created_at,topic_id) VALUES($1,$2,$3,$4,$5) RETURNING id',['quiz',JSON.stringify({title,players:[{id:'11',name:'Учасник 11'}],scores:{'11':7},...extra}),status,created,topic]))!.id;
}
before(async()=>{db=new TestDB();await db.init();browser=new MediaBrowser(db,{} as MediaWorkshop);});
after(async()=>db.close());
beforeEach(async()=>{
 await db.reset();await db.pg.exec('TRUNCATE activity_sessions,resource_views,statistics_preferences,canonical_outcomes,media_assets,archive_collections CASCADE');
 await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',participants='[{\"id\":\"11\",\"name\":\"А\"},{\"id\":\"22\",\"name\":\"Б\"}]' WHERE id=1");
 for(const id of ['11','22','33','44'])await db.query('INSERT INTO members(user_id,name,active) VALUES($1,$2,true)',[id,'Учасник '+id]);
});

test('legacy games and sessions share a paged catalogue; callback projects public fields and rejects stale versions',async()=>{
 const old=await legacy('Стара скринька',{segments:['Публічна історія'],secret:'SECRET_OBJECT',caseIndex:3,order:[7,9],answers:{'11':'SECRET_ANSWER'},director_state:'SECRET_DIRECTOR',private_state:{hint:'SECRET_PRIVATE'},unexpected_secret:'SECRET_UNKNOWN'},'completed','2026-10-15T12:00:00.123456Z');
 const newer=await session('story',4,{title:'Нова скринька',settings:{_answer:'SECRET_SETTINGS',_pack:{answers:['SECRET_PACK']}},publicState:{story:[{text:'Відкрита історія'}],secret:'SECRET_PUBLIC_STATE'}});
 await db.query('UPDATE activity_sessions SET created_at=$2 WHERE id=$1',[newer,'2026-10-15T12:00:00.123456Z']);
 await legacy('Скринька в іншій темі',{},'completed','2026-10-15T12:00:00Z','7');
 await legacy('Занадто стара скринька',{},'completed','2001-01-01T00:00:00Z');
 const q=BrowseQuery.parse({section:'games',query:'скринька',limit:1,since:'2026-10-01T00:00:00Z',until:'2026-11-01T00:00:00Z'}),first=await browser.browse(q,context()),second=await browser.browse({...q,cursor:first.next},context());
 assert.equal(first.items.length,1);assert.equal(second.items.length,1);assert.equal(second.next,undefined);assert.notEqual(first.items[0].id,second.items[0].id);
 assert.deepEqual(new Set([first.items[0].id,second.items[0].id]),new Set(['game:'+old,'session:'+newer]));
 assert.deepEqual(new Set([first.items[0].source_type,second.items[0].source_type]),new Set(['game','activity_session']));
 assert.doesNotMatch(JSON.stringify([first,second]),/SECRET|private_state|answers/);
 const all=await browser.open(BrowseQuery.parse({...q,limit:12}),context()),tg=new FakeTelegram();
 for(let i=0;i<all.items.length;i++)assert.equal(await browser.callback(callback(all.view_id,String(i)) as any,tg as any),true);
 assert.equal(tg.calls.filter(c=>c.method==='getChatMember').length,2);assert.match(rendered(tg),/Публічна історія/);assert.match(rendered(tg),/Відкрита історія/);assert.doesNotMatch(rendered(tg),/SECRET|private_state|director_state|caseIndex|answers|settings/);
 await db.query('UPDATE games SET state=state||\'{"turn":2}\'::jsonb WHERE id=$1',[old]);const stale=new FakeTelegram(),index=all.items.findIndex((x:any)=>x.source_type==='game');
 await browser.callback(callback(all.view_id,String(index)) as any,stale as any);assert.equal(rendered(stale),'');assert.match(stale.sent[0]!.text,/змінився/);
});

test('next uses the saved page boundary despite insertions and deletions',async()=>{
 await legacy('Партія перша',{},'completed','2026-10-10T00:00:00Z');await legacy('Партія друга',{},'completed','2026-10-20T00:00:00Z');const newest=await legacy('Партія третя',{},'completed','2026-10-25T00:00:00Z');
 const q=BrowseQuery.parse({section:'games',query:'Партія',limit:1}),opened=await browser.open(q,context());assert.equal(opened.items[0].id,'game:'+newest);
 const expected=await browser.browse({...q,cursor:opened.next},context());await db.query('DELETE FROM games WHERE id=$1',[newest]);await legacy('Партія щойно додана',{},'completed','2026-10-29T00:00:00Z');
 await browser.callback(callback(opened.view_id,'next') as any,new FakeTelegram() as any);
 const next=await one(db,'SELECT query,refs FROM resource_views WHERE id<>$1 ORDER BY expires_at DESC LIMIT 1',[opened.view_id]);assert.equal(next!.query.cursor,opened.next);assert.equal(next!.refs[0].id,expected.items[0].id);
 await assert.rejects(browser.browse({...q,cursor:Buffer.from('["bad","game:1"]').toString('base64url')},context()),/browse_cursor_invalid/);
});

test('callback rechecks local and provider membership, topic, private owner and current resource ACL',async()=>{
 await legacy('Спільна партія');const opened=await browser.open(BrowseQuery.parse({section:'games'}),context()),local=new FakeTelegram();
 await db.query("UPDATE members SET active=false WHERE user_id='22'");await browser.callback(callback(opened.view_id,'0',22) as any,local as any);assert.equal(rendered(local),'');
 await browser.callback(callback(opened.view_id,'refresh',22) as any,local as any);assert.equal((await db.query('SELECT id FROM resource_views')).rows.length,1);
 class Departed extends FakeTelegram{override async call(method:string,body:any={}){if(method==='getChatMember'){this.calls.push({method,body});return {status:'left'};}return super.call(method,body);}}
 const departed=new Departed();await browser.callback(callback(opened.view_id) as any,departed as any);assert.equal(rendered(departed),'');assert.match(departed.sent[0]!.text,/недоступний/);
 await db.query("DELETE FROM members WHERE user_id='22'");const knownParticipant=new FakeTelegram();await browser.callback(callback(opened.view_id,'0',22) as any,knownParticipant as any);assert.match(rendered(knownParticipant),/Спільна партія/);
 const staleParticipant=new Departed();await browser.callback(callback(opened.view_id,'0',22) as any,staleParticipant as any);assert.equal(rendered(staleParticipant),'');assert.equal(staleParticipant.calls[0]!.method,'getChatMember');
 const wrongTopic={...callback(opened.view_id),message:{...callback(opened.view_id).message,message_thread_id:7}};assert.equal(await browser.callback(wrongTopic as any,new FakeTelegram() as any),false);
 const id=randomUUID();await db.query("INSERT INTO media_assets(id,owner_id,title,mime,path,sha256,bytes,audience,topic_id) VALUES($1,'11','Особистий файл','text/plain','/unused','hash',4,'private','0')",[id]);
 const own=await browser.open(BrowseQuery.parse({section:'materials'}),context({audience:'private'}));assert.equal(own.items.length,1);
 assert.equal(await browser.callback(callback(own.view_id,'0',22,22) as any,new FakeTelegram() as any),false);
 await db.query("UPDATE media_assets SET owner_id='33' WHERE id=$1",[id]);const revoked=new FakeTelegram();await browser.callback(callback(own.view_id,'0',11,11) as any,revoked as any);assert.equal(rendered(revoked),'');assert.match(revoked.sent[0]!.text,/недоступним/);
 await assert.rejects(browser.browse(BrowseQuery.parse({section:'games'}),context({chatId:'-999'})),/other_chat/);
});

test('events show readable agreed fields while private and calendar metadata stay hidden',async()=>{
 const id=randomUUID();await db.query("INSERT INTO group_events(id,actor_id,title,details,topic_id) VALUES($1,'11','Похід',$2,'0')",[id,JSON.stringify({start_at:'2026-11-01T10:00:00Z',timezone:'Europe/Kyiv',location:'Сосновий ліс',budget:{amount:600,currency:'грн',secret:'SECRET_BUDGET'},participants:['11',{name:'Оля',private_state:'SECRET_PARTICIPANT'}],options:[{title:'Ранковий маршрут',secret:'SECRET_OPTION'}],attendance:'not_confirmed',calendar_owner:'SECRET_OWNER',calendar_mirror:'SECRET_MIRROR',private_state:{token:'SECRET_TOKEN'},details:{answer:'SECRET_NESTED'}})]);
 const opened=await browser.open(BrowseQuery.parse({section:'events'}),context()),tg=new FakeTelegram();await browser.callback(callback(opened.view_id) as any,tg as any);const text=rendered(tg);assert.match(text,/Сосновий ліс/);assert.match(text,/600 грн/);assert.match(text,/Учасник 11, Оля/);assert.match(text,/Ще не підтверджена/);assert.doesNotMatch(text,/SECRET|calendar_owner|private_state|\{\\"amount/);
});

test('private media are filtered before the first page and group callbacks recheck owner-only artifacts',async()=>{
 for(const [title,audience,created] of [['Публічний файл','group','2026-10-01T00:00:00.123456Z'],['Ще один публічний файл','group','2026-10-01T00:00:00.123456Z'],['Прихований файл','private','2026-10-29T00:00:00Z']] as const)await db.query('INSERT INTO media_assets(id,owner_id,title,mime,path,sha256,bytes,audience,topic_id,created_at) VALUES($1,\'11\',$2,\'text/plain\',\'/unused\',\'hash\',4,$3,\'0\',$4)',[randomUUID(),title,audience,created]);
 const q=BrowseQuery.parse({section:'materials',limit:1}),page=await browser.browse(q,context({actorId:'22'})),next=await browser.browse({...q,cursor:page.next},context({actorId:'22'}));assert.equal(page.items.length,1);assert.equal(next.items.length,1);assert.notEqual(page.items[0].id,next.items[0].id);assert.equal(next.next,undefined);assert.doesNotMatch(JSON.stringify([page,next]),/Прихований/);
 const id=randomUUID();await db.query("INSERT INTO agent_artifacts(id,actor_id,topic_id,name,mime,content,revision) VALUES($1,'11','0','Авторський файл','text/plain','private bytes',0)",[id]);
 const opened=await browser.open(BrowseQuery.parse({section:'materials',query:'Авторський'}),context()),other=new FakeTelegram();await browser.callback(callback(opened.view_id,'0',33) as any,other as any);assert.equal(rendered(other),'');assert.match(other.sent[0]!.text,/недоступним/);
});

test('rankings keep mechanics, engines, score limits and scenario definitions separate; only opted-in current completed sources count',async()=>{
 for(const id of ['11','44'])await db.query('INSERT INTO statistics_preferences(user_id,ranking_opt_in) VALUES($1,true)',[id]);await db.query("UPDATE members SET active=false WHERE user_id='44'");
 await session('tournament',10);await session('tournament',6);await session('roles',2);
 await session('detective',3,{settings:{_pack:{id:'same-id',title:'Перша справа',answers:['SECRET_A']}}});await session('detective',4,{settings:{_pack:{id:'same-id',title:'Інша справа',answers:['SECRET_B']}}});
 await session('tournament',5,{rounds:4});await session('tournament',8,{settings:{_quiz:[{question:'Приклад',correct_index:1}]}});
 await session('tournament',999,{phase:'cancelled'});await session('tournament',999,{phase:'collect'});await session('roles',999,{players:['33','44']});
 const removed=await session('roles',999);await db.query('DELETE FROM activity_sessions WHERE id=$1',[removed]);await legacy('Класична вікторина',{order:[0,1],scores:{'11':7}});await legacy('Інша класична вікторина',{order:[2,3],scores:{'11':9}});
 const r=await browser.statistics({ranking:true},context()),groups=r.personal_ranking as any[];
 assert.equal(r.overall_score,'not_combined');assert.equal(groups.length,8);assert.equal(groups.filter(g=>g.engine==='session'&&g.template==='detective').length,2);assert.equal(groups.filter(g=>g.engine==='legacy').length,2);
 const compatible=groups.find(g=>g.engine==='session'&&g.template==='tournament'&&g.completed_sessions===2);assert.equal(compatible.participants[0].score,16);assert.equal(compatible.participants[0].completed_sessions,2);
 assert.deepEqual(groups.filter(g=>g.template==='roles').map(g=>g.participants[0].score),[2]);assert.ok(groups.every(g=>g.participants.every((p:any)=>p.user_id==='11'&&p.score<100)));assert.doesNotMatch(JSON.stringify(r),/SECRET|_quiz|correct_index|private_state/);
 await db.query("UPDATE statistics_preferences SET ranking_opt_in=false WHERE user_id='11'");assert.deepEqual((await browser.statistics({ranking:true},context())).personal_ranking,[]);
});

test('periods exclude inferred completion and ongoing states; status history is distinct from source versions and corrections',async()=>{
 await db.query("INSERT INTO statistics_preferences(user_id,ranking_opt_in) VALUES('11',true)");
 const inferred=await session('tournament',100),exact=await session('roles',3,{phase:'lobby'}),ongoing=await legacy('Поточна партія',{},'active'),cancelled=await session('captions',2,{phase:'cancelled'}),edge=await session('detective',8);
 await db.query("UPDATE canonical_outcomes SET time_precision='inferred',finished_at='2026-10-15T00:00:00Z' WHERE source_key=$1",[inferred]);
 assert.equal((await one(db,'SELECT finished_at FROM canonical_outcomes WHERE source_key=$1',[exact]))!.finished_at,null);
 await db.query("UPDATE activity_sessions SET phase='collect',version=version+1 WHERE id=$1",[exact]);await db.query("UPDATE activity_sessions SET phase='completed',version=version+1 WHERE id=$1",[exact]);
 await db.query("UPDATE canonical_outcomes SET finished_at='2026-10-01T00:00:00Z' WHERE source_key=$1",[exact]);await db.query("UPDATE canonical_outcomes SET finished_at='2026-10-15T00:00:00Z' WHERE source_key=$1",[cancelled]);await db.query("UPDATE canonical_outcomes SET finished_at='2026-11-01T00:00:00Z' WHERE source_key=$1",[edge]);
 const original=await one(db,'SELECT finished_at,time_precision,version FROM canonical_outcomes WHERE source_key=$1',[exact]);
 await db.query("UPDATE activity_sessions SET title=title||' уточнено',version=version+1 WHERE id=$1",[exact]);await db.query("UPDATE activity_sessions SET title=title||' ще раз',version=version+1 WHERE id=$1",[exact]);await db.query("UPDATE games SET state=state||'{\"turn\":2}'::jsonb WHERE id=$1",[ongoing]);
 const unchanged=await one(db,'SELECT finished_at,time_precision,version FROM canonical_outcomes WHERE source_key=$1',[exact]);assert.equal(new Date(unchanged!.finished_at).toISOString(),new Date(original!.finished_at).toISOString());assert.equal(unchanged!.time_precision,'exact');assert.ok(unchanged!.version>original!.version);
 const period={since:'2026-10-01T00:00:00Z',until:'2026-11-01T00:00:00Z',ranking:true},r=await browser.statistics(period,context());assert.equal(r.completed,1);assert.equal(r.incomplete_or_cancelled,1);assert.equal(r.total_recorded,2);assert.equal(r.time_coverage.unknown_terminal_time,1);assert.equal(r.time_coverage.excluded_unknown_terminal_time,1);assert.equal(r.time_coverage.excluded_ongoing,1);assert.equal(r.status_revisions,1);assert.equal(r.status_change_events,2);assert.equal(r.corrections.recorded,0);assert.equal('corrected_versions' in r,false);assert.deepEqual((r.personal_ranking as any[]).map(g=>g.participants[0].score),[3]);
 const all=await browser.statistics({},context());assert.equal(all.completed,3);assert.equal(all.total_recorded,5);assert.equal(all.status_revisions,1);
 await db.query("UPDATE activity_sessions SET phase='cancelled',version=version+1 WHERE id=$1",[exact]);assert.equal(new Date((await one(db,'SELECT finished_at FROM canonical_outcomes WHERE source_key=$1',[exact]))!.finished_at).toISOString(),new Date(original!.finished_at).toISOString());assert.equal((await browser.statistics(period,context())).status_change_events,3);
 await db.query("UPDATE activity_sessions SET phase='collect',version=version+1 WHERE id=$1",[exact]);assert.equal((await browser.statistics(period,context())).total_recorded,1);
 await db.query("UPDATE activity_sessions SET phase='completed',version=version+1 WHERE id=$1",[exact]);assert.ok(new Date((await one(db,'SELECT finished_at FROM canonical_outcomes WHERE source_key=$1',[exact]))!.finished_at).getTime()>new Date(original!.finished_at).getTime());
 await db.query("INSERT INTO canonical_outcomes(source_kind,source_key,topic_id,status,finished_at,time_precision) VALUES('activity_sessions','deleted-source','0','completed','2026-10-15T00:00:00Z','exact')");assert.equal((await browser.statistics({},context())).total_recorded,5);
 await assert.rejects(browser.statistics({since:'2026-11-01T00:00:00Z',until:'2026-10-01T00:00:00Z'},context()),/statistics_period_invalid/);
});

test('linked event assets filter ACL and bound versions before paging, expose explicit participants and open/download through guarded buttons',async()=>{
 const publications:any[]=[],media={run:async(a:any,c:ToolContext)=>{publications.push({a,c});return {queued:true};}},b=new MediaBrowser(db,media as MediaWorkshop),event=randomUUID();
 await db.query("INSERT INTO group_events(id,actor_id,title,details,version,topic_id) VALUES($1,'11','Похід із матеріалами',$2,4,'0')",[event,JSON.stringify({participants:['11',{name:'Запрошена Оля',private_state:'SECRET_EVENT_ROLE'}],attendance:'not_confirmed'})]);
 const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005'];
 for(const [i,title,audience,version,status,bound] of [[0,'Приватний секрет','private',1,'available',1],[1,'Відкликаний файл','group',1,'revoked',1],[2,'Стара версія файла','group',3,'available',2],[3,'Карта маршруту','group',2,'available',2],[4,'Пам’ятка','group',1,'available',1]] as const){await db.query("INSERT INTO media_assets(id,owner_id,title,mime,path,sha256,bytes,audience,topic_id,version,status) VALUES($1,'11',$2,'text/plain','/unused','hash',4,$3,'0',$4,$5)",[ids[i],title,audience,version,status]);await db.query("INSERT INTO resource_links(asset_id,asset_version,resource_kind,resource_id,resource_version) VALUES($1,$2,'event',$3,1)",[ids[i],bound,event]);}
 const first=await b.related({resource_kind:'event',resource_id:event,limit:1},context()),second=await b.related({resource_kind:'event',resource_id:event,limit:1,after_asset_id:first.next},context());assert.equal(first.items[0]!.title,'Карта маршруту');assert.equal(second.items[0]!.title,'Пам’ятка');assert.equal(second.next,undefined);assert.equal(first.items[0]!.bound_resource_version,1);assert.equal(first.items[0]!.current_resource_version,4);assert.equal(first.resource.participants_source,'explicit_event_details');assert.equal(first.resource.attendance,'not_inferred');assert.deepEqual(first.resource.participants!.map((p:any)=>p.name),['Учасник 11','Запрошена Оля']);assert.doesNotMatch(JSON.stringify([first,second]),/Приватний секрет|Відкликаний|Стара версія|SECRET|Учасник 33/);
 const opened=await b.open(BrowseQuery.parse({section:'events'}),context()),tg=new FakeTelegram();await b.callback(callback(opened.view_id) as any,tg as any);const rich=tg.calls.find(x=>x.method==='sendRichMessage')!;assert.match(JSON.stringify(rich.body),/Карта маршруту/);assert.doesNotMatch(JSON.stringify(rich.body),/Приватний секрет|SECRET/);const openButton=rich.body.reply_markup.inline_keyboard[0][0].callback_data.split(':');
 await db.query('UPDATE group_events SET version=5 WHERE id=$1',[event]);await b.callback(callback(openButton[1],openButton[2]) as any,tg as any);const file=tg.calls.filter(x=>x.method==='sendMessage').at(-1)!;assert.match(file.body.text,/Карта маршруту/);const send=file.body.reply_markup.inline_keyboard[0][0].callback_data.split(':');await b.callback(callback(send[1],send[2]) as any,tg as any);assert.equal(publications.length,1);assert.equal(publications[0].a.id,ids[3]);assert.equal(publications[0].a.version,2);assert.equal(publications[0].c.audience,'private');assert.equal((await one(db,"SELECT resource_version FROM resource_links WHERE asset_id=$1 AND resource_kind='event'",[ids[3]]))!.resource_version,1);
 await db.query('UPDATE media_assets SET version=3 WHERE id=$1',[ids[3]]);const stale=new FakeTelegram();await b.callback(callback(send[1],send[2]) as any,stale as any);assert.equal(publications.length,1);assert.equal(rendered(stale),'');assert.match(stale.sent[0]!.text,/недоступним/);
});

test('canonical game, session, collection and project accessors read links; private parent and changed owner block old buttons',async()=>{
 const asset=randomUUID();await db.query("INSERT INTO media_assets(id,owner_id,title,mime,path,sha256,bytes,audience,topic_id) VALUES($1,'11','Спільний матеріал','text/plain','/unused','hash',4,'group','0')",[asset]);
 const old=String(await legacy('Гра з матеріалами')),s=await session('story',0,{title:'Сесія з матеріалами'}),collection=randomUUID(),project=randomUUID();await db.query("INSERT INTO archive_collections(id,owner_id,title,audience,topic_id) VALUES($1,'11','Альбом','group','0')",[collection]);await db.query("INSERT INTO projects(id,actor_id,topic_id,title,goal,criteria) VALUES($1,'11','0','Проєкт','Підготувати','Перевірити')",[project]);
 for(const [kind,id] of [['game',old],['session',s],['collection',collection],['project',project]] as const){await db.query('INSERT INTO resource_links(asset_id,asset_version,resource_kind,resource_id,resource_version) VALUES($1,1,$2,$3,1)',[asset,kind,id]);const r=await browser.related({resource_kind:kind,resource_id:id,limit:8},context());assert.equal(r.items[0]!.id,asset);assert.equal(r.resource.id,id);assert.doesNotMatch(JSON.stringify(r),/SECRET|private_state|settings/);}
 const foreign=randomUUID();await db.query("INSERT INTO projects(id,actor_id,topic_id,title,goal,criteria) VALUES($1,'11','7','Чужа тема','Підготувати','Перевірити')",[foreign]);await assert.rejects(browser.related({resource_kind:'project',resource_id:foreign,limit:8},context()),/resource_unavailable/);
 const secret=randomUUID(),privateCollection=randomUUID();await db.query("INSERT INTO media_assets(id,owner_id,title,mime,path,sha256,bytes,audience,topic_id) VALUES($1,'11','Особистий оригінал','text/plain','/unused','hash',4,'private','0')",[secret]);await db.query("INSERT INTO archive_collections(id,owner_id,title,audience,topic_id) VALUES($1,'11','Особистий альбом','private','0')",[privateCollection]);await db.query("INSERT INTO resource_links(asset_id,asset_version,resource_kind,resource_id,resource_version) VALUES($1,1,'collection',$2,1)",[secret,privateCollection]);
 await assert.rejects(browser.related({resource_kind:'collection',resource_id:privateCollection,limit:8},context()),/resource_unavailable/);await assert.rejects(browser.related({resource_kind:'collection',resource_id:privateCollection,limit:8},context({actorId:'22',audience:'private'})),/resource_unavailable/);const own=await browser.related({resource_kind:'collection',resource_id:privateCollection,limit:8},context({audience:'private'}));assert.equal(own.items[0]!.title,'Особистий оригінал');
 await db.query("UPDATE archive_collections SET owner_id='22' WHERE id=$1",[privateCollection]);const denied=new FakeTelegram();await browser.callback(callback(own.view_id,'0',11,11) as any,denied as any);assert.equal(rendered(denied),'');assert.match(denied.sent[0]!.text,/недоступним/);
});

test('migration 17 keeps album/studio topics and linked metadata inside their chat namespace',async()=>{
 const config=ConfigSchema.parse({runtimeDir:'/tmp/lumen-browser-topic-fixture'}),media=new MediaWorkshop(db,config),topic=context({topicId:'7'}),album=await media.collection(CollectionCommand.parse({operation:'create',title:'Альбом теми 7'}),topic),studio=await media.studio(StudioCommand.parse({operation:'create',title:'Монтаж теми 7'}),context({topicId:'7'}));
 assert.equal((await browser.browse(BrowseQuery.parse({section:'collections'}),context())).items.length,0);assert.equal((await browser.browse(BrowseQuery.parse({section:'studio'}),context())).items.length,0);assert.equal((await browser.browse(BrowseQuery.parse({section:'collections'}),topic)).items[0].id,album.id);assert.equal((await browser.browse(BrowseQuery.parse({section:'studio'}),topic)).items[0].id,studio.id);
 const asset=randomUUID();await db.query("INSERT INTO media_assets(id,owner_id,title,mime,path,sha256,bytes,audience,topic_id) VALUES($1,'11','Матеріал першої групи','text/plain','/unused','hash',4,'group','7')",[asset]);await db.query("INSERT INTO resource_links(asset_id,asset_version,resource_kind,resource_id,resource_version) VALUES($1,1,'collection',$2,1)",[asset,album.id]);await assert.rejects(browser.related({resource_kind:'collection',resource_id:album.id,limit:8},context()),/resource_unavailable/);
 const registry=new ChatRegistry(db);await registry.init();const chat=await registry.ensure('-200','11','Інша група'),other=registry.database(chat);await other.query("INSERT INTO members(user_id,name,active) VALUES('11','Оля',true)");assert.equal(Number((await one(other,'SELECT count(*) AS n FROM schema_version WHERE version BETWEEN 1 AND 17'))!.n),17);assert.ok((await one(other,"SELECT to_regclass('game_result_corrections') AS existing"))!.existing);
 await other.query("INSERT INTO archive_collections(id,owner_id,title,audience,topic_id) VALUES($1,'11','Альбом іншої групи','group','7')",[album.id]);await other.query("INSERT INTO media_assets(id,owner_id,title,mime,path,sha256,bytes,audience,topic_id) VALUES($1,'11','Матеріал іншої групи','text/plain','/unused','hash',4,'group','7')",[asset]);await other.query("INSERT INTO resource_links(asset_id,asset_version,resource_kind,resource_id,resource_version) VALUES($1,1,'collection',$2,1)",[asset,album.id]);const otherBrowser=new MediaBrowser(other,{} as MediaWorkshop),r=await otherBrowser.related({resource_kind:'collection',resource_id:album.id,limit:8},context({chatId:'-200',topicId:'7'}));assert.equal(r.items[0]!.title,'Матеріал іншої групи');assert.equal((await browser.related({resource_kind:'collection',resource_id:album.id,limit:8},topic)).items[0]!.title,'Матеріал першої групи');assert.equal(await browser.callback(callback(r.view_id) as any,new FakeTelegram() as any),false);
 const message=await one(other,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES(991,'11','Оля','user','Старий альбом у темі 9','9') RETURNING id"),oldAlbum=randomUUID(),oldStudio=randomUUID();await other.query("INSERT INTO archive_collections(id,owner_id,title,audience,source_message_id) VALUES($1,'11','Старий альбом','group',$2)",[oldAlbum,message!.id]);await other.query("INSERT INTO studio_projects(id,owner_id,title,audience,source_message_id) VALUES($1,'11','Старий монтаж','group',$2)",[oldStudio,message!.id]);await other.query('DELETE FROM schema_version WHERE version=17');await migrate(other);assert.equal((await one(other,'SELECT topic_id FROM archive_collections WHERE id=$1',[oldAlbum]))!.topic_id,'9');assert.equal((await one(other,'SELECT topic_id FROM studio_projects WHERE id=$1',[oldStudio]))!.topic_id,'9');assert.equal((await one(db,'SELECT topic_id FROM archive_collections WHERE id=$1',[album.id]))!.topic_id,'7');
});

test('browse and related provenance include only returned ACL-visible records, their parents and actual source edges',async()=>{
 const message=async(text:string)=>Number((await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES($1,'11','Оля','user',$2) RETURNING id",[++n,text]))!.id),visible=await message('Джерело видимого файла'),extra=await message('Додаткова підстава видимого файла'),later=await message('Джерело наступної сторінки'),privateSource=await message('Особисте джерело поза доступом'),parentSource=await message('Джерело спільної події');
 const ids=['00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000100'];for(const [id,title,audience,source,created] of [[ids[0],'Видимий файл','group',visible,'2026-10-20T00:00:00Z'],[ids[1],'Наступний файл','group',later,'2026-10-10T00:00:00Z'],[ids[2],'Особистий файл','private',privateSource,'2026-10-29T00:00:00Z']] as const)await db.query("INSERT INTO media_assets(id,owner_id,title,mime,path,sha256,bytes,audience,topic_id,source_message_id,created_at) VALUES($1,'11',$2,'text/plain','/unused','hash',4,$3,'0',$4,$5)",[id,title,audience,source,created]);await db.query("INSERT INTO provenance_edges(derived_kind,derived_key,source_message_id) VALUES('media_asset',$1,$2)",[ids[0],extra]);
 const q=BrowseQuery.parse({section:'materials',limit:1}),first=await browser.browse(q,context({actorId:'22'})),second=await browser.browse({...q,cursor:first.next},context({actorId:'22'}));assert.deepEqual(new Set(first.source_ids),new Set([visible,extra]));assert.deepEqual(second.source_ids,[later]);assert.equal(first.source_ids.includes(later),false);assert.equal(first.source_ids.includes(privateSource),false);
 const event=randomUUID();await db.query("INSERT INTO group_events(id,actor_id,title,details,topic_id,source_message_id) VALUES($1,'11','Подія з джерелом','{}','0',$2)",[event,parentSource]);for(const asset of ids)await db.query("INSERT INTO resource_links(asset_id,asset_version,resource_kind,resource_id,resource_version) VALUES($1,1,'event',$2,1)",[asset,event]);const related=await browser.related({resource_kind:'event',resource_id:event,limit:1},context({actorId:'22'}));assert.equal(related.items[0]!.id,ids[0]);assert.deepEqual(new Set(related.source_ids),new Set([parentSource,visible,extra]));assert.equal(related.source_ids.includes(privateSource),false);assert.equal(related.source_ids.includes(later),false);const next=await browser.related({resource_kind:'event',resource_id:event,limit:1,after_asset_id:related.next},context({actorId:'22'}));assert.deepEqual(new Set(next.source_ids),new Set([parentSource,later]));assert.deepEqual((await browser.browse(BrowseQuery.parse({section:'events'}),context())).source_ids,[parentSource]);
});
