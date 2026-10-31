import {join} from 'node:path';
import {atomicJSON} from './config.js';
import {checkOperation} from './operations.js';
import {RELEASE} from './release.js';

export type RuntimeCheckResult={status:'not_run'|'running'}|{status:'verified';ok:true;proof:unknown}|{status:'failed';ok:false;code:string;error_type:string};
export interface RuntimeCheckReport {
  status:'not_run'|'running'|'verified'|'failed';
  mode:'on_demand';
  version:string;
  started_at?:string;
  checked_at?:string;
  code?:string;
  checks:Record<string,RuntimeCheckResult>;
}
export type RuntimeProbes=Record<string,()=>Promise<unknown>>;
export const RUNTIME_DIAGNOSTICS_FILE='runtime-diagnostics.json';

export function runtimeDiagnosticsRequested(args:readonly string[]){return args.includes('--diagnostics');}
export function unrunRuntimeChecks():RuntimeCheckReport{return {status:'not_run',mode:'on_demand',version:RELEASE,checks:{}};}
function failureCode(error:unknown){const e=error as {code?:unknown;message?:unknown};const code=e?.code||e?.message;return typeof code==='string'&&/^[a-z_0-9]{1,80}$/.test(code)?code:'check_failed';}

/** Explicit public/synthetic diagnostics. Never reads a release cache or starts another auth manager. */
export async function runtimeChecks(directory:string,requested:boolean,createProbes:()=>RuntimeProbes|Promise<RuntimeProbes>,changed:(report:RuntimeCheckReport)=>void=()=>{}):Promise<RuntimeCheckReport>{
  const report=unrunRuntimeChecks();
  if(!requested){changed(report);return report;}
  report.status='running';report.started_at=new Date().toISOString();changed(report);
  try{
    checkOperation();const probes=await createProbes();if(!Object.keys(probes).length)throw new Error('no_runtime_probes');
    for(const name of Object.keys(probes))report.checks[name]={status:'not_run'};
    for(const [name,operation] of Object.entries(probes)){
      checkOperation();
      report.checks[name]={status:'running'};changed(report);
      try{const proof=await operation();checkOperation();report.checks[name]={status:'verified',ok:true,proof};}
      catch(error){report.checks[name]={status:'failed',ok:false,code:failureCode(error),error_type:String((error as Error)?.name||'Error').slice(0,60)};checkOperation();}
      console.log(JSON.stringify({event:'runtime_check',check:name,result:report.checks[name]}));changed(report);
    }
    checkOperation();report.status=Object.values(report.checks).some(check=>check.status==='failed')?'failed':'verified';
  }catch(error){report.status='failed';report.code=failureCode(error);}
  report.checked_at=new Date().toISOString();
  await atomicJSON(join(directory,RUNTIME_DIAGNOSTICS_FILE),report);changed(report);
  console.log(JSON.stringify({event:'runtime_checks_finished',status:report.status,version:report.version}));
  return report;
}

/** Constructing this list performs no probes; each capability is loaded only for an explicit run. */
export function publicRuntimeProbes(nativeSearch:()=>Promise<unknown>,freshnessChoice:()=>Promise<unknown>,additional:RuntimeProbes={}):RuntimeProbes{
  return {
    web_read:async()=>{const {readWeb}=await import('./web.js');const {ToolError}=await import('./safe-http.js');const p=await readWeb('https://example.com');console.log(JSON.stringify({event:'public_page_observation',check:'web_read',url:p.url,title:'title' in p?p.title:undefined,characters:p.text.length,excerpt:p.text.slice(0,180)}));if(!('title' in p)||!/example domain/i.test(String(p.title))||p.text.length<80)throw new ToolError('unexpected_public_page');return {url:p.url,title:p.title,characters:p.text.length};},
    public_search:async()=>{const {publicSearch}=await import('./web.js');const p=await publicSearch('Node.js official website');return {provider:p.provider,sources:p.sources};},
    native_search:nativeSearch,
    automatic_freshness_choice:freshnessChoice,
    browser:async()=>{const {browsers}=await import('./browser.js');const {ToolError}=await import('./safe-http.js');let failure:unknown;for(let attempt=0;attempt<2;attempt++){try{const p:any=await browsers.run('runtime-diagnostic','open',{url:'https://example.com'});console.log(JSON.stringify({event:'public_page_observation',check:'browser',url:p.url,title:p.title,characters:p.text.length,excerpt:p.text.slice(0,180)}));if(!/example domain/i.test(p.title)||p.text.length<80)throw new ToolError('unexpected_public_page');return {title:p.title,url:p.url,characters:p.text.length};}catch(error){checkOperation();failure=error;}finally{await browsers.closeScope('runtime-diagnostic').catch(()=>{});await browsers.trim().catch(()=>{});}}throw failure;},
    compute:async()=>{const {compute}=await import('./compute.js');const value=await compute('return input.reduce((a,b)=>a+b,0)',[2,4,8]);if(value!==14)throw new Error('unexpected_computation');return {result:value};},
    ...additional,
  };
}
