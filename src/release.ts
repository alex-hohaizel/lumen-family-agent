import {one,state,queueText,type Database} from './db.js';

export const RELEASE='1.13.3';
export async function queueReleaseNotice(db:Database,packUrl?:string){
  return db.tx(async sql=>{
    const s=await state(sql,true);if(!s.chat_id||await one(sql,'SELECT version FROM release_notices WHERE version=$1',[RELEASE]))return false;
    await sql.query('INSERT INTO release_notices(version) VALUES($1)',[RELEASE]);
    const text=`Люмен ${RELEASE}\n\nСпростив спільні нагадування та їх скасування, узгодив роботу в темах і налаштував доречніші включення в розмову 🐭 Пам’ять, ігри й усі 120 наліпок збережені.${packUrl?'\n\nНаліпки: '+packUrl:''}`;

    await queueText(sql,text,s.memory_revision,`release:${RELEASE}`,true);return true;
  });
}
