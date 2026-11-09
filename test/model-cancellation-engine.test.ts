import {before,after,beforeEach,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OpenAIModel,type Plan} from '../src/model.js';
import {TestDB,harness,paired,message} from './helpers.js';

let db:TestDB,h:ReturnType<typeof harness>,id:string;
before(async()=>{db=new TestDB();await db.init();});after(async()=>db.close());
beforeEach(async()=>{
 await db.reset();h=harness(db);await paired(h);id=randomUUID();
 await db.query('UPDATE app_state SET open_group=true,mention_only=true,quiet_start=0,quiet_end=0');
 const rule={title:'Ранковий огляд',instruction:'Надіслати огляд',mode:'task',timezone:'Europe/Kyiv',start_date:'2030-01-01',time:'04:00',frequency:'daily',interval:1,dst:'reject'};
 await db.query("INSERT INTO recurring_series(id,actor_id,topic_id,rule,revision,status,audience,shared,manager_ids) VALUES($1,'11','0',$2,0,'active','group',false,'[]')",[id,JSON.stringify(rule)]);
});
function connect(plans:Plan[]){
 const requests:any[]=[];
 const fetcher=async(_url:any,init:any)=>{
  requests.push(JSON.parse(init.body));assert.ok(requests.length<=plans.length,'no hidden third model call');
  const raw=JSON.stringify(plans[requests.length-1]);
  return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:raw})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{output:[]}})+'\n\n');
 };
 const model=new OpenAIModel({...h.config,authMode:'api',apiKey:'synthetic-key',webSearch:false},{} as any,fetcher as typeof fetch);
 h.brain.plan=input=>model.plan(input);return requests;
}
const status=async()=>(await db.query('SELECT status FROM recurring_series WHERE id=$1',[id])).rows[0]!.status;
const output=async()=>(await db.query("SELECT body->>'text' AS text FROM outbox WHERE kind='text' ORDER BY id")).rows.map(r=>r.text).join('\n');
for(const bad of ['missing','old-quote'] as const)it(`actual model client repairs ${bad} metadata before the native owner request changes the root`,async()=>{
 const quote='Припини ці повтори, будь ласка',body='Люмен, я створив цю серію. '+quote;
 const action={kind:'cancel_reminder' as const,id,scope:'series' as const};
 const requests=connect([{reply:'',actions:[action],...(bad==='old-quote'?{authorization:{quote:'Фраза з іншого повідомлення',actions:['cancel_reminder']}}:{})},{reply:'',actions:[action],authorization:{quote,actions:['cancel_reminder']}}]);
 await h.lumen.receive(message(body));await h.lumen.processNext();
 assert.equal(requests.length,2);assert.equal(requests[0].model,requests[1].model);assert.equal(await status(),'ended');
 assert.match(await output(),/Майбутні повтори зупинив/u);assert.doesNotMatch(await output(),/прив’язку|Надішли прохання ще раз/u);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM domain_commands WHERE domain='reminder_cancel'")).rows[0]!.n,1);
});
it('two invalid model proofs preserve the root and expose a specific planner failure without blaming the original source',async()=>{
 const action={kind:'cancel_reminder' as const,id,scope:'series' as const};
 const bad:Plan={reply:'Скасував.',actions:[action],authorization:{quote:'Не з цього повідомлення',actions:['cancel_reminder']}};
 const requests=connect([bad,bad]),logs:string[]=[],saved=console.error;console.error=(x:unknown)=>logs.push(String(x));
 try{await h.lumen.receive(message('Люмен, я створив серію. Прошу припинити її.'));await h.lumen.processNext();}finally{console.error=saved;}
 assert.equal(requests.length,2);assert.equal(await status(),'active');assert.match(await output(),/Планувальник двічі не надав коректного доказу/u);
 assert.doesNotMatch(await output(),/прив’язку|Скасував\./u);
 const failure=logs.map(x=>JSON.parse(x)).find(x=>x.event==='reminder_control_failed');assert.equal(failure?.code,'model_cancellation_proof_invalid');
 assert.deepEqual(Object.keys(failure).sort(),['code','event','request_tag']);
});
for(const repaired of [true,false])it(`metadata repair preserves a separate explicit remember even when the second plan omits it; cancellation repaired=${repaired}`,async()=>{
 const quote='Припини ці повтори',body='Люмен, запам’ятай: яблука зелені. '+quote;
 const action={kind:'cancel_reminder' as const,id,scope:'series' as const};
 const bad:Plan={reply:'',actions:[{kind:'remember',content:'яблука зелені'},action],authorization:{quote:'Фраза іншого автора',actions:['cancel_reminder']}};
 const second:Plan=repaired?{reply:'',actions:[action],authorization:{quote,actions:['cancel_reminder']}}:{reply:'',actions:[action],authorization:bad.authorization};
 const requests=connect([bad,second]);await h.lumen.receive(message(body));await h.lumen.processNext();
 assert.equal(requests.length,2);assert.equal(await status(),repaired?'ended':'active');
 assert.equal((await db.query('SELECT content FROM memories WHERE content=$1',['яблука зелені'])).rows.length,1);
 if(!repaired)assert.doesNotMatch(await output(),/Майбутні повтори зупинив/u);
});
