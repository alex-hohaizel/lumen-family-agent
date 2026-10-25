import { access,readFile,writeFile,link,unlink,mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import { ModelError } from './auth.js';

const Credential=z.object({
  client_id:z.string().min(1).refine(x=>x!=='dynamic_agent_client'),issuer:z.literal('https://auth.openai.com'),
  subject:z.string().min(1),email:z.string().optional(),id_token:z.string().min(1),access_token:z.string().min(1),
  refresh_token:z.string().min(1),scopes:z.array(z.string()).refine(x=>x.includes('chatgpt.tokens.use.direct')&&x.includes('resource.invoke')),
  expires_at:z.number().finite().positive(),saved_at:z.string()
});
const Accounts=z.object({selected:z.string().min(1),registrations:z.array(Credential).min(1).max(20)})
  .refine(x=>x.registrations.some(r=>r.client_id===x.selected));
export async function prepareCredentials(config:Config,env:NodeJS.ProcessEnv=process.env){
  const target=resolve(config.runtimeDir,'accounts.json');
  try{await access(target);return false;}catch(e:any){if(e.code!=='ENOENT')throw e;}
  let raw:string;
  if(env.CHATGPT_ACCOUNTS_B64){
    if(env.CHATGPT_ACCOUNTS_B64.length>100000)throw new ModelError('credential_seed_invalid');
    raw=Buffer.from(env.CHATGPT_ACCOUNTS_B64,'base64').toString('utf8');
  }else{
    try{raw=await readFile('/etc/secrets/chatgpt-accounts.json','utf8');}
    catch(e:any){if(e.code==='ENOENT')return false;throw e;}
  }
  let parsed;
  try{parsed=Accounts.parse(JSON.parse(raw));}catch{throw new ModelError('credential_seed_invalid');}
  await mkdir(config.runtimeDir,{recursive:true,mode:0o700});
  const temp=resolve(config.runtimeDir,`.accounts-seed-${randomUUID()}`);
  try{
    await writeFile(temp,JSON.stringify(parsed,null,2),{mode:0o600,flag:'wx'});
    // Link creates the final file atomically and cannot overwrite a fresh rotating session.
    await link(temp,target);return true;
  }catch(e:any){if(e.code==='EEXIST')return false;throw e;}
  finally{await unlink(temp).catch(()=>{});delete env.CHATGPT_ACCOUNTS_B64;}
}
