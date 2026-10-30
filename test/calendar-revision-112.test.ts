import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestDB,FakeTelegram} from './helpers.js';
import {one} from '../src/db.js';
import {CalendarSync,CalendarCommand,calendarEvents,setCalendarChangeListener,type CalendarChange} from '../src/calendar-sync.js';
import {GroupCalendar,CalendarProposal,setCalendarOwnerResolver} from '../src/calendar-groups.js';
import {ConnectorVault} from '../src/connector-vault.js';
import type {ToolContext} from '../src/agent-tools.js';
import type {HTTPRequest,HTTPResult} from '../src/safe-http.js';
import type {Message,Telegram,CallbackQuery} from '../src/telegram.js';

class CalendarProvider {
  resources=new Map<string,{data:string;etag:string}>();
  writes:{method:string;href:string;headers:Record<string,string>}[]=[];
  loseNextWrite=false;
  private version=0;
  seed(href:string,data:string){const value={data,etag:'"'+(++this.version)+'"'};this.resources.set(href,value);return value;}
  request:HTTPRequest=async(href,options={})=>{
    const method=options.method||'GET',headers=options.headers||{},existing=this.resources.get(href);
    const response=(status:number,body='',etag?:string):HTTPResult=>({url:href,status,headers:etag?{etag}:{},body:Buffer.from(body)});
    if(method==='GET')return existing?response(200,existing.data,existing.etag):response(404);
    if(method==='PUT'||method==='DELETE'){
      this.writes.push({method,href,headers});
      if(headers['If-None-Match']==='*'&&existing||headers['If-Match']&&headers['If-Match']!==existing?.etag)return response(412);
      const saved=method==='PUT'?this.seed(href,String(options.body)):undefined;
      if(method==='DELETE')this.resources.delete(href);
      if(this.loseNextWrite){this.loseNextWrite=false;throw Error('response lost after provider commit');}
      return response(existing?204:201,'',saved?.etag);
    }
    throw Error('unexpected fixture method: '+method);
  };
}

let sequence=0;
const context=(chatId='11'):ToolContext=>({actorId:'11',chatId,topicId:'0',revision:0,updateId:'calendar-revision:'+ ++sequence,requested:true,audience:Number(chatId)>0?'private':'group'});
async function prepare(db:TestDB,chat='11'){
  await db.init();
  await db.query("UPDATE app_state SET chat_id=$1,owner_id='11',participants='[{\"id\":11}]',paused=false,memory_revision=0 WHERE id=1",[chat]);
  await db.query("INSERT INTO members(user_id,name,active) VALUES('11','Власник',true)");
}
async function fixture(){
  const db=new TestDB(),runtime=await mkdtemp(join(tmpdir(),'calendar-revision-112-')),provider=new CalendarProvider();
  await prepare(db);const connection=randomUUID(),endpoint='https://calendar.example/alice/main/';
  await new ConnectorVault(db,runtime).put('11','calendar_revision','Basic fixture');
  await db.query("INSERT INTO calendar_connections(id,owner_id,title,endpoint,credential_name,scope,status) VALUES($1,'11','Мій календар',$2,'calendar_revision','read_write','ready')",[connection,endpoint]);
  const service=new CalendarSync(db,runtime,provider.request),start=new Date(Math.floor((Date.now()+3600000)/1000)*1000).toISOString(),end=new Date(Math.floor((Date.now()+7200000)/1000)*1000).toISOString();
  const create=()=>service.run(CalendarCommand.parse({operation:'create',connection_id:connection,title:'Погоджена подія',start,end}),context());
  return {db,runtime,provider,service,connection,endpoint,start,end,create,close:async()=>{await db.close();await rm(runtime,{recursive:true,force:true});}};
}
async function waitFor(check:()=>Promise<boolean>){
  for(let n=0;n<200;n++){if(await check())return;await new Promise<void>(resolve=>setTimeout(resolve,5));}
  assert.fail('calendar background work did not finish');
}
async function groupFixture(){
  const personal=await fixture(),group=new TestDB();await prepare(group,'-100');
  const calendar=new GroupCalendar(group,personal.runtime),telegram=new FakeTelegram();
  await setCalendarOwnerResolver(group,async actor=>actor==='11'?personal.service:undefined);
  const proposal=await calendar.run(CalendarProposal.parse({operation:'create',title:'Спільна вечеря',start:personal.start,end:new Date(Date.parse(personal.end)+7200000).toISOString(),minutes:60,participants:['11']}),context('-100'));
  const share=await one(group,'SELECT * FROM calendar_shares WHERE proposal_id=$1',[proposal.id]);
  await group.query("UPDATE calendar_shares SET status='approved',mode='manual',intervals=$2,checked_at=now(),expires_at=now()+interval '1 day' WHERE token=$1",[share!.token,JSON.stringify([{start:personal.start,end:new Date(Date.parse(personal.end)+7200000).toISOString()}])]);
  const choose=async(version:number,index=0)=>{const view=await calendar.view(proposal.id,context('-100'));return calendar.run(CalendarProposal.parse({operation:'select',id:proposal.id,version,selected_start:view.windows[index].start}),context('-100'));};
  const open=()=>calendar.privateOpen({message_id:++sequence,date:Math.floor(Date.now()/1000),from:{id:11,first_name:'Власник'},chat:{id:11,type:'private'},text:'/start calbook_'+share!.token} as Message,telegram as unknown as Telegram);
  const book=()=>calendar.privateCallback({id:'book:'+ ++sequence,from:{id:11,first_name:'Власник'},data:'calshare:'+share!.token+':0'} as CallbackQuery,telegram as unknown as Telegram);
  const apply=async(change:CalendarChange)=>group.tx(async sql=>{
    const event=await one(sql,'SELECT * FROM group_events WHERE id=$1 FOR UPDATE',[change.groupEventId]);
    if(!event||event.details.calendar_owner!==change.ownerId||event.details.calendar_mirror!==change.mirrorId||event.details.calendar_sync_version>=change.version)return;
    await sql.query('UPDATE group_events SET details=$2,version=version+1 WHERE id=$1',[event.id,JSON.stringify({...event.details,calendar_sync_version:change.version,calendar_status:change.status,...(change.start?{start_at:change.start,end_at:change.end}:{}),attendance:'not_confirmed'})]);
  });
  return {...personal,group,calendar,telegram,proposal,share:share!,choose,open,book,apply,close:async()=>{await group.close();await personal.close();}};
}

