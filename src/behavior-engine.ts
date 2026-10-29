import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {one, state, type SQL} from './db.js';
import {recordProvenance} from './provenance.js';
import type {Message} from './telegram.js';
import type {Plan} from './model.js';

export const BehaviorDecisionSchema = z.object({
  move: z.enum(['listen','acknowledge','answer','clarify','offer','facilitate','repair']),
  recipient: z.enum(['bot','other','unspecified']),
  relation: z.enum(['new_request','reply','answer_to_question','accept_offer','activity_move','ambient']),
  reference_id: z.string().max(100).optional(),
  reason: z.string().min(3).max(350),
  contribution: z.object({key:z.string().min(3).max(120),summary:z.string().min(3).max(350)}).optional(),
  clarification: z.object({question:z.string().min(3).max(1000),missing_slot:z.string().min(2).max(160),why:z.string().min(3).max(350)}).optional(),
  // Expression is chosen for the current contribution, not randomly rotated.
  expression: z.enum(['plain','warm','playful','reflective','structured','brief']).optional(),
});
export type BehaviorDecision = z.infer<typeof BehaviorDecisionSchema>;

export const BEHAVIOR_INSTRUCTIONS = `ДВИГУН ПОВЕДІНКИ 1.11. Перед словами обери behavior: кому адресовано повідомлення, який задум воно продовжує і який твій внесок потрібен. reason — коротка предметна причина, не прихований хід міркувань. move listen означає reply="", actions:[], без карток і прикрас. Звернення до іншої людини не стає зверненням до тебе через твою недавню репліку. За відсутності користі обирай listen. Підстава включитися може бути соціальною: конкретний жарт, підтримка, спільна згадка, власна обґрунтована думка. Немає квоти реплік або обов'язкового циклу жарт/питання/стікер.
Зберігай теплий, кмітливий, спокійно іронічний характер. Можеш доброзичливо заперечити і пояснити власний вибір. Роль ведучого/дослідника змінює роботу, а не особистість. Коротка реакція, емодзі, стікер, структура чи повний текст мають служити саме цьому моменту. Без жартів не означає без емпатії або без доречної реакції. Не приписуй людям прихованих почуттів, мотивів і рис із мовчання.
behavior_context містить чинні питання/пропозиції й твої власні внески. Для answer_to_question/accept_offer/activity_move передай точний reference_id. За двох правдоподібних пропозицій уточни одну неоднозначність; не обирай просто останню. Якщо referent один і зрозумілий — продовж без формальностей. Відповідь іншому учаснику не закриває твоє питання. Старе або скасоване питання не змінює нову справу.
Уточнюй тільки істотне: behavior.move=clarify і clarification={question,missing_slot,why}. Питання має змінювати результат, масштаб або дозвіл. Відоме з дозволеного контексту не перепитуй. За простого прохання дай результат. Пояснюй навіщо питаєш лише коли це допомагає. Символ '?' сам по собі не створює стан очікування.
contribution.key описує сенс внеску, а summary — що саме ти додав. Перевір recent_own_contributions: перефразування своєї ж думки не стає новим внеском. На пряме прохання можна повторити або розгорнути потрібне. Твої відповіді можуть бути різної довжини й тону, зберігаючи той самий характер.
Для нового творчого детективу/пригоди використовуй start_activity з власним узгодженим задумом: rules — відкриті правила і наслідки виборів, summary — перша сцена з реальним ходом, director_state — JSON внутрішнього стану ведучого (розв'язка, причинні зв'язки, відкриті й приховані докази). На activity_turn оновлюй director_state і summary відповідно до реальних рішень людей; розв'язку з приватного стану не розкривай до дозволеного моменту. start_game — готові короткі ігри. Для нового змішаного формату доступний composition.create; він зв'язує результати collect/poll із наступними generate/tool/result.\nІніціатива: привід саме зараз → чесна користь і масштаб → простий добровільний вхід → змістовний перший крок → наслідок вибору людей → вихід/пауза → завершення. До згоди пропонуй через offer з конкретною підтримуваною дією. Згода кожного лише за себе. Не повторюй непідтриману пропозицію через мовчання. У грі пропускай церемонне повторне "Почнемо?", коли всі потрібні готові. Створений текст ще не означає проведену активність.
Стан дії, згоди й результат визначає сервер. Не називай queued доставленим, startup завершенням гри, failed успіхом. Після збою предметно працюй зі збереженим станом; про відновлення можна повідомити тільки після його реального створення. Приємна картка і жарт не підміняють фактичний результат.`;

