import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TestDB} from './helpers.js';
import {migrate,one,state} from '../src/db.js';
import {captureOriginalRequestContext} from '../src/request-context.js';

test('позначена schema20 з неповними полями відновлюється без втрати даних і повторно мігрується без змін',async()=>{
 const db=new TestDB();await db.init();try{
  await db.query("UPDATE app_state SET chat_title='Збережена група' WHERE id=1");
  await db.pg.exec('ALTER TABLE agent_tasks DROP COLUMN audience; ALTER TABLE simple_list_events DROP COLUMN revision; DROP TABLE studio_soundtracks; ALTER TABLE messages DROP COLUMN request_context;');
  assert.equal(Number((await one(db,'SELECT count(*) AS n FROM schema_version WHERE version BETWEEN 1 AND 20'))!.n),20);
  await migrate(db);
  const shape=await one(db,"SELECT count(*) AS n FROM information_schema.columns WHERE table_schema=current_schema() AND (table_name,column_name) IN (('agent_tasks','audience'),('simple_list_events','revision'),('studio_soundtracks','asset_id'),('messages','request_context'))");
  assert.equal(Number(shape!.n),4);assert.equal((await state(db)).chat_title,'Збережена група');
  await migrate(db);
  assert.equal((await state(db)).chat_title,'Збережена група');
  assert.equal(Number((await one(db,'SELECT count(*) AS n FROM schema_version WHERE version BETWEEN 1 AND 20'))!.n),20);
 }finally{await db.close();}
});

test('schema20 shape7 repairs only missing original-context column, keeps legacy NULL and preserves captured data on repeat',async()=>{
 const db=new TestDB();await db.init();try{
  await db.query("UPDATE app_state SET chat_id='-100',chat_title='Жива група' WHERE id=1");
  const legacy=await one(db,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id,created_at) VALUES(313,'11','Автор','user','Збережений оригінал','7','2000-01-01T00:00:00Z') RETURNING id");
  await db.pg.exec('ALTER TABLE messages DROP COLUMN request_context;');
  await migrate(db);
  const repaired=await one(db,'SELECT * FROM messages WHERE id=$1',[legacy!.id]);assert.ok(repaired);
  assert.equal(repaired.body,'Збережений оригінал');assert.equal(new Date(repaired.created_at).toISOString(),'2000-01-01T00:00:00.000Z');assert.equal(repaired.request_context,null);
  const captured=await db.tx(sql=>captureOriginalRequestContext(sql,Number(legacy!.id),{message_id:313,date:946684800,from:{id:11},chat:{id:-100,type:'supergroup'},message_thread_id:7,text:repaired.body,entities:[{type:'code',offset:0,length:5}]},{namespaceChatId:'-100',sourceTopicId:'7'}));assert.ok(captured);
  await migrate(db);await migrate(db);
  assert.deepEqual((await one(db,'SELECT request_context FROM messages WHERE id=$1',[legacy!.id]))!.request_context,captured);
  assert.equal((await state(db)).chat_title,'Жива група');
  assert.equal(Number((await one(db,'SELECT count(*) AS n FROM schema_version WHERE version BETWEEN 1 AND 20'))!.n),20);
 }finally{await db.close();}
});
