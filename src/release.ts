import {one,state,queueText,type Database} from './db.js';

export const RELEASE='1.13.0';
export async function queueReleaseNotice(db:Database,packUrl?:string){
  return db.tx(async sql=>{
    const s=await state(sql,true);if(!s.chat_id||await one(sql,'SELECT version FROM release_notices WHERE version=$1',[RELEASE]))return false;
    await sql.query('INSERT INTO release_notices(version) VALUES($1)',[RELEASE]);
    const text=`Люмен ${RELEASE.replace(/\.0$/,'')}\n\n«Додай хліб, молоко й яйця» — збережу покупки без зайвих питань про кількість. «Ще сир» — доповню список. Можна одразу додати: «А завтра о дев’ятій нагадай про аптеку».\n\nЗ фото й відео можу зібрати маленький ролик. Хочете з музикою — надішліть трек, і додам його до монтажу. Приватні матеріали лишаються приватними, доки ви не дозволите показати їх групі.\n\nУ розмові — прямо по суті, а коли просите докладно — з потрібними поясненнями. Якщо частина справи не вийде, скажу, що вже зроблено й що потрібно далі.`;

    await queueText(sql,text,s.memory_revision,`release:${RELEASE}`,true);return true;
  });
}