export function explicitOtherRecipient(m:Message, botId:number) {
  return Boolean(m.reply_to_message?.from && m.reply_to_message.from.id!==botId && !m.lumen_choice && !m.lumen_interaction);
}

export async function behaviorContext(sql:SQL, actor:string, topic:string, revision:number) {
  const [goals, contributions, styles,interactions,schedules] = await Promise.all([
    sql.query("SELECT id,actor_id,goal,version,status,question,missing_slot,why,allowed,question_message_id,source_message_id FROM conversation_goals WHERE topic_id=$1 AND revision=$2 AND status IN ('waiting','offered','active') AND expires_at>now() AND (actor_id=$3 OR audience='group') ORDER BY updated_at DESC LIMIT 8",[topic,revision,actor]),
    sql.query("SELECT b.id,b.move,b.meaning_key,b.summary,b.source_message_id,b.created_at FROM behavior_contributions b WHERE b.topic_id=$1 AND b.revision=$2 AND b.expires_at>now() AND EXISTS(SELECT 1 FROM outbox o WHERE o.dedup_key LIKE b.outbox_prefix||'%' AND o.status='sent') ORDER BY b.created_at DESC LIMIT 8",[topic,revision]),
    sql.query("SELECT fields,scope,goal_id,source_message_id FROM style_episodes WHERE actor_id=$1 AND topic_id=$2 AND revision=$3 AND expires_at>now() AND (goal_id IS NULL OR EXISTS(SELECT 1 FROM conversation_goals g WHERE g.id=goal_id AND g.status IN ('waiting','offered','active'))) ORDER BY created_at DESC LIMIT 4",[actor,topic,revision]),
    sql.query("SELECT id,actor_id,kind,phase,version,spec,participants,card_message_id,source_message_id FROM interactions WHERE topic_id=$1 AND revision=$2 AND phase IN ('collecting','ready','active') AND expires_at>now() AND (spec->>'scope'='open' OR participants @> $3::jsonb) ORDER BY created_at DESC LIMIT 8",[topic,revision,JSON.stringify([{id:actor}])]),
    sql.query("SELECT id,author_id AS actor_id,instruction AS goal,confirmation_message_id AS question_message_id,source_message_id FROM scheduled_actions WHERE author_id=$1 AND topic_id=$2 AND revision=$3 AND status='awaiting_confirmation' AND expires_at>now()",[actor,topic,revision]),
  ]);
  const referenceKeys=[...goals.rows,...interactions.rows,...contributions.rows].map(r=>String(r.id));
  const sources=referenceKeys.length?(await sql.query("SELECT DISTINCT source_message_id FROM provenance_edges WHERE derived_key=ANY($1::text[]) AND derived_kind IN ('goal','interaction','contribution')",[referenceKeys])).rows.map(x=>Number(x.source_message_id)):[];
  return {engine_version:'1.11',references:[...new Map<string,Record<string,any>>([...goals.rows,...interactions.rows.map(x=>({...x,question:x.spec.question,allowed:[]})),...schedules.rows.map(x=>({...x,allowed:['schedule_decision']}))].map(x=>[String((x as any).id),x])).values()],recent_own_contributions:contributions.rows,temporary_style:styles.rows,source_ids:sources,participation_is_not_a_reply_quota:true};
}

