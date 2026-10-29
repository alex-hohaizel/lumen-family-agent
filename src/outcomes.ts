import type {Plan} from './model.js';

export interface OutcomeFact {capability:string;status:'observed'|'prepared'|'queued'|'needs_consent'|'needs_input'|'failed'|'uncertain';reference?:string;detail?:string;confirmed?:'delivery'|'completion';}
export function toolOutcome(name:string,result:any):OutcomeFact {
  if(['telegram.delivery','artifact.delivery','document.delivery'].includes(name)&&(result?.deliveryReceipt?.message_id||result?.delivery_receipt?.message_id))return {capability:name,status:'observed',reference:result?.id,confirmed:'delivery'};
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

const terminalClaim=/(?:^|\n)\s*(?:готово[!,. ]*|я\s+)?(?:(?:файл|документ|звіт|повідомлення|нагадування|голосування|опитування|гру|гра|активність|підсумок).{0,25}(?:надіслано|відправлено|доставлено|створено|запущено|завершено|завершена|завершена|отправлен|доставлен)|(?:надіслав|відправив|доставив|створив|запустив|отправил|создал).{0,25}(?:файл|документ|звіт|повідомлення|нагадування|голосування|опитування|гру|активність)|(?:file|document|poll|message).{0,20}(?:sent|delivered|created))/iu;

export function gateOutcome(plan:Plan,facts:OutcomeFact[],required=true):{plan:Plan;facts:OutcomeFact[];blocked:boolean} {
  const blocked=facts.some(x=>['failed','uncertain','needs_consent','needs_input'].includes(x.status));
  const unprovenDelivery=facts.some(x=>x.status==='queued');
  const claimText=[plan.reply,plan.presentation?.card?.summary].filter(Boolean).join(' ');const deliveryClaim=/надіслано|відправлено|доставлено|надіслав|відправив|доставив|отправлен|доставлен|sent|delivered/iu.test(claimText);const claimedFile=/файл|документ|звіт|file|document/iu.test(claimText);const matching=facts.some(x=>x.confirmed===(deliveryClaim?'delivery':'completion')&&(!claimedFile||/artifact|document|media|delivery/.test(x.capability)));
  const invented=terminalClaim.test(claimText)&&!matching&&!plan.actions.length;
  if(required&&(blocked||unprovenDelivery||invented)) {
    const trusted=outcomeMessage(facts)||'Не маю підтвердження виконання цієї дії. Перевірений результат поки відсутній.';
    return {plan:{...plan,reply:trusted,actions:[],presentation:undefined,interaction:undefined,offer:undefined,dialogue:undefined,behavior:plan.behavior?{...plan.behavior,move:'repair',clarification:undefined}:undefined},facts,blocked:true};
  }
  return {plan,facts,blocked:false};
}

export function decisionFactsText(facts:OutcomeFact[]) {
  return facts.some(x=>['failed','uncertain','needs_consent','needs_input'].includes(x.status))?outcomeMessage(facts):'';
}
