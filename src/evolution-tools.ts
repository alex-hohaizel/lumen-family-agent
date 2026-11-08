import {workerMetrics,withWorkerSlot} from './work-slots.js';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {checkOperation,operationSignal} from './operations.js';
import {digest} from './evolution-core.js';
import {inspectAlbumPdf} from './media-pdf.js';
import {StorageLifecycle} from './storage-lifecycle.js';
import {ImageDesigns,ImageDesign} from './image-design.js';
import {registerAddressedTools} from './media-addressed.js';
import {registerOfficeTools} from './office-tools.js';
import {Recurring,SeriesCommand} from './recurring.js';
import {z} from 'zod';
import {Household,StockCommand} from './household.js';
import {SimpleLists,ListCommand} from './simple-lists.js';
import {MediaWorkshop,CollectionCommand,StudioCommand} from './media-workshop.js';
import {MediaBrowser,RelatedQuery} from './media-browser.js';
import {GameResults,GameResultCommand} from './game-results.js';
import {AssetCommand,BrowseQuery,assetFor,selfContainedMediaInput} from './media-assets.js';
import {Learning,LearningCommand} from './learning.js';
import {CalendarSync,CalendarCommand} from './calendar-sync.js';
import {GroupCalendar,CalendarProposal} from './calendar-groups.js';
import {one,state,type Database} from './db.js';
import type {Config} from './config.js';
import type {Brain} from './model.js';
import type {Definition,ToolContext} from './agent-tools.js';
import {ToolError} from './safe-http.js';
const hubs=new WeakMap<Database,Evolution>();
type DeliveredKind='video'|'image'|'audio'|'pdf'|'album';
const bytesHash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
// These are readback facts about the bytes actually acknowledged by Delivery.
// Filename, requested goal, declared MIME alone and a ready job are not proof.
async function decodedOutputKinds(bytes:Buffer,mime:string):Promise<DeliveredKind[]>{
 return withWorkerSlot(async()=>{
  checkOperation();
  try{
   if(mime==='application/pdf'&&bytes.subarray(0,5).toString()==='%PDF-'){const pdf=await inspectAlbumPdf(bytes);return pdf.pages>0?['pdf']:[];}
   if(mime.startsWith('image/')){const image=sharp(bytes,{failOn:'error',limitInputPixels:20_000_000}),metadata=await image.metadata();if(!['png','jpeg','webp','gif'].includes(metadata.format||''))return [];await image.resize(1,1).raw().toBuffer();return ['image'];}
   if(mime==='video/mp4'||mime==='video/webm'||mime.startsWith('audio/')){
    const kind=mime.startsWith('audio/')?'audio':'video',format=selfContainedMediaInput(bytes,mime);
    const decoded=await new Promise<boolean>(resolve=>{
     if(!ffmpeg){resolve(false);return;}const signal=operationSignal();if(signal?.aborted){resolve(false);return;}
     const child=spawn(ffmpeg as unknown as string,['-v','error','-xerror','-nostdin','-threads','1','-protocol_whitelist','pipe',...format,'-i','pipe:0','-map',kind==='video'?'0:v:0':'0:a:0','-t','0.05','-progress','pipe:1','-f','null','-'],{stdio:['pipe','pipe','ignore']});
     let finished=false,progress='';const stop=()=>child.kill('SIGKILL'),timer=setTimeout(stop,10000),done=(okay:boolean)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);resolve(okay);};
     child.stdout.on('data',chunk=>{progress=(progress+chunk.toString()).slice(-8000);});
     signal?.addEventListener('abort',stop,{once:true});child.stdin.on('error',()=>{});child.once('error',()=>done(false));child.once('close',(code)=>done(code===0&&!signal?.aborted&&(kind==='video'?[...progress.matchAll(/^frame=(\d+)$/gm)].some(match=>Number(match[1])>0):[...progress.matchAll(/^out_time_us=(\d+)$/gm)].some(match=>Number(match[1])>0))));child.stdin.end(bytes);
    });
    return decoded?[kind]:[];
   }
  }catch{checkOperation();}
  return [];
 },'image_decode');
}
function boundOutput(receipt:any,id:string,bytes:Buffer,mime:string,revision:number,version?:number){
 const output=receipt?.output;
 return output?.id===id&&output.sha256===bytesHash(bytes)&&Number(output.bytes)===bytes.length&&output.mime===mime&&Number(output.revision)===revision&&(version===undefined?output.version===undefined:Number(output.version)===version);
}
function sameReceipt(receipt:any,stored:any){
 return receipt?.message_id&&receipt.operation_id&&receipt.operation_id===stored?.operation_id&&Number(receipt.message_id)===Number(stored.message_id)&&receipt.actor_id===stored.actor_id&&receipt.audience===stored.audience&&String(receipt.scope_topic_id)===String(stored.scope_topic_id)&&Number(receipt.source_message_id)===Number(stored.source_message_id);
}
async function artifactDelivery(db:Database,id:string,c:ToolContext){
 const row=await one(db,"SELECT a.id,a.name,a.mime,a.content,a.encoding,a.revision,a.source_message_id,o.status,o.audience,o.source_message_id AS delivery_source,o.revision AS delivery_revision,o.body FROM agent_artifacts a LEFT JOIN outbox o ON o.kind='artifact' AND o.body->>'id'=a.id::text WHERE a.id=$1 AND a.actor_id=$2 ORDER BY o.id DESC LIMIT 1",[id,c.actorId]);
 if(!row)return {found:false};if(row.audience==='private'&&c.audience!=='private')throw new ToolError('private_delivery');
 const receipt=row.status==='sent'?row.body?.deliveryReceipt:undefined,bytes=Buffer.from(row.content,row.encoding==='base64'?'base64':'utf8');
 const bound=receipt?.message_id&&receipt.actor_id===c.actorId&&String(receipt.scope_topic_id)===c.topicId&&Number(receipt.source_message_id)===Number(row.delivery_source)&&Number(row.delivery_source)===Number(row.source_message_id)&&row.revision===c.revision&&row.delivery_revision===c.revision&&boundOutput(receipt,row.id,bytes,row.mime,c.revision);
 const kinds=bound?await decodedOutputKinds(bytes,row.mime):[];
 return {id:row.id,name:row.name,status:row.status==='sent'?'delivered':row.status,deliveryReceipt:receipt,...(bound?{outputProof:{id:row.id,sha256:bytesHash(bytes),bytes:bytes.length,mime:row.mime,revision:row.revision,receipt_message_id:receipt.message_id,readback_verified:true,kinds}}:{})};
}
async function libraryDelivery(db:Database,e:Evolution,id:string,c:ToolContext){
 const row=await one(db,'SELECT p.*,m.title,m.sha256 FROM media_publications p JOIN media_assets m ON m.id=p.asset_id WHERE p.id=$1 AND p.actor_id=$2',[id,c.actorId]);if(!row)return {found:false};
 const raw=row.status==='delivered'?row.receipts?.[0]:undefined,receipt=raw?.message_ids?.length?{...raw,message_id:raw.message_ids[0]}:undefined;
 if(receipt?.audience==='private'&&c.audience!=='private')throw new ToolError('private_delivery');
 let outputProof:any,sha256:string|undefined=row.sha256;
 if(receipt){
  try{
   const historical=await one(db,"SELECT body,revision,source_message_id,audience FROM outbox WHERE kind='media_asset' AND status='sent' AND actor_id=$1 AND body->>'publicationId'=$2 ORDER BY id DESC LIMIT 1",[c.actorId,id]);
   const data=await e.media.bytes(row.asset_id,row.manifest.version,c);sha256=data.asset.sha256;
   const matching=historical&&sameReceipt(receipt,historical.body.deliveryReceipt)&&receipt.actor_id===c.actorId&&String(receipt.scope_topic_id)===c.topicId&&historical.revision===c.revision&&Number(receipt.source_message_id)===Number(historical.source_message_id)&&row.manifest.id===data.asset.id&&row.manifest.sha256===data.asset.sha256&&historical.body.id===data.asset.id&&Number(historical.body.version)===Number(data.asset.version)&&historical.body.sha256===data.asset.sha256&&(!receipt.output||boundOutput(receipt,data.asset.id,data.bytes,data.asset.mime,c.revision,Number(data.asset.version)));
   if(matching){
    const kinds=await decodedOutputKinds(data.bytes,data.asset.mime);
    if(historical.body.mediaJobId){
     const job=await one(db,'SELECT * FROM media_jobs WHERE id=$1',[historical.body.mediaJobId]);
     const resource=job&&await one(db,job.kind==='album'?'SELECT version FROM archive_collections WHERE id=$1':'SELECT version FROM studio_projects WHERE id=$1',[job.resource_id]);
     const invalidInput=job&&await one(db,"SELECT i.asset_id FROM media_job_inputs i LEFT JOIN media_assets a ON a.id=i.asset_id WHERE i.job_id=$1 AND (a.id IS NULL OR a.status<>'available' OR a.version<>i.asset_version OR a.audience='private' AND (a.owner_id<>$2 OR $3<>'private')) LIMIT 1",[job.id,c.actorId,c.audience||'group']);
     if(!job||job.status!=='ready'||job.stage!=='verified'||job.output_id!==data.asset.id||job.actor_id!==c.actorId||job.topic_id!==c.topicId||job.audience!==receipt.audience||job.revision!==c.revision||Number(resource?.version)!==Number(job.resource_version)||digest(job.manifest)!==job.manifest_hash||invalidInput)kinds.length=0;
     else if(job.kind==='album'&&kinds.includes('pdf')&&job.verification?.pdf?.decoded===true&&job.verification.pdf.attachments_verified===true){
      const actual=await inspectAlbumPdf(data.bytes),verified=job.verification.pdf;
      if(actual.pages===verified.pages&&actual.attachments.length===verified.attachments?.length&&verified.attachments.every((expected:any)=>actual.attachments.some(item=>item.name===expected.name&&item.sha256===expected.sha256&&item.bytes===expected.bytes)))kinds.push('album');
     }
    }
    outputProof={id:data.asset.id,sha256:data.asset.sha256,bytes:data.bytes.length,mime:data.asset.mime,revision:c.revision,version:Number(data.asset.version),receipt_message_id:receipt.message_id,readback_verified:true,kinds};
   }
  }catch(error){checkOperation();if(error instanceof ToolError&&/private/.test(error.code))throw error;}
 }
 return {id:row.id,asset_id:row.asset_id,title:row.title,sha256,status:row.status,deliveryReceipt:receipt,...(outputProof?{outputProof}:{})};
}
export class Evolution {
 readonly storage:StorageLifecycle;readonly images:ImageDesigns;readonly series:Recurring;readonly stock:Household;readonly media:MediaWorkshop;readonly learning:Learning;readonly calendar:CalendarSync;readonly groupCalendar:GroupCalendar;readonly browser:MediaBrowser;private maintenanceAt=0;
 constructor(private db:Database,config:Config,brain:Brain){this.storage=new StorageLifecycle(db);this.series=new Recurring(db);this.stock=new Household(db);this.media=new MediaWorkshop(db,config);this.learning=new Learning(db,brain);this.calendar=new CalendarSync(db,config.runtimeDir);this.groupCalendar=new GroupCalendar(db,config.runtimeDir);this.browser=new MediaBrowser(db,this.media);this.images=new ImageDesigns(db,config,this.media);}
 async next(){const progress=await this.media.next();await this.series.tick();if(Date.now()>this.maintenanceAt){this.maintenanceAt=Date.now()+60000;await Promise.allSettled([this.media.maintenance(),this.calendar.maintenance(),this.storage.cleanup(),this.db.query('DELETE FROM resource_views WHERE expires_at<now()')]);}return progress;}
}
export function evolution(db:Database,config:Config,brain:Brain){let hub=hubs.get(db);if(!hub){hub=new Evolution(db,config,brain);hubs.set(db,hub);}return hub;}
export function registerEvolutionTools(db:Database,config:Config,brain:Brain,add:(n:string,d:Definition)=>void){const e=evolution(db,config,brain);registerOfficeTools(db,config,add);registerAddressedTools(db,config,brain,add);
 add('poll.read',{description:'Адресно перечитати збережене голосування цієї теми: точна кількість голосів за кожним варіантом і сторінка до 50 відповідей; after_user_id для продовження.',schema:z.object({poll_id:z.string().min(1).max(120),after_user_id:z.string().max(30).default(''),limit:z.number().int().min(1).max(50).default(20)}),run:(a,c)=>db.tx(async sql=>{const live=await state(sql,true);if(live.paused||live.memory_revision!==c.revision)throw new ToolError('context_changed');const poll=await one(sql,'SELECT poll_id,question,options,closed,message_id FROM polls WHERE poll_id=$1 AND topic_id=$2',[a.poll_id,c.topicId]);if(!poll)throw new ToolError('poll_unavailable');const counts=(await sql.query('SELECT option::integer AS option_id,count(*)::integer AS votes FROM poll_votes v CROSS JOIN LATERAL jsonb_array_elements_text(v.option_ids) option WHERE v.poll_id=$1 GROUP BY option ORDER BY option::integer',[a.poll_id])).rows,rows=(await sql.query('SELECT user_id,name,option_ids FROM poll_votes WHERE poll_id=$1 AND user_id>$2 ORDER BY user_id LIMIT $3',[a.poll_id,a.after_user_id,a.limit+1])).rows,total=await one(sql,'SELECT count(*)::integer AS voters FROM poll_votes WHERE poll_id=$1',[a.poll_id]);return {...poll,counts,voters_total:total!.voters,votes:rows.slice(0,a.limit),next_after_user_id:rows.length>a.limit?rows[a.limit-1]!.user_id:undefined};})});
 add('storage.status',{description:'Власнику чату: фактичний обсяг таблиць і правила зберігання оригіналів, результатів, кешів і доставки.',schema:z.object({}),run:async(_a,c)=>{if((await state(db)).owner_id!==c.actorId)throw new ToolError('chat_owner_required');return {...await e.storage.status(),heavy_work:workerMetrics()};}});
 add('storage.cleanup',{description:'Власнику чату: очистити прострочені кеші й дублікати завершених запитів; оригінали, файли, докази інструментів, квитанції та ключі повторів зберігаються.',schema:z.object({}),run:async(_a,c)=>{if((await state(db)).owner_id!==c.actorId)throw new ToolError('chat_owner_required');return e.storage.cleanup();}});
 add('artifact.remove',{description:'Видалити власний збережений файл і його майбутні доставки, щоб керувати місцем. Уже завантажені зовнішні копії не відкликаються.',schema:z.object({id:z.string().uuid()}),run:async(a,c)=>db.tx(async sql=>{const row=await one(sql,'SELECT id FROM agent_artifacts WHERE id=$1 AND actor_id=$2',[a.id,c.actorId]);if(!row)throw new ToolError('own_artifact_required');await sql.query("DELETE FROM outbox WHERE body->>'id'=$1 AND status<>'sent'",[a.id]);await sql.query('DELETE FROM agent_artifacts WHERE id=$1',[a.id]);return {removed:true};})});
 add('library.delivery',{description:'Перевірена квитанція конкретної публікації збереженого матеріалу. Тільки delivered з provider receipt підтверджує надсилання; інші статуси не є успіхом.',schema:z.object({id:z.string().uuid()}),run:(a,c)=>libraryDelivery(db,e,a.id,c)});
 add('artifact.delivery',{description:'Фактична доставка власного конкретного артефакту: усі ID повідомлень, назва й SHA256. queued/uncertain не означає надіслано.',schema:z.object({id:z.string().uuid()}),run:(a,c)=>artifactDelivery(db,a.id,c)});
 add('statistics.preferences',{description:'Особиста згода або відмова від майбутнього включення свого рахунку до статистичного рейтингу цієї групи. Типово рейтинг вимкнений; відмова відразу прибирає автора з нових вибірок.',schema:z.object({ranking_opt_in:z.boolean()}),run:async(a,c)=>{await db.query('INSERT INTO statistics_preferences(user_id,ranking_opt_in,source_message_id) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET ranking_opt_in=$2,source_message_id=$3',[c.actorId,a.ranking_opt_in,c.sourceId||null]);return {ranking_opt_in:a.ranking_opt_in};}});
 add('image.render',{description:'Погодити і створити точну редакцію зображення з image.design. Повертає збережений матеріал; надсилання окремо. Генерація моделлю доступна тільки через вже налаштований провайдер.',effect:true,schema:z.object({id:z.string().uuid(),version:z.number().int().positive()}),summary:async(a,c)=>{const row=await one(db,'SELECT spec,audience FROM image_designs WHERE id=$1 AND actor_id=$2 AND topic_id=$3 AND version=$4',[a.id,c.actorId,c.topicId,a.version]);if(!row||row.audience==='private'&&c.audience!=='private'&&Number(c.chatId)<0)throw new ToolError('own_image_design_required');return `Створити «${row.spec.title}» — ${row.spec.mode==='model'?'нова ілюстрація через налаштовану модель':row.spec.mode==='collage'?'колаж із вибраних матеріалів':'картка з текстом'}.\n${row.spec.text||row.spec.prompt||''}\nАудиторія: ${row.audience==='private'?'особисто':'ця група'}.`;},run:(a,c)=>e.images.run(ImageDesign.parse({...a,operation:'render'}),c)});
 add('image.design',{description:'Контекстний візуальний результат: спершу propose з конкретним задумом/референсами й аудиторією, потім render поточної version. Локальні картки й колажі з Люменом, або нова ілюстрація через вже налаштовану image-модель. Не пропонуй картинки автоматично до кожної відповіді. Результат зберігається як окремий матеріал; публікація окрема.',schema:ImageDesign,run:(a,c)=>{if(a.operation==='render')throw new ToolError('use_image_render');return e.images.run(a,c);}});
 add('game.result',{description:'Прочитати результат завершеної гри та історію виправлень. correct: власник/ведучий може виправити конкретні бали за поточною canonical version і справжньою причиною з повідомлення; обидва engines, попередні редакції доступні. scores є patch учасників, а не новим рейтингом різних механік.',schema:GameResultCommand,run:(a,c)=>new GameResults(db).run(a,c)});
 add('library.related',{description:'Відкрити матеріали, пов’язані з подією, грою, сесією, альбомом або проєктом: тільки доступні актуальні версії, зі зрозумілими кнопками відкрити/отримати. after_asset_id для продовження.',schema:RelatedQuery,run:(a,c)=>e.browser.related(a,c)});
 add('game.history',{description:'Оригінальні ходи збереженої гри сторінками; історія не росте всередині поточного стану. legacy_game_id для коротких ігор, session_id для активностей.',schema:z.object({legacy_game_id:z.number().int().positive().optional(),session_id:z.string().uuid().optional(),after:z.number().int().min(-1).default(-1),limit:z.number().int().min(1).max(20).default(12)}),run:async(a,c)=>{if(Boolean(a.legacy_game_id)===Boolean(a.session_id))throw new ToolError('one_game_required');const table=a.legacy_game_id?'game_segments':'activity_story_segments',key=a.legacy_game_id?'game_id':'session_id',parent=a.legacy_game_id?'games':'activity_sessions',id=a.legacy_game_id||a.session_id;if(!await one(db,`SELECT id FROM ${parent} WHERE id=$1 AND topic_id=$2`,[id,c.topicId]))throw new ToolError('game_unavailable');return (await db.query(`SELECT ordinal,user_id,body,source_message_id FROM ${table} WHERE ${key}=$1 AND ordinal>$2 ORDER BY ordinal LIMIT $3`,[id,a.after,a.limit])).rows;}});
 add('schedule.series',{description:'Повторювані нагадування й задачі: для простого явного reminder operation=create із rule+quote одразу створює одну shared серію без опитування учасників; private лишається окремим. preview показує 3 місцеві дати з часовим поясом і DST, confirm активує точну версію; пропустити/перенести одну появу, переглянути/змінити/завершити серію. Зміна всієї серії потребує нового підтвердження; після простою reminder може об’єднати пропуски, а task чекає перегляду (перенести move або skip); catch_up=skip пропускає їх.',schema:SeriesCommand,run:(a,c)=>e.series.run(a,c)});
 add('lists.manage',{description:'Прості покупки/справи: add з text або items до 50 рядків без кількостей; list поточної теми; complete/remove за exact text або id+version. Ціль і кожен пункт batch мають походити з поточного доручення; source_ids лише для доказових «це/його». Прямий add не потребує list. quote — точна цитата. Особистий список веди в особистому чаті; груповий запит не відкриває private дані. Неоднозначність повертає одне question.',schema:ListCommand,run:(a,c)=>new SimpleLists(db).run(a,c)});
 add('stock.manage',{description:'Кількісний облік спільних запасів: г/мл/штуки, невідомо окремо від нуля, потреби й резерви, чек із підтвердженням, скасування руху. Спочатку list; зміни потребують поточної version. Для простих текстових покупок/справ без кількостей використовуй lists.manage.',schema:StockCommand,run:(a,c)=>{if(a.operation==='confirm_receipt')throw new ToolError('use_stock_confirm');return e.stock.run(a,c);}});
 add('library.browse',{description:'Відкрити зручний перелік з кнопками: матеріали, альбоми, історії, події, ігри, статистика. Фільтри назви/періоду, сторінки; повертає лише доступні поточному читачеві результати.',schema:BrowseQuery,run:(a,c)=>e.browser.open(a,c)});
 add('library.asset',{description:'Зберегти відоме вкладення як довговічний матеріал, прочитати метадані, відкликати власний, зв’язати з подією/грою/проєктом або дозволити конкретну аудиторію. Чуже приватне вкладення не стає спільним. Надсилання окремим library.publish.',schema:AssetCommand,run:(a,c)=>{if(a.operation==='publish')throw new ToolError('use_library_publish');if(['allow_group','allow_destination'].includes(a.operation))throw new ToolError('use_library_share');return e.media.run(a,c);}});
 add('stock.confirm',{description:'Підтвердити конкретну чернетку чека після перевірки назв, одиниць і кількостей. Показує людям точні рядки; запис у запасах не означає зовнішню покупку.',effect:true,schema:z.object({receipt_id:z.string().uuid()}),summary:async(a,c)=>{const receipt=await one(db,"SELECT lines FROM stock_receipts WHERE id=$1 AND actor_id=$2 AND status='draft'",[a.receipt_id,c.actorId]);if(!receipt)throw new ToolError('own_draft_receipt_required');const names=(await db.query('SELECT id,name FROM stock_items WHERE id=ANY($1::uuid[])',[receipt.lines.map((x:any)=>x.id)])).rows;return 'Записати чек у спільні запаси:\n'+receipt.lines.map((line:any)=>`${names.find(x=>x.id===line.id)?.name||'Недоступний товар'} — ${line.quantity} ${line.unit}`).join('\n')+'\nКожен рядок буде застосовано один раз.';},run:(a,c)=>e.stock.run(StockCommand.parse({operation:'confirm_receipt',receipt_id:a.receipt_id}),c)});
 add('library.share',{description:'Явно погодити зміну аудиторії власного матеріалу: у цю групу або право публікації точної версії в конкретному каналі. Без погодження приватний матеріал не стає спільним.',effect:true,schema:AssetCommand,summary:async(a,c)=>{if(!['allow_group','allow_destination'].includes(a.operation))throw new ToolError('share_operation_required');const asset=await assetFor(db,a.id!,a.version,c);if(asset.owner_id!==c.actorId)throw new ToolError('asset_owner_required');const destination=a.destination_id?await one(db,"SELECT title FROM media_destinations WHERE id=$1 AND owner_id=$2 AND status='active'",[a.destination_id,c.actorId]):undefined;if(a.operation==='allow_destination'&&!destination)throw new ToolError('own_destination_required');return `Дозволити використання «${asset.title}», редакція ${asset.version}: ${a.operation==='allow_group'?'у цій групі':'публікація в каналі «'+destination!.title+'»'}.`;},run:(a,c)=>{if(!['allow_group','allow_destination'].includes(a.operation))throw new ToolError('share_operation_required');return e.media.run(a,c);}});
 add('library.publish',{description:'Надіслати точну версію збереженого файла в поточну тему/особистий чат або раніше зареєстрований канал. Канал потребує дозволу автора на цю версію й перевірки прав. queued не означає доставлено.',effect:true,schema:z.object({id:z.string().uuid(),version:z.number().int().positive(),caption:z.string().max(900).default(''),destination_id:z.string().uuid().optional()}),run:(a,c)=>e.media.run({...a,operation:'publish'},c)});
 add('library.destination',{description:'Зареєструвати канал для погоджених публікацій: потрібні права адміністратора автора й право бота надсилати. Це не вмикає читання каналу.',effect:true,schema:z.object({chat_id:z.string().max(100)}),run:(a,c)=>e.media.registerDestination(a,c)});
 add('archive.manage',{description:'Спільний або особистий альбом: створення, внески до 50 матеріалів, авторські підписи/дати з позначкою факт/жарт/непевно, перегляд, реальний PDF-експорт, скасування. Експорт асинхронний; готовий файл є матеріалом бібліотеки.',schema:CollectionCommand,run:(a,c)=>e.media.collection(a,c)});
 add('studio.manage',{description:'Монтаж наданих фото й MP4: до 20 сцен/90 секунд, підписи, обрізання, порядок, попередній перегляд. Музика тільки з наданого файла: library.asset capture, потім set_soundtrack з asset_id/asset_version; start обрізає початок, loop повторює короткий трек, volume та fade_in/fade_out керують рівнем і плавністю. remove_soundtrack прибирає трек. Для запиту з музикою export/preview завжди require_audio=true; якщо джерела немає, попроси один аудіофайл. Не генерує нове відео, музику чи голос і не зберігає автоматично оригінальний звук сцен. Перевіряє фактичні звук/відео та права на джерела. Експорт фоновий, готовий файл надішле сам; queued не означає готово чи доставлено. cancel зупиняє job.',schema:StudioCommand,run:(a,c)=>e.media.studio(a,c)});
 add('library.jobs',{description:'Власні монтажі цієї теми: фактичний стан, зрозуміле пояснення збою, перевірка звуку й відео, output_id/output_version та окремий стан доставки з квитанцією. repair дозволяє явний повторний export після виправлення; ready означає збережений файл, лише delivered з квитанцією підтверджує надсилання.',schema:z.object({}),run:(_a,c)=>e.media.jobs(c)});
 add('learn.manage',{description:'Лише приватне навчання: ціль, план до 30 вправ з передумовами, практика, відповіді/пропуск, пояснення, апеляція, пауза, видалення. Нове формулювання не переоцінює стару відповідь; key_correction виправляє ключ. Оцінка за рубрикою позначається окремо від точної перевірки.',schema:LearningCommand,run:(a,c)=>e.learning.run(a,c)});
 add('calendar.read',{description:'Особистий CalDAV: майстер підключення, список підключень, зайняті інтервали лише для обмеженого вікна, власні підтверджені події, відключення/звірка. Логіни й паролі лише в приватному майстрі; недоступний календар не вільний.',schema:CalendarCommand,run:(a,c)=>{if(['create','update','cancel','link_event'].includes(a.operation))throw new ToolError('use_calendar_write');return e.calendar.run(a,c);}});
 add('calendar.write',{description:'Окремо погоджений запис/зміна/скасування події власника у CalDAV з ETag, повторним читанням і квитанцією. Жодного припущення про участь інших; непевна відповідь звіряється без повторного створення.',effect:true,schema:CalendarCommand,run:(a,c)=>{if(!['create','update','cancel'].includes(a.operation))throw new ToolError('write_operation_required');return e.calendar.run(a,c);}});
 add('calendar.group',{description:'Підібрати спільний час: обмежене вікно й добровільні приватні внески учасників, ручна відповідь, спільні вільні вікна без назв особистих подій, явний вибір часу. Доступність не підтверджує участь; календарний запис окремий.',schema:CalendarProposal,run:(a,c)=>e.groupCalendar.run(a,c)});
 return e;
}
