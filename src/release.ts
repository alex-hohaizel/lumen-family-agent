import {one,state,queueText,type Database} from './db.js';

export const RELEASE='1.13.1';
export async function queueReleaseNotice(db:Database,packUrl?:string){
  return db.tx(async sql=>{
    const s=await state(sql,true);if(!s.chat_id||await one(sql,'SELECT version FROM release_notices WHERE version=$1',[RELEASE]))return false;
    await sql.query('INSERT INTO release_notices(version) VALUES($1)',[RELEASE]);
    const text=`Люмен ${RELEASE}\n\nОновив наліпки 🐭 Сон — із помітнішим диханням, рухи лапок і тканини — природніші. Підчистив різкі переходи й зайві підстрибування. У наборі залишилися всі 120 настроїв.${packUrl?'\n\nНаліпки: '+packUrl:''}`;

    await queueText(sql,text,s.memory_revision,`release:${RELEASE}`,true);return true;
  });
}
