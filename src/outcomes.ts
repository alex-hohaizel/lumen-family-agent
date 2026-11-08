import type {Action,Plan} from './model.js';

type DeliveredFileKind='video'|'album'|'image'|'audio'|'pdf';
export interface OutcomeFact {capability:string;status:'observed'|'prepared'|'queued'|'needs_consent'|'needs_input'|'failed'|'uncertain'|'cancelled';reference?:string;scope?:string;detail?:string;confirmed?:'delivery'|'completion';targetKind?:'file'|'calendar'|'activity'|'poll'|'message';targets?:string[];fileKinds?:DeliveredFileKind[];items?:OutcomeFact[];mediaKind?:'album'|'story';listOperation?:'add'|'list'|'complete'|'remove';listMessage?:string;listItems?:string[];}
const terminalStates=new Set(['repair','stale','failed','blocked','refused','expired']);
const asRef=(value:unknown)=>typeof value==='string'||typeof value==='number'?String(value):undefined;
export function toolOutcome(name:string,result:any,request?:any):OutcomeFact {
  // A listing describes its members; it cannot certify that the caller's goal completed.
  if(Array.isArray(result))return {capability:name,status:'observed',items:result.map(item=>toolOutcome(name,item,request))};
  const reference=asRef(result?.job_id||result?.id||result?.asset_id);
  const target=asRef(request?.job_id||request?.id||request?.asset_id||request?.url)||reference;
  const scope=target?name+':'+String(request?.operation||'')+':'+target:request?.operation?name+':'+String(request.operation):name;
  const mediaKind=result?.kind==='album'||name.startsWith('archive.')?'album':result?.kind==='story'||name.startsWith('studio.')?'story':undefined;
  const fact:OutcomeFact={capability:name,status:'observed',reference,scope,mediaKind};
  if(['telegram.delivery','artifact.delivery','document.delivery','library.delivery'].includes(name)&&result?.status==='delivered'&&(result?.deliveryReceipt?.message_id||result?.delivery_receipt?.message_id)){
    const receipt=result.deliveryReceipt||result.delivery_receipt,proof=result.outputProof;
    const typed=proof?.readback_verified===true&&proof.id===(result.asset_id||result.id)&&/^[a-f0-9]{64}$/.test(proof.sha256||'')&&Number(proof.bytes)>0&&Number.isInteger(proof.revision)&&Number(proof.receipt_message_id)===Number(receipt.message_id)&&(!receipt.output||receipt.output.id===proof.id&&receipt.output.sha256===proof.sha256&&Number(receipt.output.bytes)===Number(proof.bytes)&&receipt.output.mime===proof.mime&&Number(receipt.output.revision)===Number(proof.revision)&&(proof.version===undefined?receipt.output.version===undefined:Number(receipt.output.version)===Number(proof.version)));
    return {...fact,confirmed:'delivery',targetKind:name==='telegram.delivery'?'message':'file',targets:[result?.asset_id,result?.id,result?.name,result?.title].filter(Boolean).map(String),...(typed?{fileKinds:(proof.kinds||[]).filter((kind:any)=>['video','album','image','audio','pdf'].includes(kind))}:{})};
  }
  if(name==='calendar.write'&&result?.provider_readback===true&&result.receipt?.uid)return {...fact,confirmed:'completion',targetKind:'calendar',targets:[result.id,result.receipt.uid,result.title].filter(Boolean).map(String)};
  if(name==='composition.status'&&result?.phase==='completed')return {...fact,confirmed:'completion'};
  const error=result?.error||result?.error_code,status=String(result?.status||result?.phase||'');
  if(result?.needs_approval||result?.needs_consent)return {...fact,status:'needs_consent',reference:asRef(result.approval_id||result.id)};
  if(/uncertain|unconfirmed/.test(status)||!terminalStates.has(status)&&error&&/uncertain|unconfirmed|interrupted/.test(String(error)))return {...fact,status:'uncertain',detail:String(error||status)};
  if(status==='cancelled'||status==='canceled'||result?.cancelled===true)return {...fact,status:'cancelled',detail:String(error||status)};
  if(status==='needs_input'||error&&/soundtrack_required|select_materials_first|missing_input/.test(String(error)))return {...fact,status:'needs_input',detail:name==='lists.manage'&&typeof result?.question==='string'?result.question:String(error||status)};
  if(result?.error||terminalStates.has(status)||result?.found===false||error&&!['ready','verified','delivered','completed'].includes(status))return {...fact,status:'failed',detail:String(error||status||'not_found')};
  if(/queued|pending|delivering|running|active/.test(status))return {...fact,status:'queued'};
  if(/prepared|verified|ready/.test(status))return {...fact,status:'prepared'};
  if(name==='lists.manage'&&['add','list','complete','remove'].includes(result?.operation))return {...fact,listOperation:result.operation,listItems:[...new Set([...(result.items||[]).map((item:any)=>item?.text),result.item?.text,...(result.added||[]),...(result.already_present||[])].filter((item):item is string=>typeof item==='string'))],...(typeof result.message==='string'?{listMessage:result.message}:{})};
  return fact;
}

