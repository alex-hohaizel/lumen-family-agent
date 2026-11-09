import {after,before,beforeEach,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {TestDB,harness,paired,message} from './helpers.js';
import {type SQL,type Row} from '../src/db.js';
import {OpenAIModel,type Plan} from '../src/model.js';
import {storedSourceId} from '../src/request-context.js';
import {Recurring,SeriesRule} from '../src/recurring.js';
import {dispatchSchedules} from '../src/scheduling.js';
import {TaskJournal} from '../src/task-journal.js';
import {Delivery} from '../src/delivery.js';
import {type Telegram} from '../src/telegram.js';
import {reminderRequestSource} from '../src/reminder-control.js';

/** PGlite returns int8 numbers. Match the real pg OID20 decoder at BOTH query
 * boundaries, including transactions; JSONB values are left exactly intact. */
class PgInt8DB extends TestDB {
 decoded=0;
 private decode<R extends {rows:Row[];fields?:Array<{name:string;dataTypeID:number}>}>(result:R):R {
  const names=(result.fields||[]).filter(field=>field.dataTypeID===20).map(field=>field.name);
  return {...result,rows:result.rows.map(row=>{
   const copy:Row={...row};for(const name of names)if(copy[name]!==null&&copy[name]!==undefined){copy[name]=pg.types.getTypeParser(20)(String(copy[name]));this.decoded++;}return copy;
  })} as R;
 }
 override async query<T extends Row=Row>(sql:string,args:any[]=[]){return this.decode(await super.query<T>(sql,args));}
 override async tx<T>(fn:(sql:SQL)=>Promise<T>):Promise<T>{
  return super.tx(sql=>fn({query:async<R extends Row=Row>(text:string,args:any[]=[])=>this.decode(await sql.query<R>(text,args)),script:sql.script}));
 }
}
let db:PgInt8DB,h:ReturnType<typeof harness>,id:string;
before(async()=>{db=new PgInt8DB();await db.init();});after(async()=>db.close());
beforeEach(async()=>{
 await db.reset();await db.query('TRUNCATE recurring_series CASCADE');h=harness(db);await paired(h);id=randomUUID();
 await db.query('UPDATE app_state SET open_group=true,mention_only=true,quiet_start=0,quiet_end=0');
 const rule=SeriesRule.parse({title:'Нічна картопляна варта',instruction:'Надіслати нічну варту у цей чат.',mode:'task',timezone:'Europe/Kyiv',start_date:'2030-01-01',time:'04:00',frequency:'daily',interval:1,dst:'reject'});
 // A retained pre-migration root does not gain new sharing/management rights.
 const old=(await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id,created_at,request_context) VALUES(1,'11','Авторка','user','Старе погоджене прохання','0','2026-10-31T21:36:00Z',NULL) RETURNING id")).rows[0]!;
 assert.equal(typeof old.id,'string');
 await db.query("INSERT INTO recurring_series(id,actor_id,topic_id,rule,revision,status,audience,shared,manager_ids,source_message_id,created_at) VALUES($1,'11','0',$2,0,'active','group',false,'[]',$3,'2026-10-31T21:36:00Z')",[id,JSON.stringify(rule),old.id]);
});
function connect(plan:Plan){
 const calls:any[]=[];
 const fetcher=async(_url:any,init:any)=>{calls.push(JSON.parse(init.body));assert.equal(calls.length,1);return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:JSON.stringify(plan)})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{output:[]}})+'\n\n');};
 const model=new OpenAIModel({...h.config,authMode:'api',apiKey:'synthetic-key',webSearch:false},{} as any,fetcher as typeof fetch);
 h.brain.plan=input=>model.plan(input);return calls;
}
const status=async()=>(await db.query('SELECT status FROM recurring_series WHERE id=$1',[id])).rows[0]!.status;
const output=async()=>(await db.query("SELECT body->>'text' AS text FROM outbox WHERE kind='text' ORDER BY id")).rows.map(row=>row.text).join('\n');
const screenshot='@lumen_test_bot\n\nЛюмене, припини надсилати «Нічну картопляну варту» о04:00 у цьому чаті. Скасуй усю повторювану серію, а не лише найближчий запуск.';
for(const body of [screenshot,'@lumen_test_bot Я авторка і я рішаю: скасовуй','Люмен, не хочу більше бачити цю варту.'])it(`pg int8 fresh source stops the legacy owner root: ${body.slice(0,48)}`,async()=>{
 const quote=body===screenshot?'Скасуй усю повторювану серію':body.includes('авторка')?'Я авторка і я рішаю: скасовуй':'не хочу більше бачити цю варту';
 const calls=connect({reply:'',actions:[{kind:'cancel_reminder',id,scope:'series'}],authorization:{quote,actions:['cancel_reminder']}});
 await h.lumen.receive(message(body));
 const pending=(await db.query("SELECT payload FROM inbox WHERE status='pending' ORDER BY update_id LIMIT 1")).rows[0]!;
 assert.equal(typeof pending.payload.sourceId,'number','new jobs canonicalize real pg int8 at ingress');
 await h.lumen.processNext();assert.equal(calls.length,1);assert.equal(await status(),'ended');
 assert.match(await output(),/Майбутні повтори зупинив/u);assert.doesNotMatch(await output(),/прив’язку|Надішли прохання ще раз/u);
 assert.equal((await db.query('SELECT request_context FROM messages WHERE telegram_id=1')).rows[0]!.request_context,null,'old source is preserved');
 assert.ok(db.decoded>10,'real pg OID20 decoder covered more than the source insert');
 assert.equal(await new Recurring(db).tick(),false,'ended legacy parent cannot create another run');
});
it('an explicit whole series request overrides a contradictory model occurrence scope',async()=>{
 connect({reply:'',actions:[{kind:'cancel_reminder',id,scope:'occurrence'}],authorization:{quote:'Скасуй усю повторювану серію',actions:['cancel_reminder']}});
 await h.lumen.receive(message(screenshot));await h.lumen.processNext();assert.equal(await status(),'ended');assert.match(await output(),/Майбутні повтори зупинив/u);
});
it('a negated whole-series mention preserves a correctly selected single occurrence',async()=>{
 const body='Люмен, усю серію не чіпай, прибери тільки завтрашній запуск.';
 connect({reply:'',actions:[{kind:'cancel_reminder',id,scope:'occurrence'}],authorization:{quote:'прибери тільки завтрашній запуск',actions:['cancel_reminder']}});
 await h.lumen.receive(message(body));await h.lumen.processNext();assert.equal(await status(),'active');assert.match(await output(),/Найближчий повтор скасував; серія залишається/u);
});
it('a persisted pre-fix pg string source job resumes without exchanging native provenance',async()=>{
 const body='Люмен, припини ці повтори, будь ласка',quote='припини ці повтори, будь ласка';
 connect({reply:'',actions:[{kind:'cancel_reminder',id,scope:'series'}],authorization:{quote,actions:['cancel_reminder']}});
 await h.lumen.receive(message(body));
 // Exact old JSONB representation written by receive before the boundary fix.
 await db.query("UPDATE inbox SET payload=jsonb_set(payload,'{sourceId}',to_jsonb((payload->>'sourceId')::text)) WHERE status='pending'");
 await h.lumen.processNext();assert.equal(await status(),'ended');assert.match(await output(),/Майбутні повтори зупинив/u);
});
it('a positive nearest-only instruction preserves the series despite a conflicting planner scope',async()=>{
 const body='Люмен, скасуй лише найближчий повтор цієї варти.',quote='скасуй лише найближчий повтор цієї варти';
 connect({reply:'',actions:[{kind:'cancel_reminder',id,scope:'series'}],authorization:{quote,actions:['cancel_reminder']}});
 await h.lumen.receive(message(body));await h.lumen.processNext();assert.equal(await status(),'active');assert.match(await output(),/Найближчий повтор скасував; серія залишається/u);
});
it('pg int8 nonowner request opens one bound card and native owner agreement ends the public legacy root',async()=>{
 await db.query("INSERT INTO members(user_id,name) VALUES('11','Авторка'),('22','Співрозмовник') ON CONFLICT(user_id) DO UPDATE SET active=true,name=excluded.name");
 await new Recurring(db).tick();
 const first=(await db.query('SELECT * FROM recurring_occurrences WHERE series_id=$1 ORDER BY due_at LIMIT 1',[id])).rows[0]!;
 await db.query("UPDATE recurring_occurrences SET due_at=now()-interval '1 second' WHERE series_id=$1 AND occurrence_key=$2",[id,first.occurrence_key]);
 await db.query("UPDATE scheduled_actions SET due_at=now()-interval '1 second' WHERE id=$1",[first.schedule_id]);
 await new Recurring(db).tick();assert.equal(await dispatchSchedules(db),1);
 const task=(await db.query('SELECT t.* FROM agent_tasks t JOIN scheduled_actions a ON a.task_id=t.id JOIN recurring_occurrences r ON r.schedule_id=a.id WHERE r.series_id=$1 ORDER BY t.created_at DESC LIMIT 1',[id])).rows[0]!;
 await new TaskJournal(db).publish(task.id,true);
 const delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);assert.equal(await delivery.next('text'),true);
 assert.ok(h.tg.sent.some(sent=>sent.text.includes('Нічна картопляна варта')));
 const body='Люмен, хочу, щоб ти перестав надсилати цю варту.',quote='хочу, щоб ти перестав надсилати цю варту';
 const calls=connect({reply:'',actions:[{kind:'cancel_reminder',id,scope:'series'}],authorization:{quote,actions:['cancel_reminder']}});
 await h.lumen.receive(message(body,22));await h.lumen.processNext();assert.equal(calls.length,1);assert.equal(await status(),'active');
 const proposals=(await db.query("SELECT id,card_message_id FROM interactions WHERE spec->>'reminder_cancel'='true'")).rows;assert.equal(proposals.length,1);
 let card:number|undefined;
 for(let attempt=0;attempt<12;attempt++){
  const row=(await db.query('SELECT card_message_id FROM interactions WHERE id=$1',[proposals[0]!.id])).rows[0]!;
  if(Number(row.card_message_id)>0){card=Number(row.card_message_id);break;}await delivery.next('text');
 }
 assert.ok(card,'real scoped approval card was delivered');
 const owner=message('так',11);owner.message!.reply_to_message={message_id:card!,date:Math.floor(Date.now()/1000),from:{id:999,is_bot:true,first_name:'Люмен'},chat:{id:-100,type:'supergroup'}};
 await h.lumen.receive(owner);assert.equal(await status(),'ended');
 assert.equal((await db.query('SELECT phase FROM interactions WHERE id=$1',[proposals[0]!.id])).rows[0]!.phase,'resolved');
 assert.equal((await db.query('SELECT status FROM agent_tasks WHERE id=$1',[task.id])).rows[0]!.status,'cancelled');
 assert.ok((await db.query("SELECT id FROM outbox WHERE status='sent' AND body->>'taskId'=$1",[task.id])).rows.length,'past sent delivery retained');
});
it('source failures retain the safe exact rejection reason without changing the public error code',async()=>{
 await h.lumen.receive(message('Люмен, припини варту.'));
 const pending=(await db.query("SELECT payload FROM inbox WHERE status='pending' LIMIT 1")).rows[0]!,sourceId=pending.payload.sourceId;
 const base={sourceId,actorId:'11',topicId:'0',revision:0,chatId:'-100',audience:'group' as const};
 const check=async(c:typeof base,detail:string)=>assert.rejects(()=>reminderRequestSource(db,c),error=>(error as any).code==='reminder_request_unbound'&&(error as any).failureDetail===detail);
 await check({...base,sourceId:'1' as any},'source_id_invalid');
 await check({...base,sourceId:999999},'source_missing');await check({...base,actorId:'22'},'source_actor_mismatch');await check({...base,topicId:'7'},'source_topic_mismatch');await check({...base,revision:1},'source_revision_mismatch');
 await assert.rejects(()=>reminderRequestSource(db,{...base,requestText:'different'}),error=>(error as any).failureDetail==='source_body_mismatch');
 await db.query('UPDATE messages SET request_context=NULL WHERE id=$1',[sourceId]);await check(base,'source_context_missing');
});
it('only canonical safe positive internal source IDs can be normalized',()=>{
 for(const value of [1,483,Number.MAX_SAFE_INTEGER,'1','483',String(Number.MAX_SAFE_INTEGER)])assert.equal(storedSourceId(value),Number(value));
 for(const value of [0,-1,1.5,NaN,Infinity,null,undefined,true,{},[],'','0','00','0483','+483','-483','483.0','4.83e2',' 483','483 ',String(BigInt(Number.MAX_SAFE_INTEGER)+1n)])assert.equal(storedSourceId(value),undefined,String(value));
});
for(const source of ['0483','4.83e2','9007199254740992',0,null])it(`invalid old source ${source} cannot trigger planning or mutation`,async()=>{
 const calls=connect({reply:'',actions:[]});await h.lumen.receive(message('Люмен, припини варту.'));
 await db.query("UPDATE inbox SET payload=jsonb_set(payload,'{sourceId}',$1::jsonb) WHERE status='pending'",[JSON.stringify(source)]);
 await h.lumen.processNext();assert.equal(calls.length,0);assert.equal(await status(),'active');
 assert.equal((await db.query("SELECT status FROM inbox ORDER BY update_id DESC LIMIT 1")).rows[0]!.status,'failed');
});
