# Відновлений повний обсяг R2 + R3.1: додаток до frozen history

Дата: 2026-11-03. Цей додаток оновлює доказову межу попереднього історичного `history/requirements-decisions.md#U01` (у проєктному синтезі `HIST-U01`) / `BACKLOG-01`: повний зміст «5 великих +10 додаткових» **знайдено**, не реконструйовано з назв модулів. Попередні history файли лишилися незмінними для простежуваності. Наявність історичного source не є новим дозволом на виконання.

## Що відновлено

Під час підготовки вихідного пакета було прочитано точні байти authoring ZIP (292239954 bytes; SHA256 `ab2edc9a8765c9f85988c1581c1cced6ad1f67d8da16569b2ddb9d71af8597fa`) і вибрані малі документи. `docs/IMPLEMENTATION_1_12_PLAN.json` містить **43 повних item objects**, 56 declared original requirement IDs, усі їхні поля text/paragraphs/checks/decision/gate/evidence/verification limits і повну історичну metadata. Кожний raw item збережено без перейменування чи дописування відсутнього `requirement.id`. Деякі item групують кілька IDs; `requirement_ids` — належний original source mapping.

У проєкті збережено `docs/lumen/requirements/accepted-development-scope.json`: 43 original records + усі original top-level plan metadata fields + provenance/authority/current-proof-limit envelope. Історичні stage paths `migration/rules/project-policy/requirements/accepted-development-scope.json` і `history/authoring-intake/accepted-development-scope.json` означають матеріали підготовки; канонічний чинний запис — сусідній `accepted-development-scope.json`. Це звичайний документ проєкту, не новий runtime reader, installable skill або система виконання.

Позначення **U1–U10** нижче — точні початкові IDs десяти покращень, **F1–F5** — п’яти великих напрямків. Вони відрізняються від міграційних unknown IDs **U01…**, які вживає checkpoint; жоден із цих ID не перейменовано й не злитo.

## Прямий намір і предметна прив’язка

Доступний owner excerpt від 2026-10-30:

> Давай зроби абсолютно все з цього раунду і попередніх збережень. Окрім аудіо, це ше під питанням якості, це відкладемо на потім, а зараз все роби з попередніх узгодження щодо 5 великих і 10 додаткових, плюс ці, але поки без аудіо

Original R2 PDF рекомендував поетапний вибір одного продуктового циклу. Пізніше власник прямо замовив повний перелічений обсяг без нового аудіо. Історичний implementation checkpoint прямо зв’язує scope з усіма R2 audit fixes, five major features, ten improvements і R3.1 extension. Original full audit PDF і media extension PDF тепер збережені повністю; факт того, що вони містять пропозиції/тодішні невідомості, не стирається. Автоматичного доступу до ненаданих повних приватних чатів або невідомих platform message IDs не припускається.

## Оригінальні повні джерела

| Джерело | Exact доступний файл | Library identity |
|---|---|---|
| Design R2, baseline1.11.0,23pages | `history/authoring-intake/original-pdfs/Lumen_1_11_Full_Audit_UA_2026-10-30.pdf` + повний `.txt` | `libfile_efffc1960cd48191a3ca7df62a556c17` |
| Design R3.1,11pages | `history/authoring-intake/original-pdfs/Lumen_1_11_Media_Extension_R3_UA_2026-10-30.pdf` + повний `.txt` | `libfile_53a9ce494cb8819194bd57a08d427724` |
| Full implementation plan1.12 | `history/authoring-intake/selected/docs/IMPLEMENTATION_1_12_PLAN.json` | exact ZIP payload hash у selected-index/integrity |
| Historical QA/delivery1.12 | `history/authoring-intake/selected/docs/QA_1_12.json`, `RELEASE_1_12_DELIVERY_2026_10_30.json`, independent review | exact ZIP payloads |

Вихідні PDF bytes збережено підтримуваним transfer із Library identity/xattrs. `.txt` — повне layout extraction для читання, не заміна PDF-оригіналу. PDF snapshots і hashes у `claims-addendum.json`; ZIP metadata в `authoring-intake/zip-inventory.json`, вибрані payload checks — `selected-integrity.json`. У ZIP **1896 entries**, з них **1894 payload entries** за MANIFEST плюс README/MANIFEST; число1894 в старому checkpoint стосувалося payloads. Відео/зображення/кадри повністю не розпаковувалися й заново не оцінювалися.

## Повна карта43 записів