test('confirmed own update and cancellation deliver committed minimal notices once',async()=>{
  const f=await fixture();try{
    const made=await f.create(),event=randomUUID(),notices:CalendarChange[]=[];
    await f.db.query("UPDATE calendar_mirrors SET group_event_id=$2,group_chat_id='-100' WHERE id=$1",[made.id,event]);
    setCalendarChangeListener(f.db,async change=>{
      const committed=await one(f.db,'SELECT * FROM calendar_mirrors WHERE id=$1',[change.mirrorId]);
      assert.equal(committed!.version,change.version);
      assert.equal(Number((await one(f.db,"SELECT count(*) AS n FROM calendar_operations WHERE receipt->>'mirror_id'=$1 AND status='confirmed'",[made.id]))!.n),change.version);
      notices.push(change);
    });
    const start=new Date(Date.parse(f.start)+900000).toISOString(),end=new Date(Date.parse(f.end)+900000).toISOString();
    const updated=await f.service.run(CalendarCommand.parse({operation:'update',connection_id:f.connection,event_id:made.id,version:made.version,start,end,description:'Особистий опис не передається'}),context());
    const cancelled=await f.service.run(CalendarCommand.parse({operation:'cancel',connection_id:f.connection,event_id:made.id,version:updated.version}),context());
    assert.equal(updated.status,'confirmed');assert.equal(cancelled.status,'confirmed');
    assert.equal(notices.length,2);assert.equal(notices[0]!.start,start);assert.equal(notices[1]!.status,'cancelled');
    assert.deepEqual(Object.keys(notices[0]!).sort(),['end','groupChat','groupEventId','mirrorId','ownerId','start','status','version'].sort());
    const rows=(await f.db.query('SELECT * FROM calendar_change_outbox ORDER BY version')).rows;
    assert.equal(rows.length,2);assert.ok(rows.every(row=>row.delivered_at&&row.attempts===1));
    assert.ok(!JSON.stringify(rows).includes('Особистий опис'));
    await f.service.run(CalendarCommand.parse({operation:'reconcile',connection_id:f.connection}),context());
    await f.service.next();assert.equal(notices.length,2);
  }finally{await f.close();}
});