export function behaviorAdmission(decision:BehaviorDecision|undefined, input:{direct:boolean;otherRecipient:boolean;references?:any[];optional:boolean;reply:string}) {
  if(input.otherRecipient&&!input.direct&&decision?.relation!=='ambient')return {respond:false,reason:'other_recipient'};
  if(!decision)return {respond:input.direct&&!input.optional,reason:'explicit_request_only'};
  if(input.direct)return {respond:true,reason:'direct'};
  if(decision.move==='listen'||decision.recipient==='other')return {respond:false,reason:'listen'};
  if(decision.recipient!=='bot'&&decision.relation!=='ambient')return {respond:false,reason:'recipient_unresolved'};
  if(['answer_to_question','accept_offer','activity_move'].includes(decision.relation)) {
    if(!decision.reference_id||!(input.references||[]).some(x=>String(x.id)===decision.reference_id))return {respond:false,reason:'reference_unresolved'};
  }
  if(!decision.contribution&&decision.relation==='ambient')return {respond:false,reason:'no_contribution'};
  return {respond:true,reason:decision.reason};
}

export function normalizeBehaviorPlan(plan:Plan,direct:boolean,references:Record<string,any>[]=[]):Plan {
  if(plan.behavior&&['answer_to_question','accept_offer','activity_move'].includes(plan.behavior.relation)&&(!plan.behavior.reference_id||!references.some(r=>String(r.id)===plan.behavior!.reference_id))){
    return direct?{reply:'Уточни, яку саме пропозицію або справу продовжуємо.',actions:[],behavior:{move:'clarify',recipient:'bot',relation:'new_request',reason:'Потрібна однозначна прив’язка'}}:{reply:'',actions:[],behavior:{move:'listen',recipient:'unspecified',relation:'ambient',reason:'Невідома прив’язка не дає дозволу'}};
  }
  if(direct&&plan.behavior&&(plan.behavior.move==='listen'||plan.behavior.recipient==='other'))return {reply:'Не зовсім зрозумів, що саме ти просиш. Уточни, будь ласка, що потрібно зробити.',actions:[],behavior:{move:'clarify',recipient:'bot',relation:'new_request',reason:'Потрібна відповідь на пряме звернення'}};
  return plan;
}

export function semanticContributionKey(value:string) {
  return createHash('sha256').update(value.toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim()).digest('hex');
}

export async function repeatedContribution(sql:SQL, decision:BehaviorDecision|undefined, topic:string, revision:number) {
  if(!decision?.contribution)return false;
  return Boolean(await one(sql,"SELECT id FROM behavior_contributions WHERE topic_id=$1 AND revision=$2 AND meaning_key=$3 AND expires_at>now() LIMIT 1",[topic,revision,semanticContributionKey(decision.contribution.key)]));
}

