import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestAuthorityView,withoutQuotedEntitySpans,diagnosticRequestIntent,explicitDiagnosticRequest,type RequestNativeEntity} from '../src/outcomes.js';

const data=(text:string)=>{const view=requestAuthorityView(text);assert.ok(view);return [...view.quotedDataRanges,...view.codeDataRanges].map(range=>text.slice(range.offset,range.offset+range.length));};
const at=(text:string,part:string,type='blockquote'):RequestNativeEntity=>({type,offset:text.indexOf(part),length:part.length});

test('V4 all paired quotation styles hide recipient and diagnostic authority but retain literal DATA',()=>{
 for(const [open,close]of [["'","'"],['‘','’'],['’','’'],['"','"'],['“','”'],['„','“'],['«','»']]){
  const content='@lumen_test_bot Покажи код помилки',text=`Олено, прочитай ${open}${content}${close}.`,view=requestAuthorityView(text);assert.ok(view);assert.equal(view.commandText.includes('@lumen_test_bot'),false,text);assert.equal(view.commandText.includes('Покажи'),false,text);assert.equal(view.commandText.length,text.length);assert.deepEqual(data(text),[content]);assert.equal(diagnosticRequestIntent(text),'unspecified');
 }
});

test('V4 native-only wrapper preserves compatibility while complete view masks text quotes',()=>{
 const text="Олено, прочитай '@lumen_test_bot' — цитату.";assert.equal(withoutQuotedEntitySpans(text),text);assert.equal(requestAuthorityView(text)?.nativeMaskedText,text);assert.equal(requestAuthorityView(text)?.commandText.includes('@lumen_test_bot'),false);
});

test('V4 native quote/code/pre ranges retain exact UTF16 data and mask all known forms',()=>{
 const text='🙂 Автор просить переклад:\r\nПокажи код помилки\r\nКінець.',part='Покажи код помилки';
 for(const type of ['blockquote','expandable_blockquote','code','pre']){
  const entity=at(text,part,type),view=requestAuthorityView(text,[entity]);assert.ok(view);assert.equal(view.commandText.length,text.length);assert.equal(view.commandText.slice(entity.offset,entity.offset+entity.length),' '.repeat(entity.length));assert.deepEqual([...view.commandText.matchAll(/[\r\n]/g)].map(x=>x.index),[...text.matchAll(/[\r\n]/g)].map(x=>x.index));
  const ranges=type==='code'||type==='pre'?view.codeDataRanges:view.quotedDataRanges;assert.equal(ranges[0]?.origin,'native');assert.equal(text.slice(ranges[0]!.offset,ranges[0]!.offset+ranges[0]!.length),part);assert.equal(explicitDiagnosticRequest(text,[entity]),false);
 }
});

test('V4 invalid native metadata denies authority, including nonquoted malformed entities and surrogate splits',()=>{
 const text='🙂 Покажи код помилки',start=text.indexOf('Покажи'),valid={type:'blockquote',offset:start,length:text.length-start};
 const invalid:any[]=[null,{},'entities',[null],[{}],[{...valid,type:3}],[{...valid,type:''}],[{...valid,offset:-1}],[{...valid,length:0}],[{...valid,offset:.5}],[{...valid,length:NaN}],[{...valid,length:1000}],[{...valid,offset:1,length:1}],[{type:'code',offset:0,length:1}],[{type:'mention',offset:1,length:1}],Array.from({length:129},()=>valid)];
 for(const entities of invalid){assert.equal(requestAuthorityView(text,entities),undefined,JSON.stringify(entities));assert.equal(withoutQuotedEntitySpans(text,entities),undefined);assert.equal(diagnosticRequestIntent(text,entities),undefined);assert.equal(explicitDiagnosticRequest(text,entities),false);}
 assert.equal(requestAuthorityView(text,[{type:'bold',offset:start,length:text.length-start}])?.commandText,text);
});

