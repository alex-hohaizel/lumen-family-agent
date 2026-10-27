import {one,type Database} from './db.js';
import type {Config} from './config.js';
import {ModelError} from './auth.js';

export async function reserveModelCall(db:Database,config:Config){
  const day=new Date().toISOString().slice(0,10);
  const row=await one(db,'INSERT INTO daily_usage(day,requests) VALUES ($1,1) ON CONFLICT(day) DO UPDATE SET requests=daily_usage.requests+1 RETURNING requests',[day]);
  const limit=config.dailyTurnLimit || (config.authMode==='api'?200:0);
  if(limit>0&&Number(row!.requests)>limit)throw new ModelError('daily_request_limit');
}
