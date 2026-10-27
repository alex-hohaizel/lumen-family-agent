import {gzipSync,brotliCompressSync} from 'node:zlib';
import {describe,it,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {TestDB,harness,paired,message,FakeBrain} from './helpers.js';
import {publicIP,publicURL,decodedHTTP,type HTTPRequest} from '../src/safe-http.js';
import {pageContent,readWeb} from '../src/web.js';
import {MCPClient} from '../src/mcp-client.js';
import {ConnectorVault} from '../src/connector-vault.js';
import {AgentTools,type ToolContext} from '../src/agent-tools.js';
import {AgentTasks} from '../src/agent-tasks.js';
import {WebMonitors} from '../src/web-monitors.js';
import {pauseMemory,eraseAll} from '../src/db.js';
import {Delivery} from '../src/delivery.js';
import {ConfigSchema} from '../src/config.js';
import {OpenAIModel} from '../src/model.js';

describe('Зовнішні інструменти: мережа й протокол',()=>{
 it('декодує gzip/Brotli відповіді навіть коли сервер ігнорує identity, з обмеженням розпакованого розміру',()=>{
   for(const [encoding,encode] of [['gzip',gzipSync],['br',brotliCompressSync]] as const){const r=decodedHTTP({url:'https://example.com',status:200,headers:{'content-encoding':encoding},body:encode(Buffer.from('Example Domain'))},100);assert.equal(r.body.toString(),'Example Domain');assert.equal(r.headers['content-encoding'],undefined);}
   assert.throws(()=>decodedHTTP({url:'https://example.com',status:200,headers:{'content-encoding':'gzip'},body:gzipSync(Buffer.from('a'.repeat(10000)))},100),/oversized_compressed_response/);
 });
 it('нативний пошук збирає джерела з потокової анотації та текстового посилання',async()=>{
   const config=ConfigSchema.parse({authMode:'api',apiKey:'test',model:'account-model',webSearch:true});const model=new OpenAIModel(config,undefined,async()=>new Response(['data: '+JSON.stringify({type:'response.web_search_call.completed'}),'data: '+JSON.stringify({type:'response.output_text.annotation.added',annotation:{type:'url_citation',url:'https://example.org'}}),'data: '+JSON.stringify({type:'response.output_text.delta',delta:'Офіційний сайт: https://nodejs.org/.'}),'data: '+JSON.stringify({type:'response.completed',response:{output:[]}})].join('\n\n')+'\n\n'));const r=await model.searchWeb('офіційний сайт');assert.deepEqual(r.sources,['https://example.org','https://nodejs.org/']);
 });

 it('відкидає локальні, приватні, закодовані IP та URL зі сторонніми схемами',()=>{
   for(const value of ['127.0.0.1','10.0.2.1','169.254.169.254','192.168.1.1','172.20.0.1','100.64.0.1','::1','fc00::1','::ffff:127.0.0.1'])assert.equal(publicIP(value),false,value);
   for(const value of ['http://2130706433','http://0x7f000001','http://[::1]','file:///etc/passwd','https://name:secret@example.com','http://metadata.internal','http://localhost','http://example.com:8080'])assert.throws(()=>publicURL(value));
   assert.equal(publicURL('https://example.com/a#fragment').href,'https://example.com/a');assert.equal(publicIP('93.184.216.34'),true);
 });
 it('читає зміст і джерела, прибирає виконуваний текст і небезпечні посилання',()=>{
   const p=pageContent('<html><title>Умови</title><body><script>stealSecrets()</script><main>Ціна 100 EUR <a href="/terms">Правила</a><a href="javascript:alert(1)">bad</a></main></body></html>','https://example.com');
   assert.equal(p.title,'Умови');assert.ok(p.text.includes('100 EUR'));assert.ok(!p.text.includes('stealSecrets'));assert.deepEqual(p.links,[{text:'Правила',url:'https://example.com/terms'}]);
 });
 it('не видає HTTP-помилку за прочитаний документ',async()=>{const request:HTTPRequest=async url=>({url,status:403,headers:{},body:Buffer.from('denied')});await assert.rejects(()=>readWeb('https://example.com',request),/http_403/);});
 it('MCP виконує initialize, initialized, перелік і виклик з ізольованою сесією',async()=>{
   const calls:any[]=[];const request:HTTPRequest=async(url,o={})=>{const body=JSON.parse(o.body!);calls.push({body,headers:o.headers});return {url,status:body.method==='notifications/initialized'?202:200,headers:{'content-type':'application/json','mcp-session-id':'session-A'},body:Buffer.from(body.method==='notifications/initialized'?'':JSON.stringify({jsonrpc:'2.0',id:body.id,result:body.method==='tools/list'?{tools:[{name:'lookup',inputSchema:{type:'object'}}]}:{ok:true}}))};};
   const client=new MCPClient('https://example.com/mcp','test-token',request);assert.equal((await client.list()).length,1);assert.deepEqual(await client.call('lookup',{city:'Київ'}),{ok:true});assert.deepEqual(calls.map(c=>c.body.method),['initialize','notifications/initialized','tools/list','tools/call']);assert.equal(calls[2].headers['Mcp-Session-Id'],'session-A');
 });
 it('нативний пошук підтверджує справжній виклик і джерело з SSE',async()=>{
   const config=ConfigSchema.parse({authMode:'api',apiKey:'test',model:'account-model',webSearch:true});let request:any;
   const model=new OpenAIModel(config,undefined,async(_url,options)=>{request=JSON.parse(String(options?.body));return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'Знайшов офіційний сайт.'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{output:[{type:'web_search_call'},{type:'message',content:[{annotations:[{type:'url_citation',url:'https://example.com',title:'Source'}]}]}]}})+'\n\n',{status:200});});
   const r=await model.searchWeb('офіційний сайт');assert.equal(r.searched,true);assert.deepEqual(r.sources,['https://example.com']);assert.equal(request.tools[0].type,'web_search');assert.equal(request.tool_choice,'required');
 });
 it('не називає відповідь моделі без web_search реально виконаним пошуком',async()=>{
   const config=ConfigSchema.parse({authMode:'api',apiKey:'test',model:'account-model',webSearch:true});const model=new OpenAIModel(config,undefined,async()=>new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'Я нібито знайшов'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{output:[]}})+'\n\n'));await assert.rejects(()=>model.searchWeb('запит'),/web_search_not_executed/);
 });
});

