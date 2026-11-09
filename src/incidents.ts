import {createHash,randomBytes} from 'node:crypto';
import {ModelError} from './auth.js';
import {ToolError} from './safe-http.js';
import {TelegramError} from './telegram.js';
import {RELEASE} from './release.js';
import type {SQL,Database} from './db.js';

export type IncidentEffectState='not_started'|'unchanged'|'confirmed'|'partial'|'uncertain';
export interface IncidentContext {
 operation:string;stage:string;attemptKey:string;
 chatId?:string;requestId?:string;operationKey?:string;
 actorId?:string;topicId?:string;audience?:'group'|'private';sourceId?:number|string;revision?:number;
 actionId?:string;taskId?:string;toolRunId?:number|string;outboxId?:number|string;
 effectState?:IncidentEffectState;detail?:string;facts?:Record<string,unknown>;
}
export interface IncidentReceipt {code:string;reason:string;message:string;persisted:boolean;}
export const INCIDENT_RETENTION_DAYS=30;
export const INCIDENT_ROW_LIMIT=2000;
const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const tag=/^[a-z][a-z0-9_\.]{0,79}$/;
const codePattern=/^LM-[0-9A-HJKMNP-TV-Z]{26}$/;
const safeTag=(value:unknown,fallback:string)=>typeof value==='string'&&tag.test(value)?value:fallback;
const positive=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
const identity=(value:unknown)=>typeof value==='string'&&/^-?\d{1,20}$/.test(value)?value:null;
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)?value:null;

/** Exception messages, provider bodies and SQL errors are never a public cause. */
export function safeErrorCode(error:unknown):string {
 if(typeof error==='string')return safeTag(error,'operation_failed');
 const e=error as {code?:unknown;name?:unknown}|null;
 if(e?.code==='23505')return 'duplicate_operation';
 if(e?.code==='23503')return 'record_reference_missing';
 if(e?.code==='40001'||e?.code==='40P01')return 'database_conflict';
 if(e?.code==='53300')return 'database_connection_limit';
 if(e?.code==='57P01')return 'database_restart';
 const native:Record<string,string>={ECONNREFUSED:'network_connection_refused',ECONNRESET:'network_connection_reset',ENOTFOUND:'network_name_unresolved',ETIMEDOUT:'network_timeout',ENOSPC:'storage_full',ENOMEM:'worker_memory_busy'};
 if(typeof e?.code==='string'&&Object.hasOwn(native,e.code))return native[e.code]!;
 if(error instanceof ModelError||error instanceof ToolError||error instanceof TelegramError)return safeTag(error.code,'operation_failed');
 if(e?.name==='AbortError'||e?.name==='TimeoutError')return e.name==='TimeoutError'?'operation_timeout':'operation_cancelled';
 if(e?.name==='ZodError'||error instanceof SyntaxError)return 'response_contract_invalid';
 return 'operation_failed';
}

