import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {readWeb,publicSearch} from './web.js';
import {browsers} from './browser.js';
import {compute} from './compute.js';
import {RELEASE} from './release.js';

/** Fixed public probes, once per release. Never starts another poller or OAuth manager. */
export async function runtimeChecks(directory:string,nativeSearch:()=>Promise<unknown>){
  const path=join(directory,`checks-${RELEASE}.json`);try{return JSON.parse(await readFile(path,'utf8'));}catch{}
  const checks:Record<string,unknown>={version:RELEASE,checked_at:new Date().toISOString()};
  const probe=async(name:string,operation:()=>Promise<unknown>)=>{try{checks[name]={ok:true,proof:await operation()};}catch(e:any){checks[name]={ok:false,code:/^[a-z_0-9]{1,80}$/.test(e?.code || '')?e.code:'check_failed'};}console.log(JSON.stringify({event:'runtime_check',check:name,result:checks[name]}));};
  await probe('web_read',async()=>{const p=await readWeb('https://example.com');if(!p.text.includes('Example Domain'))throw new Error('unexpected_page');return {url:p.url,characters:p.text.length};});
  await probe('public_search',async()=>{const p=await publicSearch('Node.js official website');return {provider:p.provider,sources:p.sources};});
  await probe('native_search',nativeSearch);
  await probe('browser',async()=>{try{const p:any=await browsers.run('runtime-diagnostic','open',{url:'https://example.com'});if(!p.text.includes('Example Domain'))throw new Error('unexpected_page');return {title:p.title,url:p.url};}finally{await browsers.run('runtime-diagnostic','close',{}).catch(()=>{});}});
  await probe('compute',async()=>{const value=await compute('return input.reduce((a,b)=>a+b,0)',[2,4,8]);if(value!==14)throw new Error('unexpected_computation');return {result:value};});
  await mkdir(directory,{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(checks,null,2),{mode:0o600});return checks;
}
