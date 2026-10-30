import {it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ChatRegistry} from '../src/registry.js';
import {ChatRouter,type ChatRuntime} from '../src/router.js';
import {TransportQueue} from '../src/transport-queue.js';
import {eraseAll,one,state,type SQL} from '../src/db.js';
import {ConnectorVault} from '../src/connector-vault.js';
import type {Update} from '../src/telegram.js';
import {TestDB,harness,FakeBrain,message} from './helpers.js';
let sequence=812000;
const bot={id:999,username:'lumen_test_bot',can_read_all_group_messages:true};
function callback(data:string,chat=-3100,actor=11):Update{return {update_id:sequence++,callback_query:{id:'callback-'+sequence,from:{id:actor,first_name:'Actor'},data,message:{message_id:sequence++,date:Math.floor(Date.now()/1000),from:{id:999,first_name:'Lumen',is_bot:true},chat:{id:chat,type:chat>0?'private':'supergroup'},text:'Previous card'}}};}
async function setup(){
 const db=new TestDB();await db.init();const h=harness(db),registry=new ChatRegistry(db),brain=new FakeBrain();
 const router=new ChatRouter(registry,h.config,h.tg as any,bot,()=>brain);await router.init();let fail=false;
 const queue=new TransportQueue(db,h.config.runtimeDir,async update=>{if(fail)throw Object.assign(Error('fixture'),{code:'fixture_unavailable'});await router.receive(update);},(update,sql)=>router.ingressScopes(update,sql));await queue.init();
 const runtime=async(id=-3100)=>router.runtime(await registry.ensure(String(id),'11'));
 return {...h,db,registry,brain,router,queue,runtime,fail(value:boolean){fail=value;},async close(){await router.cancelAll();await router.drainAll();await db.close();}};
}
async function repaired(h:Awaited<ReturnType<typeof setup>>,update:Update){
 await h.db.query("UPDATE public.lumen_ingress SET status='pending',attempts=0,manual_retries=manual_retries+1,available_at=now() WHERE update_id=$1",[update.update_id]);h.fail(false);await h.queue.next();
 assert.equal((await one(h.db,'SELECT status FROM public.lumen_ingress WHERE update_id=$1',[update.update_id]))!.status,'done');
}
async function parked(h:Awaited<ReturnType<typeof setup>>,update:Update){h.fail(true);await h.queue.enqueue(update);await h.queue.next();await h.db.query("UPDATE public.lumen_ingress SET status='repair' WHERE update_id=$1",[update.update_id]);}
async function privateRequest(runtime:ChatRuntime,actor='22',status='offered'){
 const id=randomUUID(),token=randomUUID().replaceAll('-','').slice(0,24);
 await runtime.db.query('INSERT INTO private_requests(id,token,recipient_id,requester_id,topic_id,question,purpose,status,revision,expires_at) VALUES($1,$2,$3,\'11\',\'0\',\'Private question\',\'fixture\',$4,0,now()+interval \'1 day\')',[id,token,actor,status]);return {id,token};
}
async function connector(runtime:ChatRuntime,name='fixture',actor='22'){
 const id=randomUUID();await runtime.db.query("INSERT INTO connection_setups(id,actor_id,name,endpoint,status,expires_at,revision) VALUES($1,$2,$3,'https://example.com/mcp','awaiting_token',now()+interval '1 day',0)",[id,actor,name]);return id;
}

it('TransportQueue → Router: repaired consent callbacks cannot resume after pause or erasure',async t=>{
 for(const action of ['/pause','/forget_all'])await t.test(action,async()=>{
  const h=await setup();try{
   const r=await h.runtime();const update=callback('lumen:consent');
   (update as any).lumen_ingress_at='2099-01-01T00:00:00Z';(update as any).lumen_ingress_scopes=['22'];
   await parked(h,update);await h.router.receive(message('/pause',11,-3100));
   if(action==='/forget_all')await h.router.receive(message('/forget_all',11,-3100));
   assert.ok((await state(r.db)).ingress_after);assert.equal((await state(r.db)).paused,true);
   await repaired(h,update);assert.equal((await state(r.db)).paused,true);
   assert.ok(h.tg.calls.some(call=>call.method==='answerCallbackQuery'&&call.body.callback_query_id===update.callback_query!.id));
   assert.equal(h.brain.calls.length,0);
  }finally{await h.close();}
 });
});

