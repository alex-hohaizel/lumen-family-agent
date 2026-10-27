import {one,state,queueText,type Database} from './db.js';

export const RELEASE='1.5.0';
export async function queueReleaseNotice(db:Database,packUrl?:string){
  return db.tx(async sql=>{
    const s=await state(sql,true);if(!s.chat_id||await one(sql,'SELECT version FROM release_notices WHERE version=$1',[RELEASE]))return false;
    await sql.query('INSERT INTO release_notices(version) VALUES($1)',[RELEASE]);
    const text=`Повернув знайомий вигляд — вуха ті самі 🙂\n\nТепер можу сам обирати інструменти для доручення: шукати й читати сайти, працювати у браузері, читати PDF, готувати файли, рахувати та продовжувати довгі завдання після перезапуску. Можна попросити стежити за сторінкою або зберегти перевірену процедуру для повторного запуску.\n\nДля особистих сервісів потрібне підключення власника. Перед надсиланням чи бронюванням покажу конкретну дію для підтвердження; результатом називатиму лише те, що підтвердив сервіс.\n\n${packUrl?'Повернув 30 оригінальних реакцій зі знайомим малюнком: '+packUrl+'\n\n':''}Пам’ять кожної групи окрема.${s.paused?' Тут вона зараз на паузі; сам її не вмикаю.':''}`;
    await queueText(sql,text,s.memory_revision,`release:${RELEASE}`,true);return true;
  });
}
