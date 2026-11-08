import {z} from 'zod';
import sharp,{type OverlayOptions} from 'sharp';
import {readFile} from 'node:fs/promises';
import {one,state,type Database} from './db.js';
import {command,requireVersion,sourceIds} from './evolution-core.js';
import {MediaWorkshop} from './media-workshop.js';
import {assetFor,invalidateAsset} from './media-assets.js';
import {Media} from './media.js';
import {withWorkerSlot} from './work-slots.js';
import {runOperation,cancelOperations,checkOperation,operationSignal,stableId} from './operations.js';
import {recordProvenance} from './provenance.js';
import type {ToolContext} from './agent-tools.js';
import type {Config} from './config.js';
import {ToolError} from './safe-http.js';
export const ImageDesign=z.object({operation:z.enum(['propose','read','render','cancel']),id:z.string().uuid().optional(),version:z.number().int().positive().optional(),title:z.string().min(1).max(100).optional(),text:z.string().max(1400).optional(),mode:z.enum(['card','collage','model']).default('card'),references:z.array(z.object({id:z.string().uuid(),version:z.number().int().positive()})).max(6).default([]),prompt:z.string().max(3000).optional(),parent_id:z.string().uuid().optional(),claim:z.enum(['author_text','joke','source_fact']).default('author_text'),fact_source_id:z.number().int().positive().optional()});
const recovered=new WeakSet<Database>();
const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export class ImageDesigns {
 constructor(private db:Database,private config:Config,private library:MediaWorkshop){}
 private async row(id:string|undefined,c:ToolContext){const row=await one(this.db,'SELECT * FROM image_designs WHERE id=$1 AND actor_id=$2 AND topic_id=$3',[id,c.actorId,c.topicId]);if(!row||row.audience==='private'&&c.audience!=='private'&&Number(c.chatId)<0)throw new ToolError('own_image_design_required');return row;}
 async run(a:z.infer<typeof ImageDesign>,c:ToolContext):Promise<any>{
  if(!recovered.has(this.db)){await this.db.query("UPDATE image_designs SET status='needs_input' WHERE status='rendering'");recovered.add(this.db);}
  if(a.operation==='propose'){
   if(!a.title||a.mode==='model'&&!a.prompt||a.mode==='collage'&&!a.references.length)throw new ToolError('image_design_content_required');if(a.mode==='model'&&(!this.config.apiKey||!this.config.imageModel))return {status:'unavailable',reason:'image_model_not_connected',alternatives:['card','collage'],notice:'Генерацію нової ілюстрації не підключено. Можу створити картку з текстом або колаж із доступних зображень.'};
   return command(this.db,c,'image_design',a,async(sql,id)=>{for(const ref of a.references){const asset=await assetFor(sql,ref.id,ref.version,c);if(!asset.mime.startsWith('image/'))throw new ToolError('image_reference_required');if(asset.audience==='private'&&c.audience!=='private'&&Number(c.chatId)<0)throw new ToolError('private_reference_cannot_widen_audience');}if(a.claim==='source_fact'){const source=await one(sql,'SELECT body FROM messages WHERE id=$1',[a.fact_source_id]);if(!source||!a.text||!source.body.includes(a.text))throw new ToolError('image_fact_exact_source_required');}if(a.parent_id)await assetFor(sql,a.parent_id,undefined,c);
    await sql.query('INSERT INTO image_designs(id,actor_id,topic_id,audience,spec,revision,source_message_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,c.actorId,c.topicId,c.audience||'group',JSON.stringify(a),c.revision,c.sourceId||null]);await recordProvenance(sql,'image_design',id,[...sourceIds(c),...(a.fact_source_id?[a.fact_source_id]:[])]);return {id,version:1,status:'draft',title:a.title,mode:a.mode,references:a.references,claim:a.claim,preview:{text:a.text,prompt:a.prompt},notice:'render створить саме цей варіант. Можна скасувати, перевикористати готовий матеріал або створити окрему нову редакцію.'};});
  }
  const row=await this.row(a.id,c);if(a.operation==='read')return {id:row.id,version:row.version,status:row.status,output_id:row.output_id,spec:row.spec};requireVersion(row.version,a.version);
  if(a.operation==='cancel'){await this.db.query("UPDATE image_designs SET status='cancelled',version=version+1 WHERE id=$1 AND status IN ('draft','rendering')",[row.id]);cancelOperations(this.db,'image-design:'+row.id);return {cancelled:true};}
  if(row.status==='ready'){await assetFor(this.db,row.output_id,undefined,c);return {id:row.id,status:'ready',output_id:row.output_id,reused:true};}if(row.status!=='draft')throw new ToolError('image_design_not_ready_to_render');
  const started=await this.db.tx(async sql=>{const live=await state(sql,true);if(live.paused||live.memory_revision!==c.revision)throw new ToolError('task_cancelled');return one(sql,"UPDATE image_designs SET status='rendering' WHERE id=$1 AND status='draft' AND version=$2 RETURNING id",[row.id,a.version]);});if(!started)throw new ToolError('image_design_already_rendering');
  return runOperation(this.db,'image-design:'+row.id,async()=>{let output:any;try{
   const refs:Awaited<ReturnType<MediaWorkshop['bytes']>>[]=[];for(const ref of row.spec.references){const data=await this.library.bytes(ref.id,ref.version,c);refs.push(data);}
   const provenance=(await this.db.query("SELECT source_message_id FROM provenance_edges WHERE (derived_kind='media_asset' AND derived_key=ANY($1::text[])) OR (derived_kind='image_design' AND derived_key=$2)",[row.spec.references.map((x:any)=>x.id),row.id])).rows.map(x=>Number(x.source_message_id));
   let bytes:Buffer;if(row.spec.mode==='model'){const day=new Date().toISOString().slice(0,10);const allowance=await one(this.db,"INSERT INTO daily_usage(day,images) VALUES($1,1) ON CONFLICT(day) DO UPDATE SET images=daily_usage.images+1 WHERE daily_usage.images<5 RETURNING images",[day]);if(!allowance)throw new ToolError('image_daily_limit');bytes=await new Media(this.config,undefined,this.db).image(row.spec.prompt,refs.map(r=>'data:'+r.asset.mime+';base64,'+r.bytes.toString('base64')),operationSignal(180000));}
   else bytes=await withWorkerSlot(async()=>{
    const width=1200,height=900,base=sharp({create:{width,height,channels:4,background:'#f7f3e9'}}),composites:OverlayOptions[]=[];
    if(refs.length){const cols=refs.length===1?1:refs.length<=4?2:3,rows=Math.ceil(refs.length/cols),cellWidth=Math.floor(1120/cols),cellHeight=Math.floor(520/rows);for(const [index,ref] of refs.entries())composites.push({input:await sharp(ref.bytes,{limitInputPixels:20000000}).rotate().resize(cellWidth-12,cellHeight-12,{fit:'cover'}).png().toBuffer(),left:40+(index%cols)*cellWidth,top:140+Math.floor(index/cols)*cellHeight});}
    const font=new URL('../../assets/fonts/DejaVuSans.ttf',import.meta.url).pathname,hasReferences=refs.length>0;const title=await sharp({text:{text:'<span foreground="#253c3a"><b>'+esc(row.spec.title)+'</b></span>',font:'DejaVu Sans 34',fontfile:font,width:1080,rgba:true,wrap:'word-char',dpi:72}}).png().toBuffer();composites.push({input:title,left:50,top:30});
    if(row.spec.text){const text=await sharp({text:{text:'<span foreground="#253c3a">'+esc(row.spec.text)+'</span>',font:'DejaVu Sans 25',fontfile:font,width:1000,rgba:true,wrap:'word-char',dpi:72}}).png().toBuffer();const size=await sharp(text).metadata();if((size.height||0)>(hasReferences?160:630))throw new ToolError('image_text_overflow');composites.push({input:text,left:50,top:hasReferences?690:160});}
    const mouse=await sharp(await readFile(new URL('../../assets/lumen.png',import.meta.url)),{limitInputPixels:20000000}).resize(70,70,{fit:'inside'}).png().toBuffer();composites.push({input:mouse,left:1100,top:810});return base.composite(composites).png().toBuffer();
   },'image_render');
   checkOperation();await sharp(bytes,{limitInputPixels:20000000}).metadata();output=await this.library.store(bytes,'image/png',row.spec.title,{...c,sourceIds:[...sourceIds(c),...provenance],audience:row.audience},stableId('image-output:'+row.id),row.spec.parent_id);
   await this.db.tx(async sql=>{const live=await state(sql,true),current=await one(sql,'SELECT status,version FROM image_designs WHERE id=$1 FOR UPDATE',[row.id]);if(live.paused||live.memory_revision!==c.revision||current?.status!=='rendering'||current.version!==a.version)throw new ToolError('image_design_cancelled');for(const ref of row.spec.references){await assetFor(sql,ref.id,ref.version,c);await sql.query('INSERT INTO media_derivations(input_id,output_id,input_version) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ref.id,output.id,ref.version]);}await sql.query("UPDATE image_designs SET status='ready',output_id=$2 WHERE id=$1",[row.id,output.id]);});return {id:row.id,status:'ready',output_id:output.id,version:output.version,mode:row.spec.mode,sha256:output.sha256,model_generated:row.spec.mode==='model',delivery:'not_sent'};
  }catch(e){if(output)await this.db.tx(sql=>invalidateAsset(sql,output.id));await this.db.query("UPDATE image_designs SET status='needs_input' WHERE id=$1 AND status='rendering'",[row.id]);throw e;}});
 }
}
