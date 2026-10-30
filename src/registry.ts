import {createHash} from 'node:crypto';
import {applySchema,one,type Database,type SQL,type Row} from './db.js';
import {assertIngressCurrent,ingressContext} from './ingress-context.js';

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
export type RuntimeLane='conversation'|'delivery'|'media'|'automation'|'maintenance';
export interface RuntimeWork {chat:RegisteredChat;next:Partial<Record<RuntimeLane,number>>;busy:boolean;}
export type PrivateIngressKind='inbox'|'connector'|'calendar_setup'|'calendar_share'|'oauth'|'approval'|'view';
export interface PrivateIngressReference {kind:PrivateIngressKind;id:string;}
export class ChatRegistry {
  private initialization?:Promise<void>;
  private prepared=new Map<string,Promise<void>>();
  private columns=new Map<string,Map<string,Set<string>>>();
  constructor(private root:Database){}
  async init(){
    this.initialization ||= this.initialize().catch(error=>{this.initialization=undefined;throw error;});
    await this.initialization;
  }
  private async initialize(){
    await this.root.tx(async sql=>{
      const script=`CREATE TABLE IF NOT EXISTS public.lumen_transport_state(id integer PRIMARY KEY CHECK(id=1),poll_offset bigint NOT NULL DEFAULT 0,last_poll_at timestamptz,owner_user_id text);
      CREATE TABLE IF NOT EXISTS public.lumen_private_consumed(update_id bigint PRIMARY KEY,actor_id text NOT NULL,purpose text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS public.lumen_chats(chat_id text PRIMARY KEY,schema_name text NOT NULL UNIQUE,owner_id text NOT NULL,title text NOT NULL DEFAULT '',enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now());`;
      if(sql.script)await sql.script(script);else await sql.query(script);
      const registered=await one(sql,"SELECT chat_id FROM public.lumen_chats WHERE schema_name='public'");
      const old=registered?undefined:await one(sql,"SELECT to_regclass('public.app_state') AS existing");
      const legacy=old?.existing?await one(sql,'SELECT chat_id,owner_id,poll_offset,last_poll_at FROM public.app_state WHERE id=1'):undefined;
      await sql.query('INSERT INTO public.lumen_transport_state(id,poll_offset,last_poll_at,owner_user_id) VALUES(1,$1,$2,$3) ON CONFLICT DO NOTHING',[legacy?.poll_offset||0,legacy?.last_poll_at||null,legacy?.chat_id?legacy.owner_id:null]);
      if(legacy?.chat_id){
        await sql.query("INSERT INTO public.lumen_chats(chat_id,schema_name,owner_id) VALUES($1,'public',$2) ON CONFLICT DO NOTHING",[legacy.chat_id,legacy.owner_id]);
      }
    });
  }
  async privateConsumed(updateId:number,actor:string){return Boolean(await one(this.root,'SELECT update_id FROM public.lumen_private_consumed WHERE update_id=$1 AND actor_id=$2',[updateId,actor]));}
  async consumePrivate(updateId:number,actor:string,purpose:string){return (await this.root.query('INSERT INTO public.lumen_private_consumed(update_id,actor_id,purpose) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING update_id',[updateId,actor,purpose])).rows.length===1;}
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
  async list(includeDisabled=false){return (await this.root.query<RegisteredChat>(`SELECT * FROM public.lumen_chats ${includeDisabled?'':'WHERE enabled=true'} ORDER BY created_at`)).rows;}
  async find(chatId:string){return await one(this.root,'SELECT * FROM public.lumen_chats WHERE chat_id=$1',[chatId]) as RegisteredChat|undefined;}
  database(chat:RegisteredChat){return new ChatDatabase(this.root,chat.schema_name);}
  async ensure(chatId:string,ownerId:string,title=''){
    const chat=await this.root.tx(async sql=>{
      await sql.query('SELECT id FROM public.lumen_transport_state WHERE id=1 FOR UPDATE');
      const existing=await one(sql,'SELECT * FROM public.lumen_chats WHERE chat_id=$1',[chatId]) as RegisteredChat|undefined;
      if(existing){
        await sql.query('UPDATE public.lumen_chats SET enabled=true,title=$2 WHERE chat_id=$1',[chatId,title]);
        if(!existing.enabled&&ingressContext()&&(await this.tableColumns(sql,existing.schema_name)).has('app_state')){
          await sql.query(`SET LOCAL search_path TO "${checkedSchema(existing.schema_name)}", pg_catalog`);
          const live=await one(sql,'SELECT * FROM app_state WHERE id=1 FOR UPDATE');if(live)await assertIngressCurrent(sql,{...live,chat_id:chatId});
        }
        return {...existing,enabled:true,title};
      }
      const schema=schemaForChat(chatId);
      await sql.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await sql.query('INSERT INTO public.lumen_chats(chat_id,schema_name,owner_id,title) VALUES($1,$2,$3,$4)',[chatId,schema,ownerId,title]);
      return {chat_id:chatId,schema_name:schema,owner_id:ownerId,title,enabled:true};
    });
    await this.prepare(chat);
    return chat;
  }
  // The registry is the only owner of chat migration. Registration and startup
  // never migrate unrelated chats; a namespace is prepared on its first use.
  async prepare(chat:RegisteredChat){
    if(!chat.enabled)throw new Error('chat_disabled');
    let pending=this.prepared.get(chat.schema_name);
    if(!pending){
      pending=this.root.tx(async sql=>{
        const enabled=await one(sql,'SELECT * FROM public.lumen_chats WHERE chat_id=$1 AND enabled=true FOR SHARE',[chat.chat_id]);
        if(!enabled)throw new Error('chat_disabled');
        await sql.query(`SET LOCAL search_path TO "${checkedSchema(chat.schema_name)}", pg_catalog`);
        await applySchema(sql);
        await sql.query("UPDATE app_state SET chat_id=$1,owner_id=$2,chat_title=$3 WHERE id=1 AND (chat_id IS NULL OR chat_id<>$1)",[chat.chat_id,chat.owner_id,chat.title]);
        await sql.query("UPDATE app_state SET open_group=true,mention_only=true,mode='quiet' WHERE id=1 AND NOT open_group");
      }).then(()=>{this.columns.delete(chat.schema_name);}).catch(error=>{this.prepared.delete(chat.schema_name);throw error;});
      this.prepared.set(chat.schema_name,pending);
    }
    await pending;
  }
  private async tableColumns(sql:SQL,schema:string){
    let tables=this.columns.get(schema);
    if(!tables){
      tables=new Map();
      for(const row of (await sql.query('SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1',[schema])).rows){let fields=tables.get(row.table_name);if(!fields){fields=new Set();tables.set(row.table_name,fields);}fields.add(row.column_name);}
      this.columns.set(schema,tables);
    }
    return tables;
  }
  private async inspect<T>(chat:RegisteredChat,fn:(sql:SQL,has:(table:string,...columns:string[])=>boolean)=>Promise<T>){
    return this.root.tx(async sql=>{
      // Keep disable/re-enable ordered with reads of a tenant namespace. In
      // particular, cached registry rows cannot authorize a disabled schema.
      const enabled=await one(sql,'SELECT chat_id FROM public.lumen_chats WHERE chat_id=$1 AND enabled=true FOR SHARE',[chat.chat_id]);
      if(!enabled)return undefined;
      const tables=await this.tableColumns(sql,chat.schema_name);
      await sql.query(`SET LOCAL search_path TO "${checkedSchema(chat.schema_name)}", pg_catalog`);
      return fn(sql,(table,...columns)=>Boolean(tables.get(table)&&columns.every(column=>tables.get(table)!.has(column))));
    });
  }
  async inspectWork(chat:RegisteredChat):Promise<RuntimeWork|undefined>{
    return this.inspect(chat,async(sql,has)=>{
      const parts:string[]=[];
      const paused=has('app_state','paused')?"COALESCE((SELECT paused FROM app_state WHERE id=1),true)":'false';
      const add=(lane:RuntimeLane,table:string,columns:string[],at:string,where:string,busy='false')=>{
        if(has(table,...columns))parts.push(`SELECT '${lane}'::text AS lane,min(${at}) AS wake_at,COALESCE(bool_or(${busy}),false) AS busy FROM ${table} WHERE ${where}`);
      };
      add('conversation','inbox',['status','available_at'],"CASE WHEN status='pending' THEN available_at ELSE now() END","status IN ('pending','processing')",'true');
      add('conversation','action_work',['status','available_at'],"CASE WHEN status='pending' THEN available_at ELSE now() END","status IN ('pending','running')",'true');
      add('conversation','composition_runs',['phase','lease_until'],"COALESCE(lease_until,now())","phase='running'",'true');
      add('conversation','media_jobs',['status'],"now()","status IN ('queued','running')",'true');
      add('conversation','recurring_series',['status','next_check'],"next_check","status='active'");
      add('conversation','commitments',['phase','expires_at'],"expires_at","phase NOT IN ('completed','cancelled','expired','failed')");
      add('delivery','outbox',['kind','status','available_at'],"CASE WHEN status='pending' THEN available_at ELSE now() END","status IN ('pending','sending') AND kind NOT IN ('artifact','voice','image','animation','private_result','media_asset')",'true');
      add('media','outbox',['kind','status','available_at'],"CASE WHEN status='pending' THEN available_at ELSE now() END","status IN ('pending','sending') AND kind IN ('artifact','voice','image','animation','private_result','media_asset')",'true');
      add('media','attachments',['status','attempts'],"now()","status='processing' OR status='pending' AND attempts<2",'true');
      add('media','image_jobs',['status','cancelled'],"now()","status IN ('pending','processing') AND cancelled=false",'true');
      add('delivery','reminders',['status','due_at'],"due_at","status='pending'");
      add('delivery','scheduled_actions',['status','due_at','expires_at'],"CASE WHEN status='pending' THEN due_at ELSE expires_at END","status IN ('pending','awaiting_confirmation')");
      if(has('scheduled_actions','task_id','status')&&has('agent_tasks','id','status'))parts.push("SELECT 'delivery'::text AS lane,min(now()) AS wake_at,false AS busy FROM scheduled_actions a JOIN agent_tasks t ON t.id=a.task_id WHERE a.status IN ('dispatched','needs_input') AND (t.status='completed' OR t.status IN ('failed','needs_input') AND a.status<>'needs_input' OR t.status='cancelled')");
      add('delivery','activity_sessions',['phase','deadline'],"deadline","phase='collect' AND deadline IS NOT NULL");
      add('delivery','signals',['status','due_at','expires_at'],"LEAST(due_at,expires_at)","status='pending'");
      add('delivery','agent_tasks',['status','progress_at'],"COALESCE(progress_at+interval '45 seconds',now())","status IN ('pending','running','waiting','needs_input','delivering','verifying')");
      add('automation','agent_tasks',['status','available_at'],"CASE WHEN status='pending' THEN available_at ELSE now() END","status IN ('pending','running','verifying')",'true');
      add('automation','tool_approvals',['status','expires_at'],"CASE WHEN status IN ('approved','executing') THEN now() ELSE expires_at END","status IN ('pending','approved','executing')","status='executing'");
      add('automation','tool_connections',['enabled','health'],"now()","enabled=true AND health IN ('check_pending','checking')","health='checking'");
      add('automation','web_monitors',['status','next_check_at','expires_at'],"LEAST(next_check_at,expires_at)","status='active'");
      add('automation','oauth_setups',['status','next_poll'],"next_poll","status='pending'");
      if(has('calendar_connections','id','status','next_sync','last_window')&&has('calendar_mirrors','connection_id','status','next_check')&&has('calendar_operations','connection_id','status'))parts.push("SELECT 'automation'::text AS lane,min(c.next_sync) AS wake_at,false AS busy FROM calendar_connections c WHERE c.status='ready' AND (c.last_window IS NOT NULL OR EXISTS(SELECT 1 FROM calendar_mirrors m WHERE m.connection_id=c.id AND m.status='confirmed') OR EXISTS(SELECT 1 FROM calendar_operations o WHERE o.connection_id=c.id AND o.status IN ('uncertain','dispatching')))");
      add('automation','calendar_operations',['status'],"NULL::timestamptz","status='dispatching'",'true');
      add('automation','calendar_change_outbox',['delivered_at','next_attempt'],"next_attempt","delivered_at IS NULL");
      add('maintenance','private_requests',['status','expires_at'],"CASE WHEN status='revoked' THEN now() ELSE expires_at END",'true');
      add('maintenance','private_results',['expires_at'],"expires_at",'true');
      for(const table of ['resource_views','message_panels','research_cache','style_episodes','behavior_contributions','media_inspection_payloads'])add('maintenance',table,['expires_at'],"expires_at",`NOT (${paused})`);
      add('maintenance','inbox',['status','created_at','plan','payload'],"created_at+interval '1 day'",`NOT (${paused}) AND status='done' AND (plan IS NOT NULL OR payload ? 'message')`);
      if(has('outbox','status','canonical_message_id','telegram_id','body','created_at')&&has('messages','telegram_id','role','body','edited_at'))parts.push(`SELECT 'maintenance'::text AS lane,min(o.created_at+interval '1 day') AS wake_at,false AS busy FROM outbox o JOIN messages m ON m.telegram_id=o.telegram_id AND m.role='assistant' WHERE NOT (${paused}) AND o.status='sent' AND o.canonical_message_id IS NULL AND o.body->>'text'=m.body AND m.edited_at IS NULL`);
      add('conversation','media_garbage',['created_at'],"created_at",'true');
      if(has('app_state','summary_checked_at','paused')&&has('episodes','last_source_id')&&has('messages','role','id'))parts.push("SELECT 'maintenance'::text AS lane,CASE WHEN NOT (SELECT paused FROM app_state WHERE id=1) AND (SELECT count(*) FROM (SELECT id FROM messages WHERE role='user' AND id>COALESCE((SELECT max(last_source_id) FROM episodes),0) LIMIT 60) recent)>=60 THEN COALESCE((SELECT summary_checked_at+interval '1 hour' FROM app_state WHERE id=1),now()) END AS wake_at,false AS busy");
      if(!parts.length)return {chat,next:{},busy:false};
      const rows=(await sql.query(`SELECT lane,min(CASE WHEN ${paused} AND lane IN ('conversation','automation') THEN NULL ELSE wake_at END) AS wake_at,bool_or(busy) AS busy FROM (${parts.join(' UNION ALL ')}) jobs GROUP BY lane`)).rows;
      const next:RuntimeWork['next']={};let busy=false;
      for(const row of rows){if(row.wake_at)next[row.lane as RuntimeLane]=new Date(row.wake_at).getTime();busy ||= row.busy;}
      return {chat,next,busy};
    });
  }
  // Private replies and poll answers have no group id. Locate their durable
  // records first, so an evicted group's inbox still works without warming all
  // enabled groups or probing a disabled namespace.
  async privateChats(actor:string){
    const found:RegisteredChat[]=[];
    for(const chat of await this.list()){
      if(chat.chat_id===actor){found.push(chat);continue;}
      const match=await this.inspect(chat,async(sql,has)=>{
        const conditions:string[]=[];
        const add=(table:string,field:string,where='true')=>{if(has(table,field))conditions.push(`EXISTS(SELECT 1 FROM ${table} WHERE ${field}=$1 AND ${where})`);};
        add('private_requests','recipient_id',"status IN ('offered','answering','answered') AND expires_at>now()");
        add('connection_setups','actor_id',"status IN ('pending','awaiting_token') AND expires_at>now()");
        add('calendar_setups','owner_id',"status IN ('pending','choose_scope','awaiting_secret') AND expires_at>now()");
        add('calendar_shares','actor_id',"status<>'revoked'");
        add('oauth_setups','actor_id',"status IN ('offered','pending')");
        add('tool_approvals','actor_id',"audience='private' AND status='pending' AND expires_at>now()");
        add('resource_views','actor_id',"audience='private' AND expires_at>now()");
        return conditions.length?Boolean((await one(sql,`SELECT ${conditions.join(' OR ')} AS matched`,[actor]))?.matched):false;
      });
      if(match)found.push(chat);
    }
    return found;
  }
  async ingressPrivateTarget(sql:SQL,actor:string,reference?:PrivateIngressReference){
    const chats=(await sql.query<RegisteredChat>('SELECT * FROM public.lumen_chats WHERE enabled=true ORDER BY created_at')).rows;
    const definitions:Record<PrivateIngressKind,{table:string;actor:string;key:string}>={inbox:{table:'private_requests',actor:'recipient_id',key:'token'},connector:{table:'connection_setups',actor:'actor_id',key:'id'},calendar_setup:{table:'calendar_setups',actor:'owner_id',key:'id'},calendar_share:{table:'calendar_shares',actor:'actor_id',key:'token'},oauth:{table:'oauth_setups',actor:'actor_id',key:'id'},approval:{table:'tool_approvals',actor:'actor_id',key:'id'},view:{table:'resource_views',actor:'actor_id',key:'id'}};
    const priorities:PrivateIngressKind[]=['calendar_setup','calendar_share','connector','inbox'];
    let active:{chat:RegisteredChat;kind:PrivateIngressKind;priority:number}|undefined;
    for(const chat of chats){
      const tables=await this.tableColumns(sql,chat.schema_name),has=(table:string,...fields:string[])=>Boolean(tables.get(table)&&fields.every(field=>tables.get(table)!.has(field)));
      await sql.query(`SET LOCAL search_path TO "${checkedSchema(chat.schema_name)}", pg_catalog`);
      if(reference){
        const d=definitions[reference.kind];
        if(has(d.table,d.actor,d.key)&&await one(sql,`SELECT ${d.key} FROM ${d.table} WHERE ${d.actor}=$1 AND ${d.key}::text=$2 LIMIT 1`,[actor,reference.id]))return {chat,kind:reference.kind};
      }else{
        for(let priority=0;priority<(active?.priority??priorities.length);priority++){
          const kind=priorities[priority]!,d=definitions[kind];
          if(!has(d.table,d.actor,'status','expires_at'))continue;
          const status=kind==='calendar_setup'?'awaiting_secret':kind==='calendar_share'?'manual_input':kind==='connector'?'awaiting_token':'answering';
          const where=kind==='calendar_share'&&has('calendar_proposals','id','expires_at')?'EXISTS(SELECT 1 FROM calendar_proposals p WHERE p.id=calendar_shares.proposal_id AND p.expires_at>now())':'expires_at>now()';
          if(await one(sql,`SELECT 1 FROM ${d.table} WHERE ${d.actor}=$1 AND status=$2 AND ${where} LIMIT 1`,[actor,status])){active={chat,kind,priority};break;}
        }
        if(active?.priority===0)return active;
      }
    }
    return active;
  }
  async privateTarget(actor:string,reference:PrivateIngressReference){return this.root.tx(sql=>this.ingressPrivateTarget(sql,actor,reference));}
  async ingressPollTargets(sql:SQL,pollId:string){
    const found:string[]=[];
    for(const chat of (await sql.query<RegisteredChat>('SELECT * FROM public.lumen_chats WHERE enabled=true ORDER BY created_at')).rows){
      if(!(await this.tableColumns(sql,chat.schema_name)).get('polls')?.has('poll_id'))continue;
      await sql.query(`SET LOCAL search_path TO "${checkedSchema(chat.schema_name)}", pg_catalog`);
      if(await one(sql,'SELECT poll_id FROM polls WHERE poll_id=$1 LIMIT 1',[pollId]))found.push(chat.chat_id);
    }
    return found;
  }
  async ingressStale(scopes:readonly string[],enqueuedAt:string,allowDisabled=false){
    for(const id of scopes){
      const chat=await this.find(id);if(!chat)continue;if(!chat.enabled){if(allowDisabled)continue;return true;}
      const stale=await this.inspect(chat,async(sql,has)=>has('app_state','ingress_after')&&Boolean((await one(sql,'SELECT $1::timestamptz<ingress_after AS stale FROM app_state WHERE id=1',[enqueuedAt]))?.stale));
      if(stale===undefined||stale)return true;
    }
    return false;
  }
  async suspendPrivatePurposes(actor:string,except?:string,purpose?:'inbox'|'calendar_setup'|'calendar_share'|'connector'){
    for(const chat of await this.list())await this.inspect(chat,async(sql,has)=>{
      if((chat.chat_id!==except||purpose!=='inbox')&&has('private_requests','recipient_id','status'))await sql.query("UPDATE private_requests SET status='offered' WHERE recipient_id=$1 AND status='answering'",[actor]);
      if((chat.chat_id!==except||purpose!=='connector')&&has('connection_setups','actor_id','status'))await sql.query("UPDATE connection_setups SET status='pending' WHERE actor_id=$1 AND status='awaiting_token'",[actor]);
      if((chat.chat_id!==except||purpose!=='calendar_setup')&&has('calendar_setups','owner_id','status'))await sql.query("UPDATE calendar_setups SET status='pending' WHERE owner_id=$1 AND status IN ('choose_scope','awaiting_secret')",[actor]);
      if((chat.chat_id!==except||purpose!=='calendar_share')&&has('calendar_shares','actor_id','status'))await sql.query("UPDATE calendar_shares SET status='waiting' WHERE actor_id=$1 AND status='manual_input'",[actor]);
    });
  }
  async pollChats(pollId:string){return this.matching('polls','poll_id',pollId);}
  async memberChats(actor:string){return this.matching('members','user_id',actor,'active=true');}
  private async matching(table:string,field:string,value:string,where='true'){
    const found:RegisteredChat[]=[];
    for(const chat of await this.list())if(await this.inspect(chat,async(sql,has)=>has(table,field)&&Boolean(await one(sql,`SELECT ${field} FROM ${table} WHERE ${field}=$1 AND ${where} LIMIT 1`,[value]))))found.push(chat);
    return found;
  }
  async disable(chatId:string){await this.root.query('UPDATE public.lumen_chats SET enabled=false WHERE chat_id=$1',[chatId]);}
  async migrateChat(oldId:string,newId:string){
    if(!/^-?\d+$/.test(newId))throw new Error('invalid_chat_id');
    await this.root.tx(async sql=>{
      const chat=await one(sql,'SELECT * FROM public.lumen_chats WHERE chat_id=$1 FOR UPDATE',[oldId]);
      if(!chat)return;
      if(await one(sql,'SELECT chat_id FROM public.lumen_chats WHERE chat_id=$1',[newId]))throw new Error('chat_migration_conflict');
      await sql.query('UPDATE public.lumen_chats SET chat_id=$2 WHERE chat_id=$1',[oldId,newId]);
      if(!chat.enabled){this.prepared.delete(chat.schema_name);return;}
      await sql.query(`SET LOCAL search_path TO "${checkedSchema(chat.schema_name)}", pg_catalog`);
      await sql.query('UPDATE app_state SET chat_id=$1 WHERE id=1',[newId]);
    });
  }
}
