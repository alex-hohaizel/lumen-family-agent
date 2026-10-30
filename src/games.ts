import {recordProvenance} from './provenance.js';
import { randomInt } from 'node:crypto';
import { one, type SQL } from './db.js';

type Player={id:string;name:string};
export const GAME_NAMES:Record<string,string>={quiz:'Вікторина',detective:'Кооперативний детектив',twenty:'20 запитань',story:'Історія по черзі',debate:'Аргументи',custom:'Ваша гра'};
const QUIZ=[
  ['Яка планета найближча до Сонця?',['меркурій','mercury']],
  ['Який океан найбільший за площею?',['тихий','pacific']],
  ['Скільки сторін має шестикутник?',['6','шість']],
  ['Яка хімічна формула води?',['h2o','н2о']],
  ['Столиця Японії?',['токіо','tokyo']],
  ['Який газ становить найбільшу частку атмосфери Землі?',['азот','nitrogen']],
  ['Автор «Лісової пісні»?',['леся українка']],
  ['Скільки хвилин у трьох годинах?',['180','сто вісімдесят']],
  ['Яка фігура має всі точки на однаковій відстані від центра в площині?',['коло']],
  ['Яка найбільша тварина на Землі?',['синій кит','блакитний кит']],
  ['Скільки нулів у мільйоні?',['6','шість']],
  ['Який музичний інструмент має клавіші, струни та молоточки?',['фортепіано','піаніно','рояль']]
] as [string,string[]][];
const CASES=[
  {title:'Зниклий пиріг',scene:'Із кухні зник вишневий пиріг. У будинку були Марко, Олена й Тарас. Марко каже, що читав; Олена — що поливала квіти; Тарас — що ремонтував велосипед. Розслідуємо без поспіху.',clues:['На столі залишився слід велосипедної мастильної оливи.','На тарілці лежить клаптик зеленого рукава.','Тарас у зеленому светрі. У Марка руки чисті, а в Олени мокрі від води.'],answer:'тарас',explanation:'Слід оливи й клаптик зеленого светра разом вказують на Тараса.'},
  {title:'Загублений ключ',scene:'Ключ від оранжереї зник. Леся складала букети, Роман місив тісто, Ірина читала на терасі. Хтось поклав ключ у чужу кишеню й забув.',clues:['На гачку для ключа є борошно.','Біля дверей — білі відбитки пальців.','Роман знайшов на своїй куртці свіжу борошняну пляму.'],answer:'роман',explanation:'Борошно біля ключа та на куртці Романа пояснює, у кого він залишився.'}
];
const THINGS=[
  {name:'кіт',aliases:['кіт','кішка','котик'],props:['живе','тварина','домашнє','пухнасте','рухається','менше людини','їсть']},
  {name:'велосипед',aliases:['велосипед','ровер','велік'],props:['рукотворне','транспорт','металеве','має колеса','рухається','більше долоні','надворі']},
  {name:'яблуко',aliases:['яблуко'],props:['їстівне','рослина','фрукт','кругле','менше людини','менше долоні','природне']},
  {name:'чайник',aliases:['чайник'],props:['рукотворне','кухня','металеве','вдома','більше долоні','менше людини','нагріває']},
  {name:'дерево',aliases:['дерево'],props:['живе','рослина','більше людини','надворі','природне','дерев’яне']},
  {name:'книга',aliases:['книга','книжка'],props:['рукотворне','вдома','паперове','менше людини','більше долоні','для читання']}
];
const PROPERTY_MATCH:[RegExp,string][]=[
  [/жив(е|ий|а)|істота/,'живе'],[/тварин/,'тварина'],[/домашн|свійськ/,'домашнє'],[/пухнаст|шерст/,'пухнасте'],
  [/їстів|можна.*їсти|це їжа/,'їстівне'],[/рослин/,'рослина'],[/фрукт/,'фрукт'],[/кругл/,'кругле'],
  [/людин.*створ|створ.*людин|рукотвор/,'рукотворне'],[/природн/,'природне'],[/транспорт/,'транспорт'],
  [/метал/,'металеве'],[/колес/,'має колеса'],[/руха|рухом/,'рухається'],[/менш.*людин/,'менше людини'],
  [/більш.*людин/,'більше людини'],[/менш.*долон/,'менше долоні'],[/більш.*долон/,'більше долоні'],
  [/надвор|на вулиці/,'надворі'],[/кухн/,'кухня'],[/вдома|у домі/,'вдома'],[/нагріва|гріє|кип.?ят/,'нагріває'],
  [/дерев.?ян/,'дерев’яне'],[/папер/,'паперове'],[/читан|читати/,'для читання'],[/воно їсть|харчу/,'їсть']
];
const DEBATES=['Краще спонтанна подорож чи ретельно спланована?','Чи потрібен у вихідні будильник?','Яка суперсила корисніша: телепортація чи розуміння всіх мов?','Краще жити біля моря чи біля лісу?'];
function normalize(text:string){return text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N} ]/gu,' ').replace(/\s+/g,' ').trim();}
function matches(text:string,answer:string){const n=normalize(text);return n===answer || (answer.length>2 && ` ${n} `.includes(` ${answer} `));}
export async function advancePendingPlayers(sql:SQL,s:any){
  if(!s.interaction_id)return;
  const root=await one(sql,'SELECT pending_participants FROM interactions WHERE id=$1 FOR UPDATE',[s.interaction_id]);
  for(const person of root?.pending_participants||[])if(!s.players.some((p:Player)=>p.id===person.id)){s.players.push(person);s.scores[person.id]=0;}
  if(root?.pending_participants?.length)await sql.query("UPDATE interactions SET participants=participants||pending_participants,pending_participants='[]' WHERE id=$1",[s.interaction_id]);
}
function scores(s:any){return s.players.map((p:Player)=>`${p.name}: ${s.scores[p.id] || 0}`).join(' · ');}
export async function startGame(sql:SQL,kind:string,players:Player[],title?:string,topicId='0',openJoin=false){
  if(!GAME_NAMES[kind])throw new Error('game_unknown');
  if(players.length<1)return 'Спочатку познайоммося хоча б з одним гравцем.';
  if(await one(sql,"SELECT id FROM games WHERE status='active' AND topic_id=$1",[topicId]))return 'Гра в цій темі вже триває. Спочатку /stopgame або дограємо її.';
  const s:any={players,scores:Object.fromEntries(players.map(x=>[x.id,0])),turn:0,segments:[],open_join:openJoin};let reply='';
  if(kind==='quiz'){
    const order=QUIZ.map((_,i)=>i);for(let i=order.length-1;i>0;i--){const j=randomInt(i+1);[order[i],order[j]]=[order[j]!,order[i]!];}
    s.order=order.slice(0,5);s.round=0;s.answers={};
    reply=`П’ять раундів. Кожен відповідає один раз; правильна відповідь — 1 бал. Пишіть «пас», щоб пропустити.\nРаунд 1: ${QUIZ[s.order[0]]![0]}`;
  }else if(kind==='detective'){
    s.caseIndex=randomInt(CASES.length);s.clues=0;s.guesses=0;
    const c=CASES[s.caseIndex]!;reply=`${c.title}\n${c.scene}\nПопросіть «підказка» або назвіть підозрюваного. У вас 5 спільних спроб.`;
  }else if(kind==='twenty'){
    s.secret=randomInt(THINGS.length);s.questions=0;
    reply='Я загадав предмет або живу істоту. У вас 20 запитань разом. Питайте про ознаки: живе, тварина, рослина, матеріал, розмір, призначення. Щоб відгадати, просто назвіть відповідь.';
  }else if(kind==='story'){
    s.limit=Math.max(12,players.length*2);s.segments=['Одного вечора у двері подзвонив листоноша. Він тримав лист, надісланий із завтрашнього дня.'];
    reply=`Пишемо по черзі, по 1–3 речення. ${s.limit} ходів, після яких завершимо історію.\n${s.segments[0]}\nПочинає ${players[0]!.name}.`;
  }else if(kind==='debate'){
    s.topic=DEBATES[randomInt(DEBATES.length)];s.limit=Math.max(2,players.length*2);
    reply=`${s.topic}\n${players.map((p,i)=>`${p.name} — ${i%2?'друга':'перша'} позиція`).join('; ')}. По два аргументи, по черзі, без переходів на особистості. Наприкінці можна попросити мене порівняти аргументи. Починає ${players[0]!.name}.`;
  }else{
    const rule=await one(sql,'SELECT * FROM rules WHERE lower(title)=lower($1)',[title || '']);
    if(!rule)return 'Спочатку надішліть правила: «Люмен, вивчи гру: назва, правила…». Збережені правила — /rules.';
    s.title=rule.title;s.rules=rule.content;s.limit=null;
    reply=`Гра «${s.title}». Правила:\n${s.rules}\nЗберігаю черговість і текст ходів. Починає ${players[0]!.name}. Коли захочеться завершити чи змінити формат — просто скажіть.`;
  }
  s.segment_count=s.segments.length;const created=await one(sql,'INSERT INTO games (kind,state,topic_id) VALUES ($1,$2,$3) RETURNING id',[kind,JSON.stringify(s),topicId]);for(const [i,body] of s.segments.entries())await sql.query('INSERT INTO game_segments(game_id,ordinal,body) VALUES($1,$2,$3)',[created!.id,i,body]);
  return reply;
}
export async function gameTurn(sql:SQL,userId:string,raw:string,topicId='0',joining?:Player,sourceId?:number){
  const row=await one(sql,"SELECT * FROM games WHERE status='active' AND topic_id=$1 FOR UPDATE",[topicId]);if(!row)return 'Зараз у цій темі немає активної гри. /games — оберемо.';
  if(row.state.interaction_id){const owner=await one(sql,'SELECT phase,expires_at FROM interactions WHERE id=$1',[row.state.interaction_id]);if(!owner||!['active','ready'].includes(owner.phase)||new Date(owner.expires_at).getTime()<=Date.now())return 'Цю партію призупинено або завершено. Можемо погодити продовження.';}
  const s=row.state;const kind=row.kind;if(s.segment_count===undefined){for(const [i,body] of (s.segments||[]).entries())await sql.query('INSERT INTO game_segments(game_id,ordinal,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[row.id,i,body]);s.segment_count=(s.segments||[]).length;s.segments=(s.segments||[]).slice(-32);}
  if(sourceId)await recordProvenance(sql,'game',row.id,[sourceId]);let player:Player|undefined=s.players.find((p:Player)=>p.id===userId);
  if(!player&&s.open_join&&joining?.id===userId){
    player=joining;s.players.push(joining);s.scores[userId]=0;
    if(kind==='story')s.limit=Math.max(s.limit,s.players.length*2);
    if(kind==='debate')s.limit=s.players.length*2;
    await sql.query('UPDATE games SET state=$1,updated_at=now() WHERE id=$2',[JSON.stringify(s),row.id]);
  }
  if(!player)return 'Тебе ще немає серед гравців цієї партії. Наступну можемо почати разом.';
  const text=raw.replace(/^\s*(люмене?|lumen)[,!: ]*/iu,'').replace(/^@\w+\s*[,!:]?\s*/,'').trim();let reply='',ended=false;
  if(kind==='quiz'){
    if(Object.hasOwn(s.answers,userId))return 'Твоя відповідь у цьому раунді вже є. Чекаємо інших учасників.';
    const q=QUIZ[s.order[s.round]]!;
    const correct=q[1].some(a=>matches(text,a));s.answers[userId]=correct;if(correct)s.scores[userId]++;
    if(Object.keys(s.answers).length<s.players.length)reply='Відповідь прийняв. Чекаю інших гравців.';
    else{
      reply=`Відповідь: ${q[1][0]}. ${scores(s)}.`;s.round++;s.answers={};await advancePendingPlayers(sql,s);
      if(s.round>=s.order.length){ended=true;reply+='\nВікторина завершена ✨';}
      else reply+=`\nРаунд ${s.round+1}: ${QUIZ[s.order[s.round]]![0]}`;
    }
  }else if(kind==='detective'){
    const c=CASES[s.caseIndex]!;
    if(/підказ|улика|доказ|зачіпк/iu.test(text)){
      reply=c.clues[s.clues] || 'Усі підказки вже відкриті. Хто це був?';s.clues=Math.min(s.clues+1,c.clues.length);
    }else if(matches(text,c.answer)){ended=true;reply=`Так, це ${c.answer[0]!.toUpperCase()+c.answer.slice(1)}. ${c.explanation} Справу закрито!`;}
    else{s.guesses++;if(s.guesses>=5){ended=true;reply=`П'ять спроб вичерпано. ${c.explanation}`;}else reply=`Ця версія не підтвердилася. Залишилося спроб: ${5-s.guesses}. Можете попросити підказку.`;}
  }else if(kind==='twenty'){
    const thing=THINGS[s.secret]!;
    if(thing.aliases.some(a=>matches(text,a))){ended=true;reply=`Вгадали: ${thing.name}! Використали ${s.questions} із 20 запитань.`;}
    else{
      const property=PROPERTY_MATCH.find(([r])=>r.test(text.toLowerCase()))?.[1];
      if(!property)return 'Не можу однозначно зіставити це з ознакою. Сформулюйте простіше: «це тварина?», «їстівне?», «з металу?», «більше людини?». Це запитання не рахую.';
      s.questions++;reply=`${thing.props.includes(property)?'Так':'Ні'}. Запитання ${s.questions}/20.`;
      if(s.questions>=20){ended=true;reply+=` Я загадав: ${thing.name}.`;}
    }
  }else{
    if(/^(покажи|показати).*(істор|ход)/iu.test(text)){const page=(await sql.query('SELECT body FROM game_segments WHERE game_id=$1 ORDER BY ordinal LIMIT 30',[row.id])).rows;return page.map(x=>x.body).join('\n\n')+(s.segment_count>30?'\n\nПродовження доступне сторінками через game.history.':'')||'Ходів ще немає.';}
    const expected:Player=s.players[s.turn % s.players.length];if(expected.id!==userId)return `Зараз хід ${expected.name}.`;
    if(!text || text.length>2000)return 'Для одного ходу потрібно від 1 до 2000 символів.';
    await sql.query('INSERT INTO game_segments(game_id,ordinal,body,user_id,source_message_id) VALUES($1,$2,$3,$4,$5)',[row.id,s.segment_count,text,userId,sourceId||null]);s.segment_count++;s.segments=[...(s.segments||[]),text].slice(-32);s.turn++;
    if(s.limit&&s.turn>=s.limit){ended=true;reply=kind==='story'?`Історію завершено:\n${s.segments.join('\n\n')}`:kind==='debate'?'У кожного було по два аргументи. Можу порівняти їх за логікою, прикладами й відповідями на заперечення.':`Завершив партію «${s.title}». Правила залишаються збереженими.`;}
    else reply=`Хід записав. Далі ${s.players[s.turn % s.players.length].name}.${kind==='debate'?` Аргумент ${s.turn+1}/${s.limit}.`:''}`;
  }
  if(kind!=='quiz')await advancePendingPlayers(sql,s);
  await sql.query('UPDATE games SET state=$1,status=$2,updated_at=now() WHERE id=$3',[JSON.stringify(s),ended?'completed':'active',row.id]);
  return reply;
}
export function publicGame(row:any,currentUserId?:string){
  if(!row)return null;
  const {secret,caseIndex,order,director_state,players=[],scores={},segments=[],...s}=row.state;
  const important=players.filter((p:Player,i:number)=>i<30||p.id===currentUserId||i===s.turn%players.length);
  // Answers, objects and solutions never enter the general model context.
  return {id:row.id,kind:row.kind,...s,players:important,players_total:players.length,scores:Object.fromEntries(important.map((p:Player)=>[p.id,scores[p.id] || 0])),segments:segments.slice(-8)};
}
