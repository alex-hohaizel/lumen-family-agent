import type {Plan} from './model.js';

export interface OutcomeFact {capability:string;status:'observed'|'prepared'|'queued'|'needs_consent'|'needs_input'|'failed'|'uncertain';reference?:string;detail?:string;confirmed?:'delivery'|'completion';targetKind?:'file'|'calendar'|'activity'|'poll'|'message';targets?:string[];}
export function toolOutcome(name:string,result:any):OutcomeFact {
  if(['telegram.delivery','artifact.delivery','document.delivery','library.delivery'].includes(name)&&result?.status==='delivered'&&(result?.deliveryReceipt?.message_id||result?.delivery_receipt?.message_id))return {capability:name,status:'observed',reference:result?.asset_id||result?.id,confirmed:'delivery',targetKind:name==='telegram.delivery'?'message':'file',targets:[result?.asset_id,result?.id,result?.name,result?.title].filter(Boolean)};
  if(name==='calendar.write'&&result?.provider_readback===true&&result.receipt?.uid)return {capability:name,status:'observed',reference:result.id,confirmed:'completion',targetKind:'calendar',targets:[result.id,result.receipt.uid,result.title].filter(Boolean)};
  if(name==='composition.status'&&result?.phase==='completed')return {capability:name,status:'observed',reference:result.id,confirmed:'completion'};
  if(result?.error)return {capability:name,status:/uncertain|unconfirmed|interrupted/.test(String(result.error))?'uncertain':'failed',detail:String(result.error)};
  if(result?.needs_approval||result?.needs_consent)return {capability:name,status:'needs_consent',reference:result.approval_id||result.id};
  const status=String(result?.status||result?.phase||'');
  if(/uncertain|unconfirmed/.test(status))return {capability:name,status:'uncertain',reference:result?.id};
  if(/failed|blocked|refused/.test(status)||result?.found===false)return {capability:name,status:'failed',reference:result?.id};
  if(/needs_input/.test(status))return {capability:name,status:'needs_input',reference:result?.id};
  if(/queued|pending|delivering|running|active/.test(status))return {capability:name,status:'queued',reference:result?.id};
  if(/prepared|verified|ready/.test(status))return {capability:name,status:'prepared',reference:result?.id};
  return {capability:name,status:'observed',reference:result?.id};
}

export function outcomeMessage(facts:OutcomeFact[]) {
  if(facts.some(x=>x.status==='uncertain'))return 'Результат цієї дії поки не підтверджений. Повторювати її автоматично не буду, щоб не створити дубль. Потрібна перевірка фактичного стану.';
  if(facts.some(x=>x.status==='failed'))return 'Не вдалося виконати потрібний крок. Успішного результату для нього немає; вже збережені дані та відповіді залишилися на місці.';
  if(facts.some(x=>x.status==='needs_consent'))return 'Підготовлено наступний крок. Чекаю потрібного погодження в його картці; сама дія ще не виконана.';
  if(facts.some(x=>x.status==='needs_input'))return 'Для продовження потрібне уточнення. Підготовлений стан збережено.';
  if(facts.some(x=>x.status==='queued'))return 'Підготовлено й поставлено в чергу. Завершення або доставку ще не підтверджено.';
  return '';
}