for(const afterCommit of [false,true])test('failed group notice retries after restart '+(afterCommit?'after target commit':'before target commit'),async()=>{
  const f=await groupFixture();try{
    const selected=await f.choose(1);await f.open();await f.book();let attempts=0;
    setCalendarChangeListener(f.db,async change=>{attempts++;if(afterCommit||attempts>1)await f.apply(change);if(attempts===1)throw Error('group callback unavailable');});
    const before=await one(f.group,'SELECT * FROM group_events WHERE id=$1',[selected.group_event_id]);
    const mirror=await one(f.db,'SELECT * FROM calendar_mirrors WHERE id=$1',[before!.details.calendar_mirror]);
    const updated=await f.service.run(CalendarCommand.parse({operation:'update',connection_id:f.connection,event_id:mirror!.id,version:mirror!.version,start:new Date(Date.parse(f.start)+1800000).toISOString(),end:new Date(Date.parse(f.end)+1800000).toISOString()}),context());
    assert.equal(updated.status,'confirmed');assert.equal((await one(f.db,'SELECT status FROM calendar_operations WHERE id=$1',[updated.operation_id]))!.status,'confirmed');
    assert.equal((await one(f.db,'SELECT delivered_at FROM calendar_change_outbox'))!.delivered_at,null);
    await f.db.query('UPDATE calendar_change_outbox SET next_attempt=now()');
    await f.db.query("UPDATE calendar_connections SET next_sync=now()+interval '1 day'");
    await f.db.query("UPDATE calendar_mirrors SET next_check=now()+interval '1 day'");
    const restarted=new CalendarSync(f.db,f.runtime,f.provider.request),writes=f.provider.writes.length;
    assert.equal(await restarted.next(),true);assert.equal(attempts,2);assert.equal(f.provider.writes.length,writes);
    const current=await one(f.group,'SELECT * FROM group_events WHERE id=$1',[selected.group_event_id]);
    assert.equal(current!.version,before!.version+1);assert.equal(current!.details.calendar_sync_version,updated.version);
    assert.ok((await one(f.db,'SELECT delivered_at FROM calendar_change_outbox'))!.delivered_at);
    assert.equal(await restarted.next(),false);assert.equal(attempts,2);
  }finally{await f.close();}
});

test('pending group notices stop at the owner memory revision boundary',async()=>{
  const f=await fixture();try{
    const made=await f.create();let attempts=0;
    await f.db.query("UPDATE calendar_mirrors SET group_event_id=$2,group_chat_id='-100' WHERE id=$1",[made.id,randomUUID()]);
    setCalendarChangeListener(f.db,async()=>{attempts++;throw Error('target unavailable');});
    const updated=await f.service.run(CalendarCommand.parse({operation:'update',connection_id:f.connection,event_id:made.id,version:made.version,start:new Date(Date.parse(f.start)+900000).toISOString(),end:new Date(Date.parse(f.end)+900000).toISOString()}),context());
    assert.equal(updated.status,'confirmed');assert.equal(attempts,1);
    await f.db.query("UPDATE calendar_connections SET next_sync=now()+interval '1 day'");
    await f.db.query('UPDATE calendar_change_outbox SET next_attempt=now()');
    await f.db.query('UPDATE app_state SET paused=true,memory_revision=1 WHERE id=1');
    assert.equal(await f.service.next(),false);assert.equal(attempts,1);
    await f.db.query('UPDATE app_state SET paused=false WHERE id=1');
    assert.equal(await f.service.next(),false);assert.equal(attempts,1);assert.equal((await f.db.query('SELECT id FROM calendar_change_outbox')).rows.length,0);
    assert.equal((await one(f.db,'SELECT status FROM calendar_operations WHERE id=$1',[updated.operation_id]))!.status,'confirmed');
  }finally{await f.close();}
});

