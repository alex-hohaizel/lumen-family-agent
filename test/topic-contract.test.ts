import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {topicKey,transportThread} from '../src/topic-scope.js';
import {Telegram,TelegramError,telegramRepairHint} from '../src/telegram.js';
import {TestDB,harness,paired,message} from './helpers.js';
import {Delivery} from '../src/delivery.js';
import {queueText} from '../src/db.js';

describe('Bot API topic contract and safe failures',()=>{
  it('General absent/zero is one scope; historical1 and real topics retain their identities',()=>{
    assert.equal(topicKey({}),'0');assert.equal(topicKey({message_thread_id:0}),'0');
    for(const id of [1,101,202]){assert.equal(topicKey({message_thread_id:id}),String(id));assert.equal(transportThread(id),id);}
    assert.equal(transportThread(0),undefined);
    for(const id of [-1,NaN,Infinity,1.1,'101',null])assert.throws(()=>topicKey({message_thread_id:id}),/Invalid topic/);
  });
  it('wire calls omit General0, preserve topic202, and sanitize thread/permission errors',async()=>{
    const bodies:any[]=[];let failure:any;
    const tg=new Telegram('synthetic',async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify(failure||{ok:true,result:{message_id:1}}),{status:failure?.error_code||200});});
    await tg.call('sendMessage',{chat_id:-100,text:'test',message_thread_id:0});assert.equal('message_thread_id' in bodies[0],false);
    await tg.call('sendMessage',{chat_id:-100,text:'test',message_thread_id:202});assert.equal(bodies[1].message_thread_id,202);
    for(const [description,code,status] of [['Bad Request: message thread not found','telegram_thread_not_found',400],['Bad Request: TOPIC_CLOSED','telegram_topic_closed',400],['Forbidden: bot was kicked from the supergroup chat','telegram_permission_denied',403]] as const){
      failure={ok:false,error_code:status,description:description+' private raw text'};
      await assert.rejects(tg.text('-100','test'),(e:any)=>e instanceof TelegramError&&e.code===code&&!e.message.includes('private raw text'));
      assert.ok(telegramRepairHint(code));
    }
    const count=bodies.length;await assert.rejects(tg.call('sendMessage',{message_thread_id:-5}));assert.equal(bodies.length,count);
  });
  it('General and forum topics bind actual original source and confirmed receipt through the same scope',async()=>{
    const db=new TestDB();await db.init();const h=harness(db);
    try{
      await paired(h);await db.query('UPDATE app_state SET open_group=true,mention_only=true,quiet_start=0,quiet_end=0');
      for(const thread of [undefined,0,101,202]){
        const update=message('Люмен, коротко поясни цю тему');update.message!.chat.is_forum=true;update.message!.is_topic_message=Boolean(thread);update.message!.message_thread_id=thread;
        h.brain.replies.push({reply:'Ця відповідь у потрібній темі.',actions:[]});
        await h.lumen.receive(update);await h.lumen.processNext();
        const source=(await db.query('SELECT id,topic_id,request_context FROM messages WHERE role=\'user\' AND telegram_id=$1',[update.message!.message_id])).rows[0]!;
        assert.equal(source.topic_id,String(thread||0));assert.equal(source.request_context.topic_id,source.topic_id);
        const delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);await delivery.next();
        const row=(await db.query('SELECT body FROM outbox WHERE source_message_id=$1 AND status=\'sent\' ORDER BY id DESC LIMIT 1',[source.id])).rows[0]!;
        assert.equal(row.body.deliveryReceipt.scope_topic_id,source.topic_id);assert.equal(row.body.deliveryReceipt.destination_chat_id,'-100');
        assert.equal(h.tg.options.at(-1)!.threadId,thread||undefined);
      }
    }finally{await db.close();}
  });
  it('terminal topic failure is recorded in the same outbox without retrying in General/another audience',async()=>{
    const db=new TestDB();await db.init();const h=harness(db);
    try{await paired(h);await queueText(db,'Only in topic202',0,'topic-failure',false,{threadId:202,actorId:'11'});
      h.tg.failure=new TelegramError('telegram_thread_not_found',0,false);
      const delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);await delivery.next();await delivery.next();
      const rows=(await db.query('SELECT status,error_code,body FROM outbox')).rows;assert.equal(rows.length,1);assert.equal(rows[0]!.status,'failed');assert.equal(rows[0]!.error_code,'telegram_thread_not_found');assert.equal(rows[0]!.body.threadId,202);assert.equal(h.tg.sent.length,0);
    }finally{await db.close();}
  });
});