| Original item index | Kind | Original requirement IDs | Original title/source section |
|---:|---|---|---|
| 0 | findings | S01 | Пряме звернення скасовує коректне слухання |
| 1 | findings | S02 | Збережена пауза між ініціативами не застосовується |
| 2 | findings | S03 | Разове побажання можна записати як постійне |
| 3 | findings | S04 | Політики стікерів і розбору цитат неузгоджені |
| 4 | findings | P01, P04 | Коротка форма може приховати потрібні факти |
| 5 | findings | P02, P03, P06, P08, P13 | Форматування губиться або суперечить правилам API |
| 6 | findings | P05, P07, P09, P12 | Кнопки і фрагменти можуть втратити звʼязок зі змістом |
| 7 | findings | P10, P11, P14 | Декорації й службові репліки не мають єдиної політики |
| 8 | findings | B01 | Контекст читається через багато взаємно заблокованих транзакцій |
| 9 | findings | B02 | Recovery повторно переписує завершені дії |
| 10 | findings | B03 | Похідні дані не завжди успадковують усі джерела |
| 11 | findings | B04 | Прострочене меню може залишити осиротілі голоси |
| 12 | findings | C02, C03 | Заява про виконання може обійти guard |
| 13 | upgrades | U1 | Приватні внески без технічних форм |
| 14 | upgrades | U2 | Справді різні сценарії ігор |
| 15 | upgrades | U3 | Темп гри під життя компанії |
| 16 | upgrades | U4 | Дослідження з перевіркою кожного важливого висновку |
| 17 | upgrades | U5 | Пригадування за змістом із перевіркою оригіналу |
| 18 | upgrades | U6 | Редагування готових документів зі збереженням структури |
| 19 | upgrades | U7 | Моніторинг потрібної зміни |
| 20 | upgrades | U8 | Адресний аналіз довгих документів і відео |
| 21 | upgrades | U9 | Повторювані доручення як керовані серії |
| 22 | upgrades | U10 | Проєкти з перевірним результатом |
| 23 | major | F1 | 13 F1 Спільні запаси й покупки |
| 24 | major | F2 | 14 F2 Керований сімейний архів |
| 25 | major | F3 | 15 F3 Календар із двобічною синхронізацією |
| 26 | major | F4 | 16 F4 Добровільні навчальні траєкторії |
| 27 | major | F5 | 17 F5 Спільна студія сімейних історій |
| 28 | media | R3.1-6 | 6 Зображення та інші форми відповіді |
| 29 | media | R3.1-7 | 7 Навігатор матеріалів подій та результатів |
| 30 | media | R3.1-8 | 8 Статистика якій можна довіряти |
| 31 | media | R3.1-9 | 9 Спільна модель та серверні межі |
| 32 | media | R3.1-10 | 10 Канали та інтерфейс Telegram |
| 33 | media | R3.1-11, M01, M02 | 11 Нові зауваження та перевірки |
| 34 | media | R3.1-12 | 12 Черговість повної реалізації |
| 35 | requirement | B05 | B05 Сумарний prompt |
| 36 | requirement | B06 | B06 Ріст збережених копій |
| 37 | requirement | B07 | B07 Не всі model calls обліковані |
| 38 | requirement | B08 | B08 Сумарне навантаження медіа |
| 39 | requirement | B09 | B09 Довга гра переписує всю історію |
| 40 | requirement | B10 | B10 Вхідний update втрачає payload після 4 помилок |
| 41 | requirement | B11 | B11 Індекси й плани |
| 42 | requirement | B12 | B12 Idle робота й eager runtimes |

## Повний текст десяти покращень і п’яти напрямків

Нижче подано original requirement content без скорочення. Original implementation status/evidence і verification limits кожного item збережені в canonical JSON. Тодішні фрази «ще немає» всередині proposal paragraphs описують design baseline; зовнішнє `implemented_in_deployed_code` — пізніший historical claim1.12. Це різні часові шари, обидва збережено.

### U1: Приватні внески без технічних форм

Замість JSON або числового коду людина пише «мені до 600 гривень, у пʼятницю після шостої». Бот формує typed draft, показує зрозуміле тлумачення, приймає виправлення та питає лише відсутню істотну умову. Ranking і неприйнятні варіанти задаються кнопками. Ephemeral input може доповнити чинний DM-канал після перевірки API й клієнтів.

Original gate:

12 звичайних неоднозначних і помилкових відповідей; бюджет валюта дата й групова справа не підмінюються; відмова приватної доставки не відкриває відповідь у групі.

Original baseline locator: `src/group-work.ts:122; src/agent-services.ts:76; src/router.ts:255`.

Historical implementation evidence refs: `src/private-drafts.ts`, `src/private-inbox.ts`, `test/upgrade-112.test.ts`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.

### U2: Справді різні сценарії ігор

Готові activity шаблони отримують versioned scenario packs із різними підказками, допустимими діями, рішеннями й наслідками. У bounded typed schema перевіряються заявлені clue/solution constraints. Для довільної вільної прози математична гарантія цілісності не заявляється.

Original gate:

