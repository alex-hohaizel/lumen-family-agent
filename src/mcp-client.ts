import {safeRequest,publicURL,ToolError,type HTTPRequest} from './safe-http.js';

export class MCPClient {
  private session?:string;private id=0;private initialized=false;private protocol='2025-06-18';
  constructor(private endpoint:string,private token?:string,private request:HTTPRequest=safeRequest){if(publicURL(endpoint).protocol!=='https:'&&token)throw new ToolError('connector_https_required');}
  private async rpc(method:string,params:unknown={},notification=false):Promise<any>{
    const id=++this.id;
    const r=await this.request(this.endpoint,{method:'POST',headers:{accept:'application/json, text/event-stream','content-type':'application/json','MCP-Protocol-Version':this.protocol,...(this.session?{'Mcp-Session-Id':this.session}:{}),...(this.token?{authorization:'Bearer '+this.token}:{})},body:JSON.stringify({jsonrpc:'2.0',...(!notification?{id}:{}),method,params}),redirects:0,timeout:30000,maxBytes:1500000});
    if(r.status===401||r.status===403)throw new ToolError('connector_authorization_required');if(r.status>=400)throw new ToolError('connector_http_error');
    if(r.headers['mcp-session-id'])this.session=r.headers['mcp-session-id'];if(notification&&r.status===202)return;
    let data:any;const text=r.body.toString('utf8');
    if((r.headers['content-type'] || '').includes('text/event-stream')){
      for(const block of text.split(/\r?\n\r?\n/)){const s=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(s){try{const d=JSON.parse(s);if(d.id===id)data=d;}catch{}}}
    }else{try{data=JSON.parse(text);}catch{throw new ToolError('connector_invalid_response');}}
    if(!data||data.id!==id||data.error)throw new ToolError('connector_rpc_error');return data.result;
  }
  async init(){if(this.initialized)return;const result=await this.rpc('initialize',{protocolVersion:this.protocol,capabilities:{},clientInfo:{name:'lumen',version:'1.5.0'}});if(/^\d{4}-\d{2}-\d{2}$/.test(result?.protocolVersion || ''))this.protocol=result.protocolVersion;await this.rpc('notifications/initialized',{},true);this.initialized=true;}
  async list(){await this.init();const tools:any[]=[];let cursor:string|undefined;
    for(let i=0;i<5;i++){const r=await this.rpc('tools/list',cursor?{cursor}:{});tools.push(...(r.tools || []));cursor=r.nextCursor;if(!cursor)break;}return tools.slice(0,100);
  }
  async call(name:string,args:unknown){await this.init();const result=await this.rpc('tools/call',{name,arguments:args});if(result?.isError)throw new ToolError('connector_tool_error');const json=JSON.stringify(result);return this.token?JSON.parse(json.split(this.token).join('[redacted]')):result;}
}