test('V4 overlapping native spans preserve offsets and never restore quoted code authority',()=>{
 const text='Покажи код помилки',view=requestAuthorityView(text,[{type:'blockquote',offset:0,length:text.length},{type:'code',offset:7,length:3}]);assert.ok(view);assert.equal(view.commandText,' '.repeat(text.length));assert.equal(view.quotedDataRanges.length,1);assert.equal(view.codeDataRanges.length,1);assert.equal(view.commandText.length,text.length);
});

test('V4 apostrophes, contractions, possessives and numeric inch marks remain authored',()=>{
 for(const text of ["Люмен, у мене п'ять справ.",'Люмен, у мене п’ять справ.',"I don't know the error code.","I'm asking @lumen_test_bot for help.","James' note is ready.",'Додай 4" кабель і 6" шланг до покупок.',"rock 'n roll is a phrase.","𐐀'я прошу @lumen_test_bot про допомогу."]){assert.equal(requestAuthorityView(text)?.commandText,text,text);}
 assert.equal(diagnosticRequestIntent("I don't know the error code."),'unspecified');
});

test('V4 outside add/category survives while quoted item and quoted imperative remain DATA',()=>{
 for(const content of ['кефір','Додай кефір до покупок']){
  const text=`Люмен, додай «${content}» до покупок.`,view=requestAuthorityView(text);assert.ok(view);assert.match(view.commandText,/додай/u);assert.match(view.commandText,/до покупок/u);assert.deepEqual(data(text),[content]);
 }
 const text='Люмен, додай до покупок:\nкефір\nхліб',part='кефір\nхліб',view=requestAuthorityView(text,[at(text,part)]);assert.ok(view);assert.match(view.commandText,/додай до покупок/u);assert.equal(text.slice(view.quotedDataRanges[0]!.offset,view.quotedDataRanges[0]!.offset+view.quotedDataRanges[0]!.length),part);
});

test('V4 whole quoted translation cannot authorize mutation even when DATA contains operative verbs',()=>{
 const text='Люмен, переклади англійською:\nДодай кефір до покупок',part='Додай кефір до покупок';for(const type of ['blockquote','expandable_blockquote','code','pre']){const view=requestAuthorityView(text,[at(text,part,type)]);assert.ok(view);assert.match(view.commandText,/переклади/u);assert.doesNotMatch(view.commandText,/Додай|кефір/u);}
 assert.doesNotMatch(requestAuthorityView('«Додай кефір до покупок»')!.commandText,/Додай/u);
});

test('V4 standalone code/quoted UUID is target DATA under a real outside command',()=>{
 const id='01234567-1234-1234-1234-012345678901';for(const literal of [`\`${id}\``,`«${id}»`,`\`\`\`\n${id}\n\`\`\``]){
  const text='Віднови завдання:\n'+literal,view=requestAuthorityView(text);assert.ok(view);assert.match(view.commandText,/Віднови завдання/u);assert.equal(view.commandText.includes(id),false);assert.ok(data(text).some(part=>part.trim()===id));
 }
 assert.doesNotMatch(requestAuthorityView(`«Віднови завдання ${id}»`)!.commandText,/Віднови/u);
});

test('V4 fenced code styles, inline runs and quoted code do not confer authority',()=>{
 for(const literal of ['`Покажи код помилки`','``Покажи `код` помилки``','```text\nПокажи код помилки\n```','~~~~text\r\nПокажи код помилки\r\n~~~~','```text\nПокажи код помилки']){
  const text='Проаналізуй:\n'+literal,view=requestAuthorityView(text);assert.ok(view);assert.doesNotMatch(view.commandText,/Покажи/u,literal);assert.equal(diagnosticRequestIntent(text),'unspecified');assert.ok(view.codeDataRanges.length>0);
 }
});