it('all five synthetic Update routes preserve the trusted timestamp and target scopes',async()=>{
 const h=await setup();try{
  const r=await h.runtime(),seen:Update[]=[],receive=r.engine.receive.bind(r.engine);
  r.engine.receive=async(update,administrator)=>{seen.push(update);return receive(update,administrator);};
  await r.db.query("INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id) VALUES(6100,'11','Actor','user','Original','0')");
  await r.db.query("INSERT INTO polls(poll_id,message_id,question,options,revision) VALUES('routing-poll',6200,'Pick','[\"A\",\"B\"]',0)");
  const choice=randomUUID();await r.db.query("INSERT INTO choices(id,label,topic_id,revision) VALUES($1,'A','0',0)",[choice]);
  const updates:Update[]=[
   {update_id:sequence++,message_reaction:{chat:{id:-3100,type:'supergroup'},message_id:6100,user:{id:11,first_name:'Actor'},date:Math.floor(Date.now()/1000),old_reaction:[],new_reaction:[{type:'emoji',emoji:'👍'}]}},
   {update_id:sequence++,poll_answer:{poll_id:'routing-poll',user:{id:11,first_name:'Actor'},option_ids:[0]}},
   callback('li:'+randomUUID()+':1:a'),callback('lumen:choice:'+choice),callback('lumen:consent')
  ];
  for(const update of updates){(update as any).lumen_ingress_at='2099-01-01T00:00:00Z';(update as any).lumen_ingress_scopes=['777'];await h.queue.enqueue(update);await h.queue.next();}
  assert.equal(seen.length,5);
  for(const update of seen){const persisted=await one(h.db,'SELECT created_at::text AS at FROM public.lumen_ingress WHERE update_id=$1',[update.update_id]);assert.equal((update as any).lumen_ingress_at,persisted!.at);assert.deepEqual((update as any).lumen_ingress_scopes,['-3100']);}
 }finally{await h.close();}
});

it('sub-millisecond cutoff ordering survives the queue and rejects an older repaired callback',async()=>{
 const h=await setup();try{
  const r=await h.runtime(),update=callback('lumen:consent');await parked(h,update);
  await h.db.query("UPDATE public.lumen_ingress SET created_at='2030-01-01 00:00:00.000100+00' WHERE update_id=$1",[update.update_id]);
  await r.db.query("UPDATE app_state SET paused=true,ingress_after='2030-01-01 00:00:00.000200+00' WHERE id=1");
  await repaired(h,update);assert.equal((await state(r.db)).paused,true);
 }finally{await h.close();}
});

it('deleted private callback purpose is consumed and acknowledged without touching namespace B',async()=>{
 const h=await setup();try{
  const a=await h.runtime(-3200),b=await h.runtime(-3201),request=await privateRequest(a),other=await privateRequest(b,'22','answering');
  const update=callback('lumen:pv:'+request.token+':task',22,22);await parked(h,update);await a.db.tx(eraseAll);
  const sent=h.tg.sent.length;await repaired(h,update);
  assert.equal(h.tg.sent.length,sent);assert.equal(await h.registry.privateConsumed(update.update_id,'22'),true);
  assert.equal((await one(b.db,'SELECT status FROM private_requests WHERE id=$1',[other.id]))!.status,'answering');
  assert.equal(await h.registry.find('22'),undefined);assert.equal(h.brain.calls.length,0);
  assert.ok(h.tg.calls.some(call=>call.method==='answerCallbackQuery'&&call.body.callback_query_id===update.callback_query!.id));
 }finally{await h.close();}
});

