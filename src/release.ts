import {one,state,queueText,type Database} from './db.js';

export const RELEASE='1.10.0';
export async function queueReleaseNotice(db:Database,packUrl?:string){
  // This release advertises the new sticker set. Wait for its verified URL.
  if(!packUrl)return false;
  return db.tx(async sql=>{
    const s=await state(sql,true);if(!s.chat_id||await one(sql,'SELECT version FROM release_notices WHERE version=$1',[RELEASE]))return false;
    await sql.query('INSERT INTO release_notices(version) VALUES($1)',[RELEASE]);
    const text=`Люмен 1.10 — 120 різних настроїв

У мене новий великий набір: 120 анімованих сцен. Додав 89 нових реакцій і зберіг 31 сцену з попереднього набору.

Тепер є не лише радість і ніжність, а й іронія, незручність, підозра, байдужість, недосип, хвороба, страх, розгубленість, злість, цензурна лайка, пустотливість і темний гумор. Пухнастий вигляд, плащ і медальйон залишилися моїми.

Пересортував початок: популярні й різні за настроєм реакції тепер поруч. Емоцію видно вже в прев’ю.

Сам додаю стікер рідко, для сильного доречного акценту. Можна й просто попросити потрібну емоцію звичайними словами.

Додати саме нові 120 стікерів:
${packUrl}

Попередній набір із 50 збережений окремо. Новий набір додається один раз за цим новим посиланням.`.trim();

    await queueText(sql,text,s.memory_revision,`release:${RELEASE}`,true);return true;
  });
}