const reasonText:Record<string,string>={
 foreground_deadline:'Час поточного ходу вичерпано після виконання кроку; повний результат ще не підтверджено.',
 foreground_step_limit:'Планувальник знову запросив інструмент після вичерпання кількості кроків цього ходу; наступну дію не запускали.',
 reminder_request_unbound:'Не пройшла перевірка зв’язку між отриманим повідомленням і збереженим запитом на скасування.',
 reminder_transcription_unbound:'Збережений доказ голосового запиту не відповідає отриманому голосовому повідомленню.',
 reminder_target_unbound:'Обраний запис нагадування не підтверджується змістом прохання.',
 reminder_request_changed:'Зміст запиту змінився після перевірки.',
 reminder_target_changed:'Запис нагадування змінився після його вибору.',
 reminder_not_found:'Пошук у поточному чаті й темі не знайшов чинного нагадування, доступного для цього запиту.',
 reminder_clarification_expired:'Строк уточнення вибору нагадування минув; попередній вибір більше не чинний.',
 series_target_changed:'Версія повторюваної серії змінилася після її вибору.',
 reminder_candidates_overflow:'Кількість можливих нагадувань перевищила безпечну межу пошуку; повноту вибору не підтверджено.',
 reminder_audience_ambiguous:'У проханні одночасно вказано несумісні приватний і спільний способи доставки.',
 reminder_vote_explicit_required:'У відповіді немає явного погодження саме дії з поточної картки.',
 reminder_vote_unbound:'Відповідь не пов’язана з поточною карткою погодження.',
 reminder_vote_changed:'Відповідь на картку змінилася після перевірки.',
 reminder_time_invalid:'Заданий час минув або не є коректною датою. На яку дату й годину запланувати дію?',
 schedule_time_invalid:'Заданий час минув або не є коректною датою. На яку дату й годину запланувати дію?',
 schedule_timezone_mismatch:'Місцевий час не відповідає вказаному часовому поясу.',
 schedule_timezone_invalid:'Не вдалося розпізнати вказаний часовий пояс.',
 schedule_confirmation_expired:'Строк погодження цієї запланованої дії закінчився.',
 series_dst_choice_required:'Заданий місцевий час неоднозначний через переведення годинника.',
 series_no_future_occurrences:'За поточним правилом серії немає майбутніх запусків.',
 model_cancellation_proof_invalid:'Планувальник двічі не надав коректного доказу, що скасування відповідає власному проханню автора.',
 model_network:'З’єднання з сервісом моделі не вдалося встановити.',
 model_stream_interrupted:'Потік відповіді моделі перервався до завершення.',
 model_http_503:'Сервіс моделі повернув тимчасову недоступність (HTTP 503).',
 oauth_refresh_unavailable:'Сервіс авторизації не підтвердив поновлення сесії моделі.',
 oauth_refresh_network:'Мережевий запит на поновлення сесії авторизації перервався.',
 chatgpt_reauth_required:'Сервіс авторизації відхилив поновлення сесії ChatGPT; потрібен повторний вхід.',
 chatgpt_plan_permission_missing:'Надана сесія ChatGPT не має потрібного дозволу для виклику моделі.',
 api_key_missing:'Для вибраного API-режиму не налаштовано ключ доступу.',
 model_not_selected:'Для цього підключення не вибрано модель.',
 response_contract_invalid:'Отримана відповідь не відповідає потрібному формату даних.',
 invalid_tool_arguments:'Параметри вибраного інструмента не відповідають його контракту.',
 unknown_tool:'Планувальник обрав інструмент, якого немає в поточному каталозі.',
 tool_not_requested:'Поточне прохання не дозволяє виконати обраний інструмент.',
 tool_not_configured:'Для потрібного інструмента немає готового підключення.',
 tool_not_allowed_in_background:'Цю дію заборонено виконувати у фоновому завданні.',
 telegram_thread_not_found:'Telegram повідомив, що вказану тему не знайдено.',
 telegram_topic_closed:'Telegram повідомив, що тема закрита для повідомлень.',
 telegram_permission_denied:'Telegram відмовив через права доступу бота в цьому чаті.',
 telegram_topic_invalid:'Ідентифікатор теми не відповідає транспортному контракту Telegram.',
 telegram_network:'Запит до Telegram перервався на рівні з’єднання.',
 telegram_bad_response:'Telegram не повернув придатної для перевірки відповіді.',
 telegram_400:'Telegram відхилив запит як некоректний (HTTP 400); точнішу причину адаптер не визначив.',
 telegram_403:'Telegram заборонив запит (HTTP 403).',
 telegram_429:'Telegram обмежив частоту запитів (HTTP 429).',
 telegram_500:'Telegram повернув внутрішню помилку сервісу (HTTP 500).',
 telegram_partial_album:'Telegram підтвердив лише частину повідомлень альбому.',
 localization_unavailable:'Не вдалося підготувати переклад відповіді обраною мовою.',
 conversation_admin_required:'Для зміни налаштувань усієї групи потрібні права адміністратора.',
 owner_only:'Ця зміна доступна лише власнику підключення.',
 member_required:'Чат недоступний для цієї дії: немає чинного підтвердження участі в ньому.',
 other_chat:'Запит належить іншому чату і не може змінити цей запис.',
 task_cancelled:'Доручення вже скасоване або його контекст утратив чинність.',
 outbound_cancelled:'Доставка втратила чинність після скасування чи зміни контексту.',
 action_unavailable:'Дія вже не має чинного стану, який дозволяє продовження.',
 operation_cancelled:'Поточне виконання було перервано сигналом скасування.',
 operation_timeout:'Виконання перевищило допустимий час.',
 duplicate_operation:'База даних відхилила повтор операції з уже зайнятим унікальним ідентифікатором.',
 record_reference_missing:'Пов’язаний запис уже відсутній у базі даних.',
 database_conflict:'Транзакція зіткнулася з одночасною зміною даних.',
 database_connection_limit:'База даних не прийняла з’єднання через ліміт підключень.',
 database_restart:'З’єднання з базою даних перервано її перезапуском.',
 network_connection_refused:'Віддалений сервіс відхилив мережеве з’єднання.',
 network_connection_reset:'Віддалений сервіс розірвав мережеве з’єднання.',
 network_name_unresolved:'Мережа не змогла визначити адресу сервісу.',
 network_timeout:'Віддалений сервіс не відповів у відведений час.',
 storage_full:'На робочому диску закінчилося вільне місце.',
 worker_memory_busy:'Для обробки зараз недостатньо вільної пам’яті.',
 worker_queue_busy:'Черга обробки заповнена до встановленої межі.',
 worker_queue_timeout:'Завдання не отримало місце в черзі за відведений час.',
 browser_busy:'Усі дозволені сеанси браузера зараз зайняті.',
 voice_not_configured:'Розпізнавання голосу для цього бота не підключено. Напиши, будь ласка, текстом.',
 image_not_configured:'Створення нових зображень для цього бота не підключено, тому зараз не можу створити нове зображення. Можу допомогти з описом або роздивитися надіслане зображення.',
 image_daily_limit:'Для цього чату вичерпано денний ліміт генерації зображень.',
 document_type_not_supported:'Тип надісланого документа не підтримується поточним читачем.',
 document_parse_failed:'Читач документа не зміг розібрати його вміст.',
 http_timeout:'Сайт не відповів у відведений час.',
 dns_unavailable:'Не вдалося визначити мережеву адресу сайту.',
 http_unavailable:'З’єднання із сайтом не вдалося встановити.',
 http_interrupted:'З’єднання із сайтом перервалося до отримання всіх даних.',
 response_too_large:'Відповідь сайту перевищила допустимий розмір.',
 public_url_required:'Адреса не відповідає правилам доступу до відкритих зовнішніх сайтів.',
 public_address_required:'Мережева адреса сайту не дозволена правилами зовнішнього доступу.',
 monitor_json_invalid:'Сайт повернув дані, які не вдалося прочитати як JSON.',
 monitor_json_field_missing:'У відповіді сайту немає погодженого поля JSON.',
 calendar_read_failed:'Календарний сервіс не підтвердив читання даних.',
 calendar_timezone_unknown:'У календарній події не вдалося визначити часовий пояс.',
 original_audio_required:'Для збереження оригінального звуку потрібен відеофрагмент зі звуком. Надішли його або вибери зі збережених матеріалів; порядок сцен збережено.',
 original_audio_silent:'У вибраних відеофрагментах немає чутного оригінального звуку. Можемо вибрати інший відрізок або додати надану музику; монтаж збережено.',
 original_audio_has_no_usable_audio:'Не вдалося прочитати оригінальний звук цього відео. Надішли інше відео або заміни фрагмент; решту монтажу збережено.',
 original_audio_shorter_than_scene:'Оригінальний звук закінчується раніше за вибраний фрагмент. Можемо скоротити його або вибрати інше відео; решту монтажу збережено.',
 soundtrack_shorter_than_story:'Музика закінчується раніше за відео. Можемо повторити цей трек або взяти довший; фото й порядок сцен збережено.',
 soundtrack_silent:'У наданому треку немає чутного звуку. Надішли інший аудіофайл; фото й порядок сцен збережено.',
 soundtrack_has_no_usable_audio:'Не вдалося прочитати звук у цьому файлі. Надішли інший аудіофайл; фото й порядок сцен збережено.',
 scene_exceeds_source_duration:'Один із фрагментів коротший за вибраний відрізок. Можемо скоротити його або замінити; решту монтажу збережено.',
 soundtrack_required:'Для погодженого ролика з музикою ще немає аудіофайла.',
 render_time_limit:'Обробка медіа перевищила дозволений час.',
 render_cancelled_or_timeout:'Обробку медіа зупинено через скасування або вичерпаний час; готовий результат не підтверджено. Матеріали збережено; можемо скоротити відео або продовжити за новим проханням.',
 worker_interrupted:'Робочий процес обробки медіа перервався після перезапуску. Вихідні матеріали й порядок збережено; можеш попросити зібрати результат знову.',
 task_step_budget_exhausted:'Виконавець використав дозволену кількість кроків, але перевіреного результату ще немає.',
 task_deadline_exceeded:'Строк виконання доручення минув до підтвердження результату.',
 task_result_unconfirmed:'Зібраних доказів недостатньо, щоб підтвердити виконання доручення.',
 page_unavailable:'Читач сайту не отримав придатної відповіді; точнішої мережевої причини не збережено.',
 visual_decode_unavailable:'Не вдалося декодувати надісланий візуальний матеріал.',
 render_failed:'Процес обробки медіа завершився помилкою; точніший крок не визначено.',
 media_decode_or_render_failed:'Не завершився етап декодування або побудови медіа; точніший крок не визначено.',
 media_delivery_not_ready:'Готовий перевірений файл для цієї доставки ще не підтверджено.',
 media_delivery_not_verified:'Перевірка готового файла та його потрібних складових не підтверджена.',
 media_delivery_output_changed:'Готовий файл змінився після підготовки відправки.',
 media_delivery_resource_changed:'Склад матеріалу змінився після підготовки відправки; попередня версія більше не чинна.',
 media_delivery_source_changed:'Один із вихідних матеріалів змінився або його доступ відкликано.',
 media_delivery_scope_changed:'Дозвіл або аудиторія матеріалу змінилися після підготовки відправки.',
 media_delivery_task_changed:'Доручення змінено або зупинено після підготовки відправки.',
 media_delivery_action_changed:'Зв’язок відправки з погодженою дією змінився після перевірки.',
 asset_bytes_unavailable:'Не вдалося прочитати збережений файл.',
 asset_checksum_mismatch:'Збережений файл не пройшов перевірку цілісності.',
 publication_source_changed:'Версія файла змінилася після підготовки відправки.',
 publication_permission_revoked:'Дозвіл на публікацію в каналі відкликано.',
 channel_publish_rights_changed:'У автора або бота більше немає потрібних прав у каналі.',
 publication_manifest_changed:'Параметри відправки змінилися після підготовки; потрібне нове підтвердження.',
 publication_revoked:'Відправку цього файла відкликано.',
 calendar_write_unconfirmed:'Календарний сервіс не підтвердив результат зміни.',
 calendar_readback_mismatch:'Повторне читання календаря не підтвердило очікуваний результат зміни.',
 image_failed:'Генерація зображення завершилася внутрішнім збоєм; точну причину не встановлено.',
 delivery_unconfirmed:'Провайдер не підтвердив доставку результату.',
 result_delivery_unconfirmed:'Провайдер не підтвердив доставку вже підготовленого результату.',
 tool_result_unconfirmed:'Інструмент не повернув перевіреного результату після початку зовнішньої дії.',
 external_tool_returned_failure:'Інструмент повернув структурований неуспішний результат; точнішої безпечної причини адаптер не надав.',
 approval_expired:'Строк погодження дії закінчився до її виконання.',
 task_delivery_timeout:'Доставка підготовленого результату не підтвердилася у відведений час.',
 oauth_invalid_response:'Сервіс авторизації повернув відповідь, яку не вдалося прочитати як JSON.',
 oauth_metadata_unavailable:'Сервіс не повернув метадані авторизації.',
 oauth_https_required:'Для передавання даних авторизації потрібне захищене HTTPS-з’єднання.',
 oauth_issuer_mismatch:'Адреса сервісу авторизації не збігається з його заявленим видавцем.',
 oauth_endpoint_origin_mismatch:'Кінцева адреса авторизації належить іншому серверу, ніж погоджений видавець.',
 oauth_device_flow_not_supported:'Сервіс не оголосив підтримку авторизації через Device Flow.',
 oauth_device_start_failed:'Сервіс відхилив початок авторизації через Device Flow.',
 oauth_device_response_invalid:'Відповідь сервісу не містить коректного коду чи строку авторизації.',
 oauth_verification_origin_mismatch:'Сторінка підтвердження авторизації належить непогодженому серверу.',
 oauth_authorization_failed:'Сервіс не надав чинного токена доступу після перевірки авторизації.',
 connector_reauthorization_required:'Строк доступу до сервісу минув, а його поновлення не підтвердилося.',
 connection_required:'Для цього сервісу не знайдено збереженого доступу.',
 connection_unreadable:'Збережений доступ не пройшов перевірку розшифрування.',
 private_answer_text_required:'Для особистої відповіді потрібне текстове повідомлення до 6000 символів.',
 private_answer_or_cancel_required:'У цьому кроці очікується особиста відповідь або команда /cancel.',
 private_request_expired:'Особистий запит закритий, прострочений або його версія контексту змінилася.',
 group_membership_required:'Участь у відповідній групі більше не підтверджена.',
 private_draft_unreadable:'Збережену чернетку особистої відповіді не вдалося прочитати; новою відповіддю її не замінював.',
 private_draft_invalid:'Збережена чернетка особистої відповіді має некоректний формат; новою відповіддю її не замінював.',
 decision_closed_or_changed:'Спільне рішення вже закрите або змінило версію після запрошення.',
 research_no_readable_sources:'Жодне зі знайдених джерел не вдалося прочитати.',
 view_stale:'Матеріал змінився або більше недоступний у версії цього перегляду. Відкрий актуальний перегляд.',
 view_membership_required:'Перегляд недоступний: немає чинного підтвердження участі у відповідній групі.',
 view_scope_required:'Перегляд не відповідає поточній темі, аудиторії або особистому отримувачу.',
 resource_unavailable:'Запис недоступний для цього запиту: його не знайдено в дозволеній області або чинні права не дозволяють доступ.',
 asset_unavailable:'Матеріал недоступний у дозволеній області запиту: запис або чинний доступ не підтверджено.',
 linked_material_unavailable:'Пов’язаний матеріал недоступний для цього перегляду: збережений зв’язок, версія або чинний доступ не пройшли перевірку.',
 owner_required:'Доступ до цього особистого простору не підтверджено для поточного автора запиту.',
 context_changed:'Поточний контекст більше не відповідає версії, на якій підготовлено дію.',
};
const detailText:Record<string,string>={
 source_id_invalid:'Ідентифікатор збереженого повідомлення має непридатний формат.',
 source_missing:'Збережене вихідне повідомлення не знайдено.',
 source_context_missing:'У вихідному повідомленні немає перевіреного опису транспортного контексту.',
 source_actor_mismatch:'Автор запиту не збігається з автором вихідного повідомлення.',
 source_topic_mismatch:'Запит і вихідне повідомлення належать різним темам.',
 source_body_mismatch:'Текст, переданий виконавцю, відрізняється від отриманого повідомлення.',
 source_revision_mismatch:'Версія контексту змінилася після отримання повідомлення.',
 source_forwarded:'Повідомлення є пересланим текстом і не є власним дорученням автора.',
 source_via_bot:'Повідомлення надійшло через іншого бота.',
 source_edited:'Вихідне повідомлення відредагували після перевірки.',
 cancellation_quote_invalid:'Доказ скасування не містить власного безумовного доручення автора.',
};
const operations:Record<string,string>={cancel_reminder:'скасування нагадування','schedule.cancel':'скасування нагадування','schedule.series':'зміни повторюваної серії',conversation:'підготовки відповіді',delivery:'доставки відповіді',telegram:'дії Telegram',model:'планування відповіді',image:'створення зображення',media:'обробки медіа',task:'виконання доручення',monitor:'перевірки спостереження',calendar:'роботи з календарем',ingress:'приймання повідомлення',startup:'запуску бота',oauth:'авторизації сервісу',connector:'перевірки підключення',private_answer:'приймання особистої відповіді',private_result:'підготовки особистого результату',research:'перевірки джерел'};
const operationFamilies:Record<string,string>={studio:'роботи з відеоісторією',archive:'роботи з альбомом',lists:'роботи зі списком',tasks:'виконання доручення',connector:'роботи з підключеним сервісом',web:'отримання даних із сайту',research:'перевірки джерел',memory:'роботи з пам’яттю',browser:'роботи зі сторінкою у браузері',code:'виконання обчислення',event:'роботи зі спільною подією',project:'роботи зі спільним проєктом',decision:'роботи зі спільним рішенням',activity:'спільної активності',game:'роботи з грою',poll:'перегляду опитування',calendar:'роботи з календарем',schedule:'роботи з нагадуванням',image:'створення зображення',media:'підготовки медіа',library:'роботи зі збереженим матеріалом',artifact:'роботи зі збереженим файлом',document:'підготовки документа',learn:'роботи з навчальною вправою',stock:'обліку запасів',coordinator:'порівняння та погодження варіантів',private:'роботи з особистим запитом',signal:'роботи зі сповіщенням',watch:'спостереження за сайтом',feedback:'збереження зворотного зв’язку',workflow:'роботи зі збереженою процедурою',access:'керування дозволами',tools:'перегляду доступних інструментів',capabilities:'перевірки можливостей',diagnostics:'перевірки стану роботи',result:'перевірки результату',statistics:'перегляду статистики',storage:'керування зберіганням'};
const stages:Record<string,string>={source:'перевірки вихідного повідомлення',source_binding:'перевірки вихідного повідомлення',planning:'планування дії',model:'отримання плану від моделі',tool:'виконання інструмента',apply:'зміни запису',delivery:'доставки результату',poll:'отримання повідомлень',validation:'перевірки даних',startup:'запуску бота',authorization:'авторизації',token:'отримання доступу',membership:'перевірки участі',summary:'пояснення результату',search:'пошуку джерел',read:'читання джерела',verification:'перевірки доказів',answer:'збереження відповіді'};
const ownText=(mapping:Record<string,string>,key:string)=>Object.hasOwn(mapping,key)?mapping[key]:undefined;

