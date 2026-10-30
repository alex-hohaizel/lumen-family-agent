import type {Brain} from './model.js';

/** Public synthetic dialogues only. Plans are inspected, never executed. */
export async function probeCompanionConversation(brain:Brain,reserve:()=>Promise<void>=async()=>{}){
 const common={now:new Date().toISOString(),timezone:'Europe/Kyiv',current_author:{id:'501',name:'Оля'},current_topic:{id:'0'},participants:[{id:'501',name:'Оля'}],personalization:{chat:{language:'uk'},people:[{id:'501',name:'Оля',preferences:{}}]},behavior_context:{references:[],recent_own_contributions:[]}};
 const cases=[
  {id:'simple_answer',current:'Люмен, скільки буде 2+2?',context:{}},
  {id:'tired_conversation',current:'Люмен, я сьогодні зовсім вимоталась. Не хочу вже ніяких списків справ.',context:{recent:[{author:'Оля',body:'Весь день бігала у справах, щойно прийшла додому.'}]}},
  {id:'missing_music',current:'Давай з музикою.',context:{recent:[{author:'Оля',body:'Люмен, збери ці два фото в коротке відео.'}],available_attachments:[{id:'fixture-photo-1',kind:'photo'},{id:'fixture-photo-2',kind:'photo'}],tool_results:[{tool:'studio.manage',args:{operation:'export',require_audio:true},result:{ok:false,error:'soundtrack_required'}}]}},
 ];
 const results=[];
 for(const item of cases){
  await reserve();
  const plan=await brain.plan({current:item.current,context:JSON.stringify({...common,...item.context}),instructions:'Фіксована синтетична діагностика розмови. Усі імена, репліки й матеріали вигадані, приватні дані відсутні. Поверни звичайний план behavior/reply/actions; жодні запропоновані дії тут не виконуються.',search:false});
  const text=[plan.reply,plan.behavior?.clarification].filter(Boolean).join(' ').trim();
  const technical=/(?:\b(?:MP4|PDF|DOCX|XLSX|pipeline|render_failed|soundtrack_required)\b|успішного результату для|виконати потрібний крок|успешного результата для|выполнить нужный шаг)/iu.test(text);
  const direct=plan.actions.length===0;
  const ok=Boolean(text)&&!technical&&direct&&(item.id!=='simple_answer'||/4/u.test(text))&&(item.id!=='missing_music'||/музик|трек|аудіо|мелод|пісн|надіш|надісл/iu.test(text));
  results.push({case:item.id,ok,reply:plan.reply,clarification:plan.behavior?.clarification,move:plan.behavior?.move,actions:plan.actions.map(a=>a.kind)});
 }
 return {synthetic:true,private_data_used:false,actions_executed:false,cases:results,ok:results.every(x=>x.ok),scope:'Three planned dialogues; no human conversation-quality or end-to-end tool execution claim.'};
}
