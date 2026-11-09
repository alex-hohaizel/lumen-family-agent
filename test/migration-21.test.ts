import {it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TestDB,harness,message} from './helpers.js';
import {migrate,one} from '../src/db.js';

it('a version20 namespace receives the full21 migration, keeps old ownership/uncertain effects, and survives restart',async()=>{
  const db=new TestDB();await db.init();try{
    await db.query("UPDATE app_state SET chat_id='-100',owner_id='11',open_group=true,mention_only=true,chat_title='Збережена група' WHERE id=1");
    await db.query("INSERT INTO members(user_id,name) VALUES('11','Автор')");
    const series=randomUUID();await db.query("INSERT INTO recurring_series(id,actor_id,topic_id,rule,status,revision) VALUES($1,'11','0',$2,'active',0)",[series,JSON.stringify({mode:'reminder',title:'Старе',instruction:'Старе',time:'04:00',timezone:'Europe/Kyiv'})]);
    await db.query("INSERT INTO reminders(title,due_at,author_id) VALUES('Збережене',now()+interval '1 day','11')");
    await db.query("INSERT INTO outbox(dedup_key,kind,body,revision,status) VALUES('old-uncertain','text',$1,0,'uncertain')",[JSON.stringify({text:'Збережений невідомий ефект'})]);
    // Reconstruct the old public contract, not an empty fresh database. The
    // independent QA also replays the exact committed v20 schema snapshot.
    await db.pg.exec(`DROP TABLE reminder_clarifications;
      ALTER TABLE recurring_series DROP COLUMN shared,DROP COLUMN manager_ids;
      ALTER TABLE scheduled_actions DROP COLUMN shared,DROP COLUMN manager_ids,DROP COLUMN audience;
      ALTER TABLE reminders DROP COLUMN shared,DROP COLUMN manager_ids,DROP COLUMN audience;
      ALTER TABLE topic_attention DROP COLUMN silenced_source_id,DROP COLUMN silenced_revision,DROP COLUMN silenced_body_sha256;
      DELETE FROM schema_version WHERE version=21;`);
    await migrate(db);
    assert.equal((await one(db,'SELECT max(version) AS n FROM schema_version'))!.n,22);
    assert.ok((await one(db,"SELECT to_regclass('reminder_clarifications') AS name"))!.name);
    const old=(await one(db,'SELECT actor_id,shared,manager_ids FROM recurring_series WHERE id=$1',[series]))!;assert.equal(old.actor_id,'11');assert.equal(old.shared,false);assert.deepEqual(old.manager_ids,[]);
    assert.equal((await one(db,"SELECT status FROM outbox WHERE dedup_key='old-uncertain'"))!.status,'uncertain');
    const h=harness(db);await h.lumen.receive(message('Люмен, як справи?'));assert.equal(await h.lumen.processNext(),true);
    await migrate(db);assert.equal((await one(db,'SELECT chat_title FROM app_state'))!.chat_title,'Збережена група');assert.equal(Number((await one(db,'SELECT count(*) AS n FROM reminders'))!.n),1);
    // A marker alone never hides a partially applied schema.
    await db.pg.exec('DROP TABLE reminder_clarifications; ALTER TABLE recurring_series DROP COLUMN manager_ids;');
    await migrate(db);assert.deepEqual((await one(db,'SELECT manager_ids FROM recurring_series WHERE id=$1',[series]))!.manager_ids,[]);
    assert.ok((await one(db,"SELECT to_regclass('reminder_clarifications') AS name"))!.name);
  }finally{await db.close();}
});
