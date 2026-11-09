import {one,state,queueText,type Database} from './db.js';
import type {Config} from './config.js';
import type {Telegram} from './telegram.js';
import {Media} from './media.js';
import {VisualMemory} from './visual.js';
import {recordIncident,safeErrorCode} from './incidents.js';

export class ImageJobs {
  constructor(private db:Database,private config:Config,private telegram:Telegram,private visual:VisualMemory,private media=new Media(config,undefined,db)){}
  async next(){
    const job=await this.db.tx<Record<string,any>|null>(async sql=>{const s=await state(sql,true);if(s.paused)return null;const j=await one(sql,"SELECT * FROM image_jobs WHERE status='pending' AND cancelled=false AND revision=$1 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",[s.memory_revision]);if(!j)return null;
      const day=new Date().toLocaleDateString('en-CA',{timeZone:this.config.timezone});
      const usage=await one(sql,'SELECT images FROM daily_usage WHERE day=$1',[day]);
      if(Number(usage?.images || 0)>=5){await sql.query("UPDATE image_jobs SET status='failed',error_code='image_daily_limit' WHERE id=$1",[j.id]);const incident=await recordIncident(sql,{operation:'image',stage:'validation',attemptKey:`image-limit:${j.id}`,actorId:j.author_id,topicId:j.topic_id,audience:'group',sourceId:j.source_message_id,revision:j.revision,effectState:'not_started'},'image_daily_limit');await queueText(sql,incident.message,s.memory_revision,`image-limit:${j.id}`,false,{actorId:j.author_id,threadId:Number(j.topic_id)||undefined,sourceMessageId:j.source_message_id});return null;}
      await sql.query('INSERT INTO daily_usage(day,images) VALUES($1,1) ON CONFLICT(day) DO UPDATE SET images=daily_usage.images+1',[day]);
      await sql.query("UPDATE image_jobs SET status='processing',attempts=attempts+1,updated_at=now() WHERE id=$1",[j.id]);return {...j,chatId:s.chat_id};});
    if(!job)return false;
    const abort=new AbortController();let checking=false;
    const watch=setInterval(async()=>{if(checking)return;checking=true;try{const s=await state(this.db),j=await one(this.db,'SELECT cancelled,generation_version FROM image_jobs WHERE id=$1',[job.id]);if(s.paused||s.memory_revision!==job.revision||!j||j.cancelled||j.generation_version!==job.generation_version)abort.abort();}catch{abort.abort();}finally{checking=false;}},1000);
    try{
      const refs=job.reference_ids.length?await this.visual.view(job.reference_ids):{images:[]};
      const bytes=await this.media.image(job.prompt,refs.images,abort.signal);
      const live=await state(this.db),current=await one(this.db,'SELECT * FROM image_jobs WHERE id=$1',[job.id]);
      if(abort.signal.aborted||!current||current.cancelled||live.paused||live.memory_revision!==job.revision||current.generation_version!==job.generation_version)return true;
      const sent=await this.telegram.upload('sendPhoto',job.chatId,bytes,`${job.author_name}, ось зображення за вашим задумом.`,'image/png',Number(job.topic_id)||undefined) as {message_id:number;photo?:{file_id:string}[]};
      await this.db.tx(async sql=>{const s=await state(sql,true);const j=await one(sql,'SELECT * FROM image_jobs WHERE id=$1',[job.id]);if(!j||j.cancelled||s.paused||s.memory_revision!==job.revision||j.generation_version!==job.generation_version)return;
        const file=sent.photo?.at(-1)?.file_id || null;
        await sql.query("UPDATE image_jobs SET status='done',result_file_id=$1,result_description=$2,updated_at=now() WHERE id=$3",[file,job.prompt.slice(0,1400),job.id]);
        const message=await one(sql,"INSERT INTO messages(telegram_id,user_id,author,role,body,topic_id,source_message_id) VALUES($1,'lumen','Люмен','assistant',$2,$3,$4) RETURNING id",[sent.message_id,`[зображення] ${job.prompt}`,job.topic_id,job.source_message_id]);
        if(file)await sql.query("INSERT INTO attachments(source_message_id,topic_id,kind,file_id,mime,description,status,revision) VALUES($1,$2,'generated',$3,'image/png',$4,'ready',$5)",[message!.id,job.topic_id,file,job.prompt.slice(0,1400),job.revision]);
      });
    }catch(e:any){
      const j=await one(this.db,'SELECT * FROM image_jobs WHERE id=$1',[job.id]);if(!j||j.cancelled||abort.signal.aborted||j.generation_version!==job.generation_version)return true;
      const code=safeErrorCode(e);const uncertain=Boolean(e.uncertain);
      await this.db.tx(async sql=>{const s=await state(sql,true);if(s.paused||s.memory_revision!==job.revision)return;await sql.query('UPDATE image_jobs SET status=$1,error_code=$2,updated_at=now() WHERE id=$3',[uncertain?'uncertain':'failed',code,job.id]);const incident=await recordIncident(sql,{operation:'image',stage:uncertain?'delivery':'tool',attemptKey:`image-failed:${job.id}:${job.generation_version}`,actorId:job.author_id,topicId:job.topic_id,audience:'group',sourceId:job.source_message_id,revision:job.revision,effectState:uncertain?'uncertain':undefined},e);await queueText(sql,incident.message,s.memory_revision,`image-failed:${job.id}`,false,{threadId:Number(job.topic_id)||undefined,sourceMessageId:job.source_message_id,actorId:job.author_id});});
    }finally{clearInterval(watch);}
    return true;
  }
}
