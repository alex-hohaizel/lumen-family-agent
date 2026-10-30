import {one,type SQL} from './db.js';
import {ToolError} from './safe-http.js';

export type MediaAudioIntent='required'|'silent'|'unspecified';
export type MediaAudioSource='original'|'soundtrack';
export interface MediaAudioExpectation {
 mode:MediaAudioIntent;required:boolean;source_ids:number[];basis:'source'|'goal'|'prior'|'none';
 audio_source?:MediaAudioSource;
 task_id?:string;goal_version?:number;actor_id:string;topic_id:string;audience?:'group'|'private';
}
export interface MediaAudioContext {actorId:string;topicId:string;revision:number;sourceId?:number;taskId?:string;goalVersion?:number;actionId?:string;requestText?:string;resourceId?:string;audience?:'group'|'private';}

/** Explicit audio instruction only. Quoted material and informational requests do not author a soundtrack. */
export function parseMediaAudioInstruction(text:string):{mode:MediaAudioIntent;audio_source?:MediaAudioSource} {
 const clean=text.replace(/```[\s\S]*?```|«[^»]*»|[“"][^”"\n]*[”"]|`[^`\n]*`/g,'');let instruction:{mode:MediaAudioIntent;audio_source?:MediaAudioSource}={mode:'unspecified'};
 const music='(?:музик[\\p{L}]*|музык[\\p{L}]*|трек[\\p{L}]*|саундтрек[\\p{L}]*|music|soundtrack|audio(?:\\s+track)?)';
 const sound='(?:звук[\\p{L}]*|звучан[\\p{L}]*|аудіо|аудио|audio|sound)',original='(?:оригінальн[\\p{L}]*|оригинальн[\\p{L}]*|початков[\\p{L}]*|вихідн[\\p{L}]*|original|native|source)';
 for(const part of clean.split(/[.!?;\n]+/u)){
  if(/^\s*(?:(?:люмене?|lumen|@\w+)[,!: ]+)?(?:(?:будь ласка|можеш|можете|please|could you)\s+)?(?:поясн|розкаж|порівня|проаналіз|порад|обговор|знайди|дослід|объясн|расскаж|сравн|посовет|найди|explain|describe|recommend|research|find|how\s+to|як\s+(?:зробити|додати)|как\s+(?:сделать|добавить))/iu.test(part))continue;
  const silent=new RegExp(`(?<![\\p{L}])(?:без\\s+(?:${original}\\s+)?(?:${music}|звуку|звука|аудіо|аудио)|(?:прибери|забери|видали|вимкни|убери|удали|отключи|remove|mute|without)\\s+(?:цю\\s+|эту\\s+|the\\s+)?(?:${original}\\s+)?(?:${music}|звук[\\p{L}]*|sound)|(?:не\\s+(?:додавай|добавляй|треба|потрібна|нужна)|no)\\s+${music}|(?:(?:не\\s+(?:залишай|зберігай|сохраняй|оставляй))|(?:do\\s+not|don't)\\s+(?:keep|preserve|retain))\\s+(?:the\\s+)?(?:${original}\\s+)?${sound}|silent\\s+(?:video|clip|movie))`,'giu');
  const required=new RegExp(`(?<![\\p{L}])(?:(?:з|із|зі|с|під|под|with|to)\\s+(?:(?:надан[\\p{L}]*|ці[\\p{L}]*|цю|цей|додан[\\p{L}]*|эту|этот|provided|supplied|this|the)\\s+){0,3}${music}|(?:додай|додати|залиши|поверни|збережи|добавь|добавить|оставь|верни|add|keep|include|restore)\\s+(?:цю\\s+|эту\\s+|the\\s+)?${music}|(?:потрібна|треба|нужна|need)\\s+${music})`,'giu');
  const native=new RegExp(`(?<![\\p{L}])(?:(?:залиши|збережи|зберегти|поверни|оставь|сохрани|сохранить|верни|keep|preserve|retain|restore)\\s+(?:(?:цей|цю|той|його|її|the|its|this)\\s+)?(?:${original}\\s+)?${sound}|(?:з|із|зі|с|with)\\s+${original}\\s+${sound})(?![\\p{L}])`,'giu');
  const negated=(index:number)=>/(?:^|\s)(?:не|don't|do not)\s+$/iu.test(part.slice(0,index));
  const matches=[...part.matchAll(silent)].map(x=>({index:x.index!,mode:'silent' as MediaAudioIntent,audio_source:undefined as MediaAudioSource|undefined})).concat([...part.matchAll(required)].filter(x=>!negated(x.index!)).map(x=>({index:x.index!,mode:'required' as MediaAudioIntent,audio_source:'soundtrack' as MediaAudioSource|undefined})),[...part.matchAll(native)].filter(x=>!negated(x.index!)).map(x=>({index:x.index!,mode:'required' as MediaAudioIntent,audio_source:'original' as MediaAudioSource|undefined})));
  for(const match of matches.sort((a,b)=>a.index-b.index))instruction={mode:match.mode,...(match.audio_source?{audio_source:match.audio_source}:{})};
 }
 return instruction;
}
export function parseMediaAudioIntent(text:string):MediaAudioIntent{return parseMediaAudioInstruction(text).mode;}

/** Read actual own sources/current goal; model flags and titles are never the sole audio authority. */
export async function resolveMediaAudioExpectation(sql:SQL,c:MediaAudioContext,prior?:MediaAudioExpectation|null):Promise<MediaAudioExpectation>{
 const base={actor_id:c.actorId,topic_id:c.topicId,audience:c.audience},none:MediaAudioExpectation={...base,mode:'unspecified',required:false,source_ids:[],basis:'none'};
 const source=c.sourceId?await one(sql,"SELECT id,body FROM messages WHERE id=$1 AND user_id=$2 AND topic_id=$3 AND role='user'",[c.sourceId,c.actorId,c.topicId]):undefined;
 if(c.sourceId&&!source)throw new ToolError('media_source_unavailable');
 const make=(mode:MediaAudioIntent,basis:MediaAudioExpectation['basis'],ids:number[],task?:any,audioSource?:MediaAudioSource):MediaAudioExpectation=>({...base,mode,required:mode==='required',source_ids:[...new Set(ids.filter(id=>Number.isSafeInteger(id)&&id>0))],basis,...(mode==='required'&&audioSource?{audio_source:audioSource}:{}),...(task?{task_id:String(task.id),goal_version:Number(task.goal_version)}:{})});
 let task:any;if(c.taskId){task=await one(sql,'SELECT id,actor_id,topic_id,revision,source_message_id,goal,goal_version,criteria,status FROM agent_tasks WHERE id=$1',[c.taskId]);if(!task||task.actor_id!==c.actorId||task.topic_id!==c.topicId||task.revision!==c.revision||c.goalVersion&&task.goal_version!==c.goalVersion)throw new ToolError('task_cancelled');}
 const own=parseMediaAudioInstruction(String(source?.body||'')),ownMode=own.mode;
 if(ownMode!=='unspecified'&&(!task||Number(source?.id)!==Number(task.source_message_id)))return make(ownMode,'source',[Number(source!.id)],task,own.audio_source);
 if(task&&Number(task.goal_version)>1&&Array.isArray(task.criteria)&&task.criteria.includes('media')){
  const mode=task.criteria.includes('media_silent')?'silent':task.criteria.includes('media_audio')?'required':'unspecified';
  const sources=(await sql.query("SELECT m.id,m.body FROM provenance_edges p JOIN messages m ON m.id=p.source_message_id WHERE p.derived_kind='task' AND p.derived_key=$1::text AND m.user_id=$2 AND m.topic_id=$3 AND m.role='user' ORDER BY m.id DESC",[task.id,c.actorId,c.topicId])).rows;
  const authoritative=sources.find(row=>mode!=='unspecified'&&parseMediaAudioIntent(String(row.body))===mode),instruction=parseMediaAudioInstruction(String(authoritative?.body||task.goal));
  if(instruction.audio_source==='original'&&!authoritative)throw new ToolError('media_source_unavailable');
  return make(mode,'goal',authoritative?[Number(authoritative.id)]:[],task,instruction.audio_source);
 }
 if(ownMode!=='unspecified')return make(ownMode,'source',[Number(source!.id)],task,own.audio_source);
 if(task){
  const goal=parseMediaAudioInstruction(String(task.goal)),mode=task.criteria?.includes('media_silent')?'silent':task.criteria?.includes('media_audio')?'required':goal.mode;
  if(mode!=='unspecified'){
   if(mode==='required'&&goal.audio_source==='original'){
    const sources=(await sql.query("SELECT m.id,m.body FROM messages m WHERE m.user_id=$2 AND m.topic_id=$3 AND m.role='user' AND (m.id=$4 OR EXISTS(SELECT 1 FROM provenance_edges p WHERE p.derived_kind='task' AND p.derived_key=$1::text AND p.source_message_id=m.id)) ORDER BY m.id DESC",[task.id,c.actorId,c.topicId,task.source_message_id])).rows,authoritative=sources.find(row=>parseMediaAudioInstruction(String(row.body)).audio_source==='original');
    if(!authoritative)throw new ToolError('media_source_unavailable');return make(mode,'goal',[Number(authoritative.id)],task,'original');
   }
   return make(mode,'goal',source?[Number(source.id)]:[],task,goal.audio_source);
  }
 }
 if(prior&&prior.actor_id===c.actorId&&prior.topic_id===c.topicId&&(!prior.audience||!c.audience||prior.audience===c.audience)&&prior.mode!=='unspecified'&&Array.isArray(prior.source_ids)&&prior.source_ids.length){
  const ids=[...new Set(prior.source_ids.map(Number))],live=(await sql.query("SELECT id FROM messages WHERE id=ANY($1::bigint[]) AND user_id=$2 AND topic_id=$3 AND role='user'",[ids,c.actorId,c.topicId])).rows;
  const goal=prior.task_id?await one(sql,'SELECT goal_version FROM agent_tasks WHERE id=$1 AND actor_id=$2 AND topic_id=$3',[prior.task_id,c.actorId,c.topicId]):undefined;
  if(live.length===ids.length&&(!prior.task_id||goal&&Number(goal.goal_version)===Number(prior.goal_version)))return make(prior.mode,'prior',ids,task,prior.audio_source);
 }
 return none;
}

/** Pure shared boundary for the exact source timeline rendered and later delivered. */
export function verifiedOriginalAudio(manifest:any,verification:any,assets:ReadonlyArray<{id:string;version:number;mime:string;sha256:string;status?:string}>):boolean{
 if(manifest?.audio_source!=='original'||manifest?.audio_expectation?.audio_source!=='original'||manifest?.audio_expectation?.mode!=='required'||manifest?.require_audio!==true||manifest.soundtrack||verification?.has_soundtrack!==false||verification?.has_original_audio!==true)return false;
 const sources=manifest.audio_expectation.source_ids;if(!Array.isArray(sources)||!sources.length||sources.some((id:any)=>!Number.isSafeInteger(id)||id<=0)||!Array.isArray(verification.audio_source_ids)||sources.length!==verification.audio_source_ids.length||sources.some((id:number,index:number)=>id!==verification.audio_source_ids[index]))return false;
 if(!Array.isArray(manifest.items)||!Array.isArray(manifest.original_audio)||!Array.isArray(verification.original_audio))return false;
 const current=new Map(assets.map(asset=>[asset.id,asset]));
 if(!manifest.items.length||manifest.items.length>20||new Set(manifest.items.map((item:any)=>item?.id)).size!==manifest.items.length||manifest.items.some((item:any)=>{const asset=current.get(item?.asset_id);return !asset||asset.version!==item.asset_version||asset.status&&asset.status!=='available'||!/^(?:video\/mp4|image\/(?:png|jpeg|webp))$/.test(asset.mime)||!Number.isFinite(Number(item.duration))||Number(item.duration)<1||Number(item.duration)>12||!Number.isInteger(Number(item.position))||Number(item.position)<0||!Number.isFinite(Number(item.start_seconds))||Number(item.start_seconds)<0;}))return false;
 const videos=manifest.items.filter((item:any)=>current.get(item?.asset_id)?.mime==='video/mp4');
 if(!videos.length||videos.length!==manifest.original_audio.length||videos.length!==verification.original_audio.length||new Set(videos.map((item:any)=>item.id)).size!==videos.length)return false;
 const total=manifest.items.reduce((sum:number,item:any)=>sum+Number(item.duration),0),final=verification.audio;
 if(!Number.isFinite(total)||total<=0||total>90||final?.codec!=='aac'||final?.decoded!==true||final?.non_silent!==true||!Number.isFinite(final.duration)||Math.abs(final.duration-total)>.15||!Number.isFinite(final.max_db)||!Number.isFinite(final.mean_db)||final.max_db<-60||final.mean_db<-70)return false;
 let audible=0;
 for(const [index,scene]of videos.entries()){
  const binding=manifest.original_audio[index],proof=verification.original_audio[index],asset=current.get(scene.asset_id);
  if(!asset||asset.status&&asset.status!=='available'||asset.version!==scene.asset_version||asset.mime!=='video/mp4'||!/^[a-f0-9]{64}$/.test(asset.sha256))return false;
  const expected={scene_id:scene.id,asset_id:scene.asset_id,asset_version:scene.asset_version,start_seconds:Number(scene.start_seconds),duration:Number(scene.duration),position:Number(scene.position),sha256:asset.sha256};
  if(!Number.isFinite(expected.start_seconds)||expected.start_seconds<0||!Number.isFinite(expected.duration)||expected.duration<1||expected.duration>12||!Number.isInteger(expected.position))return false;
  if(Object.entries(expected).some(([key,value])=>binding?.[key]!==value||proof?.[key]!==value)||proof.decoded!==true||typeof proof.has_audio!=='boolean'||typeof proof.non_silent!=='boolean')return false;
  if(proof.has_audio){
   if(!Number.isFinite(proof.audio_duration)||Math.abs(proof.audio_duration-expected.duration)>.08||!Number.isFinite(proof.max_db)||!Number.isFinite(proof.mean_db)||proof.non_silent!==(proof.max_db>=-60&&proof.mean_db>=-70))return false;
   if(proof.non_silent)audible++;
  }else if(proof.non_silent||proof.audio_duration!==0||proof.max_db!==undefined||proof.mean_db!==undefined)return false;
 }
 return audible>0;
}