test('reselecting and rebooking the same proposal updates its exact mirror and UID',async()=>{
  const f=await groupFixture();try{
    setCalendarChangeListener(f.db,f.apply);
    const first=await f.choose(1);await f.open();await f.book();
    const bound=await one(f.group,'SELECT * FROM group_events WHERE id=$1',[first.group_event_id]);
    const original=await one(f.db,'SELECT * FROM calendar_mirrors WHERE id=$1',[bound!.details.calendar_mirror]);
    assert.equal(bound!.details.calendar_owner,'11');
    await f.choose(2,1);
    const selected=await one(f.group,'SELECT * FROM group_events WHERE id=$1',[first.group_event_id]);
    assert.equal(selected!.details.calendar_mirror,original!.id);assert.equal(selected!.details.calendar_owner,'11');
    await f.open();await f.book();await f.open();await f.book();
    const mirrors=(await f.db.query('SELECT * FROM calendar_mirrors')).rows,operations=(await f.db.query('SELECT kind FROM calendar_operations ORDER BY created_at')).rows;
    assert.equal(mirrors.length,1);assert.equal(mirrors[0]!.uid,original!.uid);assert.equal(mirrors[0]!.version,3);assert.equal(f.provider.resources.size,1);
    assert.deepEqual(operations.map(row=>row.kind),['create','update','update']);
    assert.equal(f.provider.writes[0]!.headers['If-None-Match'],'*');assert.ok(f.provider.writes.slice(1).every(write=>write.headers['If-Match']));
    const group=await one(f.group,'SELECT * FROM group_events WHERE id=$1',[first.group_event_id]);
    assert.equal(group!.details.calendar_mirror,original!.id);assert.equal(group!.details.calendar_sync_version,3);assert.equal(group!.details.attendance,'not_confirmed');
    assert.ok(!f.telegram.sent.some(message=>message.text.includes('зв’язування потребує')));
  }finally{await f.close();}
});

test('a different booking connection cannot silently create a second event',async()=>{
  const f=await groupFixture();try{
    await f.choose(1);await f.open();await f.book();const other=randomUUID();
    await f.db.query("INSERT INTO calendar_connections(id,owner_id,title,endpoint,credential_name,scope,status) VALUES($1,'11','Другий',$2,'calendar_revision','read_write','ready')",[other,'https://calendar.example/alice/second/']);
    await f.open();const options=await one(f.group,'SELECT connection_options FROM calendar_shares WHERE token=$1',[f.share.token]);assert.deepEqual(options!.connection_options,[f.connection]);
    await f.group.query('UPDATE calendar_shares SET connection_options=$2 WHERE token=$1',[f.share.token,JSON.stringify([other])]);
    const writes=f.provider.writes.length;await assert.rejects(f.book(),/calendar_booking_connection_change_requires_review/);
    assert.equal(f.provider.writes.length,writes);assert.equal(f.provider.resources.size,1);
  }finally{await f.close();}
});

test('a legacy lost group binding recovers only its single actor-owned mirror',async()=>{
  const f=await groupFixture();try{
    const selected=await f.choose(1);await f.open();await f.book();
    const mirror=await one(f.db,'SELECT * FROM calendar_mirrors');
    await f.db.query('UPDATE calendar_operations SET id=$1',[randomUUID()]);
    await f.group.query("UPDATE group_events SET details=details-'calendar_owner'-'calendar_mirror'-'calendar_sync_version'-'calendar_receipt' WHERE id=$1",[selected.group_event_id]);
    await f.choose(2,1);await f.open();await f.book();
    const recovered=await one(f.group,'SELECT * FROM group_events WHERE id=$1',[selected.group_event_id]);
    assert.equal(recovered!.details.calendar_mirror,mirror!.id);assert.equal(f.provider.resources.size,1);
    assert.deepEqual((await f.db.query('SELECT kind FROM calendar_operations ORDER BY created_at')).rows.map(row=>row.kind),['create','update']);
    const duplicateId=randomUUID();await f.db.query("INSERT INTO calendar_mirrors(id,connection_id,uid,href,title,starts_at,ends_at,etag,status,group_event_id,group_chat_id) SELECT $1,connection_id,'old-duplicate',href,title,starts_at,ends_at,etag,status,group_event_id,group_chat_id FROM calendar_mirrors WHERE id=$2",[duplicateId,mirror!.id]);
    await f.group.query("UPDATE group_events SET details=details-'calendar_owner'-'calendar_mirror' WHERE id=$1",[selected.group_event_id]);
    await f.open();const writes=f.provider.writes.length;await assert.rejects(f.book(),/calendar_multiple_bookings_require_review/);assert.equal(f.provider.writes.length,writes);
  }finally{await f.close();}
});

