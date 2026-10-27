import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {one,type Database} from './db.js';
import {ToolError} from './safe-http.js';

export class ConnectorVault {
  constructor(private db:Database,private runtimeDir:string){}
  private async key(){
    const path=resolve(this.runtimeDir,'connector-vault.key');await mkdir(this.runtimeDir,{recursive:true,mode:0o700});
    try{return await readFile(path);}catch(e:any){if(e.code!=='ENOENT')throw e;const key=randomBytes(32);try{await writeFile(path,key,{mode:0o600,flag:'wx'});return key;}catch(e:any){if(e.code==='EEXIST')return readFile(path);throw e;}}
  }
  async put(owner:string,name:string,value:string){
    if(!/^[a-z][a-z0-9_-]{0,59}$/.test(name)||!value||value.length>20000)throw new ToolError('invalid_connection');
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await this.key(),iv);cipher.setAAD(Buffer.from(owner+':'+name));
    const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    await this.db.query('INSERT INTO tool_credentials(owner_id,name,ciphertext,iv,tag) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,name) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,tag=excluded.tag,updated_at=now()',[owner,name,encrypted.toString('base64'),iv.toString('base64'),cipher.getAuthTag().toString('base64')]);
  }
  async get(owner:string,name:string){
    const row=await one(this.db,'SELECT * FROM tool_credentials WHERE owner_id=$1 AND name=$2',[owner,name]);if(!row)throw new ToolError('connection_required');
    const cipher=createDecipheriv('aes-256-gcm',await this.key(),Buffer.from(row.iv,'base64'));cipher.setAAD(Buffer.from(owner+':'+name));cipher.setAuthTag(Buffer.from(row.tag,'base64'));
    try{return Buffer.concat([cipher.update(Buffer.from(row.ciphertext,'base64')),cipher.final()]).toString('utf8');}catch{throw new ToolError('connection_unreadable');}
  }
  async list(owner:string){return (await this.db.query('SELECT name,updated_at FROM tool_credentials WHERE owner_id=$1 ORDER BY name',[owner])).rows;}
  async remove(owner:string,name:string){await this.db.query('DELETE FROM tool_credentials WHERE owner_id=$1 AND name=$2',[owner,name]);}
}