Три різні справи або квести змінюють законні рішення, мають коректний reveal і не зводяться до тих самих констант. Некоректний generated case не стартує; доступний перевірений stored scenario.

Original baseline locator: `src/session-engine.ts:106; src/session-engine.ts:204; src/session-engine.ts:226; src/games.ts:6`.

Historical implementation evidence refs: `src/scenario-packs.ts`, `src/session-engine.ts`, `test/upgrade-112.test.ts`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.

### U3: Темп гри під життя компанії

Погоджена політика синхронної чи вечірньої асинхронної партії, пас, пауза, повернення, передача ведення та приєднання з наступного раунду. Відсутність людини не стає автоматичною поразкою або згодою. Recovery уже існує; нове тут соціальне правило темпу.

Original gate:

Учасник зник інший запізнився ведучий пішов. Партія або законно триває або ясно стоїть. Повернення дає коротку орієнтацію та конкретний доступний хід; тиха година не спричиняє несподіваний reveal.

Original baseline locator: `src/games.ts:93; src/games.ts:120; src/session-engine.ts:92`.

Historical implementation evidence refs: `src/session-engine.ts`, `test/upgrade-112.test.ts`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.

### U4: Дослідження з перевіркою кожного важливого висновку

Claim records повʼязують твердження, часову область, точний excerpt/locator, дату джерела, позначку висновку й суперечності. Посилання на сторінку саме по собі не підтверджує число або рекомендацію. Людська відповідь лишається читабельною, докази відкриваються адресно.

Original gate:

Змінена ціна суперечливі дати нерелевантне джерело й dead URL не стають verified висновком. Збій джерела дає частковий результат із чіткою межею. Кеш показує давність.

Original baseline locator: `src/agent-services.ts:45; src/result-verifier.ts:16; src/extended-tools.ts:150`.

Historical implementation evidence refs: `src/agent-services.ts`, `src/result-verifier.ts`, `src/extended-tools.ts`, `test/revision-112.test.ts`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.

### U5: Пригадування за змістом із перевіркою оригіналу

Пошук враховує парафразу, українські форми слів, час, автора, тему й статус факту. Кандидати перечитуються у джерелі. Виправлений факт, жарт і припущення не подаються як чинна домовленість. Потреба vector index визначається порівнянням якості, ціни й стирання.

Original gate:

Зафіксований набір із 30 запитів включає парафрази та негативні приклади. Вимірюються recall false attribution і вартість. При сумніві бот показує два релевантні кандидати або уточнює; забуті джерела не повертаються.

Original baseline locator: `src/agent-tools.ts:125; src/attention.ts:50; src/memory.ts:12`.

Historical implementation evidence refs: `src/recall.ts`, `test/upgrade-112.test.ts`, `docs/qa-1-12/recall-evaluation.json`, `scripts/recall-controls.mjs`, `docs/qa-1-12/recall-controls.json`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.
- 30 positives plus 30 time-filter and 30 denied-author controls; 0 false source/author metadata. Final model false attribution and production cost not measured.

### U6: Редагування готових документів зі збереженням структури

Підтримувані зміни абзацу, таблиці або діапазону клітинок зберігають незачеплені частини, мають original/output/diff і перевірку вмісту та render. Формули потребують реального recalculation engine. Це великий окремий upgrade із залежностями, а не обовʼязкова частина найближчого релізу.

Original gate:

Типовий 8-сторінковий DOCX і 3-sheet XLSX після правки зберігають потрібні зображення структуру та значення. Непідтриманий елемент пояснений до втрати даних. Вихід відкривається на телефоні й desktop.

Original baseline locator: `src/document-workshop.ts:102; src/office.ts:91; src/office.ts:98`.

Historical implementation evidence refs: `src/office-edit.ts`, `src/office-tools.ts`, `test/deep-112.test.ts`, `test/upgrade-112.test.ts`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.

### U7: Моніторинг потрібної зміни

Умова watch привʼязана до сутності, дати, кількості, одиниць і перевіреного поля. Повідомлення показує старе й нове значення. Зміна footer або слово «місця» у фразі «місць немає» не стають успіхом.

Original gate:

Позитивне підтвердження потрібної дати створює один alert. Нерелевантна зміна дає тишу; outage і відновлення не множать сповіщення. Неоднозначний extraction ставить конкретне питання.

Original baseline locator: `src/web-monitors.ts:26; src/web-monitors.ts:29`.

Historical implementation evidence refs: `src/web-monitors.ts`, `test/deep-112.test.ts`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.

### U8: Адресний аналіз довгих документів і відео

Coverage map зберігає реально оглянуті сторінки, діапазони й таймкоди, пропущені частини та помилки. Людина може попросити сторінку 18 або 00:43–00:48, і бот продовжить від потрібного фрагмента без повторної обробки всього файла.

Original gate:

Відповідь із пізнього фрагмента має точний locator і реальний аналіз. Перші сторінки не видаються за весь документ. Restart і corrupt page не підміняють source. Більший файл обробляється порціями з квотами.

Original baseline locator: `src/documents.ts:7; src/document-workshop.ts:70; src/visual.ts:21`.

Historical implementation evidence refs: `src/media-addressed.ts`, `src/media-inspections.ts`, `test/media-coverage-112.test.ts`, `test/upgrade-112.test.ts`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.

### U9: Повторювані доручення як керовані серії

Серія має локальний час і timezone, окремий occurrence ID, пропуск одного виконання, перенесення, зміну всієї серії та кінцеву умову. Reminder і виконувана task отримують різну політику пропущених запусків.

Original gate:

Дві ночі переходу часу restart після трьох пропусків cancel one/all та одночасний snooze не створюють дублі або лавину повідомлень. Попередній перегляд показує найближчі три дати.

Original baseline locator: `src/scheduling.ts:8; src/scheduling.ts:47; src/agent-services.ts:139`.

Historical implementation evidence refs: `src/recurring.ts`, `test/revision-112.test.ts`, `test/upgrade-112.test.ts`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.

### U10: Проєкти з перевірним результатом

Критерій задачі може вимагати конкретний файл, перевірку власника або provider proof. Зміна вимог повертає результат на review. Перепризначення враховує нову згоду, а залежні задачі показують зрозумілий blocker.

Original gate:

Слово done не закриває задачу з обовʼязковим відсутнім файлом. Decline reassignment або видалення залежності не лишає невидимий deadlock. Власник бачить наслідки зміни без щоденного допиту учасників.

Original baseline locator: `src/group-work.ts:61; src/group-work.ts:88`.

Historical implementation evidence refs: `src/project-evidence.ts`, `test/upgrade-112.test.ts`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.

### F1: 13 F1 Спільні запаси й покупки

Обіцянка: люди можуть природними фразами вести потреби, покупки й залишки; одночасні дії двох учасників не гублять кількості. Люмен розбирає мову, а арифметику, одиниці та конкурентні зміни контролює сервер. Це новий предметний модуль поверх наявних задач і фактів.

Проектний сценарій: Оля додає потребу у двох літрах молока й повідомляє про літр удома. Марко бере покупку, а Оля одночасно зменшує потребу. Марко каже, що є пляшки по 900 мл, і сам обирає кількість. Після «купив дві» бот записує фактичний рух, показує залишок потреби та пізніше враховує використання. Фото чека може допомогти розібрати дані, але розпізнана цифра сама не доводить покупку.

Новизна: поточний project може містити «купити молоко», а knowledge fact — «молоко вдома». Вони не забезпечують атомарні резерви, перерахунок одиниць, незалежні потребу й запас та правильне undo. Якщо цей модуль не дає кращого результату за простий закріплений список, його слід відкласти.

Проектні дані: household_lists; canonical items з unit та aliases; окремі need quantities; StockObservation із фактичним залишком і часом; inventory_movements; reservations із власником і TTL; receipt drafts. Операції add, adjust, reserve, release, purchase, consume, recount і reverse мають operation ID, expected resource version та джерела. Невідомий залишок відрізняється від нуля. Перетворення ml↔l можливе за явним точним правилом; «дві пачки» не перетворюється на вагу навмання.

Права й відновлення: список належить одному чату; тема є способом його показати. Ясне доручення виконується без повторної церемонії; уточнення потрібне для невизначеної позиції чи одиниці. Учасник змінює дозволений спільний список і власний резерв. TTL, вихід автора, cancel, часткова покупка та конфлікт версій мають явні переходи. Restart після commit повертає той самий результат, а повтор update не додає ще один movement. Інтеграція магазину, оплата й доставка для основної можливості не потрібні.

Уточнений контракт Design R2: ledger є append-only для звичайних змін, але forget є винятком. Забуті джерела та їхні залежні movements, receipts і snapshots видаляються або перебудовуються. Баланс, який більше не доводиться рештою незалежних дозволених джерел, стає unknown; залежні резерви стають needs_reconcile. Бот не лишає стару цифру як підтверджену й не обнуляє її мовчки. Новий фізичний перерахунок є окремим джерелом, яке не відновлює забутий текст. UI повідомляє тільки «залишок потребує уточнення», без забутої причини чи суми. Автоматична покупка або поновлення недоведеного резерву не запускається. Цей контракт перевірено незалежною роллю на рівні правил, реалізації ще немає.

Залежності та масштаб: поточні PostgreSQL, Telegram і модель достатні для ядра; потрібні новий доменний модуль та індекси. Ledger читається адресно й сторінками, до моделі передається компактний актуальний стан. Обмеження кількості позицій, bytes і batch imports задаються за вимірюваннями чинного сервера.