it('deleted connector and calendar secret purposes never fall back to ordinary private memory',async t=>{
 for(const kind of ['connector','calendar'])await t.test(kind,async()=>{
  const h=await setup();try{
   const a=await h.runtime(-3300),b=await h.runtime(-3301);await privateRequest(b);
   if(kind==='connector')await connector(a);
   else await a.db.query("INSERT INTO calendar_setups(id,owner_id,endpoint,revision,status,expires_at) VALUES($1,'22','https://example.com/calendar/',0,'awaiting_secret',now()+interval '1 day')",[randomUUID()]);
   const update=message(kind==='calendar'?'account-name\nquiet old password':'quiet old password',22,22,'private');await parked(h,update);await a.db.tx(eraseAll);await repaired(h,update);
   assert.equal(await h.registry.privateConsumed(update.update_id,'22'),true);assert.equal(await h.registry.find('22'),undefined);
   assert.equal((await b.db.query('SELECT id FROM tool_connections')).rows.length,0);assert.equal(h.brain.calls.length,0);
   assert.equal((await a.db.query("SELECT id FROM messages WHERE role='user'")).rows.length,0);
  }finally{await h.close();}
 });
});

it('forgetting an unrelated offered namespace does not cancel a valid active secret in B',async()=>{
 const h=await setup();try{
  const a=await h.runtime(-3400),b=await h.runtime(-3401);await privateRequest(a);await connector(b,'namespace-b');
  const update=message('B scoped value',22,22,'private');await parked(h,update);await a.db.tx(eraseAll);await repaired(h,update);
  assert.equal(await new ConnectorVault(b.db,h.config.runtimeDir).get('22','namespace-b'),'B scoped value');
  assert.equal((await one(b.db,"SELECT health FROM tool_connections WHERE id='namespace-b'"))!.health,'check_pending');
  assert.equal(await h.registry.find('22'),undefined);assert.equal(h.brain.calls.length,0);
 }finally{await h.close();}
});

it('privacy-fence target transaction closes erase after the initial Router cutoff check',async()=>{
 const h=await setup();try{
  const a=await h.runtime(-3500),b=await h.runtime(-3501);await connector(a);const other=await privateRequest(b,'22','answering');
  const update=message('must not be repurposed',22,22,'private');await h.queue.enqueue(update);
  const inspect=h.registry.ingressStale.bind(h.registry);let race=true;
  h.registry.ingressStale=async(scopes,at)=>{const stale=await inspect(scopes,at);if(race){race=false;await a.db.tx(eraseAll);}return stale;};
  await h.queue.next();assert.equal((await one(h.db,'SELECT status FROM public.lumen_ingress WHERE update_id=$1',[update.update_id]))!.status,'done');
  assert.equal(await h.registry.privateConsumed(update.update_id,'22'),true);assert.equal(await h.registry.find('22'),undefined);
  assert.equal((await one(b.db,'SELECT status FROM private_requests WHERE id=$1',[other.id]))!.status,'answering');assert.equal(h.brain.calls.length,0);
 }finally{await h.close();}
});

it('legacy private or poll ciphertext without an authenticated binding stays encrypted in validation repair',async()=>{
 const h=await setup();try{
  const r=await h.runtime();await connector(r);
  for(const update of [message('legacy secret',22,22,'private'),{update_id:sequence++,poll_answer:{poll_id:'legacy-poll',user:{id:22,first_name:'Actor'},option_ids:[0]}} as Update]){
   await h.queue.enqueue(update);await h.db.query('UPDATE public.lumen_ingress SET context_version=0 WHERE update_id=$1',[update.update_id]);await h.queue.next();
   const row=await one(h.db,'SELECT status,ciphertext,error_kind,last_error FROM public.lumen_ingress WHERE update_id=$1',[update.update_id]);
   assert.equal(row!.status,'repair');assert.equal(row!.error_kind,'validation');assert.equal(row!.last_error,'ingress_scope_requires_review');assert.ok(row!.ciphertext);assert.equal(row!.ciphertext.includes('legacy secret'),false);assert.equal(await h.registry.find('22'),undefined);
  }
 }finally{await h.close();}
});

