import {one,type Database} from './db.js';
import type {Config} from './config.js';
import {ModelError} from './auth.js';

export async function reserveModelCall(db:Database,config:Config){
  const day=new Date().toISOString().slice(0,10);
  const row=await one(db,'INSERT INTO daily_usage(day,requests) VALUES ($1,1) ON CONFLICT(day) DO UPDATE SET requests=daily_usage.requests+1 RETURNING requests',[day]);
  const limit=config.dailyTurnLimit || (config.authMode==='api'?200:0);
  if(limit>0&&Number(row!.requests)>limit)throw new ModelError('daily_request_limit');
}

export async function physicalModelCall(db:Database,usage?:{input_tokens?:number;output_tokens?:number},failed=false,started=false){
 const day=new Date().toISOString().slice(0,10);await db.query('INSERT INTO daily_usage(day,requests,physical_requests,input_tokens,output_tokens,failed_requests,usage_missing) VALUES($1,0,$2,$3,$4,$5,$6) ON CONFLICT(day) DO UPDATE SET physical_requests=daily_usage.physical_requests+$2,input_tokens=daily_usage.input_tokens+$3,output_tokens=daily_usage.output_tokens+$4,failed_requests=daily_usage.failed_requests+$5,usage_missing=daily_usage.usage_missing+$6',[day,started?1:0,Math.max(0,Number(usage?.input_tokens)||0),Math.max(0,Number(usage?.output_tokens)||0),failed?1:0,!started&&!usage?1:0]);
}

export async function recordPromptFootprint(db:Database,footprint:{total_text_bytes:number;image_inputs:number}){const day=new Date().toISOString().slice(0,10);await db.query('INSERT INTO daily_usage(day,requests,prompt_bytes,max_prompt_bytes,image_inputs) VALUES($1,0,$2,$2,$3) ON CONFLICT(day) DO UPDATE SET prompt_bytes=daily_usage.prompt_bytes+$2,max_prompt_bytes=GREATEST(daily_usage.max_prompt_bytes,$2),image_inputs=daily_usage.image_inputs+$3',[day,footprint.total_text_bytes,footprint.image_inputs]);}
