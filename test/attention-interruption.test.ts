import {it} from 'node:test';
import assert from 'node:assert/strict';
import {TestDB,harness,paired,message} from './helpers.js';
import {one,state,forgetPhrase} from '../src/db.js';
import {Lumen} from '../src/engine.js';
import {Delivery} from '../src/delivery.js';
import type {Telegram} from '../src/telegram.js';
import type {Media} from '../src/media.js';
import {unsolicitedBudgetAvailable} from '../src/attention.js';

async function setup(){const db=new TestDB();await db.init();const h=harness(db);await paired(h);await db.query("UPDATE app_state SET open_group=true,mention_only=true,quiet_start=0,quiet_end=0,proactive_mode='helpful'");return {db,h};}
it('the group cap uses confirmed delivery time rather than old queue time',async()=>{
  const {db}=await setup();try{
    for(let i=0;i<4;i++)await db.query("INSERT INTO outbox(dedup_key,kind,body,status,revision,created_at) VALUES($1,'text',$2,'sent',0,now()-interval '610 seconds')",['cap-receipt-'+i,JSON.stringify({ambient:true,text:'sent',sentAt:new Date(Date.now()-590000).toISOString()})]);
    assert.equal(await unsolicitedBudgetAvailable(db,99999),false);
    await db.query('UPDATE outbox SET body=body||$1::jsonb',[JSON.stringify({sentAt:new Date(Date.now()-610000).toISOString()})]);assert.equal(await unsolicitedBudgetAvailable(db,99999),true);
  }finally{await db.close();}
});
it('an authored silence survives restart and other turns, leaves other topics/direct requests usable, and is not a permanent profile',async()=>{
  const {db,h}=await setup();try{
    await h.lumen.receive(message('Люмен, помовчи, я допишу.'));await h.lumen.processNext();assert.equal((await state(db)).proactive_mode,'helpful');assert.ok((await one(db,'SELECT silenced_source_id FROM topic_attention WHERE topic_id=\'0\''))!.silenced_source_id);
    const restarted=new Lumen(db,h.config,h.tg as unknown as Telegram,h.brain,h.lumen.bot),delivery=new Delivery(db,h.tg as unknown as Telegram,h.config);
    await restarted.receive(message('Картопля на кухні знову стала мемом',22));assert.equal((await db.query("SELECT update_id FROM inbox WHERE status='pending'")).rows.length,0);
    const other=message('Картопля на кухні стала мемом',22);other.message!.message_thread_id=101;await restarted.receive(other);assert.equal((await db.query("SELECT update_id FROM inbox WHERE status='pending'")).rows.length,1);await db.query("DELETE FROM inbox WHERE status='pending'");
    h.brain.replies.push({reply:'Так, поясню.',actions:[]});await restarted.receive(message('Люмен, поясни мені це коротко',22));await restarted.processNext();await delivery.next();assert.equal(h.tg.sent.length,1);
    await restarted.receive(message('Картопля на кухні стала мемом',22));assert.equal((await db.query("SELECT update_id FROM inbox WHERE status='pending'")).rows.length,0);
    h.brain.replies.push({reply:'Продовжимо.',actions:[]});await restarted.receive(message('Люмен, тепер поясни це мені',11));await restarted.processNext();assert.equal((await one(db,'SELECT silenced_source_id FROM topic_attention WHERE topic_id=\'0\''))!.silenced_source_id,null);
    await restarted.receive(message('Картопля на кухні стала мемом',22));assert.equal((await db.query("SELECT update_id FROM inbox WHERE status='pending'")).rows.length,1);
  }finally{await db.close();}
});
it('quoted/forwarded silence cannot persist; forgetting the actual silence source releases its derived interruption',async()=>{
  const {db,h}=await setup();try{
    for(const forwarded of [false,true]){
      const update=message('Люмен, помовчи, я допишу.');update.message!.reply_to_message={message_id:900,from:{id:999,first_name:'Люмен',is_bot:true}};
      if(forwarded)(update.message as any).forward_origin={type:'user'};else update.message!.entities=[{type:'blockquote',offset:0,length:update.message!.text!.length}];
      await h.lumen.receive(update);await h.lumen.processNext();assert.equal((await one(db,'SELECT silenced_source_id FROM topic_attention WHERE topic_id=\'0\''))?.silenced_source_id??null,null);
    }
    await h.lumen.receive(message('Люмен, помовчи, я допишу.'));await h.lumen.processNext();await db.tx(sql=>forgetPhrase(sql,'помовчи'));
    await h.lumen.receive(message('Картопля на кухні стала мемом',22));assert.equal((await db.query("SELECT update_id FROM inbox WHERE status='pending'")).rows.length,1);
  }finally{await db.close();}
});
it('an addressed voice silence uses the actual transcription proof and also suppresses the next ambient turn',async()=>{
  const {db,h}=await setup();try{
    const media={transcribe:async()=> 'Люмен, помовчи, я допишу.'} as unknown as Media;
    const lumen=new Lumen(db,{...h.config,apiKey:'synthetic-only',transcribeModel:'synthetic-only'},h.tg as unknown as Telegram,h.brain,h.lumen.bot,media);
    const update=message('');delete update.message!.text;update.message!.voice={file_id:'silence-voice'};update.message!.reply_to_message={message_id:9990,from:{id:999,first_name:'Люмен',is_bot:true}};
    await lumen.receive(update);await lumen.processNext();assert.ok((await one(db,'SELECT silenced_source_id FROM topic_attention WHERE topic_id=\'0\''))!.silenced_source_id);
    await lumen.receive(message('Картопля на кухні знову стала мемом',22));assert.equal((await db.query("SELECT update_id FROM inbox WHERE status='pending'")).rows.length,0);
  }finally{await db.close();}
});
