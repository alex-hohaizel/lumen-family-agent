import {one,state,queueText,type Database} from './db.js';

export const RELEASE='1.4.0';
export async function queueReleaseNotice(db:Database,packUrl?:string){
  return db.tx(async sql=>{
    const s=await state(sql,true);if(!s.chat_id||await one(sql,'SELECT version FROM release_notices WHERE version=$1',[RELEASE]))return false;
    await sql.query('INSERT INTO release_notices(version) VALUES($1)',[RELEASE]);
    const text=`Оновив амулет — вуха ті самі, а внутрішній «мене не кликали» відправив у відпустку 🙂\n\nТепер можу сам підхопити нашу стару тему, відгукнутися на доречний момент бесіди чи смішні фото, додати думку або влучний жарт. Кожну репліку озвучувати не збираюся: іноді найрозумніша моя відповідь — дати вам договорити.\n\n${packUrl?'Ще перевдягнув 30 рухомих реакцій у нові мінісцени: '+packUrl+'\n\n':''}Пам’ять кожної групи окрема.${s.paused?' Тут вона зараз на паузі; сам її не вмикаю.':''}`;
    await queueText(sql,text,s.memory_revision,`release:${RELEASE}`,true);return true;
  });
}
