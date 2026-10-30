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
export function monitorSnapshot(text:string,needle:string,condition:string,jsonValue?:unknown,jsonPath?:string){
 const normalized=text.replace(/[\u00a0\u202f]/g,' ').replace(/\r/g,'').trim();let excerpt=normalized;
 if(jsonPath)excerpt=jsonPath+': '+String(jsonValue);
 else if(needle.trim()){const index=normalized.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());if(index<0)return {status:'not_found',hash:createHash('sha256').update('not_found').digest('hex'),excerpt:'',matched:false};const begin=Math.max(normalized.lastIndexOf('\n',index)+1,index-100),end=normalized.indexOf('\n',index+needle.length);excerpt=normalized.slice(begin,end<0?Math.min(normalized.length,index+needle.length+250):end).trim();}
 else excerpt=normalized.split('\n').filter(line=>!/(?:copyright|all rights reserved|усі права|всі права|cookie|політика конфіденційності|updated at|останнє оновлення)/iu.test(line)).map(line=>line.trim().replace(/\s+/g,' ')).filter(Boolean).join('\n');
 const negative=/(?:немає|відсутн|недоступн|не (?:доступн|знайден|прода)|нет (?:в наличии|билет)|not available|unavailable|sold out|out of stock|no tickets)/iu.test(excerpt),measurement=condition==='below'?(jsonPath&&typeof jsonValue==='number'?{value:jsonValue,excerpt}:monitoredNumber(excerpt,needle)):undefined;
 const unit=excerpt.match(/(?:грн|UAH|USD|EUR|€|\$|кг|мл|шт|%)/iu)?.[0]||null,meaning=condition==='below'?{value:measurement?.value??null,unit}:condition==='contains'?{available:!negative,present:true}:excerpt;
 return {status:negative?'negative':condition==='below'&&!measurement?'unknown':'observed',hash:createHash('sha256').update(JSON.stringify(meaning)).digest('hex'),excerpt:excerpt.slice(0,1000),matched:!negative,measurement,unit,meaning};
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
      const page=await this.reader(row.url);let text=page.text;let jsonValue:any;if(row.json_path){let data;try{data=JSON.parse(text);}catch{throw new ToolError('monitor_json_invalid');}jsonValue=fieldAt(data,row.json_path);if(jsonValue===undefined||jsonValue!==null&&typeof jsonValue==='object')throw new ToolError('monitor_json_field_missing');text=String(jsonValue);}const snapshot=monitorSnapshot(text,row.needle,row.condition,jsonValue,row.json_path);const hash=snapshot.hash,measurement=snapshot.measurement,number=measurement?.value??NaN;
      const matched=row.condition==='change'?Boolean(row.last_hash&&row.last_hash!==hash&&snapshot.status==='observed'):row.condition==='contains'?snapshot.matched&&snapshot.status==='observed':snapshot.matched&&Number.isFinite(number)&&number<Number(row.threshold);
      await this.db.tx(async sql=>{const s=await state(sql,true),current=await one(sql,'SELECT status FROM web_monitors WHERE id=$1',[row.id]);if(s.paused||s.memory_revision!==row.revision||current?.status!=='active')return;
        const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:this.config.timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date()));
        const quiet=s.quiet_start===s.quiet_end?false:s.quiet_start<s.quiet_end?hour>=s.quiet_start&&hour<s.quiet_end:hour>=s.quiet_start||hour<s.quiet_end;
        const notify=matched&&!quiet&&(!row.last_notified_at||Date.now()-new Date(row.last_notified_at).getTime()>3600000)&&row.last_hash!==hash;
        const old=row.last_observation;
        if(notify)await queueText(sql,`${row.label}\n${row.condition==='change'?'Змінився погоджений показник.':row.condition==='contains'?'Погоджену умову знайдено без ознак заперечення.':`Показник «${row.needle}»: ${number} ${snapshot.unit||''}, нижче порога ${row.threshold}.`}\nБуло: ${old?.excerpt||row.last_excerpt||'попередній стан не збережений'}\nСтало: ${snapshot.excerpt||'даних недостатньо'}\nПеревірено: ${page.retrieved_at}\n${page.url}`,s.memory_revision,`watch:${row.id}:${hash}`,false,{threadId:row.topic_id==='0'?undefined:Number(row.topic_id),actorId:row.actor_id,sourceMessageId:row.source_message_id?Number(row.source_message_id):undefined});
        await sql.query('UPDATE web_monitors SET last_hash=$1,last_excerpt=$2,last_observation=$5,last_notified_at=CASE WHEN $3 THEN now() ELSE last_notified_at END,error_code=NULL,failures=0 WHERE id=$4',[matched&&!notify?row.last_hash:hash,snapshot.excerpt,notify,row.id,JSON.stringify({...snapshot,checked_at:page.retrieved_at,url:page.url})]);
      });
    }catch{
      await this.db.tx(async sql=>{const s=await state(sql,true);if(s.paused||s.memory_revision!==row.revision)return;const failed=await one(sql,"UPDATE web_monitors SET error_code='page_unavailable',failures=failures+1,status=CASE WHEN failures>=4 THEN 'needs_input' ELSE status END WHERE id=$1 AND status='active' RETURNING failures",[row.id]);if(Number(failed?.failures)===5)await queueText(sql,`Не можу перевірити «${row.label}» після п’яти спроб. Спостереження зупинене; сайт може вимагати вхід або бути недоступним.\n${row.url}`,s.memory_revision,'watch-failed:'+row.id,false,{actorId:row.actor_id,threadId:row.topic_id==='0'?undefined:Number(row.topic_id)});});
    }
    return true;
  }
}
