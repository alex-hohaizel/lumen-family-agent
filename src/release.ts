import {one,state,queueText,type Database} from './db.js';

export const RELEASE='1.13.4';
export async function queueReleaseNotice(db:Database,packUrl?:string){
  return db.tx(async sql=>{
    const s=await state(sql,true);if(!s.chat_id||await one(sql,'SELECT version FROM release_notices WHERE version=$1',[RELEASE]))return false;
    await sql.query('INSERT INTO release_notices(version) VALUES($1)',[RELEASE]);
    const text=`Люмен ${RELEASE}\n\nТепер можеш попросити припинити нагадування своїми словами. Для спільної роботи іншого автора поясню, чиє підтвердження потрібне, і покажу кнопки зупинки. Пам’ять, ігри та всі 120 наліпок збережені.${packUrl?'\n\nНаліпки: '+packUrl:''}`;

    await queueText(sql,text,s.memory_revision,`release:${RELEASE}`,true);return true;
  });
}
