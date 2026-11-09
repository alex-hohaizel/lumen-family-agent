const order=['now','local_time','timezone','current_author','current_topic','available_tools','capabilities','task','engagement_context','behavior_context','personalization','interaction','interaction_event','active_dialogue','clarification_of_current_author','replying_to','reminder_roots','tool_results_untrusted','game','facilitator_private_state','available_stickers','notes','rules','skills','recent','scheduled_actions','reminders','collaboration','feedback','related_discussions','media_context','attachments','image_jobs','recent_bot_turns','recent_polls','recent_choices','episodes_generated_not_verified'];
const size=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const notice='Це обмежена вибірка, не вся пам’ять. Відсутній фрагмент не доводить відсутності факту. memory.search/memory.original/history/library.browse читають оригінали адресно; tools.describe повертає схеми інструментів.';

export function packContext(raw:Record<string,any>,maxBytes=72000){
 const {context_coverage:previous,...input}=raw;
 const priorOmitted:Record<string,number>={};
 for(const [key,value] of Object.entries(previous?.omitted||{})){
  if(key!=='context_coverage'&&Number.isSafeInteger(value)&&Number(value)>0)priorOmitted[key]=Number(value);
 }
 const clip=(value:any)=>{
  if(typeof value!=='string')return value;
  let out='';for(const char of value){if(Buffer.byteLength(out+char)>720)break;out+=char;}return out;
 };
 const stickers=Array.isArray(input.available_stickers)?input.available_stickers.map((x:any)=>({id:x.id,emoji:x.emoji,set_name:x.set_name,description:String(x.description||'').slice(0,100),keywords:x.keywords})):undefined;
 // Engine orders our own pack first. Preserve those scenes while compacting
 // tool summaries; their complete contracts remain available in tools.describe.
 const preferredSet=stickers?.find((x:any)=>x.set_name)?.set_name;
 const preferred=stickers?.filter((x:any)=>!preferredSet||x.set_name===preferredSet)||[];
 const tools=Array.isArray(input.available_tools)?input.available_tools:undefined;
 const normalized={...input,...(Array.isArray(input.recent)?{recent:input.recent.map((x:any)=>({...x,body:clip(x.body)}))}:{}),...(stickers?{available_stickers:stickers}:{})};
 const pack=(descriptionLimit:number)=>{
  const values={...normalized,...(tools?{available_tools:tools.map((x:any)=>({...x,description:descriptionLimit?x.description?.slice(0,descriptionLimit):undefined}))}:{})};
  const result:Record<string,any>={},omitted={...priorOmitted};
  const missing=(key:string,count:number)=>{if(count>0)omitted[key]=(omitted[key]||0)+count;};
  const budget=maxBytes-Math.max(1600,size(priorOmitted)+800);
  for(const key of [...new Set([...order,...Object.keys(values)])]){
   const value=values[key as keyof typeof values];if(value===undefined)continue;
   if(size({...result,[key]:value})<=budget){result[key]=value;continue;}
   if(Array.isArray(value)){
    const kept=[];for(const item of value){if(size({...result,[key]:[...kept,item]})>budget)break;kept.push(item);}
    result[key]=kept;missing(key,value.length-kept.length);
   }else if(value&&typeof value==='object'){
    const kept:Record<string,any>={};
    for(const [field,v] of Object.entries(value)){if(size({...result,[key]:{...kept,[field]:v}})>budget){missing(key,1);continue;}kept[field]=v;}
    result[key]=kept;
   }else missing(key,1);
  }
  const previousLimit=Number(previous?.tool_description_max_chars);
  result.context_coverage={budget_bytes:maxBytes,omitted,...(tools?{tool_description_max_chars:Number.isFinite(previousLimit)?Math.min(previousLimit,descriptionLimit):descriptionLimit}:{}),notice};
  return result;
 };
 let result=pack(90);
 if(tools&&preferred.length){
  for(const limit of [60,30,0]){
   const kept=result.available_stickers||[];
   if(result.available_tools?.length===tools.length&&kept.filter((x:any)=>!preferredSet||x.set_name===preferredSet).length===preferred.length)break;
   result=pack(limit);
  }
 }
 return JSON.stringify(result);
}
