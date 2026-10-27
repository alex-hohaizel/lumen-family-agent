import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {readWeb,publicSearch} from './web.js';
import {browsers} from './browser.js';
import {compute} from './compute.js';
import {RELEASE} from './release.js';
import {ToolError} from './safe-http.js';

/** Fixed public probes, once per release. Never starts another poller or OAuth manager. */
export async function runtimeChecks(directory:string,nativeSearch:()=>Promise<unknown>,freshnessChoice:()=>Promise<unknown>){
  const path=join(directory,`checks-${RELEASE}-2.json`);let previous:Record<string,unknown>={};try{previous=JSON.parse(await readFile(path,'utf8'));}catch{}
  const checks:Record<string,unknown>={...previous,version:RELEASE,checked_at:new Date().toISOString()};
  const probe=async(name:string,operation:()=>Promise<unknown>)=>{if((checks[name] as any)?.ok===true)return;try{checks[name]={ok:true,proof:await operation()};}catch(e:any){checks[name]={ok:false,code:/^[a-z_0-9]{1,80}$/.test(e?.code || '')?e.code:'check_failed',error_type:String(e?.name || 'Error').slice(0,60),detail:(String(e?.message || '').split('\n')[0] || '').slice(0,300)};}console.log(JSON.stringify({event:'runtime_check',check:name,result:checks[name]}));};
  await probe('web_read',async()=>{const p=await readWeb('https://example.com');console.log(JSON.stringify({event:'public_page_observation',check:'web_read',url:p.url,title:'title' in p?p.title:undefined,characters:p.text.length,excerpt:p.text.slice(0,180)}));if(!('title' in p)||!/example domain/i.test(String(p.title))||p.text.length<80)throw new ToolError('unexpected_public_page');return {url:p.url,title:p.title,characters:p.text.length};});
  await probe('public_search',async()=>{const p=await publicSearch('Node.js official website');return {provider:p.provider,sources:p.sources};});
  await probe('native_search',nativeSearch);
  await probe('automatic_freshness_choice',freshnessChoice);
  await probe('browser',async()=>{let failure:unknown;for(let attempt=0;attempt<2;attempt++){try{const p:any=await browsers.run('runtime-diagnostic','open',{url:'https://example.com'});console.log(JSON.stringify({event:'public_page_observation',check:'browser',url:p.url,title:p.title,characters:p.text.length,excerpt:p.text.slice(0,180)}));if(!/example domain/i.test(p.title)||p.text.length<80)throw new ToolError('unexpected_public_page');return {title:p.title,url:p.url,characters:p.text.length};}catch(e){failure=e;await browsers.close().catch(()=>{});}finally{await browsers.run('runtime-diagnostic','close',{}).catch(()=>{});}}throw failure;});
  await probe('compute',async()=>{const value=await compute('return input.reduce((a,b)=>a+b,0)',[2,4,8]);if(value!==14)throw new Error('unexpected_computation');return {result:value};});
  await mkdir(directory,{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(checks,null,2),{mode:0o600});return checks;
}