describe('Автономні задачі 1.5, приватність і перевірені навички',()=>{
 const db=new TestDB();let h:ReturnType<typeof harness>,tools:AgentTools,c:ToolContext,temp:string;
 before(async()=>{await db.init();temp=await mkdtemp(join(tmpdir(),'lumen-vault-test-'));});
 after(async()=>{await db.close();await rm(temp,{recursive:true,force:true});});
 beforeEach(async()=>{await db.reset();h=harness(db);await paired(h);h.config.runtimeDir=temp;tools=new AgentTools(db,h.config,h.brain);c={actorId:'11',chatId:'-100',topicId:'0',revision:0,updateId:randomUUID(),requested:true};});
 it('доступний пошук визначається можливостями, а не спеціальним словом',async()=>{
   h.config.webSearch=true;await h.lumen.receive(message('Люмен, яка сьогодні погода в Києві?'));await h.lumen.processNext();assert.equal(h.brain.calls.at(-1)?.search,true);
 });
 it('повертає результат нового інструмента моделі в тому самому діалозі',async()=>{
   await db.query("INSERT INTO messages(telegram_id,user_id,author,role,body) VALUES(901,'11','А','user','Поїздка до Львова')");
   h.brain.replies=[{reply:'',actions:[{kind:'tool',name:'memory.search',arguments:JSON.stringify({terms:['Львова']})}]},{reply:'Знайшов нашу поїздку до Львова.',actions:[]}];
   await h.lumen.receive(message('Люмен, пригадай нашу поїздку'));await h.lumen.processNext();assert.equal(h.brain.calls.length,2);assert.ok(h.brain.calls[1]!.context.includes('Поїздка до Львова'));assert.ok((await db.query('SELECT * FROM tool_runs')).rows[0]?.status==='succeeded');
 });
 it('відкидає дію без поточного доручення й неправильні параметри до мережі',async()=>{await assert.rejects(()=>tools.execute('tasks.create',{title:'Назва',goal:'Завдання'},{...c,requested:false}),/tool_not_requested/);await assert.rejects(()=>tools.execute('web.read',{url:'wrong'},c),/invalid_tool_arguments/);});
 it('черга тривалого завдання переживає відновлення й доставляє завершений результат',async()=>{
   const task=await tools.execute('tasks.create',{title:'Перевірити події',goal:'Покажи наявні події нашої групи'},c);const brain=new FakeBrain();brain.replies=[{reply:'',actions:[{kind:'tool',name:'event.list',arguments:'{}'}]},{reply:'Запланованих подій немає.',actions:[]}];
   const runner=new AgentTasks(db,h.config,brain);assert.equal(await runner.next(),true);await db.query('UPDATE agent_tasks SET available_at=now() WHERE id=$1',[task.id]);await runner.recover();assert.equal(await runner.next(),true);const row=(await db.query('SELECT * FROM agent_tasks WHERE id=$1',[task.id])).rows[0];assert.equal(row?.status,'delivering');assert.ok((await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'task-result:%'")).rows.length===1);const delivery=new Delivery(db,h.tg as any,h.config);for(let i=0;i<5;i++)await delivery.next();assert.equal((await db.query('SELECT status FROM agent_tasks WHERE id=$1',[task.id])).rows[0]?.status,'completed');
 });
 it('інший учасник не скасовує й не читає власні задачі першого',async()=>{
   const task=await tools.execute('tasks.create',{title:'Особисте',goal:'Дослідити місця'},c);const other={...c,actorId:'22',updateId:randomUUID()};assert.deepEqual(await tools.execute('tasks.cancel',{id:task.id},other),{cancelled:false});assert.deepEqual(await tools.execute('tasks.list',{},other),[]);
 });
 it('пауза скасовує задачі, спостереження й погодження та забороняє нові дії',async()=>{
   await tools.execute('tasks.create',{title:'Пошук',goal:'Дослідити місця'},c);await tools.execute('watch.create',{url:'https://example.com',label:'Квитки',condition:'change',expires_at:new Date(Date.now()+86400000).toISOString()},c);
   await db.tx(pauseMemory);assert.equal((await db.query('SELECT status FROM agent_tasks')).rows[0]?.status,'cancelled');assert.equal((await db.query('SELECT status FROM web_monitors')).rows[0]?.status,'paused');await assert.rejects(()=>tools.execute('event.list',{},c),/task_cancelled/);
 });
 it('перед зовнішнім записом створює конкретне погодження та не викликає сервіс',async()=>{
   const result=await tools.execute('connector.call',{connection:'calendar',tool:'create_event',arguments:'{"title":"Зустріч"}'},c);assert.equal(result.needs_approval,true);assert.equal((await db.query('SELECT status FROM tool_approvals')).rows[0]?.status,'pending');assert.equal((await db.query('SELECT * FROM tool_runs')).rows.length,0);
 });
 it('файл CSV з формулою стає безпечним і не оголошується доставленим до відповіді Telegram',async()=>{
   const a=await tools.execute('artifact.create',{name:'План.csv',content:JSON.stringify([['Назва','Сума'],['=IMPORTXML("evil")',25]])},c);assert.equal(a.status,'queued_for_delivery');const row=(await db.query('SELECT * FROM agent_artifacts')).rows[0];assert.ok(row?.content.includes("'=IMPORTXML"));
   const delivery=new Delivery(db,h.tg as any,h.config);await delivery.next();assert.equal((await db.query("SELECT status FROM outbox WHERE dedup_key=$1",['artifact:'+a.id])).rows[0]?.status,'sent');
 });
 it('не дає іншому автору читати згенерований особистий файл',async()=>{const a=await tools.execute('artifact.create',{name:'Нотатка.md',content:'Особистий текст'},c);assert.deepEqual(await tools.execute('artifact.read',{id:a.id},{...c,actorId:'22',updateId:randomUUID()}),{found:false});});
 it('вивчена процедура стає verified лише після справжнього успішного виконання',async()=>{
   const workflow=await tools.execute('workflow.save',{title:'Перевірити план',steps:JSON.stringify([{tool:'event.list',arguments:{}}])},c);assert.equal(workflow.status,'draft');const result=await tools.execute('workflow.run',{id:workflow.id},{...c,updateId:randomUUID()});assert.equal(result.status,'verified');assert.equal((await db.query('SELECT verified_runs FROM agent_workflows')).rows[0]?.verified_runs,1);
 });
 it('не зберігає процедуру з рекурсією чи непогодженими зовнішніми записами',async()=>{for(const tool of ['workflow.run','connector.call','browser.commit','tasks.create'])await assert.rejects(()=>tools.execute('workflow.save',{title:'Небезпечна',steps:JSON.stringify([{tool,arguments:{}}])},{...c,updateId:randomUUID()}),/workflow_read_or_artifact_steps_required/);});
 it('токени зашифровані та розділені за власником, ключ має режим 0600',async()=>{
   const vault=new ConnectorVault(db,temp);await vault.put('11','calendar','private-A');await vault.put('22','calendar','private-B');assert.equal(await vault.get('11','calendar'),'private-A');assert.equal(await vault.get('22','calendar'),'private-B');assert.ok(!(await db.query('SELECT ciphertext FROM tool_credentials')).rows.some(r=>r.ciphertext.includes('private-')));assert.equal((await stat(join(temp,'connector-vault.key'))).mode&0o777,0o600);
 });
 it('очищення пам’яті видаляє результати, задачі, погодження й секрети цієї групи',async()=>{await tools.execute('tasks.create',{title:'Пошук',goal:'Знайти місця'},c);await new ConnectorVault(db,temp).put('11','test','secret');await db.tx(eraseAll);assert.equal((await db.query('SELECT * FROM agent_tasks')).rows.length,0);assert.equal((await db.query('SELECT * FROM tool_credentials')).rows.length,0);});
 it('спостереження запам’ятовує базовий стан і повідомляє про зміну один раз',async()=>{
   await db.query('UPDATE app_state SET quiet_start=0,quiet_end=0 WHERE id=1');const a=await tools.execute('watch.create',{url:'https://example.com',label:'Квитки',condition:'change',expires_at:new Date(Date.now()+86400000).toISOString()},c);let text='Немає місць';const monitors=new WebMonitors(db,h.config,async()=>({url:'https://example.com',title:'Квитки',text,links:[],retrieved_at:new Date().toISOString(),content_is_untrusted:true}));
   await monitors.next();assert.equal((await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'watch:%'")).rows.length,0);text='Є два місця';await db.query('UPDATE web_monitors SET next_check_at=now() WHERE id=$1',[a.id]);await monitors.next();await db.query('UPDATE web_monitors SET next_check_at=now() WHERE id=$1',[a.id]);await monitors.next();assert.equal((await db.query("SELECT * FROM outbox WHERE dedup_key LIKE 'watch:%'")).rows.length,1);
 });
 it('постійне читання вимагає погодження власника, має добовий ліміт і відкликається',async()=>{
   await db.query("INSERT INTO tool_connections(owner_id,id,endpoint,trusted_read_tools) VALUES('11','calendar','https://example.com','[\"lookup\"]')");let calls=0;
   (tools as any).connector=async(owner:string)=>{assert.equal(owner,'11');return {list:async()=>[{name:'lookup',annotations:{readOnlyHint:true}}],call:async()=>({ok:true,call:++calls})};};
   const args={connection:'calendar',tool:'lookup',expires_at:new Date(Date.now()+86400000).toISOString(),daily_limit:1,share_to_group:true};
   const proposal=await tools.execute('access.grant_read',args,c);assert.equal(proposal.needs_approval,true);assert.equal((await db.query('SELECT * FROM tool_grants')).rows.length,0);
   await db.query("UPDATE tool_approvals SET status='approved' WHERE id=$1",[proposal.approval_id]);
   const grant=await tools.execute('access.grant_read',args,{...c,updateId:'grant-approved',approvalId:proposal.approval_id});
   assert.equal((await tools.execute('connector.call',{connection:'calendar',tool:'lookup',arguments:'{}',share_result:true},{...c,updateId:'read-1'})).ok,true);assert.equal(calls,1);
   await assert.rejects(()=>tools.execute('connector.call',{connection:'calendar',tool:'lookup',arguments:'{}',share_result:true},{...c,updateId:'read-2'}),/standing_permission_daily_limit/);
   const other=await tools.execute('connector.call',{connection:'calendar',tool:'lookup',arguments:'{}',share_result:true},{...c,actorId:'22',updateId:'other-actor'});assert.equal(other.needs_approval,true);assert.equal(calls,1);
   assert.equal((await tools.execute('access.revoke',{id:grant.id},{...c,updateId:'revoke'})).revoked,true);
   const again=await tools.execute('connector.call',{connection:'calendar',tool:'lookup',arguments:'{}',share_result:true},{...c,updateId:'after-revoke'});assert.equal(again.needs_approval,true);
 });
 it('прострочене погодження переводить задачу з очікування до needs_input',async()=>{
   const job=await tools.execute('tasks.create',{title:'Запис',goal:'Погодити запис на подію'},c);
   await tools.execute('connector.call',{connection:'calendar',tool:'create',arguments:'{}'},{...c,taskId:job.id,updateId:'approval-task'});
   await db.query("UPDATE agent_tasks SET status='waiting' WHERE id=$1",[job.id]);await db.query("UPDATE tool_approvals SET expires_at=now()-interval '1 second'");
   await new AgentTasks(db,h.config,h.brain).next();assert.equal((await db.query('SELECT status FROM agent_tasks')).rows[0]?.status,'needs_input');assert.equal(h.brain.calls.length,0);
 });

 it('задача просить відсутні дані й отримує уточнення при продовженні',async()=>{
   const job=await tools.execute('tasks.create',{title:'Місце зустрічі',goal:'Підготувати зустріч компанії'},c);const brain=new FakeBrain();brain.replies=[{reply:'',actions:[{kind:'tool',name:'tasks.ask',arguments:JSON.stringify({question:'Яка дата зустрічі й кількість людей?'})}]}];
   await new AgentTasks(db,h.config,brain).next();assert.equal((await db.query('SELECT status FROM agent_tasks')).rows[0]?.status,'needs_input');
   await tools.execute('tasks.resume',{id:job.id,clarification:'Зустріч 31 жовтня, шестеро людей'},{...c,updateId:'clarification'});const row=(await db.query('SELECT status,goal FROM agent_tasks')).rows[0];assert.equal(row?.status,'pending');assert.match(row?.goal,/шестеро/);
 });
 it('подія створює календар з точним UTC-часом, екранованим текстом і доставкою файлу',async()=>{
   const event=await tools.execute('event.create',{title:'Зустріч, друзі; разом',details:'{}'},c);
   const result=await tools.execute('event.calendar',{id:event.id,start_at:'2026-10-31T18:00:00+02:00',end_at:'2026-10-31T20:00:00+02:00',location:'Київ'},{...c,updateId:'calendar'});
   const file=(await db.query('SELECT * FROM agent_artifacts WHERE id=$1',[result.id])).rows[0];assert.match(file?.content,/DTSTART:20261031T160000Z/);assert.ok(file?.content.includes('Зустріч\\, друзі\\; разом'));assert.equal(result.status,'queued_for_delivery');
   await assert.rejects(()=>tools.execute('event.calendar',{id:event.id,start_at:'2026-10-31T18:00:00Z',end_at:'2026-10-31T17:00:00Z'},{...c,updateId:'calendar-bad'}),/event_end_after_start_required/);
 });

});
