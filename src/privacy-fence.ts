import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,open,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {eraseAll,state,type Database,type SQL,type Row} from './db.js';

/** A content-free epoch on the persistent disk, separate from PostgreSQL backups.
 * Write before commit. An interrupted erase conservatively erases again, never restores content.
 * Restoring both the database and its fence requires the operator to retain the newest fence.
 */
export class PrivacyFenceDatabase implements Database {
  private highest=0;
  private constructor(private db:Database,private path:string){}
  static async open(db:Database,directory:string,namespace:string){
    const path=join(directory,'privacy-fences',createHash('sha256').update(namespace).digest('hex')+'.json');
    const fenced=new PrivacyFenceDatabase(db,path);
    try{const data=JSON.parse(await readFile(path,'utf8'));if(!Number.isSafeInteger(data.epoch)||data.epoch<0)throw Error('privacy_fence_invalid');fenced.highest=data.epoch;}
    catch(e:any){if(e.code!=='ENOENT')throw e;fenced.highest=(await state(db)).memory_revision;await fenced.persist(fenced.highest);}
    await fenced.tx(async()=>{});
    return fenced;
  }
  private async persist(epoch:number){
    await mkdir(join(this.path,'..'),{recursive:true,mode:0o700});
    const temp=this.path+'.'+randomUUID()+'.tmp',file=await open(temp,'wx',0o600);
    try{await file.writeFile(JSON.stringify({version:1,epoch}));await file.sync();}finally{await file.close();}
    await rename(temp,this.path);
    const directory=await open(join(this.path,'..'),'r');try{await directory.sync();}finally{await directory.close();}
    this.highest=Math.max(this.highest,epoch);
  }
  async tx<T>(fn:(sql:SQL)=>Promise<T>){
    return this.db.tx(async sql=>{
      let before=await state(sql,true);
      if(before.memory_revision<this.highest){
        await eraseAll(sql);
        await sql.query("UPDATE app_state SET memory_revision=$1,paused=true,consent='[]' WHERE id=1",[this.highest]);
        before=await state(sql);
      }
      const result=await fn(sql),after=await state(sql);
      if(after.memory_revision>this.highest)await this.persist(after.memory_revision);
      return result;
    });
  }
  async query<T extends Row=Row>(query:string,args:any[]=[]){return this.tx(sql=>sql.query<T>(query,args));}
  async close(){await this.db.close();}
}
