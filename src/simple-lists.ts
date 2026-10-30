import {z} from 'zod';
import {one,state,type Database,type Row,type SQL} from './db.js';
import {assertActionOwner} from './commitments.js';
import {checkOperation,stableId} from './operations.js';
import {digest} from './evolution-core.js';
import {recordProvenance} from './provenance.js';
import {ToolError} from './safe-http.js';
import {requestAuthorityView,type RequestAuthorityView,type RequestDataRange} from './outcomes.js';
import {loadOriginalRequestContext,type ValidatedOriginalRequest} from './request-context.js';
import type {ToolContext} from './agent-tools.js';

/** A small textual list deliberately has no quantity, inventory or project contract. */
export const ListCommand=z.object({
 operation:z.enum(['add','list','complete','remove']),
 category:z.enum(['shopping','todo']),
 text:z.string().trim().min(1).max(300).optional(),
 items:z.array(z.string().trim().min(1).max(300)).min(1).max(50).optional(),
 id:z.string().uuid().optional(),version:z.number().int().positive().optional(),
 status:z.enum(['open','completed','all']).default('open'),
 after:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(50),
 quote:z.string().min(2).max(2500).optional(),
 source_ids:z.array(z.number().int().positive()).max(50).optional(),
}).strict();
type ListArgs=z.infer<typeof ListCommand>;
type Scope={topic:string;audience:'group'|'private';actor:string};
const clean=(text:string)=>text.normalize('NFKC').trim().replace(/\s+/gu,' ');
const normalized=(text:string)=>clean(text).toLocaleLowerCase('uk-UA');
const uniqueSources=(values:unknown[])=>[...new Set(values.map(Number).filter(id=>Number.isSafeInteger(id)&&id>0))];
type ContinuationContext=Pick<ToolContext,'actorId'|'chatId'|'topicId'|'revision'|'sourceId'|'requestText'|'audience'>;
const scopeFor=(c:ContinuationContext):Scope=>({topic:c.topicId,audience:c.audience==='private'||Number(c.chatId)>0?'private':'group',actor:c.audience==='private'||Number(c.chatId)>0?c.actorId:''});
const scopeArgs=(s:Scope,category:string)=>[s.topic,s.audience,s.actor,category];
const continuationStart=/^(?:(?:люмене?|lumen|@\w+)[,!:]?\s*)?(?:ще|іще|і|й|також|ещ[её]|и|также|also|and|more)\s+\S/iu;
const operationVerbs={
 add:/(?:запиш|запис|дода[йт]|додат|добав|внес|внест|занес|занест|add|put|remember)|(?:до|to).{0,20}(?:спис|покуп|справ|list)/iu,
 complete:/познач|відміт|отмет|заверш|викона|зроблен|готов|купив|купила|купили|complete|done|check\s*off/iu,
 remove:/видал|приб[еи]р|вилуч|викрес|убер|удал|remove|delete|cross\s*out/iu,
};
const listPrivateQuestion='Для особистого списку напиши мені в особистому чаті. Перейдемо туди?';
const personalListIntent=(text:string)=>/(?:особист\p{L}*|приват\p{L}*|личн\p{L}*|персональн\p{L}*|personal|private)\s+(?:спис\p{L}*|покуп\p{L}*|справ\p{L}*|list|shopping|todo)|особисто\s+(?:для\s+)?мені|лично\s+мне|(?:тільки|лише)\s+(?:для\s+)?мене|только\s+(?:для\s+)?меня|(?:only|just)\s+for\s+me/iu.test(bareIntent(text));
const stripAddress=(text:string)=>text.replace(/^\s*(?:(?:люмене?|lumen|@\w+)[,!:\s]*)?/iu,'').trim();
const metaRequest=(text:string)=>/^(?:переклади|переведи|переведите|translate|процитуй|процитируй|quote|що означає|що значить|что значит|what does)(?=$|[\s:])/iu.test(stripAddress(bareIntent(text)));
const negatedMutation=/(?:^|\s)(?:не|no|not|don['’]t)\s+(?:(?:треба|потрібно|нужно|need\s+to)\s+)?(?:дода|добав|запис|запиш|внес|занес|видал|удал|приб[еи]р|убер|вилуч|викрес|познач|відміт|отмет|заверш|add|put|remember|remove|delete|complete|check)/iu;
const maskQuoted=(text:string)=>requestAuthorityView(text)?.commandText??text.replace(/[^\r\n]/g,' ');
const bareIntent=(text:string)=>maskQuoted(text).trim();
const labelHeader='(?:(?<shopping>список[ \\t]+покупок|покупки|shopping(?:[ \\t]+list)?|grocery[ \\t]+list|groceries)|(?<todo>список[ \\t]+(?:справ|завдань|дел|задач)|справи|завдання|дела|задачи|to[ \\t–‑-]?do(?:[ \\t]+list)?|task[ \\t]+list|tasks|things[ \\t]+to[ \\t]+do))[ \\t]*(?::[ \\t]*|(?=\\r?\\n|$))';
const labelAnywhere=new RegExp('(?<![\\p{L}\\p{N}])'+labelHeader,'iu');
const stripItemMarker=(text:string)=>text.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/u,'').trim();
function declaredItems(payload:string,commas:boolean){
 const text=payload;
 const masked=maskQuoted(text),boundary=commas?/[\n;,]/gu:/[\n;]/gu,items:string[]=[];let start=0;
 for(const match of masked.matchAll(boundary)){items.push(stripItemMarker(text.slice(start,match.index)));start=match.index!+1;}
 items.push(stripItemMarker(text.slice(start)));return items.filter(Boolean);
}
function labeledList(text:string,commandText=maskQuoted(text)){
 const input=stripAddress(text);
 const inputStart=text.indexOf(input),commandInput=commandText.slice(inputStart,inputStart+input.length);
 const headings=new RegExp('(?:^|[\\n;])[ \\t]*'+labelHeader,'giu');
 const rawHeading=new RegExp('^(?:[\\n;])?[ \\t]*'+labelHeader,'iu');
 const matches=[...commandInput.matchAll(headings)].flatMap(match=>{
  const raw=rawHeading.exec(input.slice(match.index));
  return raw?[{index:match.index!,length:raw[0].length,groups:raw.groups}]:[];
 });if(!matches.length)return;
 const prefix=input.slice(0,matches[0]!.index).trim(),prefixCommand=commandInput.slice(0,matches[0]!.index).trim();
 const sections=matches.map((match,index)=>({category:match.groups?.shopping?'shopping':'todo',payload:input.slice(match.index+match.length,matches[index+1]?.index),start:inputStart+match.index+match.length,end:inputStart+(matches[index+1]?.index??input.length)}));
 return {prefix,prefixCommand,sections};
}
type BoundClause={body:string;command:string;start:number;end:number;data:string[]};
function boundClauses(text:string,masked=maskQuoted(text),ranges:ReadonlyArray<RequestDataRange>=[]):BoundClause[]{
 // Quoted item titles stay intact. A noun-first statement after “а/but” is a
 // separate clause even when it does not repeat an imperative.
 const boundary=/[.!?](?=\s|$)|[;\n]|,?\s+(?:а|але|проте|однак|но|зато|but|however)\s+|,?\s+(?:і|й|та|також|и|также|and|also)\s+(?=(?:через|завтра|пізніше|потом|позже|напомн|нага|remind|не\s|дода|добав|запиш|познач|відміт|отмет|прибер|прибир|видал|удал|убер|add|put|remove|delete|complete|переклади|переведи|translate))|,\s*(?=(?:дода|добав|запиш|внес|познач|відміт|отмет|прибер|прибир|видал|удал|убер|add|put|remove|delete|complete))|(?:,\s*|\s+(?:і|й|та|и|and)\s+)(?=[^,;.!?\n]{0,160}(?<![\p{L}\p{N}])(?:вже|уже|already|купив|купила|купили|купил|куплено|bought|маю|є)(?![\p{L}\p{N}]))/giu;
 const parts:BoundClause[]=[];let start=0;
 const push=(end:number)=>{if(text.slice(start,end).trim())parts.push({body:text.slice(start,end).trim(),command:masked.slice(start,end).trim(),start,end,data:[]});};
 for(const match of masked.matchAll(boundary)){push(match.index!);start=match.index!+match[0].length;}
 push(text.length);
 for(let index=0;index<parts.length;index++)if(/[:：]\s*$/u.test(parts[index]!.command)){
  for(let next=index+1;next<parts.length&&!parts[next]!.command;next++)for(const range of ranges){
   if(range.offset>=parts[next]!.start&&range.offset+range.length<=parts[next]!.end){const data=text.slice(range.offset,range.offset+range.length).trim();if(data&&!parts[index]!.data.includes(data))parts[index]!.data.push(data);}
  }
 }
 return parts;
}
const clauses=(text:string,masked?:string)=>boundClauses(text,masked).map(part=>part.body);
type ListCategory='shopping'|'todo';
function destinationCategories(text:string):ListCategory[]{
 const visible=maskQuoted(text),found=new Set<ListCategory>();
 const modifier=String.raw`(?:мій|моя|моє|мої|мого|моєї|мою|моєму|моїм|моїх|наш\p{L}*|мой|мои|моего|моей|моём|моем|моим|моих|цей|ця|це|ці|цього|цієї|цю|цьому|цим|цих|этот|эта|это|эти|этого|этой|эту|этом|этим|этих|групов\p{L}*|спільн\p{L}*|общ\p{L}*|особист\p{L}*|личн\p{L}*|my|our|your|the|a|this|shared|group|personal|private)`;
 const destination=new RegExp(String.raw`(?<![\p{L}\p{N}])(?:до|у|в|зі|із|з|из|to|into|in|from|on|onto)\s+(?:${modifier}\s+){0,2}(?:(?:спис\p{L}*|list\s+of)\s+)?(?:${modifier}\s+){0,2}(?:(?<shopping>покуп\p{L}*|shopping(?:\s+list)?|grocer\p{L}*(?:\s+list)?)|(?<todo>справ\p{L}*|завдан\p{L}*|дел(?:а|ах)?|задач\p{L}*|to[\s–‑-]?do(?:\s+list)?|tasks?(?:\s+list)?|things\s+to\s+do))(?![\p{L}\p{N}])`,'giu');
 for(const match of visible.matchAll(destination))found.add(match.groups?.shopping?'shopping':'todo');
 return [...found];
}
function categoryClauses(source:string,quote:string,operation:'add'|'complete'|'remove',category:ListCategory,sourceCommand=maskQuoted(source),quoteCommand=maskQuoted(quote),ranges:ReadonlyArray<RequestDataRange>=[]){
 const sourceClauses=boundClauses(source,sourceCommand,ranges),requested=boundClauses(quote,quoteCommand).filter(part=>!metaRequest(part.command)&&(operationVerbs[operation].test(part.command)||operation==='add'&&continuationStart.test(part.command)));
 const accepted=requested.filter(part=>{
  const direct=destinationCategories(part.command),plain=normalized(part.command);
  const matching=sourceClauses.filter(value=>{
   const visible=normalized(value.command);return visible&&plain&&(visible.includes(plain)||plain.includes(visible));
  });
  const categories=direct.length?direct:[...new Set(matching.flatMap(value=>destinationCategories(value.command)))];
  part.data=matching.flatMap(value=>value.data);
  return !categories.length||categories.length===1&&categories[0]===category;
 });
 if(requested.length&&!accepted.length)throw new ToolError('list_category_unconfirmed');
 return accepted.map(part=>[part.body,...part.data].join('\n'));
}
function categoryBody(source:string,category:ListCategory,commandText=maskQuoted(source)){
 return boundClauses(source,commandText).filter(part=>{
  const categories=destinationCategories(part.command);return !categories.length||categories.length===1&&categories[0]===category;
 }).map(part=>part.body).join('; ');
}
type OriginalAuthority={request:ValidatedOriginalRequest;view:RequestAuthorityView};
async function originalAuthority(sql:SQL,c:ContinuationContext):Promise<OriginalAuthority|undefined>{
 if(!c.sourceId)return;
 const request=await loadOriginalRequestContext(sql,{sourceId:c.sourceId,actorId:c.actorId,topicId:c.topicId,namespaceChatId:c.chatId,audience:scopeFor(c).audience,revision:c.revision});
 if(!request||request.forwarded||request.viaBot)return;
 const view=requestAuthorityView(request.body,request.entities);return view?{request,view}:undefined;
}
function readObject(text:string):ListCategory[]|undefined{
 const modifier=String.raw`(?:мій|моя|моє|мої|мого|моєї|мою|моєму|моїм|моїх|наш\p{L}*|мой|мои|моего|моей|моём|моем|моим|моих|цей|ця|це|ці|цього|цієї|цю|цьому|цим|цих|этот|эта|это|эти|этого|этой|эту|этом|этим|этих|поточн\p{L}*|наявн\p{L}*|текущ\p{L}*|актуальн\p{L}*|відкрит\p{L}*|зроблен\p{L}*|завершен\p{L}*|незавершен\p{L}*|групов\p{L}*|спільн\p{L}*|общ\p{L}*|особист\p{L}*|личн\p{L}*|весь|увесь|всі|все|my|our|the|this|current|full|entire|all|open|remaining|completed|shared|group|personal|private)`;
 const modifiers=String.raw`(?:${modifier}\s+){0,3}`,heading=String.raw`(?:(?:спис\p{L}*|list\s+of)\s+${modifiers})?`;
 const object=new RegExp(String.raw`^${modifiers}(?:(?<shopping>${heading}(?:покуп\p{L}*|shopping(?:\s+list)?|grocer\p{L}*(?:\s+list)?))|(?<todo>${heading}(?:справ\p{L}*|завдан\p{L}*|дел(?:а|ах)?|задач\p{L}*|to[\s–‑-]?do(?:\s+list)?|tasks?(?:\s+list)?|things\s+to\s+do))|(?<generic>спис\p{L}*|list))(?=$|[^\p{L}\p{N}])(?<tail>.*)$`,'iu').exec(text);
 if(!object)return;
 const tail=object.groups!.tail!.replace(/^[\s,:]+/u,'').replace(/[.!?？]+$/u,'').trim();
 // The object is the actual list. Only bounded display/filter qualifiers may
 // follow it; an arbitrary instruction containing a list noun is not a view.
 if(tail&&!/^(?:(?:будь\s+ласка|пожалуйста|please|зараз|тепер|сейчас|сьогодні|сегодня|today|now|left|remaining|open|completed|є|есть|лишил\p{L}*|залишил\p{L}*|остал\p{L}*)(?:\s+|$))*$/iu.test(tail)&&!/^(?:containing|including|with|із\s+пункт\p{L}*|з\s+пункт\p{L}*|де\s+є\s+пункт\p{L}*)(?=$|\s)/iu.test(tail))return;
 return object.groups!.shopping?['shopping']:object.groups!.todo?['todo']:[];
}
function readClause(part:string):ListCategory[]|undefined{
 const visible=part.replace(/^(?:(?:будь\s+ласка|пожалуйста|please)[,\s]+)+/iu,'').replace(/^(?:can|could)\s+you\s+(?=(?:show|view|list|read|display)(?![\p{L}\p{N}]))/iu,'').replace(/[.!?？]+$/u,'').trim();
 const verb=/^(?:покажи|покажіть|покажите|показуй|показуйте|показывай|показывайте|показати|показать|переглянь|перегляньте|переглянути|прочитай|прочитайте|прочитати|прочитать|посмотри|посмотрите|посмотреть|show|view|list|read|display)(?![\p{L}\p{N}])\s*[,;:]?\s*(.*)$/iu.exec(visible);
 const body=(verb?verb[1]!:visible).replace(/^(?:(?:будь\s+ласка|пожалуйста|please|мені|мне|нам|me|us|aloud|вголос|вслух)[,\s]+)+/iu,'');
 // These positive data-view forms are deliberately finite. Generic how/to
 // instructions have no fallback, regardless of the procedural verb used.
 const count=/^(?:(?:скільки|сколько)\s+(?:(?:пункт\p{L}*|покуп\p{L}*|справ\p{L}*|дел|задач\p{L}*)\s+)?(?:(?:є|осталось|лишилося)\s+)?(?:у|в|на)|how\s+many\s+(?:(?:items|entries|tasks|things|purchases)\s+)?(?:(?:are|remain|left)\s+)*(?:in|on))\s+(.+)$/iu.exec(body);
 if(count)return readObject(count[1]!);
 const location=/^(?:(?:що|что)\s+(?:(?:є|есть)\s+)?(?:(?:у|в)\s+нас\s+)?(?:у|в|на)|what(?:['’]s|\s+(?:is|are))\s+(?:on|in))\s+(.+)$/iu.exec(body);
 if(location)return readObject(location[1]!);
 const remaining=/^(?:(?:що|что)\s+(?:(?:ще|ещ[её]|нам|мені|мне)\s+){0,2}(?:лишилося|залишилося|осталось)\s+(?:ще\s+)?(?<slavic>купити|купить|зробити|сделать)|what(?:['’]s|\s+is)?\s+(?:left|remaining|remains|still\s+left)\s+(?:to\s+)?(?<english>buy|do))$/iu.exec(body);
 if(remaining)return /куп|buy/iu.test(remaining.groups!.slavic||remaining.groups!.english!)?['shopping']:['todo'];
 const appearance=/^(?:як\s+вигляда(?:є|ють)|как\s+выгляд(?:ит|ят))\s+(.+)$/iu.exec(body)||/^how\s+(?:does\s+)?(.+?)\s+looks?$/iu.exec(body);
 if(appearance)return readObject(appearance[1]!);
 if(verb)return readObject(body);
 const which=/^(?:які|яка|какие|какой|what)\s+(.+)$/iu.exec(body);
 return which?readObject(which[1]!):undefined;
}
function readSelection(text:string):{categories:ListCategory[]}|undefined{
 const visible=stripAddress(text);
 if(!visible||negatedMutation.test(visible))return;
 const joined=/[,;]?\s+(?:і|й|та|також|и|также|and|also)\s+(?=(?:покаж|показ|перегля|прочит|посмотр|show|view|list|read|display|що|что|what|поясни|объясни|explain|переклад|перевед|translate|процит|quote|не\s|not\s|don['’]t\s))/iu;
 const found=new Set<ListCategory>();let selected=false;
 for(const raw of clauses(visible,visible).flatMap(part=>part.split(joined))){
  const part=stripAddress(raw).replace(/^(?:а|і|й|також|и|также|and|also)[,:]?\s+/iu,'');
  if(metaRequest(part)||/^(?:не|not|don['’]t)\s+(?:показ|перегля|прочит|show|view|list|read)/iu.test(part))continue;
  if(/(?<![\p{L}\p{N}])(?:приклад|пример|зраз|образ(?:ец|ц)|шаблон|перекла(?:д|ст)|перев(?:од|ед|ест)|транслітер|транслитер|вимов|произно|произне|цитат|процит|означ|значенн|значени|тлумач|толкова|example|sample|template|demo|translat|transliter|pronounc|spell|quot|definition|meaning|means?)\p{L}*(?![\p{L}\p{N}])/iu.test(part))continue;
  const categories=readClause(part);if(!categories)continue;
  selected=true;for(const category of categories)found.add(category);
 }
 return selected?{categories:[...found]}:undefined;
}
const pronominalTarget=/(?:дода\p{L}*|добав\p{L}*|запиш\p{L}*|внес\p{L}*|познач\p{L}*|відміт\p{L}*|отмет\p{L}*|прибер\p{L}*|прибир\p{L}*|видал\p{L}*|вилуч\p{L}*|убер\p{L}*|удал\p{L}*|add|put|remove|delete|complete|check\s+off)\s+(?:(?:будь\s+ласка|пожалуйста|please)\s+)?(?:це|цей|цю|те|ту|той|його|її|їх|ці|это|этот|эту|его|е[её]|их|эти|this|that|it|them|these)(?=$|[\s,.!?])/iu;
const filler=new Set(['у','в','до','на','з','зі','із','від','для','і','й','та','и','с','со','of','to','the','a','an','and']);
function wordKey(word:string){
 const w=normalized(word).replaceAll('ё','е');
 if(/^(?:подзвон\p{L}*|зателефон\p{L}*|позвон\p{L}*|дзвон\p{L}*|call)$/u.test(w))return 'call';
 if(/^(?:купи\p{L}*|купу\p{L}*|buy)$/u.test(w))return 'buy';
 let stem=w.replace(/(?:ами|ями|ові|еві|ого|ому|ою|ею|ими|ыми|ая|яя|ие|ые|ой|ое|ее|ым|им|ую|юю|ам|ям|ом|ем|ів|ей|ах|ях|у|ю|а|я|и|і|о|е|ь|ы)$/u,'');
 if(stem.length<3)stem=w;
 return stem==='майстер'?'майстр':stem;
}
function groundedTarget(target:string,text:string,category:string){
 const literal=normalized(target).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 if(new RegExp('(?<![\\p{L}\\p{N}])'+literal+'(?![\\p{L}\\p{N}])','u').test(normalized(text)))return true;
 const tokens=(target.match(/[\p{L}\p{N}]+/gu)||[]).filter(word=>!filler.has(normalized(word))).map(wordKey).filter(word=>!(category==='shopping'&&word==='buy'));
 const available=new Set((text.match(/[\p{L}\p{N}]+/gu)||[]).map(wordKey));
 return tokens.length>0&&tokens.every(word=>available.has(word));
}
type ListAuthorization={dependencies:number[];body:string;clauses:string[];references:string[];labeledWholeItems?:string[];original?:OriginalAuthority};
function excludedTarget(target:string,clause:string,category:string){
 const exclusions=clause.matchAll(/(?:^|\s)(?:без|окрім|крім|кроме|without|except|не(?!\s+(?:забуд|лише|тільки|только))|not(?!\s+(?:forget|only)))\s+([^,;.!?\n]+)/giu);
 return [...exclusions].some(match=>groundedTarget(target,match[1]!,category));
}
function moreReference(clause:string){
 return /^(?:дода\p{L}*|добав\p{L}*|запиш\p{L}*|внес\p{L}*|add|put)\s+(?:ще|іще|ещ[её]|more)(?:\s+(?:(?:на|до|у|в|for|to)\s+(?:завтра|сьогодні|потім|спис\p{L}*|покуп\p{L}*|tomorrow|today|later|shopping|the\s+list)))?[.!]?$/iu.test(stripAddress(bareIntent(clause)));
}
function authorizedTarget(target:string,a:ListArgs,authorization:ListAuthorization,id?:string){
 if(authorization.clauses.some(clause=>excludedTarget(target,clause,a.category)))return false;
 if(authorization.labeledWholeItems)return authorization.clauses.some(item=>groundedTarget(target,item,a.category))||authorization.labeledWholeItems.some(item=>normalized(item)===normalized(target));
 if(authorization.clauses.some(clause=>{
  const request=clause.split(/\s+(?:бо|оскільки|тому\s+що|потому\s+что|так\s+как|because|since)\s+/iu)[0]!;
  return id&&request.includes(id)||groundedTarget(target,request,a.category);
 }))return true;
 if(a.operation==='add')for(const clause of authorization.clauses.filter(moreReference)){
  const current=clauses(authorization.body),index=current.findIndex(part=>part===clause);
  const antecedent=index>0?current[index-1]:undefined;
  if(antecedent?groundedTarget(target,antecedent,a.category):authorization.references.some(body=>groundedTarget(target,body,a.category)))return true;
 }
 if(!authorization.clauses.some(clause=>pronominalTarget.test(bareIntent(clause))))return false;
 return groundedTarget(target,authorization.body,a.category)||authorization.references.some(body=>groundedTarget(target,body,a.category));
}
function targetQuestion(operation:string,source_ids:number[]){return {operation,status:'needs_input',reason:'list_target_unconfirmed',question:operation==='add'?'Який саме пункт потрібно додати до списку?':operation==='complete'?'Який саме пункт позначити як зроблений?':'Який саме пункт потрібно прибрати зі списку?',source_ids};}

// The first surviving add owns the text/attribution; the latest surviving event owns
// its state. Erasing completion/removal therefore restores only a surviving add.
const projection=`WITH scoped AS (
 SELECT * FROM simple_list_events WHERE topic_id=$1 AND audience=$2 AND scope_actor=$3 AND category=$4
), additions AS (
 SELECT DISTINCT ON(item_id) item_id,text,normalized_text,owner_id,ordinal AS first_ordinal,created_at
 FROM scoped WHERE operation='add' ORDER BY item_id,ordinal
), latest AS (
 SELECT DISTINCT ON(item_id) item_id,operation,ordinal,actor_id,created_at AS updated_at
 FROM scoped ORDER BY item_id,ordinal DESC
)
SELECT a.item_id AS id,a.text,a.normalized_text,a.owner_id,a.first_ordinal,a.created_at,
 l.ordinal AS version,l.actor_id AS updated_by,l.updated_at,
 CASE l.operation WHEN 'add' THEN 'open' WHEN 'complete' THEN 'completed' ELSE 'removed' END AS status,
 ARRAY(SELECT source_message_id FROM (
  SELECT e.source_message_id FROM scoped e WHERE e.item_id=a.item_id
  UNION SELECT p.source_message_id FROM scoped e JOIN provenance_edges p ON p.derived_kind='list_event' AND p.derived_key=e.id::text WHERE e.item_id=a.item_id
 ) sources ORDER BY source_message_id) AS source_ids
FROM additions a JOIN latest l ON l.item_id=a.item_id`;

function itemResult(row:Row,s:Scope,category:string){return {
 id:row.id,text:row.text,category,status:row.status,version:Number(row.version),
 owner_id:row.owner_id,audience:s.audience,topic_id:s.topic,
 source_ids:uniqueSources(row.source_ids||[]),
};}
function resultSources(items:any[],sourceId?:number){return uniqueSources([...(sourceId?[sourceId]:[]),...items.flatMap(item=>item.source_ids||[])]);}
function validateShape(a:ListArgs){
 if(a.operation==='add'){
  if(Boolean(a.text)===Boolean(a.items)||a.id||a.version)throw new ToolError('list_text_or_items_required');
 }else if(a.operation==='list'){
  if(a.text||a.items||a.id||a.version||a.source_ids?.length)throw new ToolError('list_read_selector_unexpected');
 }else if(a.items||Boolean(a.id)===Boolean(a.text)||Boolean(a.id)!==Boolean(a.version))throw new ToolError('list_id_and_version_or_exact_text_required');
}

/** Narrow admission evidence for “Ще сир”; calling this never performs a mutation. */
export async function isListAddContinuation(sql:SQL,c:ContinuationContext,category?:'shopping'|'todo'){
 if(!c.sourceId)return false;
 const live=await state(sql);if(live.paused||live.memory_revision!==c.revision||String(live.chat_id)!==String(c.chatId))return false;
 const original=await originalAuthority(sql,c);if(!original)return false;
 const text=original.view.commandText.trim();
 if(text.length<2||text.length>200||/[?？]|переклад|перевед|перевод|translate|процит|це цитата|это цитата/iu.test(text)||!continuationStart.test(text)||personalListIntent(text)||scopeFor(c).audience==='group'&&c.requestText&&personalListIntent(c.requestText))return false;
 return Boolean(await priorListSelection(sql,c,category));
}
async function priorListSelection(sql:SQL,c:ContinuationContext,category?:ListCategory){
 const scope=scopeFor(c);
 const rows=(await sql.query(`SELECT previous.id,selected.category,selected.source_ids FROM messages current JOIN LATERAL (
  SELECT id,user_id,created_at FROM messages WHERE role='user' AND topic_id=current.topic_id AND id<current.id ORDER BY id DESC LIMIT 1
 ) previous ON previous.user_id=$2 AND current.created_at-previous.created_at BETWEEN interval '0 seconds' AND interval '15 minutes'
 JOIN LATERAL (
  SELECT e.category,jsonb_build_array(e.source_message_id) AS source_ids FROM simple_list_events e
   WHERE e.source_message_id=previous.id AND e.operation='add' AND e.topic_id=$3 AND e.audience=$4 AND e.scope_actor=$5 AND e.revision=$6::integer
  UNION ALL
  SELECT d.result->>'category',d.source_ids FROM domain_commands d
   WHERE d.domain='lists' AND d.actor_id=$2 AND d.source_message_id=previous.id AND d.result->>'context_only'='true'
    AND d.result->>'operation'='list' AND d.result->>'topic_id'=$3 AND d.result->>'audience'=$4 AND d.result->>'scope_actor'=$5
    AND d.result->>'revision'=($6::integer)::text AND d.result->>'category' IN ('shopping','todo')
 ) selected ON true WHERE current.id=$1`,[c.sourceId,c.actorId,scope.topic,scope.audience,scope.actor,c.revision])).rows;
 const categories=[...new Set(rows.map(row=>String(row.category)))];
 if(categories.length!==1||category&&categories[0]!==category)return;
 return {category:categories[0] as ListCategory,dependencies:uniqueSources(rows.flatMap(row=>[row.id,...row.source_ids||[]]))};
}
async function rememberReadSelection(sql:SQL,c:ToolContext,a:ListArgs,s:Scope,items:any[],original?:OriginalAuthority){
 if(!c.sourceId||!original)return;
 const read=readSelection(original.view.commandText);if(!read||read.categories.length>1)return;
 if(read.categories.length&&read.categories[0]!==a.category)throw new ToolError('list_category_unconfirmed');
 const previous=!read.categories.length?await priorListSelection(sql,c,a.category):undefined;
 if(!read.categories.length&&!previous)return;
 const canonical={operation:'list',category:a.category,context_only:true,topic_id:s.topic,audience:s.audience,scope_actor:s.actor,revision:c.revision};
 const id=stableId(['lists:read-selection',c.chatId,s.topic,s.audience,s.actor,c.actorId,a.category].join(':'));
 const sources=uniqueSources([c.sourceId,...resultSources(items),...previous?.dependencies||[]]);
 // This is scope/selection evidence, not a cached list or a mutation receipt.
 // Replace one pointer per actor/namespace/category; erasure already follows
 // domain_commands.source_ids and its source-message foreign key.
 await sql.query(`INSERT INTO domain_commands(id,domain,actor_id,arguments_hash,result,source_message_id,source_ids)
  VALUES($1,'lists',$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET arguments_hash=EXCLUDED.arguments_hash,
  result=EXCLUDED.result,source_message_id=EXCLUDED.source_message_id,source_ids=EXCLUDED.source_ids,created_at=now()`,[id,c.actorId,digest(canonical),JSON.stringify(canonical),c.sourceId,JSON.stringify(sources)]);
}

async function authorize(sql:SQL,c:ToolContext,mutation:boolean,a:ListArgs):Promise<ListAuthorization|null>{
 checkOperation();
 if(!c.requested)throw new ToolError('tool_not_requested');
 const live=await state(sql,true);
 if(live.paused||live.memory_revision!==c.revision)throw new ToolError('task_cancelled');
 if(!live.chat_id||String(live.chat_id)!==String(c.chatId))throw new ToolError('other_chat');
 await assertActionOwner(sql,c.actionId,c.revision);
 const member=await one(sql,'SELECT active FROM members WHERE user_id=$1',[c.actorId]);
 if(member?.active===false||!member&&live.owner_id!==c.actorId&&!(live.participants||[]).some((p:any)=>String(p.id)===c.actorId))throw new ToolError('member_required');
 const source=c.sourceId?await one(sql,"SELECT user_id,role,body,topic_id FROM messages WHERE id=$1",[c.sourceId]):undefined;
 const original=await originalAuthority(sql,c);
 const currentRequest=original?.view.commandText||(source?.role==='user'&&source.user_id===c.actorId&&source.topic_id===c.topicId?String(source.body):c.requestText||'');
 if(scopeFor(c).audience==='group'&&(c.personal||personalListIntent(currentRequest)))return null;
 if(!mutation)return {dependencies:[],body:currentRequest,clauses:[],references:[],original};
 if(!c.sourceId)throw new ToolError('list_current_source_required');
 if(!source||source.role!=='user'||source.user_id!==c.actorId||source.topic_id!==c.topicId)throw new ToolError('list_current_source_required');
 if(!original)throw new ToolError('list_request_unconfirmed');
 const quote=a.quote||original.request.body,quoteAt=original.request.body.indexOf(quote);
 if(quoteAt<0)throw new ToolError('list_request_unconfirmed');
 const quoteCommand=original.view.commandText.slice(quoteAt,quoteAt+quote.length),plain=quoteCommand.trim(),visibleSource=original.view.commandText;
 const quoteBound=plain.length>=2;
 if(labelAnywhere.test(visibleSource)&&(/[?？]/u.test(visibleSource)||negatedMutation.test(visibleSource)||metaRequest(visibleSource)||/^(?:приклад|пример|example|це цитата|это цитата|this is a quote|питання|вопрос|question|поясни|объясни|explain|обговорімо|обсуди|discuss)(?=$|[\s:])/iu.test(stripAddress(visibleSource))))throw new ToolError('list_request_unconfirmed');
 const declaration=labeledList(original.request.body,visibleSource);
 if(declaration){
  // A category heading declares data to save, not authority to execute commands
  // inside its items. Its source, category and material targets remain bound.
  const prefix=declaration.prefixCommand,visible=visibleSource;
  if(a.operation!=='add'||!quoteBound||/[?？]/u.test(visible)||negatedMutation.test(visible)||prefix&&(!operationVerbs.add.test(prefix)||metaRequest(prefix)||/^(?:приклад|пример|example|це цитата|это цитата|this is a quote)/iu.test(stripAddress(prefix))))throw new ToolError('list_request_unconfirmed');
  const sections=declaration.sections.filter(section=>section.category===a.category);
  if(!sections.length)throw new ToolError('list_category_unconfirmed');
  const dataRanges=[...original.view.quotedDataRanges,...original.view.codeDataRanges];
  // A bare heading retains ordinary quoted titles, but an isolated quoted
  // block remains an excerpt unless an actual outside add introduces it.
  if(!prefix&&sections.every(section=>!visibleSource.slice(section.start,section.end).trim())&&sections.some(section=>dataRanges.some(range=>range.kind!=='quote'&&range.offset>=section.start&&range.offset+range.length<=section.end)))throw new ToolError('list_request_unconfirmed');
  const quotedItems=sections.flatMap(section=>dataRanges.filter(range=>range.offset>=section.start&&range.offset+range.length<=section.end).map(range=>original.request.body.slice(range.offset,range.offset+range.length).trim())).filter(Boolean);
  const items=[...sections.flatMap(section=>declaredItems(section.payload,true)),...quotedItems];
  if(!items.length)throw new ToolError('list_request_unconfirmed');
  return {dependencies:[c.sourceId],body:original.request.body,clauses:items,references:[],labeledWholeItems:[...sections.flatMap(section=>declaredItems(section.payload,false)),...quotedItems],original};
 }
 const clause=clauses(visibleSource,visibleSource).find(part=>part.includes(plain))||'';
 if(metaRequest(quoteCommand)||metaRequest(clause))throw new ToolError('list_request_unconfirmed');
 const verbs=operationVerbs[a.operation as 'add'|'complete'|'remove'];
 let continuation=false;
 if(a.operation==='add'&&!verbs.test(plain)&&!/\?/u.test(plain)&&continuationStart.test(plain)&&(a.items||[a.text!]).every(text=>groundedTarget(text,source.body,a.category))){
  continuation=await isListAddContinuation(sql,c,a.category);
 }
 if(!quoteBound||!verbs.test(plain)&&!continuation||negatedMutation.test(plain))throw new ToolError('list_request_unconfirmed');
 const referenced=uniqueSources(a.source_ids||[]).filter(id=>id!==c.sourceId),known=new Set(c.sourceIds||[]);
 if(referenced.some(id=>!known.has(id)))throw new ToolError('list_reference_unavailable');
 let references:string[]=[];
 if(referenced.length){
  const rows=(await sql.query("SELECT id,user_id,role,topic_id,body FROM messages WHERE id=ANY($1::bigint[])",[referenced])).rows;
  if(rows.length!==referenced.length||rows.some(row=>row.topic_id!==c.topicId||!['user','assistant'].includes(row.role)||scopeFor(c).audience==='private'&&row.role==='user'&&row.user_id!==c.actorId))throw new ToolError('list_reference_unavailable');
  references=rows.map(row=>String(row.body));
 }
 if(a.operation==='add'&&!referenced.length&&/(?:^|\s)(?:це|цей|цю|те|ту|той|this|that|it)(?=$|[\s,.!?])/iu.test(plain)&&!(a.items||[a.text!]).every(text=>normalized(source.body).includes(normalized(text))))throw new ToolError('list_reference_required');
 return {dependencies:[c.sourceId,...referenced],body:categoryBody(original.request.body,a.category,visibleSource),clauses:categoryClauses(original.request.body,quote,a.operation as 'add'|'complete'|'remove',a.category,visibleSource,quoteCommand,[...original.view.quotedDataRanges,...original.view.codeDataRanges]),references,original};
}

export class SimpleLists {
 constructor(private db:Database){}
 async run(a:ListArgs,c:ToolContext):Promise<any>{
  validateShape(a);
  return this.db.tx(async sql=>{
   const mutation=a.operation!=='list',authorization=await authorize(sql,c,mutation,a);
   if(!authorization)return {operation:a.operation,status:'needs_input',reason:'personal_list_requires_private_chat',question:listPrivateQuestion,source_ids:uniqueSources(c.sourceId?[c.sourceId]:[])};
   const dependencies=authorization.dependencies;
   const scope=scopeFor(c),values=scopeArgs(scope,a.category);
   if(!mutation){
    const rows=(await sql.query(`SELECT * FROM (${projection}) p WHERE status<>'removed' AND ($5='all' OR status=$5) AND first_ordinal>$6 ORDER BY first_ordinal LIMIT $7`,[...values,a.status,a.after,a.limit+1])).rows;
    const items=rows.slice(0,a.limit).map(row=>itemResult(row,scope,a.category));
    await rememberReadSelection(sql,c,a,scope,items,authorization.original);
    return {operation:'list',category:a.category,items,has_more:rows.length>a.limit,next_after:rows.length>a.limit?Number(rows[a.limit-1]!.first_ordinal):null,source_ids:resultSources(items),message:items.length?items.map(item=>`${item.status==='completed'?'✓ ':'• '}${item.text}`).join('\n'):a.category==='shopping'?'У списку покупок поки порожньо.':'У списку справ поки порожньо.'};
   }
   const texts=new Map<string,string>();
   if(a.operation==='add')for(const text of a.items||[a.text!])if(!texts.has(normalized(text)))texts.set(normalized(text),clean(text));
   const entries=[...texts.entries()];
   const canonical={operation:a.operation,category:a.category,...(a.operation==='add'?{items:entries.map(([key])=>key).sort()}:a.id?{id:a.id,version:a.version}:{text:normalized(a.text!)}),...(a.source_ids?.length?{source_ids:uniqueSources(a.source_ids).sort((a,b)=>a-b)}:{})};
   // Foreground updateId includes the replan step. The source plus canonical action
   // keeps this receipt stable across replans and process restarts.
   const explicit=c.operationKey&&!c.operationKey.startsWith('tool:')?c.operationKey:undefined;
   const key=['lists',c.chatId,scope.topic,scope.audience,scope.actor,c.actorId,c.sourceId,explicit||digest(canonical)].join(':'),id=stableId(key),hash=digest(canonical);
   const previous=await one(sql,"SELECT actor_id,arguments_hash,result FROM domain_commands WHERE id=$1 AND domain='lists'",[id]);
   if(previous&&(previous.actor_id!==c.actorId||previous.arguments_hash!==hash))throw new ToolError('operation_key_conflict');
   const namedTargets=a.operation==='add'?entries.map(([,text])=>text):a.text?[a.text]:previous?.result?.item?[previous.result.item.text]:[];
   if(namedTargets.some(target=>!authorizedTarget(target,a,authorization,a.id)))return targetQuestion(a.operation,dependencies);
   if(previous)return previous.result;
   let result:any;
   if(a.operation==='add'){
    const items:any[]=[];
    for(const [key,text] of entries){
     const existing=await one(sql,`SELECT * FROM (${projection}) p WHERE normalized_text=$5 AND status='open' ORDER BY first_ordinal LIMIT 1`,[...values,key]);
     const itemId=existing?.id||stableId(id+':item:'+key),eventId=stableId(id+':add:'+itemId);
     await this.event(sql,{id:eventId,itemId,operation:'add',text,key,owner:c.actorId},a,scope,c,dependencies);
     const current=(await sql.query(`SELECT * FROM (${projection}) p WHERE id=$5`,[...values,itemId])).rows[0]!;
     items.push({...itemResult(current,scope,a.category),outcome:existing?'already_present':'added'});
    }
    const added=items.filter(item=>item.outcome==='added').map(item=>item.text),present=items.filter(item=>item.outcome==='already_present').map(item=>item.text);
    const message=[added.length?`Додав ${a.category==='shopping'?'у покупки':'до справ'}: ${added.join(', ')}.`:'',present.length?`Уже в списку: ${present.join(', ')}.`:''].filter(Boolean).join(' ');
    result={operation:'add',category:a.category,items,added,already_present:present,source_ids:resultSources(items,c.sourceId),message};
   }else{
    const rows=(await sql.query(`SELECT * FROM (${projection}) p WHERE ${a.id?'id=$5':"normalized_text=$5 AND status<>'removed'"} ORDER BY first_ordinal`,[...values,a.id||normalized(a.text!)])).rows;
    const relevant=a.operation==='complete'&&!a.id&&rows.some(row=>row.status==='open')?rows.filter(row=>row.status==='open'):rows;
    if(relevant.length!==1){
     const candidates=relevant.map(row=>itemResult(row,scope,a.category));
     result={operation:a.operation,status:'needs_input',question:relevant.length?'Який саме пункт маєш на увазі?':'Не знайшов цей пункт у поточному списку. Який саме пункт маєш на увазі?',candidates,source_ids:resultSources(candidates,c.sourceId)};
    }else{
     const row=relevant[0]!;
     if(a.id&&Number(row.version)!==a.version)throw new ToolError('version_conflict_read_current');
     if(!authorizedTarget(row.text,a,authorization,a.id))return targetQuestion(a.operation,dependencies);
     const unchanged=row.status==='removed'||a.operation==='complete'&&row.status==='completed';
     if(!unchanged)await this.event(sql,{id:stableId(id+':'+a.operation+':'+row.id),itemId:row.id,operation:a.operation,text:row.text,key:row.normalized_text,owner:row.owner_id},a,scope,c,dependencies);
     const current=(await sql.query(`SELECT * FROM (${projection}) p WHERE id=$5`,[...values,row.id])).rows[0]!,item=itemResult(current,scope,a.category);
     const outcome=unchanged?(row.status==='removed'?'already_removed':'already_completed'):a.operation==='complete'?'completed':'removed';
     result={operation:a.operation,outcome,item,source_ids:resultSources([item],c.sourceId),message:outcome==='completed'?`Позначив як зроблене: ${item.text}.`:outcome==='removed'?`Прибрав зі списку: ${item.text}.`:outcome==='already_completed'?`Уже зроблено: ${item.text}.`:`Цей пункт уже прибрано: ${item.text}.`};
    }
   }
   checkOperation();
   result.source_ids=uniqueSources([...result.source_ids,...dependencies]);
   if(result.status!=='needs_input')await sql.query("INSERT INTO domain_commands(id,domain,actor_id,arguments_hash,result,source_message_id,source_ids) VALUES($1,'lists',$2,$3,$4,$5,$6)",[id,c.actorId,hash,JSON.stringify(result),c.sourceId,JSON.stringify(result.source_ids)]);
   return result;
  });
 }
 private async event(sql:SQL,event:{id:string;itemId:string;operation:string;text:string;key:string;owner:string},a:ListArgs,s:Scope,c:ToolContext,dependencies:number[]){
  const row=await one(sql,`INSERT INTO simple_list_events(id,item_id,operation,category,text,normalized_text,topic_id,audience,scope_actor,owner_id,actor_id,revision,source_message_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(item_id,source_message_id,operation) DO NOTHING RETURNING id`,[event.id,event.itemId,event.operation,a.category,event.text,event.key,s.topic,s.audience,s.actor,event.owner,c.actorId,c.revision,c.sourceId]);
  const actual=row||await one(sql,'SELECT id FROM simple_list_events WHERE item_id=$1 AND source_message_id=$2 AND operation=$3',[event.itemId,c.sourceId,event.operation]);
  if(actual)await recordProvenance(sql,'list_event',actual.id,dependencies);
 }
}

/** Called before generic provenance erasure, including source edits. */
export async function forgetListSource(sql:SQL,sourceId:number){
 await sql.query(`WITH RECURSIVE erased(id) AS (
  SELECT $1::bigint
  UNION SELECT d.id FROM erased e CROSS JOIN LATERAL (
   SELECT m.id FROM messages m WHERE m.source_message_id=e.id AND m.role='assistant'
   UNION SELECT m.id FROM provenance_edges p JOIN messages m ON m.id::text=p.derived_key WHERE p.derived_kind='message' AND p.source_message_id=e.id
  ) d
 ) DELETE FROM simple_list_events e WHERE e.source_message_id IN(SELECT id FROM erased)
  OR EXISTS(SELECT 1 FROM provenance_edges p WHERE p.derived_kind='list_event' AND p.derived_key=e.id::text AND p.source_message_id IN(SELECT id FROM erased))`,[sourceId]);
 await purgeOrphans(sql);
}
async function purgeOrphans(sql:SQL){
 await sql.query("DELETE FROM simple_list_events e WHERE NOT EXISTS(SELECT 1 FROM simple_list_events a WHERE a.item_id=e.item_id AND a.operation='add')");
 await sql.query("DELETE FROM provenance_edges p WHERE p.derived_kind='list_event' AND NOT EXISTS(SELECT 1 FROM simple_list_events e WHERE e.id::text=p.derived_key)");
}
export async function purgeListPhrase(sql:SQL,phrase:string){
 await sql.query('DELETE FROM simple_list_events WHERE strpos(lower(text),lower($1))>0',[phrase]);
 await purgeOrphans(sql);
}
