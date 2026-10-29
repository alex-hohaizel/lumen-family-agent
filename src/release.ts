import {one,state,queueText,type Database} from './db.js';

export const RELEASE='1.8.0';
export async function queueReleaseNotice(db:Database,packUrl?:string){
  return db.tx(async sql=>{
    const s=await state(sql,true);if(!s.chat_id||await one(sql,'SELECT version FROM release_notices WHERE version=$1',[RELEASE]))return false;
    await sql.query('INSERT INTO release_notices(version) VALUES($1)',[RELEASE]);
    const text=`Люмен 1.8

У мене 50 різних анімованих стікерів: окрема сценка й емоція для кожного. Збережено мій пухнастий образ; емоцію видно вже у прев’ю.

Сам додаю стікер дуже рідко — коли він яскраво підкреслює мої власні слова. Можна й просто попросити: «Люмене, надішли стікер із поцілунком».

${packUrl?'Оновлений набір: '+packUrl:''}`.trim();

    await queueText(sql,text,s.memory_revision,`release:${RELEASE}`,true);return true;
  });
}