const terminalObject='(?:файл|документ|звіт|повідомлення|нагадування|голосування|опитування|гру|гра|активність|підсумок|поді[яюї]|календар|ролик|альбом|зображення|картинк[ау]|событи[ея]|календарь|сообщени[ея]|file|document|poll|message|event|calendar|clip|video|album|image)';
const terminalVerb='(?:надіслано|відправлено|доставлено|створено|запущено|завершено|завершена|надіслав|відправив|доставив|створив|запустив|отправлен[оа]?|доставлен[оа]?|создан[оа]?|отправил|создал|sent|delivered|created|completed|published)';
const terminalPattern='(?<![\\p{L}\\p{N}])(?:'+terminalObject+'.{0,60}?'+terminalVerb+'|'+terminalVerb+'.{0,60}?'+terminalObject+')(?![\\p{L}\\p{N}])';
const terminalClaim=new RegExp(terminalPattern,'iu');
function resultClaims(sentence:string){
 const blank=(text:string)=>text.replace(/[^\r\n]/g,' ');
 const visible=sentence.replace(/```[\s\S]*?```/g,blank).replace(/«[^»]*»|[“"][^”"\n]*[”"]|`[^`\n]*`/g,text=>terminalClaim.test(text)?blank(text):text);
 if(/[?？]\s*$/.test(visible)||/^\s*(?:якщо|коли|у разі|за умови|если|if|when)(?=\s|[,:;—]|$)/iu.test(visible)||/(?:не можу|не можу ще|не вдається|не могу|cannot|can't).{0,30}(?:підтверд|ствердж|сказа|confirm|verify)/iu.test(visible))return [];
 const matches=[...visible.matchAll(new RegExp(terminalPattern,'giu'))],claims:string[]=[];
 for(const [index,match] of matches.entries()){
  const at=match.index!,prefix=visible.slice(0,at).split(/[,;:]|—/u).at(-1)||'',verb=match[0].match(new RegExp(terminalVerb,'iu'))!,beforeVerb=match[0].slice(0,verb.index);
  const negated=/(?:^|[\s,])(?:не|not|no|ще не|поки не)\s*(?:(?:вже|ще|поки|yet|already|було|був)\s*)*$/iu;
  if(/^(?:у|в)\s+(?:(?:нашому|нашій|цьому|цій)\s+)?(?:детективі|грі|квесті|пригоді|сцені|історії|сюжеті)\s+[\p{L}][\p{L}’'ʼ-]{1,40}\s*$/iu.test(prefix.trim())&&!/(?:^|\s)(?:я|ми|I|we)(?=\s|$)/iu.test(prefix))continue;
  if(negated.test(beforeVerb)||negated.test(prefix)||/(?:зі слів|каже|написав|повідомив|сказав|he|she)\s*$/iu.test(prefix))continue;
  claims.push(sentence.slice(at,index+1<matches.length?matches[index+1]!.index:undefined));
 }
 return claims;
}

export function gateOutcome(plan:Plan,facts:OutcomeFact[],required=true):{plan:Plan;facts:OutcomeFact[];blocked:boolean} {
  const blocked=facts.some(x=>['failed','uncertain','needs_consent','needs_input'].includes(x.status));
  const unprovenDelivery=facts.some(x=>x.status==='queued');
  const claimText=[plan.reply,plan.presentation?.card?.title,plan.presentation?.card?.summary,...(plan.presentation?.card?.facts||[]),plan.presentation?.card?.question,plan.presentation?.card?.details].filter(Boolean).join('\n');const units=claimText.split(/(?<=[.!?;])\s+|\n|,(?=\s*(?:опитування|голосування|подію|гру|файл|документ))/u).flatMap(resultClaims);
  const invented=units.some(unit=>{
    const delivery=/надіслано|відправлено|доставлено|надіслав|відправив|доставив|отправлен|доставлен|отправил|sent|delivered|published/iu.test(unit),kind=/файл|документ|звіт|ролик|альбом|зображення|картинк[ау]|file|document|clip|video|album|image/iu.test(unit)?'file':/поді[яюї]|событи[ея]|календар|calendar|event/iu.test(unit)?'calendar':/опитування|голосування|poll/iu.test(unit)?'poll':/гр[ау]|активність|activity|game/iu.test(unit)?'activity':'message';
    const eligible=facts.filter(x=>x.confirmed===(delivery?'delivery':'completion')&&(x.targetKind?x.targetKind===kind:kind==='file'?/artifact|document|media|library/.test(x.capability):kind==='activity'?/composition|activity|game/.test(x.capability):kind==='calendar'?/calendar/.test(x.capability):kind==='poll'?/poll|vote/.test(x.capability):/telegram|message/.test(x.capability)));
    if(!eligible.length)return true;
    const named=[...unit.matchAll(/[«“"]([^»”"\n]{2,150})[»”"]|([a-zA-Z0-9_-]{4,}\.(?:pdf|docx|xlsx|png|mp4|csv))|([a-f0-9]{8}-[a-f0-9-]{27})/gu)].map(m=>m[1]||m[2]||m[3]).filter(Boolean);
    return named.some(name=>!eligible.some(f=>[...(f.targets||[]),f.reference].filter(Boolean).some(target=>String(target).toLocaleLowerCase()===String(name).toLocaleLowerCase())));
  });
  if(required&&(blocked||unprovenDelivery||invented)) {
    const trusted=outcomeMessage(facts)||'Не маю підтвердження виконання цієї дії. Перевірений результат поки відсутній.';
    return {plan:{...plan,reply:trusted,actions:[],presentation:undefined,interaction:undefined,offer:undefined,dialogue:undefined,behavior:plan.behavior?{...plan.behavior,move:'repair',clarification:undefined}:undefined},facts,blocked:true};
  }
  return {plan,facts,blocked:false};
}

export function decisionFactsText(facts:OutcomeFact[]) {
  return facts.some(x=>['failed','uncertain','needs_consent','needs_input'].includes(x.status))?outcomeMessage(facts):'';
}
