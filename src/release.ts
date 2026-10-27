import {one,state,queueText,type Database} from './db.js';

export const RELEASE='1.6.0';
export async function queueReleaseNotice(db:Database,packUrl?:string){
  return db.tx(async sql=>{
    const s=await state(sql,true);if(!s.chat_id||await one(sql,'SELECT version FROM release_notices WHERE version=$1',[RELEASE]))return false;
    await sql.query('INSERT INTO release_notices(version) VALUES($1)',[RELEASE]);
    const text=`Люмен 1.6

Можу вести довге доручення й відповідати іншим паралельно. Показую зроблене, поточний етап і залишок; «що робиш?» та «стоп» працюють під час задачі.

Додалися спільні проєкти, приватне голосування, десять шаблонів активностей із фазами й таємними відповідями, дослідження з джерелами, DOCX/XLSX/PDF, версії навичок і перевірка результату перед завершенням.

Особисті запитання та підключення — в лічці; спосіб розкриття відповіді обирає адресат. Доступ до акаунтів потребує авторизації власника. Голосова генерація й нові зображення працюють лише з окремо налаштованим провайдером.

${packUrl?'Знайомі стікери: '+packUrl+'\n\n':''}Пам’ять груп і особистих чатів розділена.${s.paused?' Тут пам’ять зараз на паузі.':''}`;
    await queueText(sql,text,s.memory_revision,`release:${RELEASE}`,true);return true;
  });
}
