import {loadConfig} from './config.js';
import {Postgres,one} from './db.js';
// Operational recovery has no message payload output and never decrypts a dead-letter entry.
const config=await loadConfig(),db=new Postgres(config.databaseUrl);try{
 const [operation='list',id]=process.argv.slice(2);if(operation==='list'){console.log(JSON.stringify((await db.query("SELECT update_id,status,attempts,manual_retries,created_at,available_at,last_error,error_kind FROM public.lumen_ingress WHERE status='repair' ORDER BY created_at LIMIT 100")).rows,null,2));}
 else if(['retry','drop'].includes(operation)&&/^\d+$/.test(id||'')){
  const result=await one(db,operation==='retry'?"UPDATE public.lumen_ingress SET status='pending',attempts=0,manual_retries=manual_retries+1,available_at=now(),last_error=NULL WHERE update_id=$1 AND status='repair' AND ciphertext IS NOT NULL RETURNING update_id,status":"UPDATE public.lumen_ingress SET status='discarded',ciphertext=NULL,last_error='operator_discarded' WHERE update_id=$1 AND status='repair' RETURNING update_id,status",[id]);console.log(JSON.stringify(result||{changed:false}));
 }else throw Error('Use: npm run ingress -- list | retry UPDATE_ID | drop UPDATE_ID');
}finally{await db.close();}
