import {mkdir,writeFile,readFile,rename,rm,statfs} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {one,state,type Database,type SQL} from './db.js';
import {command,digest,requireVersion,sourceIds} from './evolution-core.js';
import {recordProvenance} from './provenance.js';
import {checkOperation,stableId} from './operations.js';
import {ToolError} from './safe-http.js';
import {Telegram,type CallbackQuery} from './telegram.js';
import type {ToolContext} from './agent-tools.js';
import type {Config} from './config.js';

export const AssetCommand=z.object({operation:z.enum(['capture','read','revoke','link','unlink','allow_group','allow_destination','publish']),id:z.string().uuid().optional(),version:z.number().int().positive().optional(),attachment_id:z.number().int().positive().optional(),title:z.string().max(160).optional(),caption:z.string().max(900).default(''),resource_kind:z.enum(['event','game','session','collection','project']).optional(),resource_id:z.string().max(100).optional(),destination_id:z.string().uuid().optional()});
export const BrowseQuery=z.object({section:z.enum(['materials','collections','studio','events','games','statistics']).default('materials'),query:z.string().max(160).default(''),cursor:z.string().max(400).optional(),timezone:z.string().max(80).default('Europe/Kyiv'),ranking:z.boolean().default(false),limit:z.number().int().min(1).max(12).default(8),since:z.string().datetime({offset:true}).optional(),until:z.string().datetime({offset:true}).optional()});
// Never let MIME/extension or FFmpeg auto-probing select a playlist demuxer.
// MOV data references are disabled explicitly, including references to local files.
export function selfContainedMediaInput(bytes:Uint8Array,mime:string):string[]{
 const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength),ascii=(start:number,end:number)=>b.toString('ascii',start,end),mov=b.length>=12&&ascii(4,8)==='ftyp';let format:string|undefined;
 if(mime.startsWith('audio/')){
  if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WAVE')format='wav';else if(ascii(0,4)==='fLaC')format='flac';else if(ascii(0,4)==='OggS')format='ogg';else if(mov)format='mov';else if(ascii(0,3)==='ID3')format='mp3';
  else if(b.length>=4&&b[0]===255&&(b[1]!&0xf6)===0xf0)format='aac';
  else if(b.length>=4&&b[0]===255&&(b[1]!&0xe0)===0xe0&&(b[1]!&6)!==0&&(b[2]!&0xf0)!==0xf0&&(b[2]!&0x0c)!==0x0c)format='mp3';
 }else if(mime==='video/mp4'&&mov)format='mov';else if(mime==='video/webm'&&b.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))format='matroska';else if(mime==='image/gif'&&/^GIF8[79]a$/.test(ascii(0,6)))format='gif';
 if(!format)throw new ToolError(mime.startsWith('audio/')?'self_contained_audio_required':'self_contained_media_required');
 return ['-f',format,...(format==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[])];
}
export async function assetFor(sql:SQL,id:string,version:number|undefined,c:ToolContext){const a=await one(sql,'SELECT * FROM media_assets WHERE id=$1',[id]);if(!a||a.status!=='available'||a.audience!=='group'&&(a.owner_id!==c.actorId||c.audience!=='private'&&Number(c.chatId)<0))throw new ToolError('asset_unavailable');if(version!==undefined)requireVersion(a.version,version);return a;}
export async function invalidateAsset(sql:SQL,id:string,seen=new Set<string>()){
 if(seen.has(id))return;seen.add(id);const a=await one(sql,'SELECT path FROM media_assets WHERE id=$1',[id]);if(!a)return;
 await sql.query("UPDATE image_designs SET status='stale',spec='{}' WHERE output_id=$1",[id]);
 await sql.query("UPDATE media_assets SET status='revoked',version=version+1,title='Відкликаний матеріал' WHERE id=$1",[id]);await sql.query('INSERT INTO media_garbage(id,path) VALUES($1,$2)',[randomUUID(),a.path]);
 for(const derived of (await sql.query('SELECT output_id FROM media_derivations WHERE input_id=$1',[id])).rows)await invalidateAsset(sql,derived.output_id,seen);
 const outputs=(await sql.query('SELECT j.id,j.output_id,j.action_id FROM media_jobs j JOIN media_job_inputs i ON i.job_id=j.id WHERE i.asset_id=$1',[id])).rows;
 for(const job of outputs){await sql.query("UPDATE media_jobs SET status='stale',manifest='{}',error_code='source_revoked' WHERE id=$1",[job.id]);if(job.action_id)await sql.query("UPDATE commitments SET phase='blocked',error_code='source_revoked',state_version=state_version+1 WHERE id=$1 AND phase IN ('runnable','executing','delivering')",[job.action_id]);if(job.output_id)await invalidateAsset(sql,job.output_id,seen);}
 await sql.query("UPDATE media_publications SET status='revoked',manifest='{}' WHERE asset_id=$1",[id]);await sql.query("DELETE FROM outbox WHERE kind='media_asset' AND body->>'id'=$1 AND status='pending'",[id]);await sql.query('DELETE FROM resource_links WHERE asset_id=$1',[id]);
}
export async function invalidateResourceJobs(sql:SQL,id:string,preserveActionId?:string){for(const job of (await sql.query('SELECT id,output_id,action_id FROM media_jobs WHERE resource_id=$1',[id])).rows){await sql.query("UPDATE media_jobs SET status='stale',manifest='{}' WHERE id=$1",[job.id]);if(job.action_id&&job.action_id!==preserveActionId)await sql.query("UPDATE commitments SET phase='blocked',error_code='resource_changed',state_version=state_version+1 WHERE id=$1 AND phase IN ('runnable','executing','delivering')",[job.action_id]);await sql.query("DELETE FROM outbox WHERE (dedup_key LIKE $1 OR dedup_key LIKE $2) AND status='pending'",['render-failed:'+job.id+':%','render-ready:'+job.id+':%']);if(job.output_id)await invalidateAsset(sql,job.output_id);}}
export async function forgetMediaSource(sql:SQL,source:number){
 await sql.query("DELETE FROM domain_commands WHERE domain='studio' AND result->'audio_expectation'->'source_ids' @> $1::jsonb",[JSON.stringify([source])]);
 const tracks=(await sql.query('DELETE FROM studio_soundtracks WHERE source_message_id=$1 RETURNING project_id',[source])).rows;
 for(const track of tracks){await sql.query('UPDATE studio_projects SET version=version+1 WHERE id=$1',[track.project_id]);await invalidateResourceJobs(sql,track.project_id);}
 const permissions=(await sql.query('SELECT id FROM media_assets WHERE audience_source_id=$1',[source])).rows;
 for(const row of permissions){await sql.query("UPDATE media_assets SET audience='private',version=version+1 WHERE id=$1",[row.id]);for(const job of (await sql.query('SELECT j.resource_id FROM media_job_inputs i JOIN media_jobs j ON j.id=i.job_id WHERE i.asset_id=$1',[row.id])).rows)await invalidateResourceJobs(sql,job.resource_id);await sql.query("DELETE FROM outbox WHERE kind='media_asset' AND body->>'id'=$1 AND status='pending'",[row.id]);}
 const captions=(await sql.query("SELECT collection_id,field_sources FROM archive_items WHERE field_sources::text LIKE '%'||$1||'%'",[String(source)])).rows;for(const row of captions)if(Object.values(row.field_sources).some(v=>Number(v)===source))await invalidateResourceJobs(sql,row.collection_id);
 for(const field of ['caption','claim','claimed_date'])await sql.query(`UPDATE archive_items SET ${field}=${field==='claimed_date'?'NULL':field==='claim'?"'uncertain'":"''"},field_sources=field_sources-$1 WHERE field_sources->>$1=$2`,[field,String(source)]);

 const resources=(await sql.query('SELECT collection_id AS id FROM archive_items WHERE source_message_id=$1 UNION SELECT project_id AS id FROM studio_scenes WHERE source_message_id=$1 UNION SELECT id FROM archive_collections WHERE source_message_id=$1 UNION SELECT id FROM studio_projects WHERE source_message_id=$1',[source])).rows;for(const row of resources)await invalidateResourceJobs(sql,row.id);
 const assets=(await sql.query("SELECT id FROM media_assets WHERE source_message_id=$1 UNION SELECT derived_key::uuid AS id FROM provenance_edges WHERE source_message_id=$1 AND derived_kind='media_asset'",[source])).rows;for(const a of assets)await invalidateAsset(sql,a.id);
}
export class MediaAssets {
 readonly telegram:Telegram;
 constructor(protected db:Database,protected config:Config,telegram?:Telegram){this.telegram=telegram||new Telegram(config.token);}
 async directory(){const s=await state(this.db),dir=join(this.config.runtimeDir,'materials',digest(String(s.chat_id)).slice(0,24));await mkdir(dir,{recursive:true,mode:0o700});return dir;}
 async store(bytes:Uint8Array,mime:string,title:string,c:ToolContext,id:string=randomUUID(),parent?:string,ownerId=c.actorId){
  checkOperation();if(bytes.length>32*1024*1024)throw new ToolError('asset_size_limit_32mb');const prior=await one(this.db,'SELECT id,version,sha256,mime FROM media_assets WHERE id=$1',[id]);if(prior){if(prior.sha256!==digest(bytes)||prior.mime!==mime)throw new ToolError('asset_id_content_conflict');return assetFor(this.db,id,prior.version,c);}
  if(parent)await assetFor(this.db,parent,undefined,c);const root=await this.directory(),disk=await statfs(root);if(Number(disk.bavail)*Number(disk.bsize)<bytes.length+80*1024*1024)throw new ToolError('media_disk_space_low');
  const ext=mime==='image/png'?'.png':mime==='image/jpeg'?'.jpg':mime==='video/mp4'?'.mp4':mime==='application/pdf'?'.pdf':mime==='audio/mpeg'?'.mp3':mime==='audio/mp4'?'.m4a':mime==='audio/aac'?'.aac':mime==='audio/wav'||mime==='audio/x-wav'?'.wav':mime==='audio/ogg'?'.ogg':mime==='audio/flac'?'.flac':'.bin',path=join(root,id+ext),hash=digest(bytes);
  let wrote=false;try{return await command(this.db,{...c,operationKey:'asset-store:'+id},'asset', {id,hash},async sql=>{
   const usage=Number((await one(sql,"SELECT COALESCE(sum(bytes),0)::text AS n FROM media_assets WHERE status='available'"))!.n);if(usage+bytes.length>192*1024*1024)throw new ToolError('original_storage_quota_manage_materials');
   await writeFile(path+'.tmp',bytes,{mode:0o600});await rename(path+'.tmp',path);wrote=true;
   await sql.query('INSERT INTO media_assets(id,owner_id,title,mime,path,sha256,bytes,audience,topic_id,parent_id,source_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,ownerId,title,mime,path,hash,bytes.length,c.audience||'group',c.topicId,parent||null,c.sourceId||null]);
   await recordProvenance(sql,'media_asset',id,sourceIds(c));if(parent)await import('./provenance.js').then(p=>p.transferProvenance(sql,'media_asset',parent,'media_asset',id));return (await one(sql,'SELECT * FROM media_assets WHERE id=$1',[id]))!;
  });}catch(e){if(wrote)await rm(path,{force:true});throw e;}
 }
 async bytes(id:string,version:number|undefined,c:ToolContext){const asset=await assetFor(this.db,id,version,c);let bytes:Buffer;try{bytes=await readFile(asset.path);}catch{throw new ToolError('asset_bytes_unavailable');}if(digest(bytes)!==asset.sha256||bytes.length!==Number(asset.bytes))throw new ToolError('asset_checksum_mismatch');return {asset,bytes};}
 async run(a:z.infer<typeof AssetCommand>,c:ToolContext):Promise<any>{
  if(a.operation==='capture'){
   const file=await one(this.db,"SELECT a.*,COALESCE(CASE WHEN m.role='assistant' THEN origin.user_id END,NULLIF(m.user_id,'lumen'),s.owner_id) AS user_id FROM attachments a JOIN messages m ON m.id=a.source_message_id LEFT JOIN messages origin ON origin.id=m.source_message_id AND origin.role='user' CROSS JOIN app_state s WHERE a.id=$1 AND s.id=1",[a.attachment_id]);if(!file)throw new ToolError('known_attachment_required');if(c.audience==='private'&&file.user_id!==c.actorId)throw new ToolError('own_private_attachment_required');
   const bytes=await this.telegram.file(file.file_id,24*1024*1024);if(file.kind==='audio'||String(file.mime).startsWith('audio/'))selfContainedMediaInput(bytes,file.mime||'audio/mpeg');
   const asset=await this.store(bytes,file.mime||'application/octet-stream',a.title||file.metadata?.file_name||file.description||'Матеріал',{...c,sourceIds:[...sourceIds(c),Number(file.source_message_id)]},stableId(c.operationKey||'capture:'+c.updateId+':'+file.id),undefined,String(file.user_id));return {id:asset.id,title:asset.title,version:asset.version,mime:asset.mime,bytes:asset.bytes,sha256:asset.sha256,durable:true,audience:asset.audience};
  }
  const asset=await assetFor(this.db,a.id!,a.version,c);
  if(a.operation==='read'){const deps=(await this.db.query("SELECT source_message_id FROM provenance_edges WHERE derived_kind='media_asset' AND derived_key=$1::text UNION SELECT source_message_id FROM media_assets WHERE id=$1::uuid AND source_message_id IS NOT NULL UNION SELECT audience_source_id AS source_message_id FROM media_assets WHERE id=$1::uuid AND audience_source_id IS NOT NULL",[asset.id])).rows;return {id:asset.id,title:asset.title,version:asset.version,mime:asset.mime,bytes:asset.bytes,sha256:asset.sha256,audience:asset.audience,parent_id:asset.parent_id,durable:true,source_ids:deps.map(x=>Number(x.source_message_id))};}
  return command(this.db,c,'media_asset',a,async(sql,id)=>{
   const current=await assetFor(sql,asset.id,a.version,c);requireVersion(current.version,a.version);
   if(a.operation==='revoke'){if(current.owner_id!==c.actorId)throw new ToolError('asset_owner_required');await invalidateAsset(sql,current.id);return {id:current.id,status:'revoked',notice:'Відкликано для майбутніх переглядів і публікацій. Зовнішні вже завантажені копії не відкликаються.'};}
   if(a.operation==='allow_group'){if(current.audience==='group')return {id:current.id,version:current.version,audience:'group',reused:true};if(current.owner_id!==c.actorId)throw new ToolError('asset_owner_required');await sql.query("UPDATE media_assets SET audience='group',version=version+1,audience_source_id=$2 WHERE id=$1",[current.id,c.sourceId||null]);await invalidateResourceJobs(sql,current.id);return {id:current.id,version:current.version+1,audience:'group'};}
   if(a.operation==='allow_destination'){
    if(current.owner_id!==c.actorId||!a.destination_id)throw new ToolError('asset_owner_and_explicit_destination_required');const destination=await one(sql,"SELECT id,title,chat_id FROM media_destinations WHERE id=$1 AND status='active'",[a.destination_id]);if(!destination)throw new ToolError('destination_unavailable');await sql.query('INSERT INTO asset_destination_grants(asset_id,destination_id,asset_version,grantor_id,source_message_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(asset_id,destination_id) DO UPDATE SET asset_version=$3,grantor_id=$4,source_message_id=$5',[current.id,destination.id,current.version,c.actorId,c.sourceId||null]);return {allowed:true,asset_id:current.id,version:current.version,destination:destination.title};
   }
   if(a.operation==='link'||a.operation==='unlink'){
    if(!a.resource_kind||!a.resource_id)throw new ToolError('resource_required');const table={event:'group_events',game:'games',session:'activity_sessions',collection:'archive_collections',project:'projects'}[a.resource_kind],target=await one(sql,`SELECT * FROM ${table} WHERE id::text=$1`,[a.resource_id]);if(!target)throw new ToolError('resource_not_found');if(current.audience!=='group'&&target.audience!=='private')throw new ToolError('private_material_cannot_widen_audience');
    if(a.operation==='unlink')await sql.query('DELETE FROM resource_links WHERE asset_id=$1 AND resource_kind=$2 AND resource_id=$3',[current.id,a.resource_kind,a.resource_id]);else await sql.query('INSERT INTO resource_links(asset_id,asset_version,resource_kind,resource_id,resource_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT(asset_id,resource_kind,resource_id) DO UPDATE SET asset_version=$2,resource_version=$5',[current.id,current.version,a.resource_kind,a.resource_id,target.version||1]);return {linked:a.operation==='link'};
   }
   let destination:any;if(a.destination_id){destination=await one(sql,"SELECT * FROM media_destinations WHERE id=$1 AND owner_id=$2 AND status='active'",[a.destination_id,c.actorId]);if(!destination)throw new ToolError('destination_unavailable');const grant=await one(sql,'SELECT grantor_id FROM asset_destination_grants WHERE asset_id=$1 AND destination_id=$2 AND asset_version=$3',[current.id,destination.id,current.version]);if(grant?.grantor_id!==current.owner_id)throw new ToolError('asset_owner_destination_consent_required');}
   const manifest={id:current.id,version:current.version,sha256:current.sha256,caption:a.caption,destination_id:destination?.id,audience:destination?'channel':c.audience==='private'?'private':current.audience};await sql.query('INSERT INTO media_publications(id,asset_id,actor_id,manifest) VALUES($1,$2,$3,$4)',[id,current.id,c.actorId,JSON.stringify(manifest)]);
   const out=await one(sql,"INSERT INTO outbox(dedup_key,kind,body,revision,actor_id,audience,source_message_id) VALUES($1,'media_asset',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id",['publication:'+id,JSON.stringify({...manifest,publicationId:id,threadId:c.topicId==='0'?undefined:Number(c.topicId)}),c.revision,c.actorId,manifest.audience==='channel'?current.audience:manifest.audience,c.sourceId||null]);
   if(out){await recordProvenance(sql,'outbox',out.id,sourceIds(c));await import('./provenance.js').then(p=>p.transferProvenance(sql,'media_asset',current.id,'outbox',out.id));}return {id,status:'queued_for_delivery',asset_id:current.id,version:current.version,audience:manifest.audience};
  });
 }
 async registerDestination(a:{chat_id:string},c:ToolContext){
  const chat=await this.telegram.call('getChat',{chat_id:a.chat_id});if(chat.type!=='channel')throw new ToolError('channel_required');const me=await this.telegram.call('getMe');const owner=await this.telegram.call('getChatMember',{chat_id:chat.id,user_id:Number(c.actorId)}),bot=await this.telegram.call('getChatMember',{chat_id:chat.id,user_id:me.id});if(!['creator','administrator'].includes(owner.status)||bot.status!=='creator'&&(bot.status!=='administrator'||bot.can_post_messages!==true))throw new ToolError('channel_admin_and_bot_publish_rights_required');
  return command(this.db,c,'destination',a,async(sql,id)=>{await sql.query('INSERT INTO media_destinations(id,owner_id,chat_id,title) VALUES($1,$2,$3,$4)',[id,c.actorId,String(chat.id),chat.title||'Канал']);return {id,title:chat.title,chat_id:String(chat.id),rights_checked:true,ingestion_enabled:false};});
 }
 async maintenance(){
  for(const row of (await this.db.query('SELECT id,path FROM media_garbage ORDER BY created_at LIMIT 25')).rows){const root=resolve(await this.directory());if(resolve(row.path).startsWith(root+'/'))await rm(row.path,{force:true,recursive:true});await this.db.query('DELETE FROM media_garbage WHERE id=$1',[row.id]);}
 }
}

export async function purgeMediaPhrase(sql:SQL,phrase:string){
 const assets=(await sql.query("SELECT id FROM media_assets WHERE strpos(lower(title),lower($1))>0",[phrase])).rows;for(const a of assets)await invalidateAsset(sql,a.id);
 for(const [table,key] of [['archive_collections','collection_id'],['studio_projects','project_id']]){const resources=(await sql.query(`SELECT id FROM ${table} WHERE strpos(lower(title),lower($1))>0`,[phrase])).rows;for(const r of resources){await invalidateResourceJobs(sql,r.id);await sql.query(`DELETE FROM ${table} WHERE id=$1`,[r.id]);}}
 for(const r of (await sql.query("SELECT collection_id AS id FROM archive_items WHERE strpos(lower(caption||' '||COALESCE(claimed_date,'')),lower($1))>0 UNION SELECT project_id AS id FROM studio_scenes WHERE strpos(lower(caption),lower($1))>0",[phrase])).rows)await invalidateResourceJobs(sql,r.id);
 await sql.query("UPDATE archive_items SET caption='',claimed_date=NULL,claim='uncertain' WHERE strpos(lower(caption||' '||COALESCE(claimed_date,'')),lower($1))>0",[phrase]);await sql.query("UPDATE studio_scenes SET caption='' WHERE strpos(lower(caption),lower($1))>0",[phrase]);
}