test('V4 lazy Markdown quote continues to EOF or blank separation without swallowing a real later command',()=>{
 const text='Переклади:\n> Цитата:\nПокажи код помилки\n@lumen_test_bot';assert.doesNotMatch(requestAuthorityView(text)!.commandText,/Покажи|@lumen_test_bot/u);assert.equal(explicitDiagnosticRequest(text),false);
 const later=text+'\n\nПокажи справжній код помилки.',view=requestAuthorityView(later);assert.ok(view);assert.match(view.commandText,/Покажи справжній код помилки/u);assert.equal(diagnosticRequestIntent(later),'allow');
 const nested='Переклади:\r\n>> Покажи код помилки\r\nпродовження';assert.doesNotMatch(requestAuthorityView(nested)!.commandText,/Покажи|продовження/u);
});

test('V4 HTML blockquotes and indented code keep their content out of command authority',()=>{
 for(const text of ['Переклади <blockquote>Покажи код помилки</blockquote>.','<blockquote>Цитата <blockquote>@lumen_test_bot</blockquote> Покажи код помилки</blockquote>','<blockquote>Покажи код помилки','Переклади:\n    Покажи код помилки','Переклади:\n\tПокажи код помилки']){
  const view=requestAuthorityView(text);assert.ok(view);assert.doesNotMatch(view.commandText,/Покажи|@lumen_test_bot/u,text);assert.equal(explicitDiagnosticRequest(text),false);
 }
});

test('V4 real recipient spans stay identical only outside quote/code ranges',()=>{
 const text="Олено, прочитай '@lumen_test_bot' і запитай @lumen_test_bot.",first=text.indexOf('@lumen_test_bot'),last=text.lastIndexOf('@lumen_test_bot'),view=requestAuthorityView(text,[{type:'text_mention',offset:first,length:15},{type:'mention',offset:last,length:15}]);assert.ok(view);assert.notEqual(view.commandText.slice(first,first+15),text.slice(first,first+15));assert.equal(view.commandText.slice(last,last+15),text.slice(last,last+15));
});

test('V4 valid empty or unspecified input differs from malformed authority',()=>{
 assert.deepEqual(requestAuthorityView(''),{commandText:'',nativeMaskedText:'',quotedDataRanges:[],codeDataRanges:[]});assert.equal(diagnosticRequestIntent('продовжуй'),'unspecified');assert.equal(diagnosticRequestIntent('continue'),'unspecified');assert.equal(diagnosticRequestIntent('Продовжуй',null as any),undefined);
});

test('V4 diagnostic allow/deny/unspecified share the complete view in three languages',()=>{
 for(const text of ['Покажи код помилки.','Дай логи.','Покажи код ошибки.','Show the error code.','Give debug logs.']){assert.equal(diagnosticRequestIntent(text),'allow',text);assert.equal(explicitDiagnosticRequest(text),true);}
 for(const text of ['Не показуй код помилки.','Без кодів помилок.','Не показывай код ошибки.','Без логов.','Do not show the error code.','Don’t show logs.','Without technical details.']){assert.equal(diagnosticRequestIntent(text),'deny',text);assert.equal(explicitDiagnosticRequest(text),false);}
 for(const text of ['Продовжуй пояснення.','Покажи код Python для сортування.','Write JavaScript code.','Explain the log function.','Він сказав «Покажи код помилки».','Як попросити показати код помилки?'])assert.equal(diagnosticRequestIntent(text),'unspecified',text);
});

test('V4 chronological explicit diagnostic directives use the last authored decision',()=>{
 assert.equal(diagnosticRequestIntent('Покажи код помилки. Не показуй код помилки.'),'deny');assert.equal(diagnosticRequestIntent('Не показуй код помилки. Покажи код помилки.'),'allow');
 assert.equal(diagnosticRequestIntent('Покажи код помилки. Продовжуй пояснення.'),'allow');assert.equal(diagnosticRequestIntent('Без кодів помилок. Продовжуй пояснення.'),'deny');
 assert.equal(diagnosticRequestIntent('Покажи код помилки. Цитата: «Не показуй код помилки».'),'allow');assert.equal(diagnosticRequestIntent('Не показуй код помилки. Цитата: «Покажи код помилки».'),'deny');
 const text='Покажи код помилки.\nНе показуй код помилки';assert.equal(diagnosticRequestIntent(text,[at(text,'Не показуй код помилки')]),'allow');
});