export function currentOutcomes(facts:OutcomeFact[]){
  const live=new Map<string,OutcomeFact>();
  for(const fact of facts){
    const key=fact.scope||fact.capability+(fact.reference?':'+fact.reference:'');
    const prior=live.get(key);
    if(fact.confirmed)live.delete(key+':unconfirmed');
    // An unconfirmed external effect must be checked, never retried into an assumed success.
    if(prior?.status==='uncertain'&&!fact.confirmed){live.set(key+':unconfirmed',prior);}
    live.set(key,fact);
  }
  return [...live.values()];
}
export function outcomeMessage(facts:OutcomeFact[]) {
  const active=currentOutcomes(facts),first=(status:OutcomeFact['status'])=>active.find(x=>x.status===status);
  if(first('uncertain'))return 'Поки не можу підтвердити результат дії. Спершу потрібно перевірити, чи вона відбулася; автоматично повторювати її не буду, щоб не створити дубль.';
  const failed=first('failed')||first('needs_input');
  if(failed){
    const album=failed.mediaKind==='album';
    if(/^(worker_memory_busy|worker_queue_busy|worker_queue_timeout|browser_busy)$/.test(failed.detail||''))return 'Зараз бракує вільних ресурсів для цієї обробки. Можеш попросити повторити її пізніше; автоматично нову спробу не запускаю.';
    if(failed.capability==='lists.manage'&&failed.status==='needs_input'&&failed.detail&&failed.detail!=='needs_input')return failed.detail;
    if(failed.capability==='lists.manage'&&/list_target_unconfirmed/.test(failed.detail||''))return 'Список не змінив: цей пункт не збігається з твоїм проханням. Уточни, що додати або прибрати.';
    if(/original_audio_required/.test(failed.detail||''))return 'Щоб зберегти оригінальний звук, потрібне відео зі звуком. Надішли таке відео або обери трек.';
    if(/original_audio_silent/.test(failed.detail||''))return 'У вибраних фрагментах не знайшов звуку, який можна зберегти. Можеш обрати інше відео або додати трек.';
    if(/original_audio_has_no_usable_audio/.test(failed.detail||''))return 'Не вдалося прочитати оригінальний звук відео. Можемо спробувати інше відео або додати окремий трек.';
    if(/original_audio_shorter_than_scene/.test(failed.detail||''))return 'Оригінальний звук закінчується раніше за вибраний фрагмент. Можемо скоротити фрагмент або обрати інше відео.';
    if(/soundtrack_required/.test(failed.detail||''))return 'Для ролика з музикою потрібен аудіофайл. Надішли сюди трек, який хочеш додати.';
    if(/select_materials_first|scene_required|no_scenes/.test(failed.detail||''))return album?'Надішли матеріали, які хочеш зібрати в альбом.':'Щоб зібрати ролик, потрібні фото або відео. Надішли їх сюди й скажи, які беремо.';
    if(/worker_interrupted/.test(failed.detail||''))return album?'Альбом не вдалося завершити цього разу. Можеш попросити зібрати його ще раз.':'Монтаж перервався. Можеш попросити зібрати ролик ще раз.';
    if(/render_time_limit/.test(failed.detail||''))return album?'Не встиг зібрати альбом. Можемо спробувати ще раз із меншою кількістю матеріалів.':'Монтаж не встиг завершитися. Можна спробувати коротший ролик або менше файлів.';
    if(/decode|render|invalid_media|corrupt/.test(failed.detail||''))return album?'З альбомом поки не вийшло: не вдалося опрацювати матеріали. Перевір файли й попроси зібрати його ще раз.':'З роликом поки не вийшло: не вдалося обробити матеріали. Перевір файли й попроси повторити монтаж.';
    if(/stale|version|changed/.test(failed.detail||''))return 'Матеріали змінилися під час роботи. Попередній результат уже не відповідає їм; потрібно зібрати новий варіант з актуальних файлів.';
    if(album)return 'З альбомом поки не вийшло. Можемо спробувати ще раз або змінити матеріали.';
    if(/studio/.test(failed.capability))return 'З роликом поки не вийшло. Можемо спробувати ще раз або змінити матеріали.';
    if(/web|research|browser/.test(failed.capability))return 'Не вдалося отримати потрібні дані. Можеш надіслати джерело сюди або попросити спробувати пошук ще раз.';
    if(failed.status==='needs_input')return 'Для продовження бракує даних. Уточни, що саме потрібно використати.';
    return 'Не вдалося завершити цю дію. Можемо спробувати ще раз або уточнити прохання.';
  }
  if(first('needs_consent'))return 'Чекаю погодження в картці дії. Після нього зможу продовжити.';
  if(first('cancelled'))return 'Роботу зупинено. Готового результату цього запуску немає.';
  const queued=first('queued');
  if(queued)return queued.mediaKind==='album'?'Готую альбом. Повідомлю, коли він буде готовий.':queued.mediaKind==='story'?'Збираю ролик. Коли він буде готовий, надішлю його сюди.':'Робота ще триває. Повідомлю, коли отримаю результат.';
  return '';
}

