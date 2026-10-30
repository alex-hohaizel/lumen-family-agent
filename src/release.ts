import {one,state,queueText,type Database} from './db.js';

export const RELEASE='1.12.0';
export async function queueReleaseNotice(db:Database,packUrl?:string){
  return db.tx(async sql=>{
    const s=await state(sql,true);if(!s.chat_id||await one(sql,'SELECT version FROM release_notices WHERE version=$1',[RELEASE]))return false;
    await sql.query('INSERT INTO release_notices(version) VALUES($1)',[RELEASE]);
    const text="Люмен 1.12\n\nМожна разом вести покупки й запаси, збирати альбоми PDF та короткі відео зі своїх матеріалів, узгоджувати зустрічі й підключити особистий календар. Приватне навчання зберігає власні спроби та наступні вправи.\n\nМатеріали, події та результати обох видів ігор доступні через перегляд із кнопками. Можу розібрати конкретні сторінки документа чи фрагмент відео, підготувати картку або колаж і допомогти з точним редагуванням DOCX/XLSX. Зображення пропоную там, де вони доречні.\n\nПовторювані справи мають місцевий час, пропуск або перенесення одного запуску. Після перерви прострочена задача чекає перегляду. Нова публікація й особистий доступ потребують відповідного погодження. Збережені оригінали залишаються доступними.";

    await queueText(sql,text,s.memory_revision,`release:${RELEASE}`,true);return true;
  });
}
