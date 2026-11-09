import {requestAuthorityView,type RequestNativeEntity} from './outcomes.js';

/** Binds the planner's interpretation to an actual authored span. This checks
 * provenance, not language: the planner identifies the cancellation intent;
 * the resolver still checks the fresh source, target, permissions and version.
 * Quoted titles remain usable as target data, never as the instruction proof. */
export function isAuthoredCancellationQuote(body:string,entities:ReadonlyArray<RequestNativeEntity>,quote:unknown):boolean{
 if(typeof body!=='string'||typeof quote!=='string'||quote.trim().length<2||quote.length>2500||!/[\p{L}\p{N}]/u.test(quote))return false;
 const view=requestAuthorityView(body,entities);if(!view)return false;
 for(let offset=body.indexOf(quote);offset>=0;offset=body.indexOf(quote,offset+1)){
  if(view.commandText.slice(offset,offset+quote.length)===quote)return true;
 }
 return false;
}

/** Keep the surrounding authored sentence/paragraph so a planner cannot omit
 * a preceding condition, translation purpose, or negation from its quote. A
 * finished unrelated sentence does not revoke a later independent request. */
export function hasUnconditionalCancellationQuote(body:string,entities:ReadonlyArray<RequestNativeEntity>,quote:unknown):boolean{
 if(!isAuthoredCancellationQuote(body,entities,quote)||typeof quote!=='string')return false;
 const authored=requestAuthorityView(body,entities)!.commandText;
 const separators=/[.!?;]|\n[ \t]*\n/gu;
 const dependent=/(?:якщо|если|(?<![\p{L}])if(?![\p{L}])|після (?:того|створення|монтажу|завершення|готовності)|коли.{0,70}(?:готов|заверш|зроб)|when.{0,70}(?:ready|done|finished)|after (?:it|creating|rendering|completion|the (?:video|clip|render))|once\b|переклад|переклади|переведи|перевод|процит|translate|quote)/iu;
 const negated=/(?<![\p{L}\p{N}])(?:не|don't|do\s+not|not)\s+(?:видал|скас|приб|зупин|припин|удал|отмен|убер|cancel|delete|remove|stop)/iu;
 for(let at=body.indexOf(quote);at>=0;at=body.indexOf(quote,at+1)){
  if(authored.slice(at,at+quote.length)!==quote)continue;
  let left=0;
  for(const match of authored.slice(0,at).matchAll(separators))left=match.index!+match[0].length;
  const after=at+quote.length,tail=authored.slice(after).search(/[.!?;]|\n[ \t]*\n/u),right=tail<0?authored.length:after+tail;
  const clause=authored.slice(left,right);
  if(!dependent.test(clause)&&!negated.test(clause))return true;
 }
 return false;
}
