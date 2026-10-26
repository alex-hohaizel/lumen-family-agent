import {one,state,queueText,type Database} from './db.js';

export const RELEASE='1.3.0';
export async function queueReleaseNotice(db:Database,packUrl?:string){
  return db.tx(async sql=>{
    const s=await state(sql,true);if(!s.chat_id||await one(sql,'SELECT version FROM release_notices WHERE version=$1',[RELEASE]))return false;
    await sql.query('INSERT INTO release_notices(version) VALUES($1)',[RELEASE]);
    const text=`Прокачав амулет — вуха ті самі, можливостей більше 🙂\n\nТепер роздивляюся фото, альбоми, стікери й доступні аватарки; підхоплюю зрозуміле продовження нашої розмови без повторного «Люмен!». У спільних виборах пам’ятаю, хто що обрав, і для кого робимо наступний крок. Можу зрідка запропонувати конкретну допомогу — без чергування біля кожної репліки.\n\n${packUrl?'Ще маю 30 власних рухомих реакцій: '+packUrl+'\n\n':''}Пам’ять кожної групи окрема.${s.paused?' Тут вона зараз на паузі; сам її не вмикаю.':''}`;
    await queueText(sql,text,s.memory_revision,`release:${RELEASE}`,true);return true;
  });
}
