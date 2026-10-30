import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {one,state,queueText,type Database,type SQL} from './db.js';
import {BrowseQuery,assetFor} from './media-assets.js';
import {MediaWorkshop,collectionFor} from './media-workshop.js';
import {ToolError} from './safe-http.js';
import {digest} from './evolution-core.js';
import {GAME_NAMES,publicGame} from './games.js';
import {ACTIVITY_TEMPLATES} from './session-engine.js';
import {GameResults,gameResultSources} from './game-results.js';
import type {ToolContext} from './agent-tools.js';
import type {CallbackQuery,Telegram} from './telegram.js';
const labels={materials:'Матеріали',collections:'Альбоми',studio:'Історії',events:'Події',games:'Ігри',statistics:'Статистика'};
const terminal=(status:string)=>status==='completed'||status==='cancelled';
const statuses:Record<string,string>={available:'Доступно',active:'Триває',lobby:'Приєднання учасників',collect:'Збір відповідей',between_rounds:'Між раундами',completed:'Завершено',cancelled:'Скасовано',planning:'Планування',agreed:'Погоджено',saved:'Збережено'};
const currentSources=`SELECT 'games'::text AS source_kind,id::text AS source_key,topic_id,status FROM games UNION ALL SELECT 'activity_sessions',id::text,topic_id,phase FROM activity_sessions`;
export const RelatedQuery=z.object({resource_kind:z.enum(['event','game','session','collection','project']),resource_id:z.string().min(1).max(100),after_asset_id:z.string().uuid().optional(),limit:z.number().int().min(1).max(12).default(8)});
type Related=z.infer<typeof RelatedQuery>;
type ReadRef={kind:'asset'|'artifact'|'attachment'|'collection'|'studio'|'event'|'project'|'game'|'session';id:string};
export class MediaBrowser {
 constructor(private db:Database,private media:MediaWorkshop){}
 private async snapshot(sql:SQL,c:ToolContext){const live=await state(sql,true);if(live.paused||live.memory_revision!==c.revision)throw new ToolError('context_changed');}
 private async access(c:ToolContext,telegram?:Telegram){
  const live=await state(this.db);if(live.paused||live.memory_revision!==c.revision)throw new ToolError('context_changed');
  if(Number(live.chat_id)<0){
   if(String(live.chat_id)!==c.chatId&&!(c.audience==='private'&&c.chatId===c.actorId))throw new ToolError('other_chat');
   const member=await one(this.db,'SELECT active FROM members WHERE user_id=$1',[c.actorId]);
   if(member?.active===false||!member&&live.owner_id!==c.actorId&&!(live.participants||[]).some((p:any)=>String(p.id)===c.actorId))throw new ToolError('member_required');
   if(telegram){const current=await telegram.call('getChatMember',{chat_id:live.chat_id,user_id:Number(c.actorId)});if(!['creator','administrator','member'].includes(current?.status)&&!(current?.status==='restricted'&&current.is_member===true))throw new ToolError('member_required');}
  }else if(!live.chat_id||String(live.chat_id)!==c.actorId||String(live.chat_id)!==c.chatId)throw new ToolError('owner_required');
  return live;
 }
 private async readSources(refs:ReadRef[],extra:unknown[]=[]){
  const sources=extra.map(Number),games=refs.filter(r=>r.kind==='game'||r.kind==='session').map(r=>({source_kind:r.kind==='game'?'games' as const:'activity_sessions' as const,source_key:r.id}));sources.push(...await gameResultSources(this.db,games));
  const tables={asset:['media_assets','media_asset'],artifact:['agent_artifacts','artifact'],attachment:['attachments',''],collection:['archive_collections','collection'],studio:['studio_projects','studio'],event:['group_events','event'],project:['projects','project']} as const;
  for(const [kind,[table,provenance]] of Object.entries(tables)){const ids=[...new Set(refs.filter(r=>r.kind===kind).map(r=>r.id))];if(!ids.length)continue;const rows=(await this.db.query(`SELECT source_message_id AS source FROM ${table} WHERE id::text=ANY($1::text[]) ${kind==='asset'?'UNION ALL SELECT audience_source_id FROM media_assets WHERE id::text=ANY($1::text[])':''} ${provenance?'UNION ALL SELECT source_message_id FROM provenance_edges WHERE derived_kind=$2 AND derived_key=ANY($1::text[])':''}`,provenance?[ids,provenance]:[ids])).rows;sources.push(...rows.map(r=>Number(r.source)));}
  const ids=[...new Set(sources.filter(id=>Number.isSafeInteger(id)&&id>0))];return ids.length?(await this.db.query('SELECT id FROM messages WHERE id=ANY($1::bigint[]) ORDER BY id',[ids])).rows.map(r=>Number(r.id)):[];
 }
 private async relatedParent(a:Related,c:ToolContext){
  let row:any;
  if(a.resource_kind==='collection'){row=await collectionFor(this.db,a.resource_id,c);if(row.topic_id!==c.topicId)throw new ToolError('resource_unavailable');}
  else if(a.resource_kind==='game')row=await one(this.db,"SELECT g.id::text,g.topic_id,COALESCE(NULLIF(g.state->>'title',''),$3::jsonb->>g.kind,g.kind) AS title,g.status,COALESCE(o.version,1) AS version,g.state->'players' AS participants FROM games g LEFT JOIN canonical_outcomes o ON o.source_kind='games' AND o.source_key=g.id::text WHERE g.id::text=$1 AND g.topic_id=$2",[a.resource_id,c.topicId,JSON.stringify(GAME_NAMES)]);
  else{const table={event:'group_events',session:'activity_sessions',project:'projects'}[a.resource_kind];row=await one(this.db,`SELECT id::text,title,topic_id,version,${a.resource_kind==='session'?'phase':'status'} AS status${a.resource_kind==='event'?",details->'participants' AS participants":''} FROM ${table} WHERE id::text=$1 AND topic_id=$2`,[a.resource_id,c.topicId]);}
  if(!row)throw new ToolError('resource_unavailable');
  let participants:any[]|undefined;
  if(a.resource_kind==='session')participants=(await this.db.query('SELECT user_id AS id,name,status FROM activity_players WHERE session_id::text=$1 ORDER BY user_id',[a.resource_id])).rows;
  else if(Array.isArray(row.participants)){
   const ids=row.participants.map((p:any)=>typeof p==='string'?p:p?.id||p?.user_id).filter((id:any)=>typeof id==='string'),members=ids.length?(await this.db.query('SELECT user_id,name FROM members WHERE user_id=ANY($1::text[])',[ids])).rows:[],names=new Map(members.map(m=>[m.user_id,m.name]));
   participants=row.participants.map((p:any)=>typeof p==='string'?{id:p,name:names.get(p)||p}:{id:typeof p?.id==='string'?p.id:typeof p?.user_id==='string'?p.user_id:undefined,name:typeof p?.name==='string'?p.name:names.get(p?.id||p?.user_id)}).filter((p:any)=>p.id||p.name);
  }
  return {kind:a.resource_kind,id:a.resource_id,title:row.title,version:row.version,status:row.status||'saved',participants,participants_source:a.resource_kind==='event'?'explicit_event_details':participants?'canonical_game_roster':undefined,attendance:'not_inferred',source_ids:await this.readSources([{kind:a.resource_kind,id:a.resource_id}])};
 }
 private async relatedData(input:Related,c:ToolContext){
  const a=RelatedQuery.parse(input);await this.access(c);const resource=await this.relatedParent(a,c),rows=(await this.db.query(`SELECT m.id::text,m.title,m.version,m.mime,m.bytes,m.status,'asset'::text AS source_type,l.resource_version AS bound_resource_version FROM resource_links l JOIN media_assets m ON m.id=l.asset_id AND m.version=l.asset_version AND m.status='available' WHERE l.resource_kind=$1 AND l.resource_id=$2 AND m.topic_id=$3 AND (m.audience='group' OR ($4::boolean AND m.owner_id=$5)) AND ($6::text IS NULL OR m.id::text>$6) ORDER BY m.id::text LIMIT $7`,[a.resource_kind,a.resource_id,c.topicId,c.audience==='private'||Number(c.chatId)>0,c.actorId,a.after_asset_id||null,a.limit+1])).rows;
  const items=rows.slice(0,a.limit).map(r=>({id:r.id,title:r.title,version:r.version,mime:r.mime,bytes:r.bytes,status:r.status,source_type:'asset',bound_resource_version:r.bound_resource_version,current_resource_version:resource.version}));return {section:'materials',title:'Матеріали: '+resource.title,resource,items,next:rows.length>a.limit?rows[a.limit-1]!.id:undefined,empty:!rows.length,source_ids:await this.readSources(items.map(r=>({kind:'asset',id:r.id})),resource.source_ids)};
 }
 private async relatedView(a:Related,r:any,c:ToolContext,sql?:SQL):Promise<string>{if(!sql)return this.db.tx(async tx=>{await this.snapshot(tx,c);return this.relatedView(a,r,c,tx);});const id=randomUUID();await sql.query('INSERT INTO resource_views(id,actor_id,topic_id,audience,revision,query,refs) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,c.actorId,c.topicId,c.audience||'group',c.revision,JSON.stringify({section:'materials',related_query:a,next_asset_id:r.next}),JSON.stringify(r.items.map((x:any)=>({id:x.id,version:x.version,type:'asset',link:{resource_kind:a.resource_kind,resource_id:a.resource_id,bound_resource_version:x.bound_resource_version}})))]);return id;}
 async related(input:Related,c:ToolContext){const a=RelatedQuery.parse(input),r=await this.relatedData(a,c);return this.db.tx(async sql=>{await this.snapshot(sql,c);const id=await this.relatedView(a,r,c,sql);await queueText(sql,this.listText(r),c.revision,'related:'+id,false,{actorId:c.actorId,audience:c.audience,threadId:c.topicId==='0'?undefined:Number(c.topicId),sourceMessageId:c.sourceId,sourceIds:r.source_ids,replyMarkup:this.buttons(id,r)});return {...r,view_id:id};});}
 private async verifyLink(ref:any,c:ToolContext){const a=RelatedQuery.parse(ref.link),parent=await this.relatedParent(a,c);const row=await one(this.db,"SELECT m.id FROM resource_links l JOIN media_assets m ON m.id=l.asset_id AND m.version=l.asset_version AND m.status='available' WHERE l.resource_kind=$1 AND l.resource_id=$2 AND l.resource_version=$3 AND l.asset_id=$4 AND l.asset_version=$5 AND m.topic_id=$6 AND (m.audience='group' OR $7::boolean AND m.owner_id=$8)",[a.resource_kind,a.resource_id,ref.link.bound_resource_version,ref.id,ref.version,c.topicId,c.audience==='private'||Number(c.chatId)>0,c.actorId]);if(!row)throw new ToolError('linked_material_unavailable');return parent.source_ids;}
 async browse(a:z.infer<typeof BrowseQuery>,c:ToolContext):Promise<any>{
  if(a.section==='statistics')return this.statistics(a,c);
  await this.access(c);
  if(a.section==='materials')return this.materials(a,c);
  if(a.section==='games')return this.games(a,c);
  const privateAllowed=c.audience==='private'||Number(c.chatId)>0;
  const table={collections:'archive_collections',studio:'studio_projects',events:'group_events'}[a.section];
  const media=['collections','studio'].includes(a.section),status=a.section==='events'?'status':"'saved'";
  const rows=(await this.db.query(`SELECT id::text,title,${status} AS status,version,created_at,created_at::text AS cursor_at${media?',audience,owner_id':''} FROM ${table} WHERE topic_id=$1 AND ($2::boolean OR $3::text IS NOT NULL) ${media?"AND (audience='group' OR ($2 AND owner_id=$3))":''}  AND ($4='' OR strpos(lower(title),lower($4))>0) AND ($5::timestamptz IS NULL OR created_at>=$5) AND ($6::timestamptz IS NULL OR created_at<$6) ${a.cursor?'AND (created_at,id::text)<($7::timestamptz,$8)':''} ORDER BY created_at DESC,id DESC LIMIT ${a.limit+1}`,[c.topicId,privateAllowed,c.actorId,a.query,a.since||null,a.until||null,...(a.cursor?this.cursor(a.cursor):[])])).rows;
  const items=rows.slice(0,a.limit);return {section:a.section,title:labels[a.section],items,next:rows.length>a.limit?Buffer.from(JSON.stringify([items.at(-1)!.cursor_at,items.at(-1)!.id])).toString('base64url'):undefined,empty:!items.length,notice:!items.length?'Поки немає доступних результатів за цими умовами.':undefined,source_ids:await this.readSources(items.map(r=>({kind:a.section==='collections'?'collection':a.section==='studio'?'studio':'event',id:r.id})))};
 }
 private async games(a:z.infer<typeof BrowseQuery>,c:ToolContext){
  const rows=(await this.db.query(`SELECT r.*,created_at::text AS cursor_at FROM (
   SELECT 'game:'||g.id::text AS id,'game'::text AS source_type,g.id::text AS source_key,'legacy'::text AS engine,g.kind AS template,COALESCE(NULLIF(g.state->>'title',''),$8::jsonb->>g.kind,g.kind) AS title,g.status,COALESCE(o.version,1) AS version,g.created_at,g.topic_id FROM games g LEFT JOIN canonical_outcomes o ON o.source_kind='games' AND o.source_key=g.id::text
   UNION ALL SELECT 'session:'||s.id::text,'activity_session',s.id::text,'session',s.template,s.title,s.phase,s.version,s.created_at,s.topic_id FROM activity_sessions s
  ) r WHERE topic_id=$1 AND ($2='' OR strpos(lower(title),lower($2))>0) AND ($3::timestamptz IS NULL OR created_at>=$3) AND ($4::timestamptz IS NULL OR created_at<$4) AND ($5::timestamptz IS NULL OR (created_at,id)<($5::timestamptz,$6::text)) ORDER BY created_at DESC,id DESC LIMIT $7`,[c.topicId,a.query,a.since||null,a.until||null,...(a.cursor?this.cursor(a.cursor):[null,'']),a.limit+1,JSON.stringify(GAME_NAMES)])).rows;
  const items=rows.slice(0,a.limit);return {section:'games',title:labels.games,items,next:rows.length>a.limit?Buffer.from(JSON.stringify([items.at(-1)!.cursor_at,items.at(-1)!.id])).toString('base64url'):undefined,empty:!items.length,source_ids:await this.readSources(items.map(r=>({kind:r.source_type==='game'?'game':'session',id:r.source_key})))};
 }
 private async materials(a:z.infer<typeof BrowseQuery>,c:ToolContext){
  const rows=(await this.db.query(`SELECT r.*,created_at::text AS cursor_at FROM (
   SELECT id::text AS id,'asset'::text AS source_type,title,status,version,mime,bytes::bigint,created_at,topic_id FROM media_assets WHERE status='available' AND (audience='group' OR ($2::boolean AND owner_id=$3))
   UNION ALL SELECT 'artifact:'||a.id::text,'artifact',a.name,'saved',a.revision,a.mime,octet_length(a.content)::bigint,a.created_at,a.topic_id FROM agent_artifacts a WHERE a.actor_id=$3 AND a.revision=$9 AND ($2::boolean OR NOT EXISTS(SELECT 1 FROM outbox o WHERE o.body->>'id'=a.id::text AND o.audience='private'))
   UNION ALL SELECT 'attachment:'||a.id::text,'attachment',COALESCE(NULLIF(a.metadata->>'file_name',''),NULLIF(left(a.description,100),''),CASE WHEN a.kind='document' THEN 'Файл від ' ELSE 'Медіа від ' END||m.author),'telegram_original',a.revision,a.mime,0::bigint,m.created_at,a.topic_id FROM attachments a JOIN messages m ON m.id=a.source_message_id WHERE a.revision=$9 AND a.kind<>'generated'
  ) r WHERE topic_id=$1 AND ($4='' OR strpos(lower(title),lower($4))>0) AND ($5::timestamptz IS NULL OR created_at>=$5) AND ($6::timestamptz IS NULL OR created_at<$6) AND ($7::timestamptz IS NULL OR (created_at,id)<($7::timestamptz,$8::text)) ORDER BY created_at DESC,id DESC LIMIT $10`,[c.topicId,c.audience==='private'||Number(c.chatId)>0,c.actorId,a.query,a.since||null,a.until||null,...(a.cursor?this.cursor(a.cursor):[null,'']),c.revision,a.limit+1])).rows;
  const items=rows.slice(0,a.limit);return {section:'materials',title:labels.materials,items,next:rows.length>a.limit?Buffer.from(JSON.stringify([items.at(-1)!.cursor_at,items.at(-1)!.id])).toString('base64url'):undefined,empty:!items.length,source_ids:await this.readSources(items.map(r=>({kind:r.source_type,id:r.id.replace(/^(artifact|attachment):/,'')})))};
 }
 private async material(ref:any,c:ToolContext,send:boolean,callbackId:string):Promise<any>{
  if(ref.type==='artifact'){
   const id=ref.id.replace(/^artifact:/,''),row=await one(this.db,'SELECT id,name,mime,revision,source_message_id FROM agent_artifacts WHERE id=$1 AND actor_id=$2 AND topic_id=$3 AND revision=$4',[id,c.actorId,c.topicId,c.revision]);if(!row||row.revision!==ref.version)throw new ToolError('view_stale');
   const privateSource=await one(this.db,"SELECT id FROM outbox WHERE body->>'id'=$1 AND audience='private' LIMIT 1",[id]);if(privateSource&&c.audience!=='private'&&Number(c.chatId)<0)throw new ToolError('private_input_cannot_widen_audience');
   if(send){await this.db.tx(async sql=>{const live=await state(sql,true);if(live.paused||live.memory_revision!==c.revision)throw new ToolError('task_cancelled');const out=await one(sql,"INSERT INTO outbox(dedup_key,kind,body,revision,actor_id,audience,source_message_id) VALUES($1,'artifact',$2,$3,$4,'private',$5) ON CONFLICT DO NOTHING RETURNING id",['download:'+callbackId,JSON.stringify({id}),c.revision,c.actorId,row.source_message_id]);if(out)await import('./provenance.js').then(p=>p.transferProvenance(sql,'artifact',id,'outbox',out.id));});return {queued:true};}
   return {id,title:row.name,mime:row.mime,status:'Збережений файл',notice:'Оригінал створеного документа. Отримати його можна кнопкою нижче.',source_ids:await this.readSources([{kind:'artifact',id}])};
  }
  let id=ref.id,version=ref.version;
  if(ref.type==='attachment'){
   const attachment=await one(this.db,'SELECT a.revision,a.metadata,a.kind FROM attachments a JOIN messages m ON m.id=a.source_message_id WHERE a.id=$1 AND a.topic_id=$2 AND m.topic_id=$2 AND a.revision=$3',[id.replace(/^attachment:/,''),c.topicId,c.revision]);if(!attachment||attachment.revision!==version)throw new ToolError('view_stale');
   if(!send)return {title:attachment.metadata?.file_name||'Вкладення з розмови',status:'Оригінал у Telegram',notice:'За запитом збережу доступні байти й надішлю особисто. Якщо Telegram більше не надає оригінал, повідомлю про це.',source_ids:await this.readSources([{kind:'attachment',id:id.replace(/^attachment:/,'')}])};
   const captured=await this.media.run({operation:'capture',attachment_id:Number(id.replace(/^attachment:/,'')),caption:''},{...c,audience:Number(c.chatId)<0?'group':'private'});id=captured.id;version=captured.version;
  }
  const a=await assetFor(this.db,id,version,c);if(a.topic_id!==c.topicId)throw new ToolError('asset_unavailable');if(send){await this.media.run({operation:'publish',id:a.id,version:a.version,caption:a.title},{...c,audience:'private',operationKey:'download:'+callbackId});return {queued:true};}
  return {id:a.id,title:a.title,version:a.version,mime:a.mime,bytes:a.bytes,status:a.status,notice:'Публікацію в окремому каналі погоджує власник конкретної версії.',source_ids:await this.readSources([{kind:'asset',id:a.id}])};
 }
 private cursor(raw:string){try{const v=JSON.parse(Buffer.from(raw,'base64url').toString());if(!Array.isArray(v)||v.length!==2||typeof v[0]!=='string'||v[0].length>80||!Number.isFinite(Date.parse(v[0]))||typeof v[1]!=='string'||v[1].length>100)throw 0;return v;}catch{throw new ToolError('browse_cursor_invalid');}}
 async open(a:z.infer<typeof BrowseQuery>,c:ToolContext){const result=await this.browse(a,c);return this.db.tx(async sql=>{await this.snapshot(sql,c);if(a.section==='statistics'){await queueText(sql,this.statsText(result),c.revision,'stats:'+c.updateId,false,{actorId:c.actorId,audience:c.audience,threadId:c.topicId==='0'?undefined:Number(c.topicId),sourceMessageId:c.sourceId,sourceIds:result.source_ids});return result;}
  const id=randomUUID();await sql.query('INSERT INTO resource_views(id,actor_id,topic_id,audience,revision,query,refs) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,c.actorId,c.topicId,c.audience||'group',c.revision,JSON.stringify({...a,next_cursor:result.next}),JSON.stringify(result.items.map((x:any)=>({id:x.id,version:x.version,type:x.source_type})))]);
  await queueText(sql,this.listText(result),c.revision,'browse:'+id,false,{actorId:c.actorId,audience:c.audience,threadId:c.topicId==='0'?undefined:Number(c.topicId),sourceMessageId:c.sourceId,sourceIds:result.source_ids,replyMarkup:this.buttons(id,result)});return {...result,view_id:id};});
 }
 private listText(r:any){return `${r.title}\n\n`+(r.items.length?r.items.map((x:any,i:number)=>`${i+1}. ${x.title} · ${statuses[x.status]||x.status}${x.mime?' · '+x.mime:''}${x.bound_resource_version!==undefined?' · прив’язано до редакції '+x.bound_resource_version+'; поточна '+x.current_resource_version:''}`).join('\n'):'Поки немає доступних результатів за цими умовами.');}
 private buttons(id:string,r:any){return {inline_keyboard:[...r.items.map((x:any,i:number)=>[{text:'Відкрити '+String(i+1)+': '+x.title.slice(0,40),callback_data:`lm:${id}:${i}`}]),...(r.next?[[{text:'Наступні результати',callback_data:`lm:${id}:next`}]]:[]),[{text:'Оновити',callback_data:`lm:${id}:refresh`}]]};}
 async callback(cb:CallbackQuery,telegram:Telegram){const match=/^lm:([a-f0-9-]{36}):(\d+|send_\d+|next|refresh)$/.exec(cb.data||'');if(!match)return false;const v=await one(this.db,'SELECT * FROM resource_views WHERE id=$1',[match[1]]);if(!v)return false;const s=await state(this.db),actor=String(cb.from.id),privateScope=v.audience==='private';if(privateScope&&v.actor_id!==actor||!privateScope&&v.topic_id!==String(cb.message?.message_thread_id||0)||String(cb.message?.chat.id)!==(privateScope?actor:String(s.chat_id)))return false;const recipient=privateScope?actor:String(s.chat_id);if(s.paused||s.memory_revision!==v.revision||new Date(v.expires_at).getTime()<=Date.now()){await telegram.text(actor,'Цей перегляд застарів. Попроси відкрити актуальний розділ.');return true;}
  const c:ToolContext={actorId:actor,chatId:String(s.chat_id),topicId:v.topic_id,revision:s.memory_revision,updateId:cb.id,requested:true,audience:v.audience};const q=BrowseQuery.parse(v.query);
  try{await this.access(c,telegram);}catch{await telegram.text(actor,'Цей перегляд більше недоступний.');return true;}
  if(match[2]==='refresh'||match[2]==='next'){if(v.query.related_query){if(match[2]==='next'&&!v.query.next_asset_id)return true;return Boolean(await this.related(RelatedQuery.parse({...v.query.related_query,after_asset_id:match[2]==='next'?v.query.next_asset_id:undefined}),c));}if(match[2]==='next'&&!v.query.next_cursor)return true;return Boolean(await this.open(BrowseQuery.parse({...q,cursor:match[2]==='next'?v.query.next_cursor:undefined}),c));}
  const send=match[2]!.startsWith('send_'),index=Number(send?match[2]!.slice(5):match[2]);const ref=v.refs[index];if(!ref)return true;let data:any;
  try{if(q.section==='materials'){const linkSources=ref.link?await this.verifyLink(ref,c):[];data=await this.material(ref,{...c,sourceIds:[...(c.sourceIds||[]),...linkSources]},send,cb.id);if(send)return true;data.source_ids=[...new Set([...(data.source_ids||[]),...linkSources])];}
  else if(q.section==='collections'||q.section==='studio'){const row=await collectionFor(this.db,ref.id,c,q.section==='studio');if(row.version!==ref.version)throw new ToolError('view_stale');data=q.section==='collections'?await this.media.collection({operation:'read',id:ref.id},c):await this.media.studio({operation:'read',id:ref.id},c);const items=data.items||data.scenes||[];data.source_ids=await this.readSources([{kind:q.section==='collections'?'collection':'studio',id:ref.id},...items.map((x:any)=>({kind:'asset' as const,id:x.asset_id}))],items.flatMap((x:any)=>[x.source_message_id,x.caption_source_id,...Object.values(x.field_sources||{})]));}
  else if(q.section==='games')data=await this.game(ref,c);
  else if(q.section==='events')data=await this.event(ref,c);
  else throw new ToolError('view_stale');
  }catch{await telegram.text(actor,'Матеріал змінився або став недоступним. Онови перелік.');return true;}
  let linkedButtons:any;const kind=q.section==='events'?'event':q.section==='collections'?'collection':q.section==='games'?ref.type==='game'?'game':'session':undefined;
  if(kind){const relatedQuery=RelatedQuery.parse({resource_kind:kind,resource_id:kind==='game'?ref.id.slice(5):kind==='session'?ref.id.slice(8):ref.id}),linked=await this.relatedData(relatedQuery,c);data.linked_materials=linked.items;data.source_ids=[...new Set([...(data.source_ids||[]),...linked.source_ids])];if(linked.items.length)linkedButtons=this.buttons(await this.relatedView(relatedQuery,linked,c),linked);}
  const text=this.detail(data);if(q.section==='materials'){await telegram.call('sendMessage',{chat_id:recipient,text,reply_markup:{inline_keyboard:[[{text:'Отримати файл особисто',callback_data:`lm:${v.id}:send_${index}`}]]},...(Number(recipient)<0?{ephemeral_message_parameters:{receiver_user_id:Number(actor),callback_query_id:cb.id}}:{})});return true;}try{await telegram.call('sendRichMessage',{chat_id:recipient,_lumen_actor_id:actor,...(Number(recipient)<0?{ephemeral_message_parameters:{receiver_user_id:Number(actor),callback_query_id:cb.id}}:{}),rich_message:{html:`<h3>${escape(data.title||'Матеріал')}</h3><details open><summary>Подробиці</summary><p>${escape(text).replace(/\n/g,'<br>')}</p></details>`},...(linkedButtons?{reply_markup:linkedButtons}:{}),...(v.topic_id!=='0'&&!privateScope?{message_thread_id:Number(v.topic_id)}:{})});}catch(e:any){if(e?.uncertain||!['telegram_400','telegram_404'].includes(e?.code))throw e;await telegram.text(actor,text,{replyMarkup:linkedButtons});}return true;
 }
 private async game(ref:any,c:ToolContext){
  if(ref.type==='game'&&/^game:\d+$/.test(ref.id)){
   const row=await one(this.db,"SELECT g.id,g.kind,g.state,g.status,COALESCE(o.version,1) AS version FROM games g LEFT JOIN canonical_outcomes o ON o.source_kind='games' AND o.source_key=g.id::text WHERE g.id=$1 AND g.topic_id=$2",[ref.id.slice(5),c.topicId]);
   if(!row||row.version!==ref.version)throw new ToolError('view_stale');
   // publicGame strips the engine's secrets. Project its public fields explicitly:
   // old or custom states may also contain fields this browser must never expose.
   const raw=row.state&&typeof row.state==='object'?row.state:{},view=publicGame({...row,state:{...raw,players:Array.isArray(raw.players)?raw.players:[],scores:raw.scores&&typeof raw.scores==='object'?raw.scores:{},segments:Array.isArray(raw.segments)?raw.segments:[]}},c.actorId);
   const players=view.players.filter((p:any)=>p&&typeof p.name==='string'),result=await new GameResults(this.db).run({operation:'read',source_kind:'games',source_key:ref.id.slice(5)},c);
   return {id:ref.id,title:typeof view.title==='string'?view.title:GAME_NAMES[row.kind]||row.kind,status:row.status,version:row.version,corrections:result.corrections,participants:result.participants,source_ids:result.source_ids,details:compact({
    'Формат':GAME_NAMES[row.kind]||row.kind,'Учасники':players.map((p:any)=>p.name).join(', '),'Кількість учасників':view.players_total,
    'Раунд':Number.isInteger(view.round)?view.round+1:undefined,'Ходів':Number.isInteger(view.turn)?view.turn:undefined,
    'Тема':typeof view.topic==='string'?view.topic:undefined,'Правила':typeof view.rules==='string'?view.rules:undefined,
    'Історія':view.segments.filter((x:any)=>typeof x==='string').join('\n'),
    'Бали партії':row.status==='completed'?players.map((p:any)=>`${p.name}: ${Number(view.scores[p.id])||0}`).join(' · '):undefined
   })};
  }
  if(ref.type!=='activity_session'||!/^session:[a-f0-9-]{36}$/.test(ref.id))throw new ToolError('view_stale');
  const row=await one(this.db,'SELECT id,title,template,phase,round,max_rounds,version,public_state,deadline FROM activity_sessions WHERE id=$1 AND topic_id=$2',[ref.id.slice(8),c.topicId]);if(!row||row.version!==ref.version)throw new ToolError('view_stale');
  const players=(await this.db.query('SELECT name,score,status FROM activity_players WHERE session_id=$1 ORDER BY user_id',[row.id])).rows,publicState=row.public_state||{},last=publicState.last_round,result=await new GameResults(this.db).run({operation:'read',source_kind:'activity_sessions',source_key:row.id},c);
  return {id:ref.id,title:row.title,status:row.phase,version:row.version,corrections:result.corrections,participants:result.participants,source_ids:result.source_ids,notice:'Приватні ролі, підказки й відповіді учасників приховано.',details:compact({
   'Версія результату':result.version,
   'Формат':ACTIVITY_TEMPLATES[row.template as keyof typeof ACTIVITY_TEMPLATES]||row.template,'Раунд':`${row.round} із ${row.max_rounds}`,
   'Учасники':players.map(p=>p.name+(p.status==='left'?' (вийшов/вийшла)':'')).join(', '),
   'Бали партії':row.phase==='completed'?players.map(p=>`${p.name}: ${p.score}`).join(' · '):undefined,
   'Відповідей в останньому раунді':Number.isInteger(last?.received)&&Number.isInteger(last?.expected)?`${last.received} із ${last.expected}`:undefined,
   'Завершення':row.phase==='completed'&&typeof publicState.ending==='string'?publicState.ending:undefined,
   'Історія':Array.isArray(publicState.story)?publicState.story.map((x:any)=>typeof x==='string'?x:typeof x?.text==='string'?x.text:'').filter(Boolean).join('\n'):undefined,
   'Кінець раунду':row.deadline?new Date(row.deadline).toISOString():undefined
  })};
 }
 private async event(ref:any,c:ToolContext){
  const row=await one(this.db,'SELECT id,title,status,version,details FROM group_events WHERE id=$1 AND topic_id=$2',[ref.id,c.topicId]);if(!row||row.version!==ref.version)throw new ToolError('view_stale');
  const d=row.details||{},details:Record<string,string>={};
  for(const [label,keys] of [
   ['Початок',['start_at','starts_at','start','date']],['Завершення',['end_at','ends_at','end']],['Часовий пояс',['timezone']],
   ['Місце',['location','place']],['Опис',['description','summary']],['План',['agenda','plan']],['Примітки',['notes']],['Бюджет',['budget']]
  ] as const){const value=keys.map(key=>d[key]).find(v=>typeof v==='string'||typeof v==='number');if(value!==undefined)details[label]=String(value);}
  if(d.budget&&typeof d.budget==='object'&&(typeof d.budget.amount==='number'||typeof d.budget.amount==='string'))details['Бюджет']=[d.budget.amount,typeof d.budget.currency==='string'?d.budget.currency:''].filter(Boolean).join(' ');
  if(Array.isArray(d.participants)){
   const ids=d.participants.map((p:any)=>typeof p==='string'?p:p?.id||p?.user_id).filter((id:any)=>typeof id==='string'),members=ids.length?(await this.db.query('SELECT user_id,name FROM members WHERE user_id=ANY($1::text[])',[ids])).rows:[],names=new Map(members.map(m=>[m.user_id,m.name]));
   details['Учасники']=d.participants.map((p:any)=>typeof p==='string'?names.get(p)||p:typeof p?.name==='string'?p.name:names.get(p?.id||p?.user_id)).filter(Boolean).join(', ');
  }
  if(Array.isArray(d.options))details['Варіанти']=d.options.map((x:any)=>typeof x==='string'?x:typeof x?.title==='string'?x.title:typeof x?.label==='string'?x.label:'').filter(Boolean).join('; ');
  if(d.attendance==='not_confirmed')details['Участь']='Ще не підтверджена';
  return {id:row.id,title:row.title,status:row.status,version:row.version,details:compact(details),source_ids:await this.readSources([{kind:'event',id:row.id}])};
 }
 private detail(d:any){return [d.title,statuses[d.status||d.phase]||d.status||d.phase,d.version?'Редакція '+d.version:undefined,d.mime?`${d.mime} · ${d.bytes} байт`:undefined,d.notice,d.details?Object.entries(d.details).filter(([k])=>!k.startsWith('_')&&!/private|secret|answer|token|credential|calendar_(mirror|owner)/i.test(k)).map(([k,v])=>`${k}: ${typeof v==='string'||typeof v==='number'?v:''}`).filter(x=>!x.endsWith(': ')).join('\n'):undefined,...(d.corrections||[]).map((x:any)=>`Виправлення результату, редакція ${x.canonical_version}: ${x.actor_name||x.actor_id} — ${x.reason}. ${scoreChanges(x,d.participants)} (джерело #${x.source_message_id})`),...(d.linked_materials||[]).map((x:any,i:number)=>`Матеріал ${i+1}: ${x.title} · ${x.mime}; прив’язано до редакції ${x.bound_resource_version}, поточна ${x.current_resource_version}`),...(d.items||d.scenes||[]).map((x:any,i:number)=>`${i+1}. ${x.caption||x.title||x.asset_id}${x.claim?' ('+x.claim+')':''}${x.claimed_date?' · '+x.claimed_date:''}`)].filter(Boolean).join('\n').slice(0,3500);}
 async statistics(a:any,c:ToolContext){
  await this.access(c);const timezone=a.timezone||'Europe/Kyiv';new Intl.DateTimeFormat('uk',{timeZone:timezone});
  const since=a.since?Date.parse(a.since):null,until=a.until?Date.parse(a.until):null,bounded=since!==null||until!==null;
  if(since!==null&&!Number.isFinite(since)||until!==null&&!Number.isFinite(until)||since!==null&&until!==null&&since>=until)throw new ToolError('statistics_period_invalid');
  const all=(await this.db.query(`SELECT o.source_kind,o.source_key,o.status,o.finished_at,o.time_precision,COALESCE(h.changes,0)::integer AS status_change_count FROM canonical_outcomes o JOIN (${currentSources}) s USING(source_kind,source_key,topic_id,status) LEFT JOIN (SELECT source_kind,source_key,count(*) AS changes FROM outcome_changes WHERE previous_status IS DISTINCT FROM status GROUP BY source_kind,source_key) h USING(source_kind,source_key) WHERE o.topic_id=$1`,[c.topicId])).rows;
  const inPeriod=(row:any)=>!bounded||terminal(row.status)&&row.time_precision==='exact'&&row.finished_at!==null&&(since===null||new Date(row.finished_at).getTime()>=since)&&(until===null||new Date(row.finished_at).getTime()<until);
  const rows=all.filter(inPeriod),unknown=all.filter(x=>terminal(x.status)&&(x.time_precision!=='exact'||x.finished_at===null)).length,ongoing=all.filter(x=>!terminal(x.status)).length,completed=rows.filter(x=>x.status==='completed').length;
  const selected=new Set(rows.map(x=>x.source_kind+':'+x.source_key)),corrections=(await this.db.query(`SELECT p.id,p.source_kind,p.source_key,p.canonical_version,p.actor_id,m.name AS actor_name,p.reason,p.patch,p.before_scores,p.after_scores,p.source_message_id,p.source_ids,p.created_at FROM game_result_corrections p JOIN canonical_outcomes o USING(source_kind,source_key) JOIN (${currentSources}) s USING(source_kind,source_key,topic_id,status) LEFT JOIN members m ON m.user_id=p.actor_id WHERE o.topic_id=$1 ORDER BY p.sequence`,[c.topicId])).rows.filter(p=>selected.has(p.source_kind+':'+p.source_key));
  const refs=(values:any[])=>values.map(p=>({source_kind:p.source_kind as 'games'|'activity_sessions',source_key:p.source_key as string})),ranking=a.ranking?await this.rankings(a,c):undefined;
  // The selected scores need every surviving correction, even if display history
  // is later shortened. All-time coverage also depends on the original records.
  const sources=await this.readSources([], [...await gameResultSources(this.db,refs(rows)),...await gameResultSources(this.db,refs(all),false),...(ranking?.source_ids||[])]);
  return {period:{since:a.since||null,until:a.until||null},timezone,completed,incomplete_or_cancelled:rows.length-completed,total_recorded:rows.length,
   status_revisions:rows.filter(x=>x.status_change_count>0).length,status_change_events:rows.reduce((n,x)=>n+x.status_change_count,0),status_history_scope:'all_recorded_changes_of_selected_sources',corrections:{recorded:corrections.length,corrected_results:new Set(corrections.map(x=>x.source_kind+':'+x.source_key)).size,scope:'surviving_corrections_of_selected_results'},correction_history:corrections.slice(-10),correction_history_total:corrections.length,source_ids:sources,
   time_coverage:{scope:'current_sources_in_topic_all_time',exact_terminal:all.filter(x=>terminal(x.status)&&x.time_precision==='exact'&&x.finished_at!==null).length,unknown_terminal_time:unknown,ongoing,excluded_unknown_terminal_time:bounded?unknown:0,excluded_ongoing:bounded?ongoing:0},
   denominator:bounded?'Канонічні завершення й скасування з точним часом у цьому періоді та чинним джерелом':'Канонічні результати й поточні стани активностей цієї теми з чинним джерелом',
   coverage:'Старі результати з приблизним або невідомим часом не входять у періоди. Видалені джерела не враховуються. Рейтинги містять лише завершені партії та учасників, які погодилися; бали різних правил і сценаріїв не додаються.',
   personal_ranking:ranking?ranking.groups:'not_requested',overall_score:'not_combined',attendance:'not_inferred',listened:'not_measurable'};
 }
 private async rankings(a:any,c:ToolContext){
  const rows=(await this.db.query(`SELECT * FROM (
   SELECT 'session'::text AS engine,s.id::text AS source_key,s.template,s.title,s.settings#>>'{_pack,id}' AS scenario_id,s.settings#>>'{_pack,title}' AS scenario_title,
    md5(jsonb_build_object('pack',s.settings->'_pack','quiz',s.settings->'_quiz','options',s.settings->'options','prompts',s.settings->'prompts','rounds',s.max_rounds,'response_mode',s.settings->'response_mode','max_choices',s.settings->'max_choices_per_player','players',(SELECT count(*) FROM activity_players x WHERE x.session_id=s.id))::text) AS score_rules,p.user_id,p.name,p.score::numeric AS score,pref.source_message_id AS preference_source_id
   FROM activity_sessions s JOIN activity_players p ON p.session_id=s.id JOIN statistics_preferences pref ON pref.user_id=p.user_id AND pref.ranking_opt_in=true JOIN members m ON m.user_id=p.user_id AND m.active=true JOIN canonical_outcomes o ON o.source_kind='activity_sessions' AND o.source_key=s.id::text AND o.topic_id=s.topic_id AND o.status=s.phase
   WHERE s.topic_id=$1 AND s.phase='completed' AND (($2::timestamptz IS NULL AND $3::timestamptz IS NULL) OR o.time_precision='exact' AND o.finished_at IS NOT NULL AND ($2::timestamptz IS NULL OR o.finished_at>=$2) AND ($3::timestamptz IS NULL OR o.finished_at<$3))
   UNION ALL
   SELECT 'legacy',g.id::text,g.kind,COALESCE(NULLIF(g.state->>'title',''),$4::jsonb->>g.kind,g.kind),NULL,NULL,
    md5(jsonb_build_object('kind',g.kind,'order',g.state->'order','case',g.state->'caseIndex','limit',g.state->'limit','rules',g.state->'rules','topic',g.state->'topic')::text),p.id,p.name,(g.state->'scores'->>p.id)::numeric,pref.source_message_id
   FROM games g CROSS JOIN LATERAL jsonb_to_recordset(CASE WHEN jsonb_typeof(g.state->'players')='array' THEN g.state->'players' ELSE '[]'::jsonb END) AS p(id text,name text) JOIN statistics_preferences pref ON pref.user_id=p.id AND pref.ranking_opt_in=true JOIN members m ON m.user_id=p.id AND m.active=true JOIN canonical_outcomes o ON o.source_kind='games' AND o.source_key=g.id::text AND o.topic_id=g.topic_id AND o.status=g.status
   WHERE g.topic_id=$1 AND g.status='completed' AND (g.state->'scores'->>p.id)~'^-?[0-9]+$' AND (($2::timestamptz IS NULL AND $3::timestamptz IS NULL) OR o.time_precision='exact' AND o.finished_at IS NOT NULL AND ($2::timestamptz IS NULL OR o.finished_at>=$2) AND ($3::timestamptz IS NULL OR o.finished_at<$3))
  ) scores ORDER BY engine,template,score_rules,source_key,user_id`,[c.topicId,a.since||null,a.until||null,JSON.stringify(GAME_NAMES)])).rows;
  const groups=new Map<string,{engine:string;mechanic:string;template:string;title:string;scenario_id:string|null;scenario_title:string|null;players:Map<string,{user_id:string;name:string;score:number;sessions:Set<string>}>;sessions:Set<string>}>();
  for(const r of rows){const score=Number(r.score);if(!Number.isSafeInteger(score))continue;const key=digest([r.engine,r.template,r.score_rules]);let group=groups.get(key);if(!group){group={engine:r.engine,mechanic:r.template,template:r.template,title:r.engine==='legacy'?GAME_NAMES[r.template]||r.template:ACTIVITY_TEMPLATES[r.template as keyof typeof ACTIVITY_TEMPLATES]||r.template,scenario_id:r.scenario_id,scenario_title:r.scenario_title,players:new Map(),sessions:new Set()};groups.set(key,group);}let player=group.players.get(r.user_id);if(!player){player={user_id:r.user_id,name:r.name||r.user_id,score:0,sessions:new Set()};group.players.set(r.user_id,player);}if(!player.sessions.has(r.source_key)){player.score+=score;player.sessions.add(r.source_key);}group.sessions.add(r.source_key);}
  return {groups:[...groups.values()].map(g=>({engine:g.engine,mechanic:g.mechanic,template:g.template,title:g.title,scenario_id:g.scenario_id,scenario_title:g.scenario_title,scoring_scope:'same_rules_and_scenario',completed_sessions:g.sessions.size,participants:[...g.players.values()].sort((a,b)=>b.score-a.score||a.user_id.localeCompare(b.user_id)).slice(0,30).map(p=>({user_id:p.user_id,name:p.name,score:p.score,completed_sessions:p.sessions.size}))})),source_ids:await this.readSources([],rows.map(r=>r.preference_source_id))};
 }
 private statsText(r:any){const ranking=Array.isArray(r.personal_ranking)?r.personal_ranking.flatMap((g:any,i:number)=>[`\nРейтинг ${i+1}: ${g.title}${g.scenario_title?' · '+g.scenario_title:''} (${g.engine==='legacy'?'класичні ігри':'сесії'}, партій: ${g.completed_sessions})`,...g.participants.map((p:any,n:number)=>`${n+1}. ${p.name}: ${p.score} · партій: ${p.completed_sessions}`)]):[];return [`Результати активностей`,`Завершені: ${r.completed}`,`Незавершені або скасовані: ${r.incomplete_or_cancelled}`,`Усього збережено: ${r.total_recorded}`,`Період: ${r.period.since||'від початку'} — ${r.period.until||'зараз'} (${r.timezone})`,`${r.denominator}.`,r.coverage,`Покриття всіх збережених партій: невідомий час завершення — ${r.time_coverage.unknown_terminal_time}; тривають — ${r.time_coverage.ongoing}.`,`Відомих змін статусу відібраних партій за весь час: ${r.status_change_events}.`,`Збережених виправлень рахунку: ${r.corrections.recorded}; виправлено результатів: ${r.corrections.corrected_results}.`,...(r.correction_history_total>10?['Нижче останні 10 виправлень; повна історія доступна в результаті конкретної гри.']:[]),...r.correction_history.map((p:any)=>`${p.source_kind==='games'?'Гра':'Сесія'} #${p.source_key}, редакція ${p.canonical_version}: ${p.actor_name||p.actor_id} — ${p.reason}. ${scoreChanges(p)} (джерело #${p.source_message_id})`),...ranking].join('\n');}
}
const scoreChanges=(correction:any,participants:any[]=[])=>Object.keys(correction.patch).map(id=>`${participants.find(p=>p.user_id===id)?.name||id}: ${correction.before_scores[id]} → ${correction.after_scores[id]}`).join('; ');
const compact=(values:Record<string,unknown>)=>Object.fromEntries(Object.entries(values).filter(([,value])=>value!==undefined&&value!==null&&value!==''));
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