Original checks:

1. 20 конкурентних reserve/adjust не перевищують потребу та не створюють відʼємний відомий запас.
2. Один update, повторений десять разів, дає один рух; crash між commit і відповіддю не подвоює його.
3. Часткова покупка, неправильний чек, неоднозначні одиниці, TTL і reversal проходять наскрізно.
4. P(+2) потім C(-1) і forget P дають unknown. Незалежний пізніший recount O(4) дає known 4 без повторного застосування старого C.
5. Інший чат не читає список; після restore з актуальним fence забуте не відновлюється.
6. Пʼять добровільних реальних закупів порівнюються із простим списком за кількістю виправлень і повторних перепитувань.

Original decision:

Перший кандидат за найменшою зовнішньою залежністю. Вайб створює тихе полегшення від коректної координації. Умова зупинки: обслуговування списку вимагає більше зусиль, ніж дає користі, або порушено інваріант кількостей чи забування.

Historical implementation evidence refs: `src/household.ts`, `test/stock-shopping-112.test.ts`, `test/evolution-112.test.ts`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.
- Full user workflow acceptance by people remains open.

### F2: 14 F2 Керований сімейний архів

Обіцянка: родина створює власні колекції подій, фотографій, рецептів або історій, керує добором і підписами та отримує перевірний альбом із реальних джерел. Люмен допомагає впорядкувати матеріал, а авторство й рішення про включення лишаються людям.

Проектний сценарій: «Зберімо нашу поїздку, ці фото не включай». Люди добровільно додають знімки й підписи. Для двох суперечливих дат бот показує невизначеність. Далі формує перегляд колекції та реальний PDF із погодженими фото. Після вилучення матеріалу випускає нову редакцію з оновленим manifest.

Новизна: attachment file IDs, описи фотографій, підсумки розмови й текстові композиції вже є. Новий домен — колекція, membership, авторський відбір, редакційна версія, дозволене використання й життєвий цикл публікації. Звичайний дайджест не рахується цим апгрейдом.

Проектні дані: collections; collection_items; asset_registry із Telegram file IDs, checksum і доступністю; captions та source claims зі статусом fact/joke/uncertain; allowed-use bindings; selection_revision; publication manifest; ingest і render jobs. Для збереження незалежної копії потрібне кероване сховище bytes з квотами й purge. Найбільший Telegram photo може бути вже стисненою версією, тому його не слід називати камерним оригіналом без відповідного файла.

Права та редакції: ясне прохання зберегти наданий матеріал виконується в межах цієї мети. Curator змінює порядок і підписи, але не розширює доступ до приватного внеску. Task-only відповідь не стає цитатою. Відсутній файл має видимий стан unavailable, а суперечлива дата — unresolved. Схожість картинки не означає тотожність версій; reconnect та повтор альбому не дублюють item.

Відкликання до render прибирає asset; під час render робить поточний output stale; після delivery оновлює доступні серверні копії й наступну редакцію. Уже завантажені або переслані людьми копії технічно не можна гарантовано відкликати. Forget не зберігає приховану копію під виглядом редакційного snapshot. Чинні jobs і cache перевіряють актуальну версію доступу перед записом і доставкою.

Залежності та масштаб: базовий архів не потребує генеративного відео або voice API. Потрібні перевірені storage policy, доступний обсяг, backup/restore і renderer для реального альбому. Обробка порціями й thumbnails знижують навантаження; весь медіаархів не додається до prompt. Не кожне фото в групі автоматично стає архівним внеском.

Original checks:

1. 50 внесків пʼяти авторів мають точне джерело версію й дозволену аудиторію.
2. Task-only або приватний внесок не потрапляє до спільної добірки.
3. Відкликання до під час і після render дає визначений стан; стара черга не доставляє revoked asset.
4. Duplicate album, restart та недоступний файл не створюють дублів або вигаданих замін.
5. Багатосторінковий PDF візуально перевірений і справді містить обрані фото й підписи.
6. Люди самі описують, чи впізнають у колекції власну історію і що хочуть прибрати.

Original decision:

Кандидат на перший творчий напрям. Спільна asset-база придатна для F5, але архів і монтаж не слід будувати одночасно як два великі продукти. Умова зупинки: добір і підтримка матеріалів не дають людям переваги над звичайним альбомом.

Historical implementation evidence refs: `src/media-workshop.ts`, `test/evolution-112.test.ts`, `test/deep-112.test.ts`, `test/revision-112.test.ts`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.
- Full user workflow acceptance by people remains open.

### F3: 15 F3 Календар із двобічною синхронізацією

Обіцянка: знайти реальний спільний час і підтримувати погоджену подію при змінах у підключених календарях. Людина може дати лише доступ до зайнятих інтервалів; назви особистих зустрічей не потрібні групі. Непідключений учасник може відповісти вручну, його стан лишається непідтвердженим до відповіді.

