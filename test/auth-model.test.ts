import { describe,it } from 'node:test';
import assert from 'node:assert/strict';
import { callbackClient,validateGrant } from '../src/auth.js';
import { consumeResponse,OpenAIModel } from '../src/model.js';
import { ConfigSchema } from '../src/config.js';

function stream(events:any[],split=false){const content=events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('');const bytes=new TextEncoder().encode(content);return new Response(new ReadableStream({start(c){if(split){for(const byte of bytes)c.enqueue(new Uint8Array([byte]));}else c.enqueue(bytes);c.close();}}));}
describe('OAuth та завершені Responses API потоки',()=>{
  it('не приймає неправильний state',()=>{assert.throws(()=>callbackClient(new URLSearchParams('state=wrong&client_id=oaiapp_1&code=code'),{state:'right'}),/state_mismatch/);});
  it('використовує виданий client_id, не dynamic entrypoint',()=>{assert.equal(callbackClient(new URLSearchParams('state=s&client_id=oaiapp_1&code=code'),{state:'s'}),'oaiapp_1');assert.throws(()=>callbackClient(new URLSearchParams('state=s&client_id=dynamic_agent_client&code=c'),{state:'s'}),/missing_client/);});
  it('не підміняє client_id під час повторної авторизації',()=>{assert.throws(()=>callbackClient(new URLSearchParams('state=s&client_id=other&code=c'),{state:'s',clientId:'original'}),/client_mismatch/);});
  it('обробляє відмову до обміну коду',()=>{assert.throws(()=>callbackClient(new URLSearchParams('state=s&error=access_denied'),{state:'s'}),/declined/);});
  it('самого identity-token недостатньо для дозволу використовувати підписку',()=>{assert.throws(()=>validateGrant({id_token:'id',access_token:'a',refresh_token:'r',scope:'openid profile',expires_in:3600}),/permission_missing/);});
  it('потребує renewable session і правильного grant',()=>{assert.throws(()=>validateGrant({id_token:'id',access_token:'a',scope:'resource.invoke chatgpt.tokens.use.direct',expires_in:3600}),/incomplete/);assert.ok(validateGrant({id_token:'id',access_token:'a',refresh_token:'r',scope:'resource.invoke chatgpt.tokens.use.direct offline_access',expires_in:3600}).includes('offline_access'));});
  it('збирає Unicode текст навіть із розбитими UTF-8 байтами',async()=>{assert.equal(await consumeResponse(stream([{type:'response.output_text.delta',delta:'Привіт ✨'},{type:'response.completed',response:{output:[]}}],true)),'Привіт ✨');});
  it('частковий текст без response.completed не вважає відповіддю',async()=>{await assert.rejects(()=>consumeResponse(stream([{type:'response.output_text.delta',delta:'Зберіг'}])),/interrupted/);});
  it('розбирає CRLF, навіть коли межа рядків розрізана мережею',async()=>{
    const data='data: {"type":"response.output_text.delta","delta":"OK"}\r\n\r\ndata: {"type":"response.completed"}\r\n\r\n';
    const res=new Response(new ReadableStream({start(c){for(const byte of new TextEncoder().encode(data))c.enqueue(new Uint8Array([byte]));c.close();}}));assert.equal(await consumeResponse(res),'OK');
  });
  it('ліміт після початку потоку не підтверджує успіх',async()=>{await assert.rejects(()=>consumeResponse(stream([{type:'response.output_text.delta',delta:'початок'},{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}])),/usage_limit/);});
  it('response.incomplete не дає виконати запропоновані дії',async()=>{await assert.rejects(()=>consumeResponse(stream([{type:'response.incomplete'}])),/stream_failed/);});
  it('не виносить сире повідомлення провайдера із секретами в помилку',async()=>{await assert.rejects(()=>consumeResponse(new Response('sk-secret-user-data',{status:401})),e=>e instanceof Error&&e.message==='model_auth_required');});
  it('запит використовує store:false, stream:true і тільки офіційний endpoint',async()=>{
    let request:any;let endpoint='';const config=ConfigSchema.parse({authMode:'api',apiKey:'test-key',model:'available-model'});
    const fetcher=async(url:any,init:any)=>{endpoint=String(url);request=JSON.parse(init.body);return stream([{type:'response.output_text.delta',delta:'OK'},{type:'response.completed',response:{output:[]}}]);};
    const model=new OpenAIModel(config,undefined,fetcher as typeof fetch);assert.equal(await model.text([{role:'user',content:'ping'}],'test'),'OK');assert.equal(endpoint,'https://api.openai.com/v1/responses');assert.equal(request.store,false);assert.equal(request.stream,true);assert.ok(!('previous_response_id' in request));assert.ok(!('max_output_tokens' in request));assert.ok(!('temperature' in request));
  });
  it('не приймає довільну команду як дію моделі',async()=>{
    const model=new OpenAIModel(ConfigSchema.parse({authMode:'api',apiKey:'test',model:'m'}),undefined,(async()=>stream([{type:'response.output_text.delta',delta:'{"reply":"","actions":[{"kind":"shell","command":"ls"}]}'},{type:'response.completed',response:{output:[]}}])) as typeof fetch);
    await assert.rejects(()=>model.plan({context:'',current:'ping'}),/invalid_plan/);
  });
  it('JSON у markdown-блоці з дужками всередині рядка коректно читається',async()=>{
    const model=new OpenAIModel(ConfigSchema.parse({authMode:'api',apiKey:'test',model:'m'}),undefined,(async()=>stream([{type:'response.output_text.delta',delta:'```json\n{"reply":"Ось дужка }","actions":[]}\n```'},{type:'response.completed',response:{output:[]}}])) as typeof fetch);
    assert.equal((await model.plan({context:'',current:'ping'})).reply,'Ось дужка }');
  });
  it('після звичайного тексту замість JSON один раз повторює те саме звернення без підміни моделі',async()=>{
    const requests:any[]=[];const expected={reply:'Ділимося на дві команди.',actions:[{kind:'activity_turn',summary:'Хід команди Хвиля; останнє слово — море.',rules:'Дві команди ходять по черзі, без повторення слів.'}]};
    const model=new OpenAIModel(ConfigSchema.parse({authMode:'api',apiKey:'test',model:'gpt-6.1-sol'}),undefined,(async(_url:any,init:any)=>{requests.push(JSON.parse(init.body));return stream([{type:'response.output_text.delta',delta:requests.length===1?'Граємо двома командами.':JSON.stringify(expected)},{type:'response.completed',response:{output:[]}}]);}) as typeof fetch);
    assert.deepEqual(await model.plan({context:'лише група А',current:'Люмен, зміни правила для двох команд'}),expected);
    assert.equal(requests.length,2);assert.deepEqual(requests[0].input,requests[1].input);assert.ok(requests.every(x=>x.model==='gpt-6.1-sol'));assert.match(requests[1].instructions,/Попередня відповідь/);assert.ok(!requests[1].instructions.includes('Граємо двома командами.'));
  });
  it('відхиляє неправильні дії та приймає лише перевірений повторний план',async()=>{
    let calls=0;const model=new OpenAIModel(ConfigSchema.parse({authMode:'api',apiKey:'test',model:'m'}),undefined,(async()=>stream([{type:'response.output_text.delta',delta:JSON.stringify(++calls===1?{reply:'',actions:[{kind:'shell',command:'ls'}]}:{reply:'Можу допомогти словами.',actions:[]})},{type:'response.completed',response:{output:[]}}])) as typeof fetch);
    assert.deepEqual(await model.plan({context:'',current:'поговорімо'}),{reply:'Можу допомогти словами.',actions:[]});assert.equal(calls,2);
  });
  it('дві неправильні відповіді завершуються помилкою без нескінченних повторів',async()=>{
    let calls=0;const model=new OpenAIModel(ConfigSchema.parse({authMode:'api',apiKey:'test',model:'m'}),undefined,(async()=>{calls++;return stream([{type:'response.output_text.delta',delta:'не JSON'},{type:'response.completed',response:{output:[]}}]);}) as typeof fetch);
    await assert.rejects(()=>model.plan({context:'',current:'ping'}),/invalid_plan/);assert.equal(calls,2);
  });
  it('ліміт підписки не спричиняє повторного запиту чи іншої моделі',async()=>{
    let calls=0;const model=new OpenAIModel(ConfigSchema.parse({authMode:'api',apiKey:'test',model:'gpt-6.1-sol'}),undefined,(async()=>{calls++;return new Response('',{status:429});}) as typeof fetch);
    await assert.rejects(()=>model.plan({context:'',current:'ping'}),/usage_limit/);assert.equal(calls,1);
  });
});