/** Uses verified facts only. Unknown causes remain explicitly unknown. */
export function describeFailure(reason:string,context:Partial<IncidentContext>={}):string {
 const safe=safeTag(reason,'operation_failed'),detail=safeTag(context.detail,'');
 const fact=ownText(detailText,detail)||ownText(reasonText,safe)||(/^model_http_\d{3}$/.test(safe)?`Сервіс моделі повернув HTTP ${safe.slice(-3)}.`:/^http_\d{3}$/.test(safe)?`Сайт повернув HTTP ${safe.slice(-3)}.`:undefined);
 const operation=ownText(operations,context.operation||'')||ownText(operationFamilies,(context.operation||'').split('.')[0]||'');
 const stage=ownText(stages,context.stage||'');
 const introduction=operation?`Під час ${operation}${stage?' на етапі '+stage:''}: `:stage?`На етапі ${stage}: `:'';
 const explanation=fact||'Внутрішній збій; точну причину ще не встановлено.';
 const effects:Record<IncidentEffectState,string>={not_started:'Дію ще не запускав.',unchanged:'Запис не змінено.',confirmed:'Підтверджений результат дії збережено; збій стосується наступного кроку.',partial:'Частину роботи виконано; повне завершення не підтверджено.',uncertain:'Сервіс міг прийняти дію; перед повтором потрібно звірити його стан.'};
 return introduction+explanation+(context.effectState&&Object.hasOwn(effects,context.effectState)?' '+effects[context.effectState]:'');
}

