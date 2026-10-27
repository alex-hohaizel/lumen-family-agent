import {operationSignal,checkOperation} from './operations.js';
import {createHash} from 'node:crypto';
import type {Browser,BrowserContext,Page} from 'playwright-core';
import {safeRequest,publicURL,ToolError,type HTTPRequest} from './safe-http.js';
import {chromiumRuntime} from './chromium-runtime.js';

interface Session {context:BrowserContext;page:Page;last:number;writeOrigin?:string;blockedWrites:number;writes:number;lastWriteStatus?:number;}
export class BrowserTools {
  private browser?:Browser;private sessions=new Map<string,Session>();private tail:Promise<unknown>=Promise.resolve();private idle?:ReturnType<typeof setTimeout>;
  constructor(private request:HTTPRequest=safeRequest){}
  async available(){try{await import('playwright-core');await import('@sparticuz/chromium');return true;}catch{return false;}}
  async run(scope:string,operation:string,args:Record<string,any>,approvedOrigin?:string){
    const task=this.tail.catch(()=>{}).then(()=>this.perform(scope,operation,args,approvedOrigin));this.tail=task;return task;
  }
  private async start(){
    if(this.browser?.isConnected())return this.browser;
    const {chromium:driver}=await import('playwright-core');const {default:binary}=await import('@sparticuz/chromium');
    const runtime=await chromiumRuntime();const executable=process.env.LUMEN_CHROMIUM_PATH || runtime.executablePath;
    this.browser=await driver.launch({executablePath:executable,args:[...binary.args.filter(a=>!a.startsWith('--single-process')),'--disable-background-networking','--disable-extensions','--disable-sync','--disable-breakpad','--disable-component-update'],headless:true,timeout:30000,env:{PATH:process.env.PATH || '/usr/bin:/bin',HOME:'/tmp',LANG:'uk_UA.UTF-8',FONTCONFIG_PATH:runtime.directory+'/fonts',LD_LIBRARY_PATH:runtime.directory+':/usr/lib:/lib/x86_64-linux-gnu'}});
    return this.browser;
  }
  private async session(scope:string){
    for(const [key,s] of this.sessions)if(Date.now()-s.last>20*60000){await s.context.close().catch(()=>{});this.sessions.delete(key);}
    let s=this.sessions.get(scope);if(s){s.last=Date.now();return s;}
    if(this.sessions.size>=3)throw new ToolError('browser_busy');
    const browser=await this.start();const context=await browser.newContext({acceptDownloads:false,serviceWorkers:'block',locale:'uk-UA',viewport:{width:1100,height:760}});
    s={context,page:await context.newPage(),last:Date.now(),blockedWrites:0,writes:0};const session=s;
    await context.route('**/*',async route=>{
      const req=route.request();
      try{
        const url=publicURL(req.url());
        if(!['GET','HEAD','OPTIONS'].includes(req.method())&&session.writeOrigin!==url.origin){session.blockedWrites++;return void await route.abort('blockedbyclient');}
        if(['media','font','image'].includes(req.resourceType()))return void await route.abort();
        const headers:Record<string,string>={};for(const [k,v] of Object.entries(req.headers()))if(!['host','connection','content-length','accept-encoding'].includes(k))headers[k]=v;
        const r=await this.request(url.href,{method:req.method(),body:req.postData() || undefined,headers,maxBytes:2500000,timeout:15000,redirects:0});
        if(!['GET','HEAD','OPTIONS'].includes(req.method())){session.writes++;session.lastWriteStatus=r.status;}
        const responseHeaders={...r.headers};for(const k of ['content-encoding','transfer-encoding','content-length','connection'])delete responseHeaders[k];
        await route.fulfill({status:r.status,headers:responseHeaders,body:r.body});
      }catch{await route.abort('blockedbyclient').catch(()=>{});}
    });
    await context.routeWebSocket('**/*',ws=>ws.close());context.on('page',page=>{if(page!==session.page)void page.close();});
    this.sessions.set(scope,s);return s;
  }
  private async perform(scope:string,op:string,args:Record<string,any>,approvedOrigin?:string){
    checkOperation();clearTimeout(this.idle);
    if(op==='close'&&!this.sessions.has(scope))return {closed:true};
    const s=await this.session(scope);s.writeOrigin=approvedOrigin;const writesBefore=s.writes;
    const signal=operationSignal();const abort=()=>{void s.context.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>void s.context.close().catch(()=>{}),45000);timer.unref();
    try{
      if(op==='open')await s.page.goto(publicURL(args.url).href,{waitUntil:'domcontentloaded',timeout:20000});
      else if(op==='close'){await s.context.close();this.sessions.delete(scope);return {closed:true};}
      else if(op!=='inspect'){
        if(s.page.url()==='about:blank')throw new ToolError('browser_open_required');
        const control=s.page.locator(`[data-lumen-id="${Number(args.id)}"]`);if(!Number.isInteger(args.id)||await control.count()!==1)throw new ToolError('browser_snapshot_required');
        if(op==='fill')await control.fill(String(args.value),{timeout:5000});
        else if(op==='select')await control.selectOption(String(args.value),{timeout:5000});
        else if(op==='click'||op==='commit'){
          if(op==='commit'&&(!approvedOrigin||publicURL(s.page.url()).origin!==approvedOrigin))throw new ToolError('exact_action_approval_required');
          const navigation=s.page.waitForNavigation({waitUntil:'domcontentloaded',timeout:5000}).catch(()=>null);
          await control.click({timeout:8000,noWaitAfter:true});await navigation;
          if(op==='commit'&&s.writes===writesBefore)throw new ToolError('no_external_submission_observed');
          if(op==='commit'&&Number(s.lastWriteStatus)>=400)throw new ToolError('external_submission_rejected');
        }else if(op!=='inspect')throw new ToolError('unknown_browser_operation');
      }
      const snapshot=await s.page.evaluate(()=>{
        const visible=(e:Element)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
        const items=Array.from(document.querySelectorAll('a,button,input,select,textarea,[role=button]')).filter(visible).slice(0,100).map((e,i)=>{
          const id=i+1;e.setAttribute('data-lumen-id',String(id));
          const input=e as HTMLInputElement;
          const secret=input.type==='password'||/password|secret|token|one-time-code|cc-number|cc-csc/i.test((input.autocomplete || '')+' '+(input.name || ''));
          return {id,tag:e.tagName.toLowerCase(),type:input.type || '',name:input.name || '',label:(e.getAttribute('aria-label')||input.labels?.[0]?.textContent||e.textContent||input.placeholder||'').trim().slice(0,160),value:secret?'[hidden]':String(input.value || '').slice(0,150),href:(e as HTMLAnchorElement).href || undefined};
        });
        return {url:location.href,title:document.title,text:(document.body?.innerText || '').slice(0,16000),controls:items};
      });
      return {...snapshot,fingerprint:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),blocked_write_requests:s.blockedWrites,submitted_requests:s.writes,last_write_status:s.lastWriteStatus,content_is_untrusted:true,retrieved_at:new Date().toISOString()};
    }catch(e){if(e instanceof ToolError)throw e;throw new ToolError('browser_operation_failed');}
    finally{signal?.removeEventListener('abort',abort);clearTimeout(timer);s.writeOrigin=undefined;s.last=Date.now();if(!s.context.pages().length)this.sessions.delete(scope);this.idle=setTimeout(()=>void this.close().catch(()=>{}),120000);this.idle.unref();}
  }
  async pdf(html:string){
    const task=this.tail.catch(()=>{}).then(async()=>{checkOperation();const browser=await this.start(),context=await browser.newContext({serviceWorkers:'block',javaScriptEnabled:false});await context.route('**/*',r=>r.abort());const signal=operationSignal();const abort=()=>{void context.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,25000);timer.unref();try{const page=await context.newPage();await page.setContent(html,{waitUntil:'domcontentloaded',timeout:15000});return await page.pdf({format:'A4',margin:{top:'18mm',right:'18mm',bottom:'18mm',left:'18mm'},printBackground:true});}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);await context.close().catch(()=>{});}});this.tail=task;return task;
  }
  async trim(){const task=this.tail.catch(()=>{}).then(async()=>{if(!this.sessions.size)await this.close();});this.tail=task;return task;}
  async closeScope(prefix:string){for(const [key,s] of this.sessions)if(key===prefix||key.startsWith(prefix+':')){await s.context.close().catch(()=>{});this.sessions.delete(key);}}
  async close(){clearTimeout(this.idle);await this.browser?.close();this.sessions.clear();this.browser=undefined;}
}
export const browsers=new BrowserTools();