Проектний сценарій: на запит про вечерю Люмен знаходить два вікна й називає, чию доступність перевірено. Люди обирають 19:00. Подія створюється у дозволеному календарі з provider receipt. Оля переносить її в календарі на 19:30. Бот бачить зміну, перевіряє конфлікти й пропонує узгодження; чужий календар не переписується автоматично проти власника.

Новизна: наявні event planning, coordinator та ICS залишаються. Нові частини — calendar mirrors, provider IDs, актуальність free/busy, двобічні зміни, повторювані події та conflict resolution. Generic MCP є транспортом, а не готовою календарною інтеграцією.

Проектні дані: calendar_connections окремо на власника; selected calendars і scopes; event_mirrors із provider ID, etag/version та owned fields; recurring parent/occurrence; sync cursor; availability cache із строком; pending changes та reconciliation jobs. Команди: availability, propose, create, modify, cancel, reconcile. Перший adapter підтримує одного конкретного провайдера та обмежену область часу; scope розширюється лише після доказу роботи.

Права та відмови: читання free/busy, запис події, редагування й запрошення людей є різними дозволами. Revoked OAuth або збій означає unknown, а не free. Втрата notification не втрачає зміни завдяки reconciliation. Конфлікт версії вимагає refetch і нового конкретного рішення. Невизначений create спочатку звіряється за operation/provider ID; сліпе повторення не дозволене. Згода на запис події не є доказом згоди кожного запрошеного.

Залежність: потрібна нова перевірена інтеграція саме Telegram runtime. Підключений у цьому ChatGPT застосунок не підключає бота. Для провайдера перевіряються допустимий OAuth flow, scopes, реєстрація client, redirect infrastructure та read/write API. Наприклад, офіційна Google Calendar API має freeBusy та incremental sync; прострочений sync token може вимагати нового повного sync. Конкретний adapter і його доступи ще не реалізовані.

Cancel до dispatch блокує запис; після dispatch потрібне коректне скасування за чинними правами та receipt. Resume перечитує актуальні календарі, не відновлює старий слот навмання. Синхронізація працює з пагінацією, backoff і квотами; заголовки приватних подій не стають груповим cache.

Original checks:

1. Реальний provider sandbox або дозволені тестові календарі проходять read create update cancel і revoke.
2. Recurrence виняток однієї події часовий пояс і перехід часу відображаються однаково в боті й календарі.
3. Одночасна зміна ботом і власником не губить правку; crash після create не робить дубль.
4. Втрата push та недійсний sync cursor приводять до визначеного reconciliation.
5. У групі видно лише погоджені дані; непідключений або недоступний календар не вважається вільним.
6. Подія в черзі не оголошується створеною; invited не оголошується accepted.

Original decision:

Утримати до перевірки інтеграції. Це корисний новий контур, але найбільша зовнішня залежність серед пʼяти. Готовий ICS лишається доступною чинною можливістю та не видається за sync.

Historical implementation evidence refs: `src/calendar-sync.ts`, `src/calendar-groups.ts`, `test/calendar-revision-112.test.ts`, `docs/CALENDAR_SANDBOX_1_12.json`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.
- Actual owned Radicale sandbox passed; user calendar credentials/permissions UX remains unverified.

### F4: 16 F4 Добровільні навчальні траєкторії

Обіцянка: Люмен продовжує навчання від конкретних попередніх спроб людини, памʼятає тип помилки й повертає відповідну вправу, коли людина готова. Це може бути мова або обрана навичка. Прогрес приватний за замовчуванням; спільна гра й приватна траєкторія не змішуються.

Проектний сценарій: Оля просить коротку практику, виконує вправу та отримує конкретне пояснення помилки. Через кілька днів обирає продовжити; бот дає іншу вправу на ту саму навичку, а не повторює загальний урок. Оля заперечує оцінку, і спроба переходить на review. Марко має власні приклади, темп і строк наступної практики. Пауза не створює боргу перед ботом.

Новизна: quiz, scores і activity sessions уже є. Нові сутності — цілі, skill map, attempts, звʼязок вправи з помилкою, рубрика оцінки, приватний стан прогресу та кероване повторення. Накопичені правильні відповіді не є доказом володіння навичкою поза перевіреними вправами.

Проектні дані: learning_goals; skill_nodes та залежності; exercise versions; attempts із відповіддю, критеріями, feedback і source; observations of performance; review state; practice schedule. Виправлення ключа або оцінки перебудовує залежний стан і наступний строк. Вибір вправи враховує дозволені дані цього учасника; його історія не стає груповою характеристикою.

