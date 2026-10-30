import {one,state,queueText,type Database} from './db.js';
import type {Telegram} from './telegram.js';

interface ActivityJob {updateId:string|number;sourceId:number;revision:number;chatId:string;threadId?:number;replyTo?:number;allowNotice:boolean;serious:boolean;started:number;finished?:number;notice:boolean;stopped:boolean;timer?:ReturnType<typeof setInterval>;inFlight?:Promise<void>;}
export interface ActivityRequest extends Omit<ActivityJob,'started'|'finished'|'notice'|'stopped'|'timer'|'inFlight'>{}
export class ChatActivity {
  private jobs=new Map<number,ActivityJob>();
  constructor(private db:Database,private telegram:Telegram,private timing={intervalMs:4000,noticeAfterMs:18000,deliveryGraceMs:45000}){}
  async begin(request:ActivityRequest){
    await this.stopSource(request.sourceId);
    const job:ActivityJob={...request,started:Date.now(),notice:false,stopped:false};this.jobs.set(job.sourceId,job);
    job.timer=setInterval(()=>{void this.tick(job);},this.timing.intervalMs);job.timer.unref();void this.tick(job);
    return {finish:async()=>{job.finished=Date.now();await this.db.query("DELETE FROM outbox WHERE dedup_key=$1 AND status='pending'",[`progress:${job.updateId}:0`]).catch(()=>{});await this.tick(job);}};
  }
  private async tick(job:ActivityJob){
    if(job.stopped)return;if(job.inFlight)return job.inFlight;
    job.inFlight=(async()=>{
      try{
        const s=await state(this.db);
        if(s.paused||s.memory_revision!==job.revision){this.stop(job);return;}
        const inbox=await one(this.db,'SELECT status FROM inbox WHERE update_id=$1',[job.updateId]);
        const pending=job.finished?await one(this.db,"SELECT id FROM outbox WHERE source_message_id=$1 AND status IN ('pending','sending') AND dedup_key NOT LIKE 'progress:%' LIMIT 1",[job.sourceId]):undefined;
        if(job.finished&&(!pending||Date.now()-job.finished>this.timing.deliveryGraceMs)||!job.finished&&inbox?.status!=='processing'){this.stop(job);return;}
        if(job.stopped)return;
        await this.telegram.call('sendChatAction',{chat_id:job.chatId,action:'typing',...(job.threadId?{message_thread_id:job.threadId}:{})},3500).catch(()=>{});
        if(!job.finished&&!job.stopped&&job.allowNotice&&!job.notice&&Date.now()-job.started>=this.timing.noticeAfterMs){
          job.notice=true;
          await this.db.tx(async sql=>{const live=await state(sql,true);const current=await one(sql,"SELECT status FROM inbox WHERE update_id=$1",[job.updateId]);if(job.stopped||live.paused||live.memory_revision!==job.revision||current?.status!=='processing')return;
            const running=await one(sql,"SELECT tool FROM tool_runs WHERE source_message_id=$1 AND status='running' ORDER BY created_at DESC LIMIT 1",[job.sourceId]);const text=running?/^(web|research|browser)\./.test(running.tool)?'Читаю джерела для відповіді.':/^(document|artifact)\./.test(running.tool)?'Працюю з документом і перевіряю результат.':/^(studio|archive|library)\./.test(running.tool)?'Готую матеріали. Готовий файл повідомлю окремо.':'Виконую поточний крок.':'Ще працюю над відповіддю.';
            await queueText(sql,text,job.revision,`progress:${job.updateId}`,false,{threadId:job.threadId,replyToMessageId:job.replyTo,sourceMessageId:job.sourceId});
          });
        }
      }catch{this.stop(job);}
    })().finally(()=>{job.inFlight=undefined;});
    return job.inFlight;
  }
  private stop(job:ActivityJob){job.stopped=true;clearInterval(job.timer);if(this.jobs.get(job.sourceId)===job)this.jobs.delete(job.sourceId);}
  async stopSource(source:number){const job=this.jobs.get(Number(source));if(job){this.stop(job);await job.inFlight;}}
  async stopAll(){const jobs=[...this.jobs.values()];for(const job of jobs)this.stop(job);await Promise.allSettled(jobs.map(j=>j.inFlight));}
}
const activities=new WeakMap<Database,ChatActivity>();
export function activityFor(db:Database,telegram:Telegram,timing?:{intervalMs:number;noticeAfterMs:number;deliveryGraceMs:number}){let activity=activities.get(db);if(!activity){activity=new ChatActivity(db,telegram,timing);activities.set(db,activity);}return activity;}
export async function disposeActivity(db:Database){await activities.get(db)?.stopAll();activities.delete(db);}