function incidentCode(){
 let time=BigInt(Date.now()),random=BigInt('0x'+randomBytes(10).toString('hex')),prefix='',suffix='';
 for(let n=0;n<10;n++){prefix=alphabet[Number(time&31n)]+prefix;time>>=5n;}
 for(let n=0;n<16;n++){suffix=alphabet[Number(random&31n)]+suffix;random>>=5n;}
 return 'LM-'+prefix+suffix;
}
export function validIncidentCode(value:unknown):value is string{return typeof value==='string'&&codePattern.test(value);}
const factsAllowed=new Set(['source_exists','source_bound','source_context_present','source_forwarded','source_via_bot','source_edited','source_id_type','received_source_id_type','source_body_bytes','request_body_bytes','source_body_sha256','request_body_sha256','request_revision','current_revision','observed_version','expected_version','attempt','http_status','retry_after','candidate_count','target_kind','adapter','contract','native_code','delivery_status','provider_confirmed','expected_count','actual_count','target_refs','target_id','requested_scope','authorization_proof_sha256','authorization_proof_utf16_length','target_count','targets_sha256','resource_id','resource_kind']);
const resourceKinds=new Set(['series','schedule','legacy','occurrence','reminder','task','media','message','image','calendar','tool','monitor','document','attachment','asset','library','composition','publication','watch','private_request','private_result','connection','oauth']);
function validTargetRef(value:unknown):value is string {
 if(typeof value!=='string')return false;
 const pair=/^(series|schedule|occurrence|reminder|legacy):(.+)$/.exec(value);
 return !!pair&&(pair[1]==='reminder'||pair[1]==='legacy'?positive(pair[2])!==null&&String(positive(pair[2]))===pair[2]:uuid(pair[2])!==null);
}
function safeFacts(facts:Record<string,unknown>={}){
 const result:Record<string,string|number|boolean|string[]>={};
 const strictStrings=new Set(['target_id','resource_id','resource_kind','requested_scope','target_kind','adapter','contract','native_code','delivery_status','source_id_type','received_source_id_type','observed_version','expected_version']);
 for(const [key,value] of Object.entries(facts))if(factsAllowed.has(key)){
  if(key==='target_refs'){
   if(Array.isArray(value)&&value.length<=20&&value.every(validTargetRef))result[key]=[...new Set(value)];
  }else if(key==='target_count'||key==='authorization_proof_utf16_length'){
   if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=(key==='target_count'?1000000:12000))result[key]=value;
  }else if(key==='resource_id'&&typeof value==='number'){
   if(positive(value)!==null)result[key]=value;
  }else if((key==='observed_version'||key==='expected_version')&&typeof value==='number'){
   if(positive(value)!==null)result[key]=value;
  }else if(!strictStrings.has(key)&&!key.endsWith('_sha256')&&(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)))result[key]=value;
  else if(typeof value==='string'){
   if(/_sha256$/.test(key)&&/^[a-f0-9]{64}$/.test(value))result[key]=value;
   else if(/source_id_type$/.test(key)&&['number','string','undefined','null','object','bigint'].includes(value))result[key]=value;
   else if((key==='target_kind'||key==='resource_kind')&&resourceKinds.has(value))result[key]=value;
   else if(key==='target_id'&&uuid(value))result[key]=value;
   else if(key==='resource_id'&&(uuid(value)||positive(value)!==null&&String(positive(value))===value))result[key]=value;
   else if(key==='requested_scope'&&['series','occurrence','auto'].includes(value))result[key]=value;
   else if((key==='observed_version'||key==='expected_version')&&(/^[a-f0-9]{64}$/.test(value)||positive(value)!==null&&String(positive(value))===value))result[key]=value;
   else if(key==='adapter'&&['telegram','openai','caldav','http','internal'].includes(value))result[key]=value;
   else if(key==='delivery_status'&&['pending','sending','sent','failed','uncertain','cleared'].includes(value))result[key]=value;
   else if(key==='native_code'&&/^(?:[0-9]{5}|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENOSPC|ENOMEM)$/.test(value))result[key]=value;
   else if(key==='contract'&&/^lumen\.[a-z_\.]+\/[0-9]{1,3}$/.test(value))result[key]=value;
  }
 }
 return result;
}
function receipt(code:string,reason:string,context:Partial<IncidentContext>,persisted:boolean):IncidentReceipt {
 return {code,reason,message:describeFailure(reason,context)+`\nКод для розробників: ${code}. Передай його розробникам для перевірки.`,persisted};
}
const attachedIncidents=new WeakMap<object,IncidentReceipt>();
const resultIncidents=new WeakMap<object,IncidentReceipt>();
const receiptContexts=new WeakMap<IncidentReceipt,IncidentContext>();
function bindReceipt(incident:IncidentReceipt,context:IncidentContext){receiptContexts.set(incident,{...context});return incident;}
/** Attach only after the transaction which saved the receipt has committed. */
export function attachIncident(error:unknown,incident:IncidentReceipt){
 if(error!==null&&(typeof error==='object'||typeof error==='function'))attachedIncidents.set(error,incident);
 return error;
}
/** Use only for a new local result envelope, never a cached/provider singleton. */
export function attachResultIncident(result:unknown,incident:IncidentReceipt){
 if(result!==null&&typeof result==='object')resultIncidents.set(result,incident);
 return result;
}
export function incidentForResult(result:unknown):IncidentReceipt|undefined {
 return result!==null&&typeof result==='object'?resultIncidents.get(result):undefined;
}
/** Untrusted provider properties cannot forge a previously recorded incident. */
export function incidentForError(error:unknown,context?:IncidentContext):IncidentReceipt|undefined {
 const incident=error!==null&&(typeof error==='object'||typeof error==='function')?attachedIncidents.get(error):undefined;
 const bound=incident&&receiptContexts.get(incident);
 // A reused singleton Error is not a request identity. Missing scope evidence
 // deliberately disables reuse rather than borrowing another request's code.
 if(!incident||!bound||!context||!bound.chatId||context.chatId!==bound.chatId)return;
 if(context.operation!==bound.operation)return;
 if(bound.operationKey!==undefined||context.operationKey!==undefined){if(!bound.operationKey||bound.operationKey!==context.operationKey||!/^[a-f0-9]{64}$/.test(bound.operationKey))return;}
 if(['actorId','topicId','audience','revision'].some(key=>context[key as keyof IncidentContext]!==bound[key as keyof IncidentContext]))return;
 if(bound.requestId||context.requestId){if(!bound.requestId||bound.requestId!==context.requestId)return;}
 else if(context.attemptKey!==bound.attemptKey)return;
 if(bound.taskId||context.taskId){if(context.taskId!==bound.taskId||context.attemptKey!==bound.attemptKey)return;}
 else if(positive(bound.sourceId)!==null){if(positive(context.sourceId)!==positive(bound.sourceId))return;}
 else if(context.attemptKey!==bound.attemptKey||positive(context.sourceId)!==null)return;
 return incident;
}
/** Convenience at a caught boundary outside an existing transaction. */
export async function captureIncident(db:Database,context:IncidentContext,error:unknown):Promise<IncidentReceipt>{
 const existing=incidentForError(error,context);if(existing)return existing;
 let incident:IncidentReceipt;
 try{incident=await db.tx(sql=>recordIncident(sql,context,error));}
 catch{incident=logIncident(context,error);}
 attachIncident(error,incident);
 return incident;
}