Оцінювання: детерміновані відповіді перевіряє правило чи calculation; відкрита відповідь оцінюється за явною рубрикою із позначеною невизначеністю. Повторена та сама відповідь не рахується новим доказом. Людина може побачити підставу оцінки, оскаржити її або зупинити траєкторію. Навчальні поради й фактичні матеріали мають перевірні джерела там, де це потрібно.

Залежності та відновлення: текстове ядро можливе на чинному backend. Аудіопрактика потребує реально доступних speech/transcription capabilities; OAuth-план текстової моделі сам не гарантує цей API. Старий незавершений attempt не перетворюється на неправильну відповідь після timeout. Скасування поточної вправи припиняє її очікування й відкладену доставку та позначає незавершену спробу cancelled; завершені attempts і попередній прогрес зберігаються. Forget окремо стирає джерело та залежні scores, prompts, review queue і cache. Повтор dispatch не створює другої спроби. Графік добровільний, без streak pressure та публічного порівняння.

Original checks:

1. Два учасники з різними помилками отримують різні релевантні наступні вправи.
2. Виправлена оцінка або ключ змінює лише відповідні залежні результати; старий score не вважається чинним.
3. Restart timeout cancel і duplicate response не подвоюють attempt та не зараховують мовчання як помилку.
4. Приватна навчальна історія не потрапляє у спільну гру або prompt іншого автора.
5. Після forget або restore не повертаються забуті помилки й профіль.
6. Людський тест перевіряє корисність feedback і перенесення на новий приклад; довготривалий освітній ефект не заявляється наперед.

Original decision:

Окремий добровільний освітній напрям після перевірки потреби. Умова зупинки: нестабільні оцінки або потреба часто виправляти бота роблять навчання обтяжливішим за звичайну практику.

Historical implementation evidence refs: `src/learning.ts`, `test/upgrade-112.test.ts`, `test/revision-112.test.ts`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.
- Full user workflow acceptance by people remains open.

### F5: 17 F5 Спільна студія сімейних історій

Обіцянка: із власних фото, коротких кліпів, підписів і записаних голосів створюється реальний короткий відеоепізод. Учасники бачать preview, змінюють окрему сцену й отримують playable MP4. Авторство характерних фраз і внесків зберігається людям.

Проектний сценарій: «Зробімо хвилинну історію про наші вихідні». Кожний охочий додає матеріал. Люмен пропонує порядок сцен і збирає rough preview. «Другу сцену скороти, цю фразу залиш як я сказав, музику тихіше». Нова редакція змінює саме обрані місця. Після перегляду готовий експорт доставляється з підтвердженням, а не лише посиланням на майбутню роботу.

Новизна: композиції text/JSON, генерація файлів, voice interface та FFmpeg для вибірки кадрів уже є. Немає scene timeline, керованого монтажу, render manifest і versioned preview/export. Власні надані аудіо можна використати без синтетичного озвучення; відсутність imagegen або TTS не повинна маскуватися під недоступність усього монтажу.

Проектні дані: studio_projects; assets із походженням і дозволеним використанням; scene revisions із asset refs, in/out, тривалістю, framing, captions і audio tracks; timeline revision; render profiles; render_jobs із manifest hash; previews і delivered exports. Commands add asset, propose scenes, reorder, trim, replace, adjust caption/audio, preview, export і cancel. Зміни мають expected scene/project version; двоє авторів не переписують правки один одного.

Життєвий цикл: ingest→draft timeline→preview queued→preview ready→revision або export queued→rendered→delivered. Це доменний стан медіа; обіцяний результат і дозвіл лишаються під єдиним existing commitment owner. Застарілий preview показується як попередня редакція. Повтор render за тим самим manifest може reuse готовий output; нові права або revoked asset роблять його недоступним.

Залежності та масштаб: FFmpeg і Sharp уже є в залежностях, але повноцінного render executor немає. Потрібні asset storage, окрема керована черга важкої роботи, process memory/CPU/time bounds, progress за фактичним етапом, cleanup та перевірка playable output. Основний чат не має чекати на CPU-bound монтаж. Додаткові генеративні моделі та музичний сервіс не є умовою core; їхня наявність не припускається.

Скасування зупиняє queued job; running процес отримує контрольований abort і прибирає temp files. Crash, disk-full, decode fail або OOM переводять конкретний render у repair, не перезапускають усі сцени без контролю. Відкликання asset до чи під час render інвалідує output і наступну доставку. Після доставки діє та сама реальна межа зовнішніх копій, що й у F2. Голос не клонують і не видають синтетичний текст за запис учасника.

Original checks:

