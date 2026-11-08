# Чинне доручення та межі

## Чинний випуск1.13.3 — 2026-11-09

Пряме доручення власника: «Заверши всі роботи поточні і доведи версію до готовності у продакшену і задеплой». Воно дозволяє завершити поточний r1/resource WIP/media blocker, пройти належні локальні й незалежні перевірки, commit і normalGitpush до приватного чинного repo, exactSHA GitHubverify та один deploy чинного worker післяCI. Це адресно замінило попередній no-push/no-deploy stop для цього випуску, без повторного погодження.

Model/voice/secrets/acceptedassets/тариф та приватність не змінюються; ручне очищення історичних reminders або чатів не входить. Additive schema21 застосовується звичайним startup. Після newprivate schedules rollback наa1fd79 заборонений; forwardfix/conditional recovery — RELEASING. Actualcompletion/CI/deploy/Telegram120/order/groupstart читаються з current_work.release_receipt, не з історичних quotes нижче. Попередні затвердження й резервні копії збережені.

## Завершений локальний ремонт — 2026-11-08

Власник прямо погодив **LM-REPAIR-2026-11-03-r1**, усі S0–S4: три виправлення локально, тести й незалежна перевірка; усі можливості та незавершений WIP зберігаються. Пряма межа: **без push, deploy і змін production**. Це чинне доручення на код/тести/стислий контекст, яке адресно замінило документаційний stop попередніх етапів. Згода з точним scope/script binding збережена поза Git; locator — у checkpoint.

Перед ремонтом перевірено installed ChatBot Atelier 5.0.0: 11 модулів узгоджені, чинне погодження зберігається, bootstrap/повторної анкети/автоматичного deployment немає. Exact pinned 2.2 baseline відсутній, тому повний historical diff не заявляється. Оновлення навичок чи їх встановлення не виконувалось.

Production DB/chat data/jobs/Render/secrets/model/voice/repo visibility/accepted assets не змінюються. Локальні PGlite/FakeBrain/FakeTelegram перевірки й additive schema SQL не означають live migration/delivery. Історія нижче зберігає попередні дозволи та виконані етапи; вона не перевизначає це доручення.

## Історичні етапи

2026-11-03, Europe/Kyiv. Пряме доручення власника в поточному Codex-чаті:

> Виконай щойно підготовлений план перенесення.
> Перевір збереження всіх правил і проведи незалежну перевірку
> продовження через ChatBot Atelier без старої навички.
> Lumen Оркестратор поки не видаляй. Production не змінюй.

Погоджена основа — LM-CONTEXT-2026-11-03-r2: 11 наявних документів доповнюються, 20 docs/lumen створюються. Дозволені local docs edits, read-only source/provider metadata, структурна/семантична перевірка й незалежний cold intake. Source inventory уточнюється фактичним registration graph; додаткові знайдені tool names не є новими функціями.

Поза scope: commit/push/PR/deploy, зміни production/DB/chat data, code/tests/assets/dependencies/CI/Render, модель/голос/providers/secrets, skill/custom-agent mutations та live diagnostics. Окремі read-only metadata не доводять runtime health/Telegram delivery. Старі цитати дозволів — історичні джерела, не поточна авторизація. Повторного дозволу на вже доручене локальне перенесення не потрібно.

Старі skills/helpers/config зберігаються; нової Lumen wrapper-навички чи другого координатора не створено. Незмінний WIP передається файлами з hashes. Звіти/backup/cold package — поза Git, у checkpoint лише короткі результати/locators. Відкат — inverse лише внесеного docs delta зі звіркою bytes; новіші правки користувача не перезаписуються.

## Пізніше пряме доручення: резервна копія й точне ім’я

Після локального перенесення власник доручив перевірити успішність перенесення та незалежного продовження; після цього зберегти перевірену повну резервну копію й прибрати лише навичку з точним ім’ям `lumen-orchestrator` підтримуваним способом. Також прямо доручено перевірити недоступність старого виклику й доступність `chatbot-atelier-director`; код, дані, активи й production не змінювати. Це адресно доповнює попередній stop щодо skills, не дає дозволу змінювати інші навички чи продукт.

Виконано підтримуване `skills/config/write` із selector `name=lumen-orchestrator`, `enabled=false`: обидві копії виведені з доступних викликів. Публічний API цієї версії Codex не має local-skill delete; фізичні файли залишені незмінними. Повна резервна копія двох каталогів/108файлів перевірена до зміни; fresh public loader у новому процесі з forceReload підтвердив0доступних старих і доступний ChatBot Atelier director. Receipt/hash/backup — у checkpoint. Ручного filesystem видалення чи зміни інших skills не виконувалося.

## Останнє уточнення: фізичне видалення сімейства

Після попереднього вимкнення власник прямо доручив фізично видалити обидві копії lumen-orchestrator та підпорядковане сімейство навичок зі збереженням перевіреної повної резервної копії; інші навички, код, дані, активи й production не змінювати; перевірити доступність chatbot-atelier-director.

Незалежно звірений scope: lumen-orchestrator (особиста й repo-local копії), lumen-architecture, lumen-conversation, lumen-feature, lumen-stickers, lumen-qa, lumen-release, lumen-cost-audit — 8 назв/9каталогів. Усі 115файлів і 19directory entries заархівовано та перевірено до видалення. Два раніше неявні правила спеціалістів явно збережені у COST_POLICY/WORKFLOW. Видалено тільки ці каталоги, без їхніх parent roots, custom agents, scripts/codex чи іншого коду. Fresh skills/list із forceReload після видалення підтвердив0записів сімейства та доступний chatbot-atelier-director. Exact backup/receipt/hash — у checkpoint. Попередні абзаци описують попередні етапи й не є поточним станом фізичних файлів.
