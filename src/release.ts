import {one,state,queueText,type Database} from './db.js';

export const RELEASE='1.11.0';
export async function queueReleaseNotice(db:Database,packUrl?:string){
  return db.tx(async sql=>{
    const s=await state(sql,true);if(!s.chat_id||await one(sql,'SELECT version FROM release_notices WHERE version=$1',[RELEASE]))return false;
    await sql.query('INSERT INTO release_notices(version) VALUES($1)',[RELEASE]);
    const text="Люмен 1.11\n\nТепер я окремо тримаю контекст незавершених справ і своїх запитань. Можу підхопити розмову, коротко відреагувати, уточнити потрібне або промовчати — залежно від ситуації.\n\nПропозиції ігор та інших активностей мають конкретний наступний крок. Згода стосується саме цієї дії; від неї можна відмовитися. Відповіді й голоси учасників передаються наступним крокам активності.\n\nПереробив запуск, відновлення після перезапуску та перегляд «Докладніше». Повідомлення про успіх спираються на фактичне виконання й доставку. Якщо результат не підтверджений, я не повторюю дію навмання.\n\nСтікерний набір із 120 сцен залишається доступним.";

    await queueText(sql,text,s.memory_revision,`release:${RELEASE}`,true);return true;
  });
}
