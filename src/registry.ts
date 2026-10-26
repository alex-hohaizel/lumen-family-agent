import {createHash} from 'node:crypto';
import {applySchema,migrate,one,type Database,type SQL,type Row} from './db.js';

function checkedSchema(schema:string){
  if(schema!=='public'&&!/^lumen_g_[a-f0-9]{48}$/.test(schema))throw new Error('invalid_chat_schema');
  return schema;
}
export function schemaForChat(chatId:string){
  if(!/^-?\d+$/.test(chatId))throw new Error('invalid_chat_id');
  return `lumen_g_${createHash('sha256').update(chatId).digest('hex').slice(0,48)}`;
}

// Every operation owns a transaction-local namespace. No public fallback is allowed
// for new chats: a missing table fails instead of reading another chat's data.
export class ChatDatabase implements Database {
  private schema:string;
  constructor(private root:Database,schema:string){this.schema=checkedSchema(schema);}
  async tx<T>(fn:(sql:SQL)=>Promise<T>){
    return this.root.tx(async sql=>{await sql.query(`SET LOCAL search_path TO "${this.schema}", pg_catalog`);return fn(sql);});
  }
  async query<T extends Row=Row>(sql:string,args:any[]=[]){return this.tx(tx=>tx.query<T>(sql,args));}
  async close(){} // The transport owns and closes the shared connection pool.
}
export interface RegisteredChat {chat_id:string;schema_name:string;owner_id:string;title:string;enabled:boolean;}
export class ChatRegistry {
  constructor(private root:Database){}
  async init(){
    await this.root.tx(async sql=>{
      const script=`CREATE TABLE IF NOT EXISTS public.lumen_transport_state(id integer PRIMARY KEY CHECK(id=1),poll_offset bigint NOT NULL DEFAULT 0,last_poll_at timestamptz,owner_user_id text);
      CREATE TABLE IF NOT EXISTS public.lumen_chats(chat_id text PRIMARY KEY,schema_name text NOT NULL UNIQUE,owner_id text NOT NULL,title text NOT NULL DEFAULT '',enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now());`;
      if(sql.script)await sql.script(script);else await sql.query(script);
      const old=await one(sql,"SELECT to_regclass('public.app_state') AS existing");
      const legacy=old?.existing?await one(sql,'SELECT chat_id,owner_id,poll_offset,last_poll_at FROM public.app_state WHERE id=1'):undefined;
      await sql.query('INSERT INTO public.lumen_transport_state(id,poll_offset,last_poll_at,owner_user_id) VALUES(1,$1,$2,$3) ON CONFLICT DO NOTHING',[legacy?.poll_offset||0,legacy?.last_poll_at||null,legacy?.chat_id?legacy.owner_id:null]);
      if(legacy?.chat_id){
        await sql.query("INSERT INTO public.lumen_chats(chat_id,schema_name,owner_id) VALUES($1,'public',$2) ON CONFLICT DO NOTHING",[legacy.chat_id,legacy.owner_id]);
      }
    });
    for(const chat of await this.list()){
      const db=new ChatDatabase(this.root,chat.schema_name);await migrate(db);
      await db.query("UPDATE app_state SET open_group=true,mention_only=true,mode='quiet' WHERE id=1 AND NOT open_group");
    }
  }
  async transport(){return (await one(this.root,'SELECT * FROM public.lumen_transport_state WHERE id=1'))!;}
  async advance(offset:number){await this.root.query('UPDATE public.lumen_transport_state SET poll_offset=$1,last_poll_at=now() WHERE id=1',[offset]);}
  async polled(){await this.root.query('UPDATE public.lumen_transport_state SET last_poll_at=now() WHERE id=1');}
  async claimOwner(uid:string){
    return this.root.tx(async sql=>{
      const s=await one(sql,'SELECT owner_user_id FROM public.lumen_transport_state WHERE id=1 FOR UPDATE');
      if(s?.owner_user_id&&s.owner_user_id!==uid)return false;
      await sql.query('UPDATE public.lumen_transport_state SET owner_user_id=$1 WHERE id=1',[uid]);return true;
    });
  }
  async list(){return (await this.root.query<RegisteredChat>('SELECT * FROM public.lumen_chats WHERE enabled=true ORDER BY created_at')).rows;}
  async find(chatId:string){return await one(this.root,'SELECT * FROM public.lumen_chats WHERE chat_id=$1',[chatId]) as RegisteredChat|undefined;}
  database(chat:RegisteredChat){return new ChatDatabase(this.root,chat.schema_name);}
  async ensure(chatId:string,ownerId:string,title=''){
    return this.root.tx(async sql=>{
      await sql.query('SELECT id FROM public.lumen_transport_state WHERE id=1 FOR UPDATE');
      const existing=await one(sql,'SELECT * FROM public.lumen_chats WHERE chat_id=$1',[chatId]) as RegisteredChat|undefined;
      if(existing){await sql.query('UPDATE public.lumen_chats SET enabled=true,title=$2 WHERE chat_id=$1',[chatId,title]);return {...existing,enabled:true,title};}
      const schema=schemaForChat(chatId);
      await sql.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await sql.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
      await applySchema(sql);
      await sql.query("UPDATE app_state SET chat_id=$1,owner_id=$2,chat_title=$3,open_group=true,mention_only=true,mode='quiet' WHERE id=1",[chatId,ownerId,title]);
      await sql.query('INSERT INTO public.lumen_chats(chat_id,schema_name,owner_id,title) VALUES($1,$2,$3,$4)',[chatId,schema,ownerId,title]);
      return {chat_id:chatId,schema_name:schema,owner_id:ownerId,title,enabled:true};
    });
  }
  async disable(chatId:string){await this.root.query('UPDATE public.lumen_chats SET enabled=false WHERE chat_id=$1',[chatId]);}
  async migrateChat(oldId:string,newId:string){
    if(!/^-?\d+$/.test(newId))throw new Error('invalid_chat_id');
    await this.root.tx(async sql=>{
      const chat=await one(sql,'SELECT * FROM public.lumen_chats WHERE chat_id=$1 FOR UPDATE',[oldId]);
      if(!chat)return;
      if(await one(sql,'SELECT chat_id FROM public.lumen_chats WHERE chat_id=$1',[newId]))throw new Error('chat_migration_conflict');
      await sql.query('UPDATE public.lumen_chats SET chat_id=$2 WHERE chat_id=$1',[oldId,newId]);
      await sql.query(`SET LOCAL search_path TO "${checkedSchema(chat.schema_name)}", pg_catalog`);
      await sql.query('UPDATE app_state SET chat_id=$1 WHERE id=1',[newId]);
    });
  }
}
