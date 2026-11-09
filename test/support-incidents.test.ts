import {describe,it,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TestDB,harness} from './helpers.js';
import {one} from '../src/db.js';
import {ToolError,type HTTPRequest} from '../src/safe-http.js';
import {ModelError} from '../src/auth.js';
import {ConnectionChecks} from '../src/connection-checks.js';
import {MCPClient} from '../src/mcp-client.js';
import {PrivateResults} from '../src/private-results.js';
import {PrivateInbox} from '../src/private-inbox.js';
import {OAuthDevices} from '../src/oauth-device.js';
import {Research} from '../src/agent-services.js';
import {ConnectorVault} from '../src/connector-vault.js';
import {TelegramError,type Telegram} from '../src/telegram.js';
import type {ToolContext} from '../src/agent-tools.js';

describe('private support error boundaries',()=>{
 let db:TestDB,h:ReturnType<typeof harness>;
 const context:ToolContext={actorId:'11',chatId:'-100',topicId:'0',audience:'private',revision:0,requested:true,updateId:'412300'};
 before(async()=>{db=new TestDB();await db.init();});after(async()=>{await db.close();});
 beforeEach(async()=>{await db.reset();for(const table of ['diagnostic_incidents','oauth_setups','private_results','research_cache'])await db.query('DELETE FROM '+table);await db.query("UPDATE app_state SET chat_id='-100',owner_id='11' WHERE id=1");h=harness(db);});
 it('failed connector verification records its real safe cause and notifies only the owner',async()=>{
  await db.query("INSERT INTO tool_connections(id,owner_id,endpoint,health) VALUES('calendar','11','https://example.com','check_pending')");
  const original=MCPClient.prototype.list;MCPClient.prototype.list=async()=>{throw new ToolError('http_timeout');};
  try{assert.equal(await new ConnectionChecks(db,h.config.runtimeDir).next(),true);}finally{MCPClient.prototype.list=original;}
  assert.equal((await one(db,'SELECT health FROM tool_connections'))!.health,'check_failed');
  const notice=(await one(db,"SELECT body,audience,actor_id FROM outbox WHERE dedup_key LIKE 'connection-check:%'"))!;
  assert.equal(notice.audience,'private');assert.equal(notice.actor_id,'11');assert.match(notice.body.text,/LM-[0-9A-Z]{26}/);assert.match(notice.body.text,/відведений час/u);
  assert.equal((await one(db,'SELECT reason_code FROM diagnostic_incidents'))!.reason_code,'http_timeout');
 });
 it('an unavailable private summary keeps the full encrypted result and gives the actual model error code privately',async()=>{
  h.brain.text=async()=>{throw new ModelError('model_stream_interrupted');};
  const service=new PrivateResults(db,h.config,h.brain),result=await service.save({secret:'PRIVATE_PROVIDER_VALUE'},context,'lookup');
  const saved=await service.read(result.private_result_id,'11');assert.equal(saved.result.secret,'PRIVATE_PROVIDER_VALUE');assert.match(saved.summary,/Потік відповіді моделі перервався/u);assert.match(saved.summary,/LM-[0-9A-Z]{26}/);
  const incident=(await one(db,'SELECT * FROM diagnostic_incidents'))!;assert.equal(incident.reason_code,'model_stream_interrupted');assert.equal(incident.audience,'private');assert.doesNotMatch(JSON.stringify(incident),/PRIVATE_PROVIDER_VALUE/u);
  assert.equal((await one(db,"SELECT audience FROM outbox WHERE kind='private_result'"))!.audience,'private');
 });
 it('membership-check failure delivers one coded private explanation rather than pretending that a valid request is unavailable',async()=>{
  const id=randomUUID();await db.query("INSERT INTO private_requests(id,token,recipient_id,requester_id,topic_id,question,purpose,revision,expires_at) VALUES($1,$2,'22','11','0','PRIVATE_QUESTION','PRIVATE_PURPOSE',0,now()+interval '1 day')",[id,'a'.repeat(24)]);
  const sent:{chatId:string;text:string}[]=[],telegram={call:async()=>{throw new TelegramError('telegram_network');},text:async(chatId:string,text:string)=>{sent.push({chatId,text});return {message_id:1};}} as unknown as Telegram;
  assert.equal(await new PrivateInbox(db,h.config.runtimeDir).open('a'.repeat(24),'22',telegram),true);
  assert.equal(sent.length,1);assert.equal(sent[0]!.chatId,'22');assert.match(sent[0]!.text,/LM-[0-9A-Z]{26}/);assert.doesNotMatch(sent[0]!.text,/PRIVATE_QUESTION|PRIVATE_PURPOSE/);
  assert.equal((await one(db,'SELECT reason_code FROM diagnostic_incidents'))!.reason_code,'telegram_network');assert.equal((await one(db,'SELECT status FROM private_requests'))!.status,'offered');
 });
 it('malformed OAuth polling response is traced without recording device tokens or guessing that credentials are wrong',async()=>{
  const request:HTTPRequest=async url=>({url,status:200,headers:{},body:Buffer.from(url.includes('.well-known')?JSON.stringify({issuer:'https://auth.example.com/',device_authorization_endpoint:'https://auth.example.com/device',token_endpoint:'https://auth.example.com/token'}):url.endsWith('/device')?JSON.stringify({device_code:'DEVICE_SECRET',user_code:'ABCD',verification_uri:'https://auth.example.com/verify',expires_in:600,interval:5}):'PRIVATE_PROVIDER_BROKEN_RESPONSE')});
  const oauth=new OAuthDevices(db,h.config.runtimeDir,request),setup=await oauth.setup({name:'calendar',endpoint:'https://api.example.com/mcp',issuer:'https://auth.example.com/',client_id:'public-client',scopes:['read']},context);
  assert.equal(await oauth.begin(setup.id,'11',h.tg as unknown as Telegram),true);await db.query("UPDATE oauth_setups SET next_poll=now()-interval '1 second'");assert.equal(await oauth.tick(),true);
  assert.equal((await one(db,'SELECT status FROM oauth_setups'))!.status,'failed');
  const notice=(await one(db,"SELECT body,audience FROM outbox WHERE dedup_key LIKE 'oauth-failed:%'"))!;assert.equal(notice.audience,'private');assert.match(notice.body.text,/JSON/u);assert.match(notice.body.text,/LM-[0-9A-Z]{26}/);assert.doesNotMatch(notice.body.text,/DEVICE_SECRET|PRIVATE_PROVIDER_BROKEN_RESPONSE|client ID/u);
  const incident=(await one(db,'SELECT * FROM diagnostic_incidents'))!;assert.equal(incident.reason_code,'oauth_invalid_response');assert.doesNotMatch(JSON.stringify(incident),/DEVICE_SECRET|PRIVATE_PROVIDER_BROKEN_RESPONSE/);
 });
 it('malformed research verification retains readable sources and exposes a traceable factual limitation',async()=>{
  h.brain.text=async()=> 'PRIVATE_INVALID_MODEL_OUTPUT';
  const reader:any=async()=>({url:'https://example.com/',text:'Першоджерело прочитане.',retrieved_at:new Date().toISOString()}),searcher:any=async()=>({sources:['https://example.com/']});
  const result=await new Research(db,{...h.config,webSearch:false},h.brain,reader,searcher).query({query:'Перевір джерело',freshness:'live'},context);
  assert.equal(result.status,'needs_review');assert.equal(result.sources.length,1);assert.equal(result.warnings?.length,1);assert.match(result.unknown[0]!,/потрібному формату/u);assert.match(result.unknown[0]!,/LM-[0-9A-Z]{26}/);
  assert.equal((await one(db,'SELECT reason_code FROM diagnostic_incidents'))!.reason_code,'response_contract_invalid');assert.doesNotMatch(JSON.stringify(result.warnings),/PRIVATE_INVALID_MODEL_OUTPUT/);
 });
 it('a corrupt persisted private draft is reported without silently replacing unfinished work',async()=>{
  const id=randomUUID(),key='private_draft_'+id.replaceAll('-','');await db.query("INSERT INTO private_requests(id,token,recipient_id,requester_id,topic_id,question,purpose,status,sharing,revision,payload,expires_at) VALUES($1,$2,'11','11','0','Час?','Зустріч','answering','task',0,$3,now()+interval '1 day')",[id,'b'.repeat(24),JSON.stringify({coordinator_key:'meeting'})]);
  const vault=new ConnectorVault(db,h.config.runtimeDir);await vault.put('11',key,'null');const inbox=new PrivateInbox(db,h.config.runtimeDir),pending=await inbox.pending('11');
  await assert.rejects(inbox.answer(pending,{message_id:1,date:1,from:{id:11,first_name:'Автор'},chat:{id:11,type:'private'},text:'так'},async()=>{throw Error('must_not_dispatch');}),/private_draft_invalid/);
  assert.equal(await vault.get('11',key),'null');assert.equal((await one(db,'SELECT status FROM private_requests WHERE id=$1',[id]))!.status,'answering');
 });
});
