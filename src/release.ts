import {one,state,queueText,type Database} from './db.js';

export const RELEASE='1.7.0';
export async function queueReleaseNotice(db:Database,packUrl?:string){
  return db.tx(async sql=>{
    const s=await state(sql,true);if(!s.chat_id||await one(sql,'SELECT version FROM release_notices WHERE version=$1',[RELEASE]))return false;
    await sql.query('INSERT INTO release_notices(version) VALUES($1)',[RELEASE]);
    const text=`Люмен 1.7

Спільну активність починаю після згоди потрібних учасників. Кнопки й текст враховуються разом; показую, хто що обрав і кого чекаємо.

Можемо діяти паралельно: різні ролі, власне завдання кожному й до двох дій за хід, коли це доречно. Окремий хід чекає лише свого автора, спільний — погодженого складу.

Сцени й відповіді стали компактнішими: заголовки, ключові факти, зрозумілі варіанти. Довгі пояснення доступні через «Докладніше» без втрати тексту.

${packUrl?'Стікери: '+packUrl+'\n\n':''}Можна змінити вибір, відмовитися, призупинити або вийти. Особисті відповіді й таємні ролі залишаються приватними.`;

    await queueText(sql,text,s.memory_revision,`release:${RELEASE}`,true);return true;
  });
}