for(const status of ['uncertain','dispatching'])test('first '+status+' create reconciles automatically without a window or mirror',async()=>{
  const f=await fixture();try{
    f.provider.loseNextWrite=true;const result=await f.create();assert.equal(result.status,'uncertain');
    if(status==='dispatching')await f.db.query("UPDATE calendar_operations SET status='dispatching' WHERE id=$1",[result.id]);
    assert.equal((await one(f.db,'SELECT last_window FROM calendar_connections'))!.last_window,null);assert.equal((await f.db.query('SELECT id FROM calendar_mirrors')).rows.length,0);
    assert.equal(await f.service.next(),true);
    await waitFor(async()=>Boolean((await one(f.db,"SELECT id FROM calendar_operations WHERE id=$1 AND status='confirmed'",[result.id]))));
    assert.equal(f.provider.writes.length,1);assert.equal(f.provider.resources.size,1);
    const mirror=await one(f.db,'SELECT * FROM calendar_mirrors');assert.equal(mirror!.status,'confirmed');assert.equal(mirror!.etag,f.provider.resources.get(mirror!.href)!.etag);
  }finally{await f.close();}
});

test('a lost first booking can be reselected without creating another UID',async()=>{
  const f=await groupFixture();try{
    const first=await f.choose(1);await f.open();f.provider.loseNextWrite=true;await f.book();assert.equal(f.provider.resources.size,1);
    await f.choose(2,1);await f.open();await f.book();
    const operations=(await f.db.query('SELECT * FROM calendar_operations ORDER BY created_at')).rows;
    assert.deepEqual(operations.map(row=>[row.kind,row.status]),[['create','confirmed'],['update','confirmed']]);
    assert.equal(new Set(operations.map(row=>row.uid)).size,1);assert.equal(f.provider.resources.size,1);
    const event=await one(f.group,'SELECT * FROM group_events WHERE id=$1',[first.group_event_id]);assert.ok(event!.details.calendar_mirror);
  }finally{await f.close();}
});

test('occurrence update and uncertain cancellation preserve recurrence identity and current ETag',async()=>{
  const f=await fixture();try{
    const uid='series@lumen',rid='2026-11-04T17:00:00Z',href=f.endpoint+'series.ics';
    const original=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:'+uid,'DTSTART:20261102T170000Z','DTEND:20261102T180000Z','RRULE:FREQ=DAILY;COUNT=4','EXDATE:20261103T170000Z','SUMMARY:Серія','LOCATION:Зберегти','END:VEVENT','END:VCALENDAR',''].join('\r\n');
    const remote=f.provider.seed(href,original),id=randomUUID();await f.db.query("INSERT INTO calendar_mirrors(id,connection_id,uid,recurrence_id,href,title,starts_at,ends_at,etag,status,group_event_id,group_chat_id) VALUES($1,$2,$3,$4,$5,'Серія','2026-11-04T17:00:00Z','2026-11-04T18:00:00Z',$6,'confirmed',$7,'-100')",[id,f.connection,uid,rid,href,remote.etag,randomUUID()]);
    const notices:CalendarChange[]=[];setCalendarChangeListener(f.db,async notice=>{notices.push(notice);});
    const updated=await f.service.run(CalendarCommand.parse({operation:'update',connection_id:f.connection,event_id:id,version:1,scope:'occurrence',start:'2026-11-04T19:00:00Z',end:'2026-11-04T20:00:00Z'}),context());assert.equal(updated.status,'confirmed');assert.equal(updated.receipt.recurrence_id,rid);
    assert.match(f.provider.resources.get(href)!.data,/RRULE:FREQ=DAILY;COUNT=4/);assert.match(f.provider.resources.get(href)!.data,/LOCATION:Зберегти/);
    f.provider.loseNextWrite=true;const cancelled=await f.service.run(CalendarCommand.parse({operation:'cancel',connection_id:f.connection,event_id:id,version:updated.version,scope:'occurrence'}),context());assert.equal(cancelled.status,'uncertain');
    const reconciled=await f.service.run(CalendarCommand.parse({operation:'reconcile',connection_id:f.connection}),context());assert.equal(reconciled.results[0].status,'confirmed');
    const current=await one(f.db,'SELECT * FROM calendar_mirrors WHERE id=$1',[id]);assert.equal(current!.recurrence_id,rid);assert.equal(current!.etag,f.provider.resources.get(href)!.etag);assert.equal(current!.status,'cancelled');
    assert.equal(f.provider.writes.filter(write=>write.method==='DELETE').length,0);assert.equal(calendarEvents(f.provider.resources.get(href)!.data).find(event=>event.recurrence_id===rid)!.status,'CANCELLED');
    assert.deepEqual(notices.map(notice=>notice.status),['confirmed','cancelled']);
  }finally{await f.close();}
});