const terminalObject='(?:файл|документ|звіт|повідомлення|нагадування|голосування|опитування|гру|гра|активність|підсумок|поді[яюї]|календар|ролик|відео|видео|відеоролик|фільм|фильм|альбом|зображення|картинк[ау]|аудіо(?:файл)?|аудио(?:файл)?|событи[ея]|календарь|сообщени[ея]|file|document|poll|message|event|calendar|clip|video|movie|album|image|audio|pdf)';
const terminalVerb='(?:надіслано|відправлено|доставлено|створено|запущено|завершено|завершена|надіслав|відправив|доставив|створив|запустив|отправлен[оа]?|доставлен[оа]?|создан[оа]?|отправил|создал|sent|delivered|created|completed|published|готовий|готова|готове|готові|готово|зібрано|зібрав|зібрала|змонтовано|змонтував|змонтувала|готов|готовы|собрано|собрал|собрала|смонтировано|смонтировал|ready|finished|done|assembled|rendered)';
const terminalPattern='(?<![\\p{L}\\p{N}])(?:'+terminalObject+'.{0,60}?'+terminalVerb+'|'+terminalVerb+'.{0,60}?'+terminalObject+')(?![\\p{L}\\p{N}])';
const collectionVerb="(?:забирай|заберіть|забирайте|тримай|отримуй|скачуй|скачивай|ось|download|grab|collect|here(?:'s| is)?)";
const collectionPattern='(?<![\\p{L}\\p{N}])'+collectionVerb+'.{0,60}?'+terminalObject+'(?![\\p{L}\\p{N}])';
const executionVerb='(?:виконав|виконала|виконали|виконано|завершив|завершила|завершили|завершено|выполнил(?:а|и)?|выполнено|completed|performed|executed|done|finished)';
const executionObject='(?:ді[яюї]|завданн[яю]|задач[ау]|action|task)';
const executionPattern='(?<![\\p{L}\\p{N}])(?:'+executionObject+'.{0,45}?'+executionVerb+'|'+executionVerb+'.{0,45}?'+executionObject+')(?![\\p{L}\\p{N}])';
const bareReady=/^\s*(?:готово|усе готово|все готово|завдання завершен[ое]|done|all done)[!.\s]*$/iu;
function outcomePieces(text:string,listContext=false){
  const protectedRanges=[...text.matchAll(/```[\s\S]*?```|«[^»]*»|[“"][^”"\n]*[”"]|`[^`\n]*`/g)].map(m=>({start:m.index!,end:m.index!+m[0].length}));
  const pieces:{text:string;start:number;end:number}[]=[];let start=0;
  const separator=listContext?/(?<=[.!?;])\s+|\n|,(?=\s*(?:опитування|голосування|подію|гру|файл|документ|(?:а|але|і|й|и|но|and|but)\s))/gu:/(?<=[.!?;])\s+|\n|,(?=\s*(?:опитування|голосування|подію|гру|файл|документ))/gu;
  for(const match of text.matchAll(separator)){
    if(protectedRanges.some(range=>match.index!>=range.start&&match.index!<range.end))continue;
    const end=match.index!+match[0].length;pieces.push({text:text.slice(start,match.index),start,end});start=end;
  }
  pieces.push({text:text.slice(start),start,end:text.length});return pieces;
}
function resultClaims(sentence:string,collectionReady=false,claimPattern?:string){
 const blank=(text:string)=>text.replace(/[^\r\n]/g,' '),pattern=claimPattern||(collectionReady?'(?:'+terminalPattern+'|'+collectionPattern+')':terminalPattern);
 const visible=sentence.replace(/```[\s\S]*?```/g,blank).replace(/«[^»]*»|[“"][^”"\n]*[”"]|`[^`\n]*`/g,text=>new RegExp(pattern,'iu').test(text)?blank(text):text);
 if(/[?？]\s*$/.test(visible)||/^\s*(?:якщо|коли|у разі|за умови|если|if|when)(?=\s|[,:;—]|$)/iu.test(visible)||/(?:не можу|не можу ще|не вдається|не могу|cannot|can't).{0,30}(?:підтверд|ствердж|сказа|confirm|verify)/iu.test(visible))return [];
 const matches=[...visible.matchAll(new RegExp(pattern,'giu'))],claims:string[]=[];
 for(const [index,match] of matches.entries()){
  const at=match.index!,fullPrefix=visible.slice(0,at),prefix=fullPrefix.split(/[,;:]|—/u).at(-1)||'',verb=match[0].match(new RegExp(terminalVerb+'|'+collectionVerb+'|'+executionVerb,'iu'))!,beforeVerb=match[0].slice(0,verb.index),afterVerb=match[0].slice((verb.index||0)+verb[0].length);
  if(/^(?:готов(?:ий|а|і)|ready)$/iu.test(verb[0])&&/(?:^|\s)(?:я|ми|I|we)(?:\s+(?:am|are|was|were))?\s*$/iu.test(prefix)&&/^\s+(?:зібрати|змонтувати|створити|зробити|допомогти|make|create|assemble|help|to\s)/iu.test(afterVerb))continue;
  const negated=/(?:^|[\s,])(?:не|not|no|ще не|поки не)\s*(?:(?:вже|ще|поки|yet|already|було|був)\s*)*$/iu;
  if(/^(?:у|в)\s+(?:(?:нашому|нашій|цьому|цій)\s+)?(?:детективі|грі|квесті|пригоді|сцені|історії|сюжеті)(?:\s+[\p{L}][\p{L}’'ʼ-]{1,40})?(?:\s+(?:вже|already))?\s*$/iu.test(prefix.trim())&&!/(?:^|\s)(?:я|ми|I|we)(?=\s|$)/iu.test(prefix))continue;
  const reported=/(?:^|[^\p{L}\p{N}_])(?:зі слів|каже|написав|повідомив|сказав|he|she)\s*[:,—]?\s*$/iu.test(fullPrefix)||/(?:^|[^\p{L}\p{N}_])(?:he|she)\s+(?:said|says|wrote|reported)(?:\s*[:,—]?\s*(?:that|the|a|an))*\s*[:,—]?\s*$/iu.test(fullPrefix);
  const reportedExecution=claimPattern===executionPattern&&/(?:^|[^\p{L}\p{N}_])(?:сказав|сказала|каже|написав|повідомив|said|says|wrote|reported)(?:\s*[:,—]?\s*(?:що|that))?(?:\s*[:,—]?\s*(?:я|ми|він|вона|I|we|he|she|the|a|an))?(?:\s+(?:вже|already))?\s*[:,—]?\s*$/iu.test(fullPrefix);
  if(negated.test(beforeVerb)||negated.test(prefix)||reported||reportedExecution)continue;
  claims.push(sentence.slice(at,index+1<matches.length?matches[index+1]!.index:undefined));
 }
 return claims;
}

export function withoutUnconfirmedExecutionClaims(text:string){
  return outcomePieces(text).filter(piece=>!resultClaims(piece.text,false,executionPattern).length).map(piece=>text.slice(piece.start,piece.end)).join('').trim();
}

// A list result can prove a saved/checked item, never an actual checkout,
// payment or parcel delivery. Keep this separate from file/calendar guards.
function physicalPurchaseClaim(text:string,listItems:string[]){
 const blank=(value:string)=>value.replace(/[^\r\n]/g,' ');
 const visible=text.replace(/```[\s\S]*?```|«[^»]*»|[“"][^”"\n]*[”"]|`[^`\n]*`/g,blank).trim();
 if(!visible||/[?？]\s*$/.test(visible)||/^\s*(?:якщо|коли|у разі|за умови|если|когда|if|when|suppose|imagine)(?=\s|[,:;—]|$)/iu.test(visible))return false;
 if(/^(?:(?:у|в)\s+(?:(?:нашій|нашому|цій|цьому|нашей|нашем)\s+)?(?:грі|игре|детективі|квесті|казці|сцені|історії|сюжеті)|in\s+(?:(?:our|the|this)\s+)?(?:game|story|scene|roleplay)|(?:рольова гра|roleplay)\s*:)|\s(?:(?:у|в)\s+(?:(?:нашій|нашому|цій|цьому|нашей|нашем)\s+)?(?:грі|игре|казці|сцені|історії|сюжеті)|in\s+(?:(?:our|the|this)\s+)?(?:game|story|scene|roleplay))[.!\s]*$/iu.test(visible))return false;
 if(/^(?:(?:це\s+)?(?:слово|фраза|вислів|значення|переклад)|(?:это\s+)?(?:слово|фраза|значение|перевод)|(?:the\s+)?(?:word|phrase|expression|translation))(?=\s|[,:;—]|$)/iu.test(visible))return false;
 const verbs='купив|купила|купили|куплено|придбав|придбала|придбали|придбано|закупив|закупила|замовив|замовила|замовили|замовлено|оформив|оформила|оформлено|оплатив|оплатила|оплатили|оплачено|купил|купила|купили|куплено|заказал|заказала|заказали|заказано|оформил|оформила|оформлено|оплатил|оплатила|оплатили|оплачено|bought|purchased|ordered|paid(?:\\s+for)?|placed|доставив|доставила|доставили|доставлено|привіз|привезла|привезено|доставил|доставила|доставили|доставлено|прив[её]з|delivered';
 for(const match of visible.matchAll(new RegExp('(?<![\\p{L}\\p{N}_])(?:'+verbs+')(?![\\p{L}\\p{N}_])','giu'))){
  const prefix=visible.slice(0,match.index).trim(),verb=match[0],tail=visible.slice(match.index!+verb.length).trim();
  if(/(?:сказав|сказала|каже|кажеш|написав|написала|повідомив|зі слів|со слов|сказал|сказала|говорит|написал|said|says|wrote|reported)(?:\s|[:,—])/iu.test(prefix+' '))continue;
  if(/(?:^|\s)(?:не|not|never|didn't|did not|haven't|have not|hasn't|has not|would|could|might|should)(?:\s+(?:ще|поки|вже|yet|already|have|been|було|був))*\s*$/iu.test(prefix))continue;
  if(/ordered\s+list|ordered\s+sequence|ordered\s+by/iu.test(verb+' '+tail))continue;
  if(/^(?:attention|tribute|respects)(?=\s|[,.!:;—]|$)/iu.test(tail))continue;
  if(/^(?:ти|ви|він|вона|вони|ты|вы|он|она|они|користувач|учасник|you|he|she|they)(?=\s|[,.!:;—]|$)|^by\s+(?:you|him|her|them|the user)(?=\s|[,.!:;—]|$)/iu.test(tail))continue;
  const delivery=/достав|прив[іеё]|привез|delivered/iu.test(verb),physicalObject=/(?:^|\s)(?:the\s+)?(?:покупк[аиоу]|продукт[иыів]|товар[иыів]|замовлення|заказ|посилк[ауи]|молоко|хліб|хлеб|groceries|shopping|purchases?|items?|parcel|milk|bread|order)(?=\s|[,.!:;—]|$)/iu;
  if(delivery&&!physicalObject.test(prefix)&&!physicalObject.test(tail))continue;
  if(delivery&&/^(?:the\s+)?(?:файл|документ|повідомлення|альбом|список|file|document|message|album|list)(?=\s|[,.!:;—]|$)/iu.test(tail))continue;
  if(/placed|оформ/iu.test(verb)&&!/(?:замовлен|заказ|order|purchase)/iu.test(prefix+' '+tail))continue;
  let simplePrefix=prefix.replace(/^(?:готово|done)[!.,:;—\s]*/iu,'').replace(/^(?:а|але|також|і|й|и|но|and|but|also)\s+/iu,'');
  // Ukrainian/Russian permit an omitted subject after the object: «Молоко
  // вже купив». Only actual list item text licenses this narrow inversion.
  for(const item of listItems){const escaped=item.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');simplePrefix=simplePrefix.replace(new RegExp('^(?:the\\s+)?'+escaped+'(?=\\s|$)\\s*','iu'),'');}
  if(/^(?:(?:я|ми|мы|i|we|i['’]ve|we['’]ve|бот|помічник|(?:the\s+)?(?:bot|assistant))(?:\s+|$))?(?:(?:вже|уже|щойно|тільки що|только что|також|also|already|just|have|had|саме|це|тобі|вам)\s*)*$/iu.test(simplePrefix))return true;
  // Passive factual completion also claims a physical result. Explicitly
  // reported third-person purchases remain conversation, not bot execution.
  if(/куплено|придбано|замовлено|заказано|оформлено|оплачено|доставлено|привезено/iu.test(verb)&&prefix&&!/^(?:ти|ви|він|вона|вони|ты|вы|он|она|они)(?=\s|$)/iu.test(prefix))return true;
  if(/bought|purchased|ordered|paid|placed|delivered/iu.test(verb)&&/\s(?:is|are|was|were|has been|have been|had been)\s*$/iu.test(prefix))return true;
 }
 return false;
}

export interface RequestNativeEntity {type:string;offset:number;length:number;}
export interface RequestDataRange {offset:number;length:number;kind:'quote'|'blockquote'|'expandable_blockquote'|'code'|'pre';origin:'native'|'textual';}
export interface RequestAuthorityView {commandText:string;nativeMaskedText:string;quotedDataRanges:RequestDataRange[];codeDataRanges:RequestDataRange[];}
type MaskSpan={start:number;end:number};
const quoteEntityKinds=new Set(['blockquote','expandable_blockquote','code','pre']);
function utf16Boundary(text:string,at:number){return at<=0||at>=text.length||!(text.charCodeAt(at-1)>=0xd800&&text.charCodeAt(at-1)<=0xdbff&&text.charCodeAt(at)>=0xdc00&&text.charCodeAt(at)<=0xdfff);}
function nativeRequestRanges(text:string,entities:ReadonlyArray<RequestNativeEntity>){
 if(typeof text!=='string'||!Array.isArray(entities))return;
 const ranges:RequestDataRange[]=[];
 for(const entity of entities){
  if(!entity||typeof entity!=='object'||typeof entity.type!=='string'||!entity.type||!Number.isSafeInteger(entity.offset)||!Number.isSafeInteger(entity.length)||entity.offset<0||entity.length<=0||entity.offset+entity.length>text.length||!utf16Boundary(text,entity.offset)||!utf16Boundary(text,entity.offset+entity.length))return;
  if(quoteEntityKinds.has(entity.type))ranges.push({offset:entity.offset,length:entity.length,kind:entity.type as RequestDataRange['kind'],origin:'native'});
 }
 return ranges.length<=128?ranges:undefined;
}
function maskedRequestText(text:string,spans:ReadonlyArray<MaskSpan>){
 const units=text.split('');for(const {start,end}of spans)for(let at=start;at<end;at++)if(units[at]!=='\r'&&units[at]!=='\n')units[at]=' ';return units.join('');
}

/** Native-only compatibility view; complete command authority uses requestAuthorityView. */
export function withoutQuotedEntitySpans(originalText:string,nativeEntities:ReadonlyArray<RequestNativeEntity>=[]):string|undefined{
 const ranges=nativeRequestRanges(originalText,nativeEntities);return ranges?maskedRequestText(originalText,ranges.map(range=>({start:range.offset,end:range.offset+range.length}))):undefined;
}

/** DATA ranges refer to original content, excluding textual delimiters; the original is never rewritten. */
export function requestAuthorityView(originalText:string,nativeEntities:ReadonlyArray<RequestNativeEntity>=[]):RequestAuthorityView|undefined{
 const native=nativeRequestRanges(originalText,nativeEntities);if(!native)return;
 const quotedDataRanges=native.filter(range=>range.kind==='blockquote'||range.kind==='expandable_blockquote'),codeDataRanges=native.filter(range=>range.kind==='code'||range.kind==='pre'),spans:MaskSpan[]=native.map(range=>({start:range.offset,end:range.offset+range.length}));
 const nativeMaskedText=maskedRequestText(originalText,spans),insideNative=(at:number)=>spans.some(span=>at>=span.start&&at<span.end);
 const record=(start:number,end:number,contentStart:number,contentEnd:number,kind:RequestDataRange['kind'])=>{
  spans.push({start,end});const range:RequestDataRange={offset:contentStart,length:Math.max(0,contentEnd-contentStart),kind,origin:'textual'};(kind==='code'||kind==='pre'?codeDataRanges:quotedDataRanges).push(range);
 };
 const lines:{start:number;contentEnd:number;end:number;text:string}[]=[];
 for(let start=0;start<originalText.length;){let contentEnd=start;while(contentEnd<originalText.length&&!/[\r\n]/u.test(originalText[contentEnd]!))contentEnd++;const end=contentEnd+(originalText[contentEnd]==='\r'&&originalText[contentEnd+1]==='\n'?2:contentEnd<originalText.length?1:0);lines.push({start,contentEnd,end,text:originalText.slice(start,contentEnd)});start=end;}
 let lazyQuote=false;
 for(let lineIndex=0;lineIndex<lines.length;lineIndex++){
  const line=lines[lineIndex]!;if(insideNative(line.start)){lazyQuote=false;continue;}
  const quotePrefix=/^ {0,3}(?:>[ \t]?)+/u.exec(line.text);
  if(quotePrefix){record(line.start,line.end,line.start+quotePrefix[0].length,line.contentEnd,'blockquote');lazyQuote=true;continue;}
  if(!line.text.trim()){lazyQuote=false;continue;}
  const fence=/^ {0,3}(`{3,}|~{3,})[^\r\n]*$/u.exec(line.text),newBlock=/^ {0,3}(?:#{1,6}\s|(?:[-+*]|\d+[.)])\s|(?:[-*_][ \t]*){3,}$)/u.test(line.text);
  if(lazyQuote&&!fence&&!newBlock){record(line.start,line.end,line.start,line.contentEnd,'blockquote');continue;}
  lazyQuote=false;
  if(fence){
   const marker=fence[1]!,closing=new RegExp('^ {0,3}'+marker[0]+'{'+marker.length+',}[ \\t]*$','u');let close=lineIndex+1;while(close<lines.length&&!closing.test(lines[close]!.text))close++;
   record(line.start,close<lines.length?lines[close]!.end:originalText.length,line.end,close<lines.length?lines[close]!.start:originalText.length,'pre');lineIndex=close;continue;
  }
  const indent=/^(?: {4}|\t)/u.exec(line.text);if(indent)record(line.start,line.end,line.start+indent[0].length,line.contentEnd,'pre');
 }
 const blockSpans=[...spans].sort((a,b)=>a.start-b.start||b.end-a.end),blockedEnd=(at:number)=>blockSpans.reduce((end,span)=>span.start<=at&&span.end>at?Math.max(end,span.end):end,at);
 const word=(char:string|undefined)=>Boolean(char&&/[\p{L}\p{N}\p{M}_]/u.test(char)),wordAt=(at:number)=>{const point=originalText.codePointAt(at);return word(point===undefined?undefined:String.fromCodePoint(point));},wordBefore=(at:number)=>word(originalText.slice(at>1&&!utf16Boundary(originalText,at-1)?at-2:at-1,at)),escaped=(at:number)=>{let count=0;while(at-count>0&&originalText[at-count-1]==='\\')count++;return count%2===1;};
 const quotePairs:Record<string,string>={'"':'"',"'":"'",'‘':'’','’':'’','“':'”','„':'“','«':'»'};
 for(let at=0;at<originalText.length;){
  const skip=blockedEnd(at);if(skip>at){at=skip;continue;}
  if(originalText.slice(at,at+11).toLowerCase()==='<blockquote'&&/^<blockquote(?:\s[^>]*|)>/iu.test(originalText.slice(at))){
   const tags=/<\/?blockquote\b[^>]*>/giu;tags.lastIndex=at;let depth=0,contentStart=at,contentEnd=originalText.length,end=originalText.length;
   for(let match=tags.exec(originalText);match;match=tags.exec(originalText)){const closing=/^<\//u.test(match[0]);if(!closing){if(depth++===0)contentStart=tags.lastIndex;}else if(--depth===0){contentEnd=match.index;end=tags.lastIndex;break;}}
   record(at,end,contentStart,contentEnd,'blockquote');at=end;continue;
  }
  if(originalText[at]==='`'){
   let count=1;while(originalText[at+count]==='`')count++;let close=at+count;
   while(close<originalText.length){if(originalText[close]!=='`'){close++;continue;}let run=1;while(originalText[close+run]==='`')run++;if(run===count)break;close+=run;}
   if(close<originalText.length){record(at,close+count,at+count,close,'code');at=close+count;continue;}at+=count;continue;
  }
  const opening=originalText[at]!,closing=quotePairs[opening];if(!closing||((opening==="'"||opening==='‘'||opening==='’'||opening==='"')&&wordBefore(at))){at++;continue;}
  const single=opening==="'"||opening==='‘'||opening==='’',escapeMode=escaped(at);let close=at+1;
  while(close<originalText.length){if(originalText[close]===closing&&escaped(close)===escapeMode&&(!single||!wordAt(close+1)))break;close++;}
  if(close<originalText.length){record(at,close+1,at+1,close,'quote');at=close+1;}else at++;
 }
 const ordered=(ranges:RequestDataRange[])=>ranges.sort((a,b)=>a.offset-b.offset||b.length-a.length||a.origin.localeCompare(b.origin));
 return {commandText:maskedRequestText(originalText,spans),nativeMaskedText,quotedDataRanges:ordered(quotedDataRanges),codeDataRanges:ordered(codeDataRanges)};
}

export type DiagnosticRequestIntent='allow'|'deny'|'unspecified';
/** The last explicit unquoted diagnostic directive wins; invalid context has no intent. */
export function diagnosticRequestIntent(actualRequestText:string,nativeEntities:ReadonlyArray<RequestNativeEntity>=[]):DiagnosticRequestIntent|undefined{
 const view=requestAuthorityView(actualRequestText,nativeEntities);if(!view)return;
 let intent:DiagnosticRequestIntent='unspecified';
 for(const clause of view.commandText.split(/[\n;.!?]|,\s*(?:але|а|но|but|and)\s+/iu)){
  const text=clause.trim();
  if(!text||/(?:як|как)\s+(?:попросити|попросить|сформулювати|сформулировать)|how\s+to\s+ask|(?:слово|фраз[ауиы]|вислів|приклад|пример|word|phrase|example)\s|^(?:чи\s+треба|нужно\s+ли|should\s+(?:I|we|you))\s|^(?:він|вона|вони|он|она|они|he|she|they).{0,30}(?:сказ|напис|попрос|said|wrote|asked)/iu.test(text))continue;
  if(/\blog\s+(?:function|formula|calculation|of)\b|(?:функці[яюї]|функци[яюи]|function).{0,25}(?:\blog\b|логарифм)/iu.test(text)&&!/помил|ошиб|error|debug|зб[оі]|сбо/iu.test(text))continue;
  const request=/(?:покажи|покажіть|наведи|наведіть|дай|дайте|назви|назвіть|повідом|поясни|розшифруй|відлагод|продіагност|потріб|покажите|укажи|укажите|назови|назовите|объясни|расшифруй|отлад|диагност|нужен|нужны|show|give|tell|provide|explain|debug|diagnose|need|want|what(?:['’]s|\s+is|\s+was)|який|какой)/iu.test(text);
  const diagnostic=/(?:код(?:и|ом|ы|ів|у|ов|а)?\s+(?:цієї\s+|этой\s+|the\s+)?(?:помилки|помилок|ошибки|ошибок)|error\s+codes?|(?<![\p{L}\p{N}_])(?:логи|логів|логов|logs?)(?![\p{L}\p{N}_])|stack\s*trace|debug\s+(?:details|output)|(?:технічн|діагностичн|техническ|диагностическ)[\p{L}\s]{0,30}(?:помил|ошиб|збо|сбо)|(?:technical|diagnostic)\s+(?:error|failure|debug)\s+details)/iu.test(text);
  const deny=/(?:^|\s)(?:не\s+(?:треба|потрібно|потрібні|потрібен|потрібна|прошу|хочу|показуй|показувати|показуйте|наводь|наводити|давай|давайте|називай|називайте|виводь|публікуй|нужно|нужны|нужен|надо|показывай|показывать)|без\s+(?:лог[\p{L}]*|код[\p{L}]*|техніч[\p{L}]*|техническ[\p{L}]*)|(?:do\s+not|don['’]t|dont|never)\s+(?:show|give|tell|provide|include|send|display|want|need|print|reveal)|no\s+(?:need|logs?|error\s+codes?)|without)(?=\s|$)/iu.test(text);
  if(deny&&(diagnostic||/(?:технічн|техническ)[\p{L}]*\s+(?:детал|подроб)|technical\s+details/iu.test(text)))intent='deny';
  else if(request&&diagnostic)intent='allow';
 }
 return intent;
}

/** Backward compatible boolean; undefined/deny/unspecified never grant diagnostic detail. */
export function explicitDiagnosticRequest(actualRequestText:string,nativeEntities:ReadonlyArray<RequestNativeEntity>=[]){
 return diagnosticRequestIntent(actualRequestText,nativeEntities)==='allow';
}

function unsupportedRecovery(text:string,active:OutcomeFact[],technicalDetailsRequested=false){
 const failed=active.filter(f=>['failed','needs_input','needs_consent','uncertain','cancelled'].includes(f.status));if(!failed.length)return false;
 const visible=text.replace(/```[\s\S]*?```|«[^»]*»|[“"][^”"\n]*[”"]|`[^`\n]*`/g,value=>value.replace(/[^\r\n]/g,' ')).trim();
 if(!visible||/[?？]\s*$/.test(visible)||/^(?:якщо|коли|у разі|за умови|если|когда|if|when|suppose|imagine)(?=\s|[,:;—]|$)/iu.test(visible))return false;
 if(/^(?:(?:у|в)\s+(?:(?:нашій|нашому|цій|цьому|нашей|нашем)\s+)?(?:грі|игре|детективі|квесті|казці|сцені|історії|сюжеті)|in\s+(?:(?:our|the|this)\s+)?(?:game|story|scene|roleplay)|(?:рольова гра|roleplay)\s*:)/iu.test(visible))return false;
 if(/^(?:ти\s+(?:написав|сказав|кажеш)|зі слів|со слов|він\s+(?:сказав|каже)|вона\s+(?:сказала|каже)|он\s+сказал|она\s+сказала|(?:he|she|you)\s+(?:said|says|wrote|reported)|(?:це\s+)?(?:слово|фраза|вислів|значення|переклад)|(?:это\s+)?(?:слово|фраза|значение|перевод)|(?:the\s+)?(?:word|phrase|expression|translation))(?=\s|[,:;—]|$)/iu.test(visible))return false;
 const details=failed.map(f=>f.detail||'').join(' '),failureProse=/не\s+(?:вийшл|вдал|удал|получил)|помилк|ошибк|failed|failure|error|could not|couldn't|^(?:код|code)(?=\s|:)/iu.test(visible);
 const rawTokens=[...text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b(?:ffmpeg|stacktrace|TypeError)\b/giu)].map(match=>match[0]);
 if((failureProse||/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+[.!\s]*$/iu.test(visible))&&rawTokens.length&&(!technicalDetailsRequested||rawTokens.some(token=>!details.toLowerCase().includes(token.toLowerCase()))))return true;
 const damaged=/(?:файл|відео|видео|аудіо|аудио|file|video|audio).{0,35}(?:пошкоджен|поврежд[её]н|corrupt|damaged|broken)|(?:пошкоджен|поврежд[её]н|corrupt|damaged|broken).{0,35}(?:файл|відео|видео|аудіо|аудио|file|video|audio)/iu.test(visible);
 if(damaged&&!/(?:не|not|isn't|is not|wasn't|was not)\s+(?:пошкоджен|поврежд[её]н|corrupt|damaged|broken)/iu.test(visible)&&!/corrupt/.test(details))return true;
 if(failureProse&&/(?:^|\s)(?:бо|тому що|через те що|потому что|because)(?=\s|[,:;—]|$)/iu.test(visible)){
  const known=/soundtrack_required/.test(details)&&/аудіо|audio|трек|музик|track|music/iu.test(visible)||/missing_input|select_materials_first|no_scenes|scene_required/.test(details)&&/матеріал|materials|фото|photo|scene|сцен|input/iu.test(visible)||/stale|version|changed|source_revoked/.test(details)&&/змінил|changed|актуальн|оновил/iu.test(visible)||/render_time_limit|deadline|timeout/.test(details)&&/час|встиг|time|дедлайн/iu.test(visible)||/worker_interrupted|render_cancelled/.test(details)&&/перерв|interrupted|зупин|stopp/iu.test(visible)||/network/.test(details)&&/мереж|network|з[’']єдн|connection/iu.test(visible)||failed.some(f=>f.status==='needs_consent')&&/дозв|погодж|permission|approval/iu.test(visible);
  if(!known)return true;
 }
 const retry=/(?<![\p{L}\p{N}_])(?:спробую|спробуємо|повторю|повторимо|перезапущу|перезапустимо|попробую|попробуем|повернуся|повернусь)(?![\p{L}\p{N}_])|(?:I['’]ll|I will|we['’]ll|we will|I am|we are).{0,25}(?:retry|try\s+again|restart|return)|^(?:retrying|restarting)\b/iu.test(visible)&&/(?:знову|ще раз|снова|ещ[её]\s+раз|повтор|перезапус|автоматич|автоматическ|retry|again|restart|повернуся|повернусь|return)/iu.test(visible)&&!/(?:спробую|попробую).{0,20}(?:пояснити|объяснить|explain)/iu.test(visible);
 if(retry&&!/(?:не|not|never|won't|will not|cannot|can't)\s+(?:буду\s+|будемо\s+)?(?:автоматич\S*\s+)?(?:спроб|повтор|перезапус|попроб|retry|try|restart|return)|не буду|не будемо|не стану|не станемо|не будем/iu.test(visible)&&!/(?:можу|можемо|можеш|можете|могу|можем|можете|can|could|may)\s+.{0,25}(?:спроб|повтор|попроб|retry|try|restart)/iu.test(visible)){
  const queued=active.some(f=>f.status==='queued'&&f.reference&&f.mediaKind&&failed.some(prior=>prior.mediaKind===f.mediaKind));
  if(!queued||/через|завтра|пізніше|позже|хвилин|минут|in\s+(?:a|one|\d+)|tomorrow|later/iu.test(visible))return true;
 }
 return false;
}

export function gateOutcome(plan:Plan,facts:OutcomeFact[],required=true,independentActions:Action[]=[],context:{technicalDetailsRequested?:boolean}={}):{plan:Plan;facts:OutcomeFact[];blocked:boolean} {
  const active=currentOutcomes(facts),unresolved=active.some(x=>['failed','uncertain','needs_consent','needs_input','queued','cancelled'].includes(x.status));
  const hasListResult=active.some(f=>f.capability==='lists.manage');
  const listItems=active.filter(f=>f.capability==='lists.manage').flatMap(f=>f.listItems||[]);
  const claimText=[plan.reply,plan.presentation?.card?.title,plan.presentation?.card?.summary,...(plan.presentation?.card?.facts||[]),plan.presentation?.card?.question,plan.presentation?.card?.details].filter(Boolean).join('\n');
  const rejectedList=(unit:string)=>{
    if(!active.some(f=>f.capability==='lists.manage'&&['failed','needs_input','needs_consent','uncertain'].includes(f.status)))return false;
    const visible=unit.replace(/```[\s\S]*?```|«[^»]*»|[“"][^”"\n]*[”"]|`[^`\n]*`/g,'');
    if(/[?？]\s*$/.test(visible)||/(?:^|\s)(?:не|not)\s+(?:додав|додала|додано|прибр|познач|добав|удал)/iu.test(visible))return false;
    return /(?:додав|додала|додано|прибр[а-яіїєґ]*|добавил|добавлено|удалил|removed|added).{0,75}(?:покуп|спис|справ|shopping|list|todo)|(?:покуп|спис|справ|shopping|list|todo).{0,75}(?:додав|додала|додано|прибр[а-яіїєґ]*|добавил|добавлено|удалил|removed|added)|(?:позначив|позначила).{0,60}(?:зроблен|виконан)/iu.test(visible);
  };
  const unsupported=(unit:string)=>{
    const visible=unit.replace(/«[^»]*»|[“"][^”"\n]*[”"]|`[^`\n]*`/g,''),names=(pattern:string)=>new RegExp('(?<![\\p{L}\\p{N}_.-])(?:'+pattern+')(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])','iu').test(visible),fileKind:DeliveredFileKind|undefined=names('ролик|відео(?:ролик|файл)?|видео(?:ролик|файл)?|фільм|фильм|clip|video|movie')?'video':names('альбом|album')?'album':names('зображення|картинк[ау]|image')?'image':names('аудіо(?:файл)?|аудио(?:файл)?|audio')?'audio':names('pdf')?'pdf':undefined;
    const delivery=/надіслано|відправлено|доставлено|надіслав|відправив|доставив|отправлен|доставлен|отправил|sent|delivered|published/iu.test(unit)||new RegExp(collectionPattern,'iu').test(unit),kind=fileKind||/файл|документ|звіт|file|document/iu.test(visible)?'file':/поді[яюї]|событи[ея]|календар|calendar|event/iu.test(visible)?'calendar':/опитування|голосування|poll/iu.test(visible)?'poll':/гр[ау]|активність|activity|game/iu.test(visible)?'activity':'message';
    const eligible=active.filter(x=>(delivery?x.confirmed==='delivery':x.confirmed==='completion'||kind==='file'&&x.confirmed==='delivery')&&(!fileKind||x.fileKinds?.includes(fileKind))&&(x.targetKind?x.targetKind===kind:kind==='file'?/artifact|document|media|library|studio/.test(x.capability):kind==='activity'?/composition|activity|game/.test(x.capability):kind==='calendar'?/calendar/.test(x.capability):kind==='poll'?/poll|vote/.test(x.capability):/telegram|message/.test(x.capability)));
    if(!eligible.length)return true;
    const named=[...unit.matchAll(/[«“"]([^»”"\n]{2,150})[»”"]|([\p{L}\p{N}_-]{1,100}\.(?:pdf|docx|xlsx|png|jpe?g|webp|gif|mp4|webm|mp3|wav|ogg|csv|txt|md|json|ics))|([a-f0-9]{8}-[a-f0-9-]{27})/giu)].map(m=>m[1]||m[2]||m[3]).filter(Boolean);
    return named.some(name=>!eligible.some(f=>[...(f.targets||[]),f.reference].filter(Boolean).some(target=>String(target).toLocaleLowerCase()===String(name).toLocaleLowerCase())));
  };
  const pieces=outcomePieces(claimText,hasListResult),rejected=new Set<string>();let readiness=false,lastBare:string|undefined,unconfirmedPurchase=false,recoveryRejected=false;
  for(const piece of pieces){
    const text=piece.text.trim(),claims=resultClaims(text,readiness),purchase=hasListResult&&physicalPurchaseClaim(text,listItems),recovery=unsupportedRecovery(text,active,context.technicalDetailsRequested),bad=purchase||recovery||rejectedList(text)||claims.some(unsupported)||unresolved&&resultClaims(text,false,executionPattern).length>0;
    if(purchase)unconfirmedPurchase=true;
    if(recovery)recoveryRejected=true;
    if(bad){rejected.add(text);if(lastBare)rejected.add(lastBare);}
    if(bareReady.test(text)&&text){readiness=true;lastBare=text;}
    else if(claims.some(claim=>/готов|ready|done|зібра|assembled|змонт|rendered/iu.test(claim))){readiness=true;lastBare=undefined;}
  }
  if(recoveryRejected)for(const piece of pieces){const text=piece.text.trim();if(/^(?:не вийшло|не вдалося|не получилось|не удалось|it failed|failed)[.!\s]*$/iu.test(text)||/^(?:надішли|надішліть|пришли|пришлите|send|resend).{0,70}(?:заново|знову|повторно|ще раз|снова|ещ[её] раз|again)/iu.test(text))rejected.add(text);}
  if(unresolved&&bareReady.test(plan.reply.trim()))rejected.add(plan.reply.trim());
  const invented=rejected.size>0;
  if(!required)return {plan,facts,blocked:false};
  const independent=new Set(independentActions.map(a=>JSON.stringify(a)));
  const actions=unresolved||invented?plan.actions.filter(a=>independent.has(JSON.stringify(a))):plan.actions;
  const emptyRecovery=active.some(x=>['failed','needs_input','needs_consent','uncertain','cancelled'].includes(x.status))&&(!plan.reply.trim()||/^(?:добре|домовились|гаразд|ок|okay|ok|на зв[’']язку|все добре|усе добре|не хвилюйся|я поруч|з радістю|звісно)[\s!.😊✨❤]*$/iu.test(plan.reply.trim()));
  if(invented||emptyRecovery){
    const listMessages=unconfirmedPurchase?active.filter(f=>f.capability==='lists.manage'&&f.status==='observed'&&f.listMessage).map(f=>f.listMessage!):[];
    const trusted=unconfirmedPurchase?[...new Set([...listMessages,outcomeMessage(active)].filter(Boolean))].join('\n\n')||'Не маю підтвердження покупки.':outcomeMessage(active)||'Поки не маю підтвердження, що цю дію виконано. Потрібно перевірити результат.';
    const keep=(text:string)=>outcomePieces(text,hasListResult).filter(piece=>!rejected.has(piece.text.trim())).map(piece=>text.slice(piece.start,piece.end)).join('').trim();
    const card=plan.presentation?.card,safe=[emptyRecovery&&!invented?'':keep(plan.reply),...(card?[keep(card.summary||''),...(card.facts||[]).map(keep),keep(card.question||''),card.details?keep(card.details):'']:[])].filter(text=>text&&!bareReady.test(text));
    const preserved=safe.filter((text,index)=>!safe.slice(0,index).some(prior=>prior.includes(text))).join('\n\n');
    return {plan:{...plan,reply:[preserved,preserved.includes(trusted)?'':trusted].filter(Boolean).join('\n\n'),actions,presentation:undefined,interaction:undefined,offer:undefined,dialogue:undefined,behavior:plan.behavior?{...plan.behavior,move:'repair',clarification:undefined}:undefined},facts,blocked:true};
  }
  // A failed attempt or queued job does not invalidate a truthful question or recovery.
  const removed=actions.length!==plan.actions.length;
  return {plan:removed?{...plan,actions,interaction:undefined,offer:undefined}:plan,facts,blocked:removed};
}

export function decisionFactsText(facts:OutcomeFact[]) {
  return currentOutcomes(facts).filter(x=>x.status==='uncertain').length?outcomeMessage(facts):'';
}
