import {fieldAt} from './confirmation.js';
import {ToolError} from './safe-http.js';
import {createHash} from 'node:crypto';
import {one,state,queueText,type Database} from './db.js';
import {readWeb} from './web.js';
import type {Config} from './config.js';

export function monitoredNumber(text:string,needle:string){
  if(!needle.trim())return undefined;
  const index=text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());if(index<0)return undefined;
  const excerpt=text.slice(index+needle.length,index+needle.length+100).split('\n')[0] || '';
  const match=excerpt.match(/[+-]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?|[+-]?\d+(?:[.,]\d{1,2})?/);
  if(!match||match.index!>30)return undefined;
  const value=Number(match[0].replace(/[ \u00a0\u202f]/g,'').replace(',','.'));
  return Number.isFinite(value)?{value,excerpt:needle+excerpt}:undefined;
}
export class WebMonitors {
  constructor(private db:Database,private config:Config,private reader=readWeb){}
  async next(){
    const row=await this.db.tx(async sql=>{const s=await state(sql,true);if(s.paused)return;
      await sql.query("UPDATE web_monitors SET status='expired' WHERE status='active' AND expires_at<=now()");
      const r=await one(sql,"SELECT * FROM web_monitors WHERE status='active' AND revision=$1 AND next_check_at<=now() AND expires_at>now() ORDER BY next_check_at LIMIT 1 FOR UPDATE SKIP LOCKED",[s.memory_revision]);if(!r)return;
      await sql.query("UPDATE web_monitors SET next_check_at=now()+(interval_minutes*interval '1 minute') WHERE id=$1",[r.id]);return r;
    });if(!row)return false;
    try{
      const page=await this.reader(row.url);let text=page.text;let jsonValue:any;if(row.json_path){let data;try{data=JSON.parse(text);}catch{throw new ToolError('monitor_json_invalid');}jsonValue=fieldAt(data,row.json_path);if(jsonValue===undefined||jsonValue!==null&&typeof jsonValue==='object')throw new ToolError('monitor_json_field_missing');text=String(jsonValue);}const hash=createHash('sha256').update(text).digest('hex');
      const measurement=row.condition==='below'?(row.json_path&&typeof jsonValue==='number'?{value:jsonValue,excerpt:row.json_path+': '+jsonValue}:monitoredNumber(text,row.needle)):undefined;
      const number=measurement?.value??NaN;
      const matched=row.condition==='change'?Boolean(row.last_hash&&row.last_hash!==hash):row.condition==='contains'?text.toLowerCase().includes(row.needle.toLowerCase()):Number.isFinite(number)&&number<Number(row.threshold);
      await this.db.tx(async sql=>{const s=await state(sql,true),current=await one(sql,'SELECT status FROM web_monitors WHERE id=$1',[row.id]);if(s.paused||s.memory_revision!==row.revision||current?.status!=='active')return;
        const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:this.config.timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date()));
        const quiet=s.quiet_start===s.quiet_end?false:s.quiet_start<s.quiet_end?hour>=s.quiet_start&&hour<s.quiet_end:hour>=s.quiet_start||hour<s.quiet_end;
        const notify=matched&&!quiet&&(!row.last_notified_at||Date.now()-new Date(row.last_notified_at).getTime()>3600000)&&row.last_hash!==hash;
        if(notify)await queueText(sql,`${row.label}\n${row.condition==='change'?'На сторінці є зміни.':row.condition==='contains'?'Знайшов погоджений текст на сторінці.':`Показник «${row.needle}»: ${number}, нижче порога ${row.threshold}.\n${measurement?.excerpt}`}\n${row.url}\n\n${text.slice(0,700)}`,s.memory_revision,`watch:${row.id}:${hash}`,false,{threadId:row.topic_id==='0'?undefined:Number(row.topic_id),actorId:row.actor_id,sourceMessageId:row.source_message_id?Number(row.source_message_id):undefined});
        await sql.query('UPDATE web_monitors SET last_hash=$1,last_excerpt=$2,last_notified_at=CASE WHEN $3 THEN now() ELSE last_notified_at END,error_code=NULL,failures=0 WHERE id=$4',[matched&&!notify?row.last_hash:hash,text.slice(0,700),notify,row.id]);
      });
    }catch{
      await this.db.tx(async sql=>{const s=await state(sql,true);if(s.paused||s.memory_revision!==row.revision)return;const failed=await one(sql,"UPDATE web_monitors SET error_code='page_unavailable',failures=failures+1,status=CASE WHEN failures>=4 THEN 'needs_input' ELSE status END WHERE id=$1 AND status='active' RETURNING failures",[row.id]);if(Number(failed?.failures)===5)await queueText(sql,`Не можу перевірити «${row.label}» після п’яти спроб. Спостереження зупинене; сайт може вимагати вхід або бути недоступним.\n${row.url}`,s.memory_revision,'watch-failed:'+row.id,false,{actorId:row.actor_id,threadId:row.topic_id==='0'?undefined:Number(row.topic_id)});});
    }
    return true;
  }
}