export async function rememberContribution(sql:SQL, decision:BehaviorDecision|undefined, context:{topic:string;actor:string;revision:number;sourceId:number;sources:number[];outboxPrefix:string}) {
  if(!decision?.contribution||decision.move==='listen')return;
  const id=randomUUID();
  await sql.query('INSERT INTO behavior_contributions(id,topic_id,actor_id,move,meaning_key,summary,revision,source_message_id,outbox_prefix) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,context.topic,context.actor,decision.move,semanticContributionKey(decision.contribution.key),decision.contribution.summary,context.revision,context.sourceId,context.outboxPrefix]);
  await recordProvenance(sql,'contribution',id,context.sources);
}

export async function saveClarification(sql:SQL, decision:BehaviorDecision|undefined, c:{topic:string;actor:string;revision:number;sourceId:number;sources:number[];request:string;allowed:string[];audience?:string}) {
  if(decision?.move!=='clarify'||!decision.clarification)return;
  const q=decision.clarification;
  const prior=decision.reference_id?await one(sql,"SELECT * FROM conversation_goals WHERE id::text=$1 AND actor_id=$2 AND topic_id=$3 AND revision=$4 AND status IN ('waiting','active') FOR UPDATE",[decision.reference_id,c.actor,c.topic,c.revision]):undefined;
  const id=prior?.id||randomUUID();
  await sql.query(`INSERT INTO conversation_goals(id,actor_id,topic_id,goal,question,missing_slot,why,allowed,audience,revision,source_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET question=excluded.question,missing_slot=excluded.missing_slot,why=excluded.why,allowed=excluded.allowed,status='waiting',updated_at=now()`,[id,c.actor,c.topic,prior?.goal||c.request,q.question,q.missing_slot,q.why,JSON.stringify(c.allowed),c.audience||'personal',c.revision,c.sourceId]);
  await recordProvenance(sql,'goal',id,c.sources);
  return id;
}

export async function completeFocusedGoal(sql:SQL, reference:string|undefined, actor:string, topic:string, revision:number) {
  if(!reference)return;
  await sql.query("UPDATE conversation_goals SET status='completed',updated_at=now() WHERE id::text=$1 AND actor_id=$2 AND topic_id=$3 AND revision=$4 AND status IN ('waiting','active')",[reference,actor,topic,revision]);
}

export function currentStyleCue(text:string) {
  const unquoted=text.replace(/^>.*$/gm,'').replace(/«[^»]*»|"[^"\n]*"|`[^`]*`/g,'');
  if(/без (?:жартів|жарт|шуток)[?？]\s*(?:ні|нет|навпаки)|не (?:треба|потрібно).{0,12}без жарт/iu.test(unquoted))return;
  const fields:Record<string,string>={};
  if(/без (?:жартів|жарт|шуток)|не жартуй|не шути|no jokes/iu.test(unquoted))fields.humor='off';
  if(/без (?:емодзі|смайл|эмодзи)|no emoji/iu.test(unquoted))fields.emoji='off';
  if(/(?:цього разу|зараз|тут|сьогодні).{0,35}(?:коротко|стисло)|(?:коротко|стисло).{0,35}(?:цього разу|зараз|сьогодні)/iu.test(unquoted))fields.length='short';
  if(/(?:цього разу|зараз).{0,35}(?:детально|повністю|докладно)/iu.test(unquoted))fields.length='detailed';
  return Object.keys(fields).length?{fields,scope:/сьогодні|сегодня|today/iu.test(unquoted)?'today':'request'}:undefined;
}

function localDayEnd(now:Date, timezone:string) {
  const parts=(d:Date)=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(d).map(p=>[p.type,p.value]));
  const p=parts(now), target=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day)+1);let estimate=target;
  for(let n=0;n<3;n++){const q=parts(new Date(estimate));const local=Date.UTC(Number(q.year),Number(q.month)-1,Number(q.day),Number(q.hour),Number(q.minute),Number(q.second));estimate+=target-local;}
  return new Date(estimate);
}

export async function saveStyleCue(sql:SQL, text:string, c:{actor:string;topic:string;sourceId:number;revision:number;timezone:string;goalId?:string}) {
  const cue=currentStyleCue(text);if(!cue)return;
  if(cue.scope==='request'&&!c.goalId)return;
  const id=randomUUID(),expires=cue.scope==='today'?localDayEnd(new Date(),c.timezone):new Date(Date.now()+30*60000);
  // Unspecified scope is the current request, never a permanent personality profile.
  await sql.query('INSERT INTO style_episodes(id,actor_id,topic_id,fields,scope,goal_id,revision,source_message_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,c.actor,c.topic,JSON.stringify(cue.fields),cue.scope,cue.scope==='today'?null:c.goalId||null,c.revision,c.sourceId,expires]);
  await recordProvenance(sql,'style',id,[c.sourceId]);
}

export async function retireBehavior(sql:SQL) {
  await sql.query("DELETE FROM behavior_contributions WHERE expires_at<=now()");
  await sql.query("DELETE FROM style_episodes WHERE expires_at<=now() OR (goal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversation_goals WHERE id=goal_id AND status IN ('waiting','offered','active')))");
  const s=await state(sql);
  await sql.query("UPDATE conversation_goals SET status='expired',question='',missing_slot='',why='',allowed='[]',updated_at=now() WHERE status IN ('waiting','offered','active') AND (expires_at<=now() OR revision<>$1)",[s.memory_revision]);
}