it('cold runtime restore commits the privacy wipe before rejecting its stale triggering ingress',async()=>{
 const h=await setup();let restarted:ChatRouter|undefined;
 try{
  const a=await h.runtime(-3800),old=callback('lumen:consent',-3800);await h.queue.enqueue(old);await a.db.tx(eraseAll);
  const raw=h.registry.database(a.chat);
  await raw.tx(async sql=>{await sql.query('UPDATE app_state SET memory_revision=0,ingress_after=NULL,paused=false WHERE id=1');await sql.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES(999001,'11','Owner','user','restored old content')");});
  restarted=new ChatRouter(h.registry,h.config,h.tg as any,bot,()=>h.brain);await restarted.init();
  const queue=new TransportQueue(h.db,h.config.runtimeDir,update=>restarted!.receive(update),(update,sql)=>restarted!.ingressScopes(update,sql));await queue.init();await queue.next();
  const repaired=await state(raw);assert.equal(repaired.memory_revision,1);assert.equal(repaired.paused,true);assert.ok(repaired.ingress_after);
  assert.equal((await raw.query('SELECT id FROM messages')).rows.length,0);assert.equal(restarted.all().length,0);
  assert.equal((await one(h.db,'SELECT status FROM public.lumen_ingress WHERE update_id=$1',[old.update_id]))!.status,'done');
  const fresh=callback('lumen:consent',-3800);await queue.enqueue(fresh);await queue.next();assert.equal((await state(raw)).paused,false);
 }finally{await restarted?.cancelAll();await restarted?.drainAll();await h.close();}
});

it('erase after the binding snapshot but before durable insert cannot rebind a secret to ordinary DM',async()=>{
 const h=await setup();try{
  const a=await h.runtime(-3600);await connector(a);const update=message('snapshot-bound secret',22,22,'private');
  const transact=h.db.tx.bind(h.db);let eraseBeforeInsert=true;
  h.db.tx=async<T>(fn:(sql:SQL)=>Promise<T>)=>{
   const result=await transact(fn);
   if(eraseBeforeInsert&&result&&typeof result==='object'&&'enqueuedAt' in result&&'scopes' in result){eraseBeforeInsert=false;await a.db.tx(eraseAll);}
   return result;
  };
  await h.queue.enqueue(update);assert.equal(eraseBeforeInsert,false);await h.queue.next();
  assert.equal(await h.registry.privateConsumed(update.update_id,'22'),true);assert.equal(await h.registry.find('22'),undefined);
  assert.equal((await a.db.query('SELECT id FROM tool_connections')).rows.length,0);assert.equal(h.brain.calls.length,0);
 }finally{await h.close();}
});

it('stale attach cannot re-enable a disabled schema; a fresh owner attach can',async()=>{
 const h=await setup();try{
  const a=await h.runtime(-3700),attach:Update={update_id:sequence++,my_chat_member:{chat:{id:-3700,type:'supergroup',title:'Re-enable'},from:{id:11,first_name:'Owner'},date:Math.floor(Date.now()/1000),old_chat_member:{status:'left'},new_chat_member:{status:'member'}}};
  await parked(h,attach);await a.db.tx(eraseAll);await h.registry.disable('-3700');await repaired(h,attach);
  assert.equal((await h.registry.find('-3700'))!.enabled,false);
  const fresh={...attach,update_id:sequence++};await h.queue.enqueue(fresh);await h.queue.next();assert.equal((await h.registry.find('-3700'))!.enabled,true);
 }finally{await h.close();}
});