/** Call in the same transaction as the final failure notice. No effects or model calls. */
export async function recordIncident(sql:SQL,context:IncidentContext,error:unknown):Promise<IncidentReceipt>{
 if(typeof context.attemptKey!=='string'||!context.attemptKey||context.attemptKey.length>1000)throw new ToolError('incident_attempt_required');
 if(context.operationKey!==undefined&&(typeof context.operationKey!=='string'||!/^[a-f0-9]{64}$/.test(context.operationKey)))throw new ToolError('incident_operation_key_invalid');
 const reason=safeErrorCode(error),operation=safeTag(context.operation,'operation'),stage=safeTag(context.stage,'unknown');
 const suppliedDetail=context.detail||(error as {failureDetail?:unknown}|null)?.failureDetail;
 const detail=typeof suppliedDetail==='string'&&Object.hasOwn(detailText,suppliedDetail)?suppliedDetail:null;
 const live=(await sql.query('SELECT memory_revision,paused,chat_id FROM app_state WHERE id=1 FOR UPDATE')).rows[0];
 if(!live||live.paused||context.revision!==undefined&&context.revision!==Number(live.memory_revision))throw new ToolError('incident_context_stale');
 const revision=Number(live.memory_revision),actor=identity(context.actorId),topic=identity(context.topicId)??'0',audience=context.audience==='group'?'group':'private';
 const source=positive(context.sourceId),facts=safeFacts(context.facts);
 let sourceId:number|null=null;
 if(source){const row=(await sql.query('SELECT id,user_id,topic_id FROM messages WHERE id=$1',[source])).rows[0];if(row&&actor&&row.user_id===actor&&row.topic_id===topic)sourceId=source;else facts.source_bound=false;}
 const effect=context.effectState||null;
 const dedup=createHash('sha256').update(JSON.stringify([context.attemptKey,context.requestId||null,operation,context.operationKey||null,stage,actor,topic,audience,revision,reason,detail,effect])).digest('hex');
 await cleanupIncidents(sql);
 const prior=(await sql.query('SELECT code,reason_code,reason_detail,effect_state FROM diagnostic_incidents WHERE dedup_key=$1',[dedup])).rows[0];
 const receiptContext:IncidentContext={...context,operation,stage,chatId:String(live.chat_id),actorId:actor||undefined,topicId:topic,audience,revision};
 if(prior){await sql.query('UPDATE diagnostic_incidents SET last_seen_at=now(),occurrences=LEAST(occurrences+1,2147483647) WHERE code=$1',[prior.code]);return bindReceipt(receipt(prior.code,prior.reason_code,{...context,operation,stage,detail:prior.reason_detail||undefined,effectState:prior.effect_state||undefined},true),receiptContext);}
 // The app_state row lock serializes insert+prune in this tenant namespace.
 await sql.query('DELETE FROM diagnostic_incidents WHERE code IN (SELECT code FROM diagnostic_incidents ORDER BY created_at DESC,code OFFSET $1)',[INCIDENT_ROW_LIMIT-1]);
 const code=incidentCode();
 await sql.query(`INSERT INTO diagnostic_incidents(code,dedup_key,operation,stage,reason_code,reason_detail,actor_id,topic_id,audience,source_message_id,revision,action_id,task_id,tool_run_id,outbox_id,effect_state,facts,app_version)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[code,dedup,operation,stage,reason,detail,actor,topic,audience,sourceId,revision,uuid(context.actionId),uuid(context.taskId),positive(context.toolRunId),positive(context.outboxId),effect,JSON.stringify(facts),RELEASE]);
 return bindReceipt(receipt(code,reason,{...context,operation,stage,detail:detail||undefined},true),receiptContext);
}

export async function cleanupIncidents(sql:SQL){
 const removed=await sql.query("DELETE FROM diagnostic_incidents WHERE created_at<now()-($1 * interval '1 day') RETURNING code",[INCIDENT_RETENTION_DAYS]);
 return removed.rows.length;
}

/** Group messages cannot retrieve private incidents. The opaque code is not an access grant. */
export async function lookupIncident(sql:SQL,code:string,scope:{actorId:string;topicId:string;audience:'group'|'private';revision:number}):Promise<Record<string,unknown>|null>{
 if(!validIncidentCode(code))return null;
 const row=(await sql.query(`SELECT code,operation,stage,reason_code,reason_detail,effect_state,created_at,last_seen_at,occurrences,app_version
 FROM diagnostic_incidents WHERE code=$1 AND actor_id=$2 AND topic_id=$3 AND audience=$4 AND revision=$5 AND created_at>=now()-($6 * interval '1 day')
 AND EXISTS(SELECT 1 FROM app_state WHERE id=1 AND paused=false AND memory_revision=$5)`,[code,scope.actorId,scope.topicId,scope.audience,scope.revision,INCIDENT_RETENTION_DAYS])).rows[0];
 return row?{...row,message:describeFailure(row.reason_code,{operation:row.operation,stage:row.stage,detail:row.reason_detail,effectState:row.effect_state||undefined})}:null;
}

/** Last-resort operational evidence: no exception text, source payload or identifiers. */
export function logIncident(context:IncidentContext,error:unknown):IncidentReceipt {
 const reason=safeErrorCode(error),code=incidentCode(),operation=safeTag(context.operation,'operation'),stage=safeTag(context.stage,'unknown');
 const result=bindReceipt(receipt(code,reason,{operation,stage,effectState:context.effectState,detail:context.detail},false),context);
 const facts=safeFacts(context.facts);for(const key of ['target_refs','target_id','resource_id'])delete facts[key];
 try{console.error(JSON.stringify({event:'lumen_incident',incident_code:code,reason_code:reason,operation,stage,persisted:false,app_version:RELEASE,effect_state:context.effectState||undefined,facts}));}catch{/* Reporting cannot change the original operation. */}
 return result;
}
