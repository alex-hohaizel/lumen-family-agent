import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {diagnosticOptions,report} from './report.mjs';

const codePattern=/^LM-[0-9A-HJKMNP-TV-Z]{26}$/;
const schemaPattern=/^(?:public|lumen_g_[a-f0-9]{48})$/;
const fields='code,operation,stage,reason_code,reason_detail,actor_id,topic_id,audience,source_message_id,revision,action_id,task_id,tool_run_id,outbox_id,effect_state,facts,app_version,created_at,last_seen_at,occurrences';

/** Uses only registry identifiers and the code. Never loads transcripts or credentials. */
export async function lookupIncidentReport(client,{code,chatId}={}){
 if(!codePattern.test(code||''))throw Error('incident_code_invalid');
 if(chatId!==undefined&&!/^-?\d{1,20}$/.test(chatId))throw Error('incident_chat_invalid');
 await client.query('BEGIN READ ONLY');
 try{
  await client.query("SET LOCAL statement_timeout='5000ms'");
  const chats=(await client.query('SELECT chat_id,schema_name FROM public.lumen_chats WHERE ($1::text IS NULL OR chat_id=$1) ORDER BY chat_id LIMIT 257',[chatId||null])).rows;
  if(chats.length>256)throw Error('incident_lookup_chat_required');
  const matches=[];
  for(const chat of chats){
   if(!schemaPattern.test(chat.schema_name))throw Error('incident_schema_invalid');
   const qualified='"'+chat.schema_name+'".diagnostic_incidents';
   if(!(await client.query('SELECT to_regclass($1) AS existing',[qualified])).rows[0]?.existing)continue;
   await client.query('SET LOCAL search_path TO "'+chat.schema_name+'",pg_catalog');
   const incident=(await client.query('SELECT '+fields+" FROM diagnostic_incidents WHERE code=$1 AND created_at>=now()-interval '30 days'",[code])).rows[0];
   if(incident)matches.push({chat_id:String(chat.chat_id),schema:chat.schema_name,...incident});
  }
  return {format:'lumen.incident-report/1',code,found:matches.length===1,ambiguous:matches.length>1,matches,reads_only:true,transcripts_read:false,provider_calls:false,limits:{retention_days:30,registry_scan:256},interpretation:'reason_code/reason_detail name the failed check; effect_state distinguishes unchanged, partial and uncertain effects. Source/task/tool/outbox IDs are private lookup references, not authority to repeat an effect.'};
 }finally{await client.query('ROLLBACK');}
}

async function main(){
 const options=diagnosticOptions({code:{type:'string'},'chat-id':{type:'string'},help:{type:'boolean'}});
 if(options.help){console.log('Read-only incident lookup. Usage: node --env-file-if-exists=.env tools/diagnostics/incident-lookup.mjs --code LM-... [--chat-id -100...] [--output-dir /external/reports]. Requires DATABASE_URL; never reads chat text or starts a worker.');return;}
 if(!codePattern.test(options.code||''))throw Error('incident_code_invalid');
 if(!process.env.DATABASE_URL)throw Error('incident_database_url_required');
 const {default:pg}=await import('pg');
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:5000});
 try{await client.connect();await report('incident-'+options.code+'.json',await lookupIncidentReport(client,{code:options.code,chatId:options['chat-id']}),options.outputDir);}
 finally{await client.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({error:/^incident_[a-z_]+$/.test(error?.message||'')?error.message:'incident_lookup_failed'}));process.exitCode=1;});
