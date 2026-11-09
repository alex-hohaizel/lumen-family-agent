import {describe,it,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {isAuthoredCancellationQuote} from '../src/reminder-intent.js';
import {authorizeAction,independentAction} from '../src/engine.js';
import {ModelError} from '../src/auth.js';
import {type Action,type Plan} from '../src/model.js';
import {type RequestNativeEntity} from '../src/outcomes.js';
import {TestDB,harness,paired,message} from './helpers.js';
import {Recurring} from '../src/recurring.js';
import {dispatchSchedules} from '../src/scheduling.js';
import {ConfigSchema} from '../src/config.js';

const ownRequest='Я хочу, щоб ти перестав це надсилати';
const title='Нічна картопляна варта';
const screenshot=`@lumen_test_bot\n\nВ тебе є таке, як\n\n"${title}\nЗавершено"\n\n${ownRequest}`;
const cancel:Action={kind:'cancel_reminder',query:title,scope:'series'};
const proof=(quote=ownRequest):NonNullable<Plan['authorization']>=>({quote,actions:['cancel_reminder']});
const native=(text:string,part:string,type:RequestNativeEntity['type']='blockquote')=>({type,offset:text.indexOf(part),length:part.length});

describe('authored natural cancellation proof is language-independent and quote-safe',()=>{
 for(const quote of [ownRequest,'Не хочу більше отримувати цю нічну варту','Please retire that daily ping','Ya no quiero que me envíes eso','Припини, будь ласка, свої нічні повідомлення'])it(`binds an actual authored clause without a cancellation keyword: ${quote}`,()=>{
  const body=`@lumen_test_bot\n"${title}"\n${quote}`;
  assert.equal(isAuthoredCancellationQuote(body,[],quote),true);
 });
 it('the exact screenshot has an authored stop clause and a separate quoted title',()=>{
  assert.equal(isAuthoredCancellationQuote(screenshot,[],ownRequest),true);
  assert.equal(isAuthoredCancellationQuote(screenshot,[],title),false);
  assert.equal(isAuthoredCancellationQuote(screenshot,[],screenshot),false);
 });
 it('accepts a genuinely authored duplicate, never only its quoted occurrence',()=>{
  assert.equal(isAuthoredCancellationQuote(`«${ownRequest}»`,[],ownRequest),false);
  assert.equal(isAuthoredCancellationQuote(`«${ownRequest}»\n\n${ownRequest}`,[],ownRequest),true);
 });
 for(const type of ['blockquote','expandable_blockquote','code','pre'] as const)it(`a native ${type} cannot supply instruction authority`,()=>{
  const body=`@lumen_test_bot\n${ownRequest}`;
  assert.equal(isAuthoredCancellationQuote(body,[native(body,ownRequest,type)],ownRequest),false);
 });
 for(const body of [`«${ownRequest}»`,`"${ownRequest}"`,`\`${ownRequest}\``,`\`\`\`\n${ownRequest}\n\`\`\``,`> ${ownRequest}`,`<blockquote>${ownRequest}</blockquote>`])it(`a textual data span is not authority: ${body}`,()=>{
  assert.equal(isAuthoredCancellationQuote(body,[],ownRequest),false);
 });
 it('fails closed for missing, normalized, invalid or excessive proof data',()=>{
  for(const quote of [undefined,null,{},'', ' ', 'Я хочу, щоб ти перестав це надсилати.', 'x'.repeat(2501)])assert.equal(isAuthoredCancellationQuote(screenshot,[],quote),false);
  assert.equal(isAuthoredCancellationQuote(screenshot,[{type:'blockquote',offset:-1,length:2}],ownRequest),false);
  assert.equal(isAuthoredCancellationQuote(screenshot,[{type:'code',offset:0,length:screenshot.length+1}],ownRequest),false);
  const body='😀'+ownRequest;assert.equal(isAuthoredCancellationQuote(body,[{type:'blockquote',offset:1,length:1}],ownRequest),false);
 });
 it('semantic authorization reaches the action gate, while missing or quoted proof does not',()=>{
  const config=ConfigSchema.parse({});
  assert.throws(()=>authorizeAction(cancel,screenshot,true,config),/action_not_explicit/);
  assert.doesNotThrow(()=>authorizeAction(cancel,screenshot,true,config,[],proof()));
  const body=`@lumen_test_bot\n${ownRequest}`;
  assert.throws(()=>authorizeAction(cancel,body,true,config,[],proof(),[native(body,ownRequest)]),/action_not_explicit/);
  assert.throws(()=>authorizeAction(cancel,screenshot,false,config,[],proof()),/action_not_requested/);
  assert.throws(()=>authorizeAction(cancel,screenshot,true,config,[],{quote:ownRequest,actions:['remember']}),/action_not_explicit/);
 });
 it('independent cancellation retains semantic proof without detaching its actual condition',()=>{
  assert.equal(independentAction(cancel,screenshot,proof()),true);
  assert.equal(independentAction(cancel,`Якщо звіт готовий, ${ownRequest}`,proof()),false);
  assert.equal(independentAction(cancel,`Якщо звіт готовий, покажи його.\n${ownRequest}`,proof()),true);
  const body=`@lumen_test_bot\n${ownRequest}`;assert.equal(independentAction(cancel,body,proof(),[native(body,ownRequest)]),false);
 });
});

describe('natural cancellation traverses ingress, model plan, fresh source and actual series change',()=>{
 let db:TestDB,h:ReturnType<typeof harness>,seriesId:string;
 before(async()=>{db=new TestDB();await db.init();});after(async()=>{await db.close();});
 beforeEach(async()=>{
  await db.reset();h=harness(db);await paired(h);
  await db.query("UPDATE app_state SET open_group=true,mention_only=true,quiet_start=0,quiet_end=0");
  seriesId=randomUUID();
  const rule={title,instruction:'Надіслати нічну картопляну варту',mode:'reminder',timezone:'Europe/Kyiv',start_date:'2030-01-01',time:'04:00',frequency:'daily',interval:1,dst:'reject'};
  await db.query("INSERT INTO recurring_series(id,actor_id,topic_id,rule,revision,status,audience,shared,manager_ids) VALUES($1,'11','0',$2,0,'active','group',true,'[\"22\"]')",[seriesId,JSON.stringify(rule)]);
 });
 const status=async()=>(await db.query('SELECT status FROM recurring_series WHERE id=$1',[seriesId])).rows[0]!.status;
 const output=async()=>(await db.query("SELECT body FROM outbox WHERE kind='text' ORDER BY id")).rows.map(x=>x.body.text).join('\n');
 async function turn(text=screenshot,quote=ownRequest,uid=11){
  h.brain.replies.push({reply:'Готово.',authorization:proof(quote),actions:[cancel]});
  const update=message(text,uid);update.message!.chat.is_forum=true;await h.lumen.receive(update);await h.lumen.processNext();return update;
 }
 it('the exact screenshot stops the canonical future series and cannot dispatch another repetition',async()=>{
  const update=await turn();assert.equal(await status(),'ended');assert.match(await output(),/Майбутні повтори зупинив/u);
  await new Recurring(db).tick();assert.equal(await dispatchSchedules(db),0);
  await h.lumen.receive(update);assert.equal((await db.query("SELECT count(*)::int AS n FROM domain_commands WHERE domain='reminder_cancel'")).rows[0]!.n,1);
 });
 for(const quote of ['Не хочу більше отримувати цю нічну варту','Please retire that daily ping','Ya no quiero que me envíes eso'])it(`uses semantic intent rather than requiring command words: ${quote}`,async()=>{
  await turn(`@lumen_test_bot\n"${title}"\n${quote}`,quote);assert.equal(await status(),'ended');
 });
 it('a named participant uses the existing shared stop right without a new consent poll',async()=>{
  await turn(screenshot,ownRequest,22);assert.equal(await status(),'ended');assert.equal((await db.query('SELECT id FROM interactions')).rows.length,0);
 });
 it('a model-selected ID from the actual scoped snapshot works without making the author type an ID or title',async()=>{
  h.brain.replies.push({reply:'',authorization:proof(),actions:[{kind:'cancel_reminder',id:seriesId,scope:'series'}]});
  const text=`@lumen_test_bot\n${ownRequest}`;assert.equal(text.includes(seriesId),false);assert.equal(text.includes(title),false);
  await h.lumen.receive(message(text));await h.lumen.processNext();
  const context=JSON.parse(h.brain.calls[0]!.context);assert.equal(context.reminder_roots.recurring[0].id,seriesId);assert.equal(context.reminder_roots.recurring[0].version,1);
  assert.equal(await status(),'ended');
 });
 it('an existing but unobserved model-selected ID never acquires authority from model arguments',async()=>{
  const unobservedId=randomUUID(),plan=h.brain.plan.bind(h.brain);
  h.brain.plan=async input=>{
   const result=await plan(input);
   await db.query("INSERT INTO recurring_series(id,actor_id,topic_id,rule,revision,status,audience,shared,manager_ids) SELECT $1,actor_id,topic_id,rule,revision,status,audience,shared,manager_ids FROM recurring_series WHERE id=$2",[unobservedId,seriesId]);return result;
  };
  h.brain.replies.push({reply:'',authorization:proof(),actions:[{kind:'cancel_reminder',id:unobservedId,scope:'series'}]});
  await h.lumen.receive(message(`@lumen_test_bot\n${ownRequest}`));await h.lumen.processNext();
  assert.equal(await status(),'active');assert.equal((await db.query('SELECT status FROM recurring_series WHERE id=$1',[unobservedId])).rows[0]!.status,'active');
 });
 it('a model-selected snapshot target cannot change after planning without renewed inspection',async()=>{
  const plan=h.brain.plan.bind(h.brain);h.brain.plan=async input=>{const result=await plan(input);await db.query('UPDATE recurring_series SET version=version+1 WHERE id=$1',[seriesId]);return result;};
  h.brain.replies.push({reply:'',authorization:proof(),actions:[{kind:'cancel_reminder',id:seriesId,scope:'series'}]});
  await h.lumen.receive(message(`@lumen_test_bot\n${ownRequest}`));await h.lumen.processNext();assert.equal(await status(),'active');
 });
 it('native quoted or forwarded requests cannot use semantic proof to change the series',async()=>{
  for(const forwarded of [false,true]){
   const update=message(screenshot);if(forwarded)(update.message! as any).forward_origin={type:'hidden_user',date:update.message!.date,sender_user_name:'Someone'};
   else update.message!.entities=[native(screenshot,ownRequest)];
   h.brain.replies.push({reply:'Скасував.',authorization:proof(),actions:[cancel]});await h.lumen.receive(update);await h.lumen.processNext();assert.equal(await status(),'active');
  }
  assert.doesNotMatch(await output(),/Майбутні повтори зупинив|Скасував[.!]/u);
 });
 it('a source descriptor invalidated after planning prevents cancellation and gives a binding error without quote blame',async()=>{
  const plan=h.brain.plan.bind(h.brain);h.brain.plan=async input=>{
   const result=await plan(input);await db.query("UPDATE messages SET request_context=NULL WHERE role='user' AND body=$1",[screenshot]);return result;
  };
  const logs:string[]=[],original=console.error;console.error=(line:unknown)=>logs.push(String(line));
  try{await turn();}finally{console.error=original;}
  assert.equal(await status(),'active');assert.match(await output(),/немає перевіреного опису транспортного контексту/u);assert.match(await output(),/LM-[0-9A-HJKMNP-TV-Z]{26}/u);assert.doesNotMatch(await output(),/цитата або пересланий/u);
  const failures=logs.map(line=>JSON.parse(line)).filter(row=>row.event==='reminder_control_failed');assert.equal(failures.length,1);assert.equal(failures[0].code,'reminder_request_unbound');assert.match(failures[0].request_tag,/^[a-f0-9]{16}$/u);assert.deepEqual(Object.keys(failures[0]).sort(),['code','event','request_tag']);assert.doesNotMatch(JSON.stringify(failures),/Нічна|картоп|-100|sourceId|actorId/u);
 });
 it('a failed unrelated tool and empty replan preserve the independent semantic cancellation',async()=>{
  const text=`@lumen_test_bot Перевір монтаж.\n"${title}"\n${ownRequest}`;
  h.brain.replies.push({reply:'',authorization:proof(),actions:[{kind:'tool',name:'studio.manage',arguments:JSON.stringify({operation:'bad'})},cancel]},{reply:'Для монтажу потрібне уточнення.',actions:[]});
  await h.lumen.receive(message(text));await h.lumen.processNext();assert.equal(await status(),'ended');assert.match(await output(),/Майбутні повтори зупинив/u);
 });
 it('an identical cancellation returned without proof on replan retains the original valid authorization',async()=>{
  h.brain.replies.push({reply:'',authorization:proof(),actions:[{kind:'tool',name:'studio.manage',arguments:JSON.stringify({operation:'bad'})},cancel]},{reply:'',actions:[cancel]});
  await h.lumen.receive(message(screenshot));await h.lumen.processNext();assert.equal(await status(),'ended');assert.match(await output(),/Майбутні повтори зупинив/u);
 });
 it('retry restores the original semantic proof and changes the series once',async()=>{
  h.brain.replies.push({reply:'',authorization:proof(),actions:[{kind:'tool',name:'tools.describe',arguments:JSON.stringify({names:['studio.manage']})},cancel]});
  const original=h.brain.plan.bind(h.brain);let calls=0;h.brain.plan=async input=>{if(++calls===2)throw new ModelError('model_network');return original(input);};
  const update=message(screenshot);await h.lumen.receive(update);await h.lumen.processNext();
  const pending=(await db.query('SELECT status,payload FROM inbox WHERE update_id=$1',[update.update_id])).rows[0]!;assert.equal(pending.status,'pending');assert.equal(pending.payload.pendingIndependent.length,1);assert.deepEqual(pending.payload.pendingIndependent[0].authorization,proof());assert.equal(await status(),'active');
  h.brain.replies.push({reply:'Продовжую.',actions:[]});await db.query('UPDATE inbox SET available_at=now() WHERE update_id=$1',[update.update_id]);await h.lumen.processNext();
  assert.equal(await status(),'ended');assert.equal((await db.query("SELECT count(*)::int AS n FROM domain_commands WHERE domain='reminder_cancel'")).rows[0]!.n,1);
 });
 it('a retry cannot rebind a carried model-selected ID to a changed target version',async()=>{
  const action:Action={kind:'cancel_reminder',id:seriesId,scope:'series'};
  h.brain.replies.push({reply:'',authorization:proof(),actions:[{kind:'tool',name:'tools.describe',arguments:JSON.stringify({names:['studio.manage']})},action]});
  const original=h.brain.plan.bind(h.brain);let calls=0;h.brain.plan=async input=>{if(++calls===2)throw new ModelError('model_network');return original(input);};
  const update=message(`@lumen_test_bot\n${ownRequest}`);await h.lumen.receive(update);await h.lumen.processNext();
  const payload=(await db.query('SELECT payload FROM inbox WHERE update_id=$1',[update.update_id])).rows[0]!.payload;
  assert.deepEqual(payload.pendingIndependent[0].cancellationTargets,[{ref:'series:'+seriesId,version:1}]);
  await db.query('UPDATE recurring_series SET version=version+1 WHERE id=$1',[seriesId]);
  h.brain.replies.push({reply:'Продовжую.',actions:[]});await db.query('UPDATE inbox SET available_at=now() WHERE update_id=$1',[update.update_id]);await h.lumen.processNext();assert.equal(await status(),'active');
 });
 it('a result-dependent semantic cancellation is not carried after a failed tool',async()=>{
  const text=`@lumen_test_bot "${title}". Якщо звіт готовий, ${ownRequest}`;
  h.brain.replies.push({reply:'',authorization:proof(),actions:[{kind:'tool',name:'studio.manage',arguments:JSON.stringify({operation:'bad'})},cancel]},{reply:'Уточни дані звіту.',actions:[]});
  await h.lumen.receive(message(text));await h.lumen.processNext();assert.equal(await status(),'active');
 });
 for(const prefix of ['Якщо звіт готовий, покажи його.','Переклади слово rose.'])it(`an unrelated finished clause does not revoke a later own stop request: ${prefix}`,async()=>{
  await turn(`@lumen_test_bot "${title}". ${prefix}\n${ownRequest}`);assert.equal(await status(),'ended');
 });
 it('a condition on the previous line remains attached to its cancellation clause',async()=>{
  await turn(`@lumen_test_bot "${title}". Якщо звіт готовий,\n${ownRequest}`);assert.equal(await status(),'active');
 });
 it('an invented ID cannot bypass observation by also supplying a valid title query',async()=>{
  const unseen=randomUUID(),plan=h.brain.plan.bind(h.brain);h.brain.plan=async input=>{
   const result=await plan(input);await db.query("INSERT INTO recurring_series(id,actor_id,topic_id,rule,revision,status,audience,shared,manager_ids) SELECT $1,actor_id,topic_id,rule,revision,status,audience,shared,manager_ids FROM recurring_series WHERE id=$2",[unseen,seriesId]);return result;
  };
  h.brain.replies.push({reply:'',authorization:proof(),actions:[{kind:'cancel_reminder',id:unseen,query:title,scope:'series'}]});
  await h.lumen.receive(message(screenshot));await h.lumen.processNext();
  assert.equal((await db.query('SELECT status FROM recurring_series WHERE id=$1',[unseen])).rows[0]!.status,'active');assert.equal(await status(),'active');
 });
 it('a retried title query cannot be rebound to a same-title replacement root',async()=>{
  h.brain.replies.push({reply:'',authorization:proof(),actions:[{kind:'tool',name:'tools.describe',arguments:JSON.stringify({names:['studio.manage']})},cancel]});
  const original=h.brain.plan.bind(h.brain);let calls=0;h.brain.plan=async input=>{if(++calls===2)throw new ModelError('model_network');return original(input);};
  const update=message(screenshot);await h.lumen.receive(update);await h.lumen.processNext();
  const replacement=randomUUID();await db.query("UPDATE recurring_series SET status='ended',version=2 WHERE id=$1",[seriesId]);
  await db.query("INSERT INTO recurring_series(id,actor_id,topic_id,rule,revision,status,audience,shared,manager_ids) SELECT $1,actor_id,topic_id,rule,revision,'active',audience,shared,manager_ids FROM recurring_series WHERE id=$2",[replacement,seriesId]);
  h.brain.replies.push({reply:'Продовжую.',actions:[]});await db.query('UPDATE inbox SET available_at=now() WHERE update_id=$1',[update.update_id]);await h.lumen.processNext();
  assert.equal((await db.query('SELECT status FROM recurring_series WHERE id=$1',[replacement])).rows[0]!.status,'active');
 });
 it('an explicit private ID preserves content-free owner control without exporting its private goal',async()=>{
  await db.query("UPDATE recurring_series SET audience='private',shared=false,manager_ids='[]' WHERE id=$1",[seriesId]);
  h.brain.replies.push({reply:'',authorization:proof(),actions:[{kind:'cancel_reminder',id:seriesId,scope:'series'}]});
  await h.lumen.receive(message(`@lumen_test_bot ${seriesId}\n${ownRequest}`));await h.lumen.processNext();
  assert.deepEqual(JSON.parse(h.brain.calls.at(-1)!.context).reminder_roots.recurring,[]);assert.equal(await status(),'ended');
 });
 it('a private literal ID retains its original version pin through a network retry',async()=>{
  await db.query("UPDATE recurring_series SET audience='private',shared=false,manager_ids='[]' WHERE id=$1",[seriesId]);
  h.brain.replies.push({reply:'',authorization:proof(),actions:[{kind:'tool',name:'tools.describe',arguments:JSON.stringify({names:['studio.manage']})},{kind:'cancel_reminder',id:seriesId,scope:'series'}]});
  const original=h.brain.plan.bind(h.brain);let calls=0;h.brain.plan=async input=>{if(++calls===2)throw new ModelError('model_network');return original(input);};
  const update=message(`@lumen_test_bot ${seriesId}\n${ownRequest}`);await h.lumen.receive(update);await h.lumen.processNext();
  await db.query('UPDATE recurring_series SET version=version+1 WHERE id=$1',[seriesId]);h.brain.replies.push({reply:'Продовжую.',actions:[]});await db.query('UPDATE inbox SET available_at=now() WHERE update_id=$1',[update.update_id]);await h.lumen.processNext();
  assert.equal(await status(),'active');
 });
 it('schedule.series end cannot bypass the own-source gate by omitting semantic authorization',async()=>{
  h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'schedule.series',arguments:JSON.stringify({operation:'end',id:seriesId,version:1})}]},{reply:'Переклад готовий.',actions:[]});
  await h.lumen.receive(message('Люмен, переклади цю фразу: «скасуй серію».'));await h.lumen.processNext();assert.equal(await status(),'active');
 });
 it('schedule.series end still accepts an actual owner request naming its literal ID',async()=>{
  h.brain.replies.push({reply:'',actions:[{kind:'tool',name:'schedule.series',arguments:JSON.stringify({operation:'end',id:seriesId,version:1})}]},{reply:'Серію зупинено.',actions:[]});
  await h.lumen.receive(message(`Люмен, скасуй усю серію ${seriesId}.`));await h.lumen.processNext();assert.equal(await status(),'ended');
 });
 it('schedule.series end reveals neither existence nor version of another participant\'s private series',async()=>{
  await db.query("UPDATE recurring_series SET audience='private',shared=false,manager_ids='[]',version=7 WHERE id=$1",[seriesId]);
  const recurring=new Recurring(db),missing=randomUUID();
  for(const id of [seriesId,missing])for(const version of [1,7,99]){
   const result=await recurring.run({operation:'end',id,version},{actorId:'22',chatId:'-100',topicId:'0',revision:0,updateId:randomUUID(),requested:true,requestText:`Скасуй усю серію ${id}.`});
   assert.deepEqual(result,{id,status:'not_found',notice:'Доступної тобі серії в цій темі не знайшов.'});
  }
  assert.equal(await status(),'active');
 });
});