1. Матеріали трьох авторів проходять до реального MP4, який відкривається на Android та iOS.
2. Точкова правка сцени зберігає незачеплені частини й відповідає поточній revision; captions audio/video sync гучність і aspect ratios перевірені.
3. Відтворений manifest дає еквівалентний зміст і таймінги; byte identity вимагається лише за детермінованого renderer.
4. Timeout restart disk-full та decode fail не зупиняють чат і не лишають нескінченні jobs чи temp files.
5. Revoked або foreign-chat asset не потрапляє в preview cache export чи відкладену доставку.
6. Повтор команди не дублює сцени або exports; delivered має квитанцію.
7. Після реального preview учасники самі обирають внести ще одну правку чи матеріал; це сигнал співавторства, а не доказ retention.

Original decision:

Найвиразніший кандидат на нове спільне переживання. Першим творчим циклом обирати або F2-архів, або повну F5-студію з потрібною спільною asset-базою. Умова зупинки: монтаж у чаті потребує надмірного листування, не вкладається в узгоджені ресурси або забирає авторство людей.

Historical implementation evidence refs: `src/media-workshop.ts`, `test/evolution-112.test.ts`, `test/revision-112.test.ts`.

Historical proof limits:

- Automated or code evidence only; no claim of observed human or production behavior.
- Full user workflow acceptance by people remains open.

## Що залишається невідомим після відновлення змісту

Знайдений plan позначає records `implemented_in_deployed_code`, але його загальна qualification **unqualified**. Full server regression575 і startup probes не закрили такі original gates:

- Human conversation/style and full user workflows
- Telegram Android/iOS presentation and MP4 playback
- Real user calendar account/permission UX
- Full simultaneous media/conversation workload under production CPU and memory limits
- U5 final model answer false attribution and production cost

Раніша independent review межа «12 unchanged sticker tests unavailable locally» пізніше адресно закрита повним Render build у1.12 delivery record; не переносити її як нинішній asset blocker. Новіші1.13/1.13.1/1.13.2 exact-SHA CI/live maintenance records мають власний scope. Вони не є добровільним human acceptance F1/F2/F4/F5, не реальним підключенням user calendar UX, не full simultaneous production-load тестом і не вимірюванням final-answer U5 attribution/cost.

Отже scope-content gap історичного `HIST-U01` / `BACKLOG-01` закрито; у чинному реєстрі `U05` відновлено зміст, а перевірка реалізації лишається відкритою на рівні **відновлених точних вимог**. Відкрита належна актуальна source/evidence binding кожного запису: не можна позначити всі56 implemented/current/pass тільки через імпорт. Загальне приймання людиною/пристроєм/календарем/навантаженням лишається addressed unknown до нового доказу.

Новий голос/TTS/STT залишаються **deferred** власником. Відкладення стосується нового аудіо; цитати не встановлюють постійного відкладення всіх нових paid providers. Інша нова платна інтеграція потребує власного конкретного доручення; нинішній документаційний scope не дозволяє її підключення. R3.1 original voice research збережено як історію, а M01 existing-voice delivery bookkeeping fix і non-audio scope не скасовані. Preservation не запускає audio jobs.

Чинний scope — локальне документаційне перенесення та незалежна перевірка за погодженим LM-CONTEXT-2026-11-03-r2; product/production/DB/assets/skills зберігаються. Застосування документа не переатестовує historical implementation. Фактичні результати цього етапу та receiving acceptance фіксуються в `../migration/checkpoint.json`.

## Доступ до оригіналів після перенесення

Вихідні paths `history/authoring-intake/*`, `claims-addendum.json`, `selected-integrity.json` та `zip-inventory.json` вище — історичні archive references. Вони не є залежностями checkout. Канонічний збережений пакет матеріалів: `Lumen_ChatBot_Atelier_Migration_2026-11-03.zip`, SHA-256 `99f116274ddc9ab3fe17a1ab313d3951f3dce363a735d7250ea1ad12db8b35c8`; на цьому Mac вхідний ZIP — `/Users/admin/Downloads/Lumen_ChatBot_Atelier_Migration_2026-11-03.zip`. Для перенесення на інший комп’ютер передати ZIP із цим hash, а не вважати локальний шлях спільним.

Усередині пакета повні PDF/TXT лежать у `evidence/original-requirements/`; implementation plan/QA/delivery — у `evidence/authoring-selection/docs/`; hashes/межі джерел — у `evidence/authoring-selection/selected-integrity.json`, `evidence/authoring-selection/zip-inventory.json`, `project-draft/docs/lumen/requirements/claims-addendum.json`. Повний нормативний зміст вимог доступний у цьому документі та `accepted-development-scope.json`; виконання через ChatBot Atelier не потребує старої навички або читача старої agent-output schema.

Повні правила H/Q — [INVARIANTS](../../codex/INVARIANTS.md), J — [QUALITY_MATRIX](../../codex/QUALITY_MATRIX.md), незмінні 24 — [companion](companion-24.json), сценарії E — [E01–E20](../quality/acceptance-scenarios-E01-E20.json).
