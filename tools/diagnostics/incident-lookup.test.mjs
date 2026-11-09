import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lookupIncidentReport} from './incident-lookup.mjs';

const code='LM-01JBA123450123456789ABCDEF';
function client(chats=[{chat_id:'-100',schema_name:'public'}]){
 const calls=[];
 return {calls,query:async(q,args=[])=>{calls.push({q,args});return {rows:q.startsWith('SELECT chat_id')?chats:q.startsWith('SELECT to_regclass')?[{existing:'diagnostic_incidents'}]:q.startsWith('SELECT code,')?[{code,reason_code:'reminder_request_unbound',reason_detail:'source_id_invalid',source_message_id:'12',effect_state:'unchanged'}]:[]};}};
}
test('incident lookup is a bounded read-only transaction with code-bound queries, no chat content',async()=>{
 const db=client(),result=await lookupIncidentReport(db,{code});
 assert.equal(result.found,true);assert.equal(result.matches[0].reason_detail,'source_id_invalid');
 assert.equal(db.calls[0].q,'BEGIN READ ONLY');assert.equal(db.calls.at(-1).q,'ROLLBACK');
 assert.ok(db.calls.some(x=>x.q.startsWith('SELECT code,')&&x.args[0]===code));
 assert.ok(!db.calls.some(x=>/\b(?:INSERT|UPDATE|DELETE|CREATE)\b|FROM messages|tool_credentials/i.test(x.q)));
});
test('invalid codes and chat IDs are rejected before a connection query',async()=>{
 const db=client();for(const value of ["x' OR true--",'LM-SECRET','https://secret'])await assert.rejects(lookupIncidentReport(db,{code:value}),/incident_code_invalid/);
 await assert.rejects(lookupIncidentReport(db,{code,chatId:"-1;DROP TABLE messages"}),/incident_chat_invalid/);assert.equal(db.calls.length,0);
});
test('unsafe schema, excessive registry scan and lookup failures roll back without reading payloads',async()=>{
 for(const [db,expected] of [[client([{chat_id:'-1',schema_name:'public; SELECT secret'}]),/incident_schema_invalid/],[client(Array.from({length:257},()=>({chat_id:'-1',schema_name:'public'}))),/incident_lookup_chat_required/]]){await assert.rejects(lookupIncidentReport(db,{code}),expected);assert.equal(db.calls.at(-1).q,'ROLLBACK');assert.ok(!db.calls.some(x=>x.q.startsWith('SELECT code,')));}
});
