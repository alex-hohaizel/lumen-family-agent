import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import https from 'node:https';
import http from 'node:http';

export class ToolError extends Error {constructor(public code:string){super(code);}}
export function publicIP(ip:string):boolean {
  ip=ip.toLowerCase();
  if(ip.startsWith('::ffff:'))return publicIP(ip.slice(7));
  if(isIP(ip)===4){
    const [a,b]=ip.split('.').map(Number) as [number,number];
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));
  }
  if(isIP(ip)===6)return /^2[0-9a-f]{3}:/.test(ip)&&!ip.startsWith('2001:db8:')&&!ip.startsWith('2001:0:')&&!ip.startsWith('2002:');
  return false;
}
export function publicURL(input:string){
  let u:URL;try{u=new URL(input);}catch{throw new ToolError('invalid_url');}
  const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port)||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||host.endsWith('.onion')||isIP(host)&&!publicIP(host))throw new ToolError('public_url_required');
  u.hash='';return u;
}
export interface HTTPResult {url:string;status:number;headers:Record<string,string>;body:Buffer;}
export type HTTPRequest=(url:string,options?:{method?:string;body?:string;headers?:Record<string,string>;maxBytes?:number;timeout?:number;redirects?:number})=>Promise<HTTPResult>;
export const safeRequest:HTTPRequest=async(input,options={})=>{
  let url=publicURL(input);let method=options.method || 'GET';let body=options.body;
  const deadline=Date.now()+(options.timeout || 20000);
  for(let n=0;n<=Math.min(options.redirects??4,4);n++){
    const host=url.hostname.replace(/^\[|\]$/g,'');
    const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await Promise.race([lookup(host,{all:true}),new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(new ToolError('dns_timeout')),3000);t.unref();})]).catch(()=>{throw new ToolError('dns_unavailable');});
    if(!addresses.length||addresses.some(a=>!publicIP(a.address)))throw new ToolError('public_address_required');
    const address=addresses[0]!;const remaining=deadline-Date.now();if(remaining<=0)throw new ToolError('http_timeout');
    const response:HTTPResult=await new Promise((resolve,reject)=>{
      const transport=url.protocol==='https:'?https:http;
      const req=transport.request(url,{method,family:address.family,headers:{'user-agent':'Lumen/1.5 (user-requested assistant)','accept':'text/html,application/json,text/plain,application/pdf,*/*;q=0.5',...options.headers,'accept-encoding':'identity'},lookup:(_host,_opts,cb:any)=>cb(null,address.address,address.family),timeout:remaining},res=>{
        const chunks:Buffer[]=[];let total=0;res.on('data',(b:Buffer)=>{total+=b.length;if(total>(options.maxBytes || 2500000)){req.destroy(new ToolError('response_too_large'));return;}chunks.push(b);});
        res.on('end',()=>resolve({url:url.href,status:res.statusCode || 0,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):v || ''])),body:Buffer.concat(chunks)}));
        res.on('error',()=>reject(new ToolError('http_interrupted')));
      });
      req.on('timeout',()=>req.destroy(new ToolError('http_timeout')));req.on('error',e=>reject(e instanceof ToolError?e:new ToolError('http_unavailable')));if(body)req.write(body);req.end();
    });
    if([301,302,303,307,308].includes(response.status)&&response.headers.location){
      if(options.redirects===0)return response;
      if(n===(options.redirects??4))throw new ToolError('too_many_redirects');
      const next=publicURL(new URL(response.headers.location,url).href);
      if(next.origin!==url.origin&&Object.keys(options.headers || {}).some(h=>/authorization|cookie|api.key/i.test(h)))throw new ToolError('authenticated_redirect_blocked');
      if(response.status===303){method='GET';body=undefined;}url=next;continue;
    }
    return response;
  }
  throw new ToolError('too_many_redirects');
};
