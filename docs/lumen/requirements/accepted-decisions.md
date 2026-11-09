# Люмен: прийняті рішення, історія й питання для продовження

Редакція застосованого контексту: 2026-11-03, LM-CONTEXT-2026-11-03-r2. Це документи чинного продукту; поведінка бота цим етапом не змінюється. Джерела прочитано з доступних файлів і наведених у вихідному пакеті уривків розмов. Доступу до повних інших приватних чатів або їхніх прихованих вкладень цим не встановлено.

> **Пізніше доповнення:** первинну прогалину точного складу «5+10» закрито. [Повний відновлений обсяг](requirements-scope-addendum.md), [43 повні records](accepted-development-scope.json) і [supersession](#scope-supersession) переважають нижчі історичні твердження про відсутність тексту. Реалізація/людське приймання цим не підтверджені.

## Поточне доручення й межі

Чинне доручення власника після перегляду LM-CONTEXT-2026-11-03-r2:

> Виконай щойно підготовлений план перенесення.
> Перевір збереження всіх правил і проведи незалежну перевірку
> продовження через ChatBot Atelier без старої навички.
> Lumen Оркестратор поки не видаляй. Production не змінюй.

Дозволено локальне документаційне перенесення погодженого allowlist та незалежну перевірку. Код, дані, runtime, активи, записи навичок, autoDeploy, providers/model/voice і production зберігаються; commit/push/PR/deploy не входять у цей етап. Повний чинний scope — [current-scope](../migration/current-scope.md), фактичний стан — [checkpoint](../migration/checkpoint.json). Історичні release-дозволи нижче залишаються provenance, а не новими повноваженнями.

Після перенесення один інтегратор — `chatbot-atelier-director`, предметні модулі — сімейство ChatBot Atelier. Правила, persona, прийняті активи, обмеження й стан належать проєкту. Другий Lumen wrapper, нова installable навичка або новий бот не замовлені.

## Як читати джерела

| Рівень | Джерело | Що воно доводить |
|---|---|---|
| Прямий намір | Чинне доручення про виконання погодженого плану, current-scope | Локальне docs-перенесення й незалежна перевірка, production/skill stop, повнота перенесення |
| Прийнятий намір | Наведені в цьому чаті уривки продуктових розмов 2026-10-25…31 | Зміст вимог власника в межах реально наведеного уривка; не повноту старого чату |
| Поточний source | Паралельний pinned intake `main` SHA `a1fd79dc1e369f0f6d50579523524cd196f11d72` | Чинний source/config/contracts; окремий фактичний звіт готується source-intake |
| Проєктні правила | `LUMEN_PROJECT_POLICY_EXPORT_UA.md` і знімки фактичних ресурсів колишньої навички | Повні правила для збереження; не реалізованість і не runtime |
| Історичні перевірки | `Lumen_1.13.2_verification.zip` та motion-repair state | Записані точні перевірки й receipts на 2026-10-31; не новий live readback 2026-11-03 |
| Раніші історичні перевірки | `Lumen_1.13_release_state.json`, `Lumen_1.13.1_project_audit.json`, retired archive | Походження змін і початкові дефекти/результати. Новіші completion records адресно закривають відповідні старі pending поля |

Історичний файл не стає current runtime через те, що його сьогодні прочитано. Новіший timestamp сам собою не скасовує погоджене: потрібні предмет і authority. Для кожного факту окремі статуси `source-confirmed`, `historical-receipt`, `accepted-intent`, `reported-defect`, `unknown`, `conflict`. Вихідний `claims.json` зберігається в архіві матеріалів; усі його substantive claims, source identities і proof limits перенесено до нижчих розділів цього канонічного документа. Історичний статус не підміняє checkpoint.

## Прийнятий характер і поведінка

**Місія.** Люмен — живий доречний учасник розмови та корисний помічник. Людський досвід важливіший за демонстрацію внутрішніх інженерних форм. Повний поточний текст persona/prompts слід брати з pinned source і зберігати окремим source snapshot; наведений тут намір не замінює оригінальних промптів.

**Мова й адресат.** Робоче спілкування з власником — українською. Мови самого продукту, адаптація до учасників, reply/actor/topic/audience та реальні locale settings відновлюються з source. Прізвисько «Саня» згадане в контексті Telegram-чату; це контекстне звертання, не загальне правило називати так усіх і не доказ синхронізації чатів.

**Самостійна доречна участь.** У дорученні 2026-10-26 власник просив реагувати також на обговорення між учасниками: якщо воно продовжує раніше обговорюване/запитане в Люмена, стосується самого Люмена або його коментар зараз доречний. Мета включає як корисний, так і доречний кумедний коментар. Це не наказ відповідати на кожне повідомлення, не обхід прохання помовчати й не новий доступ до DM. H14/H15, source/audience boundaries та відомі proactive gaps зберігають силу.

**Розмова й пропозиції як цілісна поведінка.** 2026-10-29 власник замовив глибоке переосмислення того, як Люмен говорить і пропонує дії. Поштовхом стали кнопка «детальніше», яка не давала результату, та гра, яку бот не зміг стартувати. Власник попросив поведінковий движок, у якому дії, ігри й голосування є частинами цілого. Потрібно зберегти цей системний намір і реалізований source, а не звести задачу до косметичного ремонту двох кнопок чи створення другого router/controller.

**Пропозиція має завершуватися справою.** Вхід добровільний; зрозуміло, що буде після погодження; є перший змістовний крок і вихід. `details/start/continue/cancel/retry` пов'язані з конкретними state/spec/actor/scope. ACK не є виконанням. Дві пропозиції та неоднозначне «давай» потребують правильної прив'язки, а не довільного запуску.

**Природність.** Тепло, власна позиція й емпатія; гумор лише доречний. Проста репліка не потребує анкети; складна справа не втрачає потрібного змісту. Не вигадувати результат, відсутню capability, факт доставки або причину помилки. Після помилки — природне пояснення, збережені незалежні результати й виконуваний шлях відновлення.

## Повний обсяг, який потрібно зберігати

Нижче перелічено збережений предметний scope. Це inventory вимог, а не декларація, що кожна функція реалізована й сьогодні перевірена. Рівень реалізації встановлюється окремим source/evidence inventory.

| Область | Повний збережений зміст | Належна перевірка/межа |
|---|---|---|
| Розмова | Persona, warmth, власна позиція, доречність, адресат, reply/referent, topic, мова, пропорційна глибина, мовчання, добровільність | Frozen contexts, контрастні пари, actual action alignment; людська naturalness окремо |
| Практичні справи | Нотатки, покупки/списки, нагадування/календарі й інші підтримані source справи справді збережені та доступні | Source route/storage/outcome; receipt для зовнішнього результату |
| Пам'ять | Факти, temporal preferences, scope, correction/correctedBy, source lineage, recall; разове побажання не стає постійним профілем | Синтетичні 1/5/20-turn replay та негативні cross-chat/DM тести |
| Приватність і forget | chat/topic/actor/audience/purpose; DM/task-only; forget/edit/revoke інвалідують summaries/caches/jobs/search/prompts/views/exports; restore/late results не повертають забуте | Cascade/late-result/old-backup probes; реальні приватні чати не входять до пакета |
| Дії й callbacks | Конкретні actionId/spec/version, one owner, duplicate/stale/wrong actor, cancel/expiry, неоднозначні referents; старі підтримані buttons | State/effect trace, idempotency, compatibility за current code і збереженими даними |
| Групи й ігри | Авторство/згода кожного, ролі/вибори/черговість, named/open roster, добровільний вхід/вихід; roster раунду immutable, newcomer із наступного кроку | Не рахувати silence/vote/чужу відповідь згодою; meaningful first move |
| Час | Local time, timezone/DST, date, recurrence, skip/reschedule/overdue | Actual scheduling contract і restart/late dispatch probes |
| Jobs і відновлення | Persisted ownership, queue/locks/lease, cancel/expiry/retry/reconcile, pinned owner/engine/version, pending/uncertain effects; незалежне доручення не губиться через гру або restart | Не повторювати невідомий external effect без actual status/idempotency proof |
| Медіа | Усі прийняті персонаж/сцени/емоції, originals/masters, recipes/prompts/lineage, WEBM/PNG hashes/order/fingerprint, відео/музика/кадри/captions за підтриманим контрактом | Final frozen bytes/decode/timing/full motion/listening, audience delivery; publication/readback окремо |
| Ресурси | Межі jobs/bytes/time/CPU/RSS/queue/latency; важке медіа не блокує чат; cleanup власних тимчасових outputs | Профілювання/навантаження за конкретною зміною; не вигадувати savings |
| Провайдери | Чинна модель, voice settings, tools, обмеження витрат; відсутній інструмент = gap | Каталог чи назва моделі не доводять entitlement/наскрізний шлях |
| Версії | Повні можливості/дані, підтримані старі buttons, прийняті assets/history, compatible additive migrations/rollback, source/deploy identity | Exact source/CI/provider receipt; readiness за фактично досягнутою межею |

H01–H26, Q01–Q04, J01–J12, 24 незмінні companion requirement IDs та E01–E20 зберігаються повними окремими records. Цей inventory не замінює їх і не дозволяє усереднювати hard gates з quality scores.

## Стікери й візуальна якість: прийнятий зміст

1. Власник прийняв загальний вигляд персонажа/стікерів; новий прохід має зберегти прийняті файли, сцени й емоції, доки немає конкретного дефекту.
2. 2026-10-27 для раунду 50 стікерів сформульовано: кожен унікальний, відповідає емоції/смайлу, preview одразу пояснює сенс; насичений креативний контент і висока якість. Плавність поліпшується додатковими кадрами при тій самій тривалості дії; прискорення не є заміною плавності.
3. Використання Люменом — вибірково для яскравого емоційного акценту. Постійне надсилання стікерів не замовлене.
4. 2026-10-29 власник попросив ширший спектр емоцій за наданою клавіатурою та додатковим рядком: не все підряд і без обов'язкових інопланетян; нові емоції мають розширювати досвід. Перші позиції поєднують популярність і різноманіття. Самі зображення клавіатур у цьому історичному контексті недоступні для повторної точної класифікації; актуальний manifest/approved order є виконуваним reference.
5. Власник вимагав спільну доставку коду й усіх 120 нових стікерів. Код-only активація в тому релізі суперечила дорученню. Це історичне release acceptance; нинішній документаційний scope не публікує новий набір.
6. 2026-10-31 власник вказав на майже відсутній motion у сплячого персонажа, аномальні руки при діставанні сюрпризів, рвану примітивну анімацію привида-постирадла й просте вертикальне переміщення всієї картинки. Перелік був прикладами ширшої проблеми, а не вичерпним каталогом дефектів. Приймання потребує повної анімації, локальної артикуляції й причинної дії; переміщення всього кадру не доводить якісний motion.
7. Motion state 1.13.1/1.13.2 повідомляє ремонт 35 і збереження 85 елементів. Раніший реліз 1.13.0 повідомляв 71 індивідуальний ремонт. Це різні проходи, їх не додавати й не називати 106 унікально відремонтованими стікерами без per-ID mapping.
8. Чинне правило `AGENTS.md`, прочитане головним агентом/source intake: усі **120 ID, emoji/емоцій, сцен і погоджений порядок** зберегти; при ремонті стікера не перебудовувати поведінку бота й не генерувати прийняте без конкретного дефекту.
9. Підтверджений у записах 1.13.2 fingerprint: `0c30bf0ae640f49e30caa02b3d7dd7656e43ca330514e1bbfd2783ea8513afe9`. Раніший `589ce76b16ff3d4fa47ed71fab166dfaa8eb80e962a05ceb2e2aaeb91ce3181a` належить 1.13.0; не відновлювати його як current approved value.
10. Ідентифікатор набору в receipts: `Lumen_120_Emotions_by_lumen_family_agent`, назва «Люмен — 120 настроїв», URL `https://t.me/addstickers/Lumen_120_Emotions_by_lumen_family_agent`. Це історично спостережений набір; current Telegram readback окремий.
11. Технічні exact-byte/source/manifest reviews не доводять людське сприйняття плавності, timed native playback або Android/iOS walkthrough. Їхніх нових результатів у 1.13.2 немає; якість не можна позначити `human_validated`.

## Аудіо, модель і витрати

2026-10-30 власник спочатку попросив дослідити якісне звучання, відповідне мультяшному персонажу-мишці Люмену, без підключення платних сторонніх моделей. Далі прямо визначив: аудіо лишається під питанням якості й відкладається; решту погоджених раундів виконувати поки без аудіо. У записах 1.13.0 `new_voice_enabled=false`; 1.13.2 зберігає чинні model/voice settings та заборону нових voice/paid providers без доручення.

Висновок: новий голос не є відкритим до виконання backlog item. Можливе майбутнє дослідження/приймання треба прив'язати до окремого наміру та реального quality evidence. Чинна модель за `AGENTS.md` — GPT-6.1-Sol; historical model probe `gpt-6.1-sol` записаний у 1.13.0. Actual runtime configuration сьогодні відрізняється від source preference як окремий факт; без readback не оголошувати його перевіреним.

## Тести, чистота проєкту й maintenance

Питання власника про 1099 тестів було запитом на предметний аудит: чи потрібні вони, чи є застарілі/розробницькі/дубльовані. Це не наказ досягти меншого числа тестів. Подальше «Зроби це все» дозволило відповідний maintenance scope, але поточний stop відокремлює його завершений release від цієї документаційної міграції.

Audit 1.13.1 на baseline `03a08dce371de480a1776796d2b1c8af3d3450b7` зафіксував 73 test files, 1099 виконаних case, усі mapped to source; exact body duplicate groups 0, identical titles 0; 18 production deps з підтвердженим usage. Старий номер версії в назві тесту сам собою не означає непотрібності. Зберігаються регресійні сценарії privacy/consent/authority/queues/delivery/memory/migrations, підтримана callback/action compatibility й readiness готового 120-набору.

Завершення 1.13.2 повідомляє **0 вилучених baseline cases**, 1099 збережених + 8 нових = 1107 функціональних; 11 release JS controls; успішний exact-SHA CI та restricted Docker smoke. Ці числа належать конкретній редакції й receipts, не майбутній незмінній цілі.

`audit-closure.json` містить адресні resolutions усіх A01–A14:

| ID | Прийнята maintenance зміна |
|---|---|
| A01 | Один повний обов'язковий exact-SHA CI verify; Render checksPass; без повторного full suite у build |
| A02 | Окремі production/test compilation; самодостатній `.release`; guarded finalizer build checkout |
| A03 | 120 PNG лишаються еталонами розробки; production artifact без sticker PNG |
| A04 | Авторська історія manifest в архіві; компактні Git/runtime manifests зі збереженими IDs/order/hashes |
| A05 | Широка live diagnostics opt-in в єдиному worker/lease/Auth; обов'язкова readiness збережена |
| A06 | Assertions перевіряють actual categories та сталі version/dedup/delivery контракти |
| A07 | Дубль media-inspection SQL/setup прибрано після збереження функціонального покриття |
| A08 | Діагностика у `tools/diagnostics`, outputs у власні тимчасові/явні зовнішні каталоги, cleanup |
| A09 | Harness прибирає лише owned runtimeDir; caller-owned каталоги збережені |
| A10 | Чотири unused медіафайли збережені в перевіреному retired archive перед вилученням з Git |
| A11 | Compose tmpfs/amd64 й Chromium libs узгоджено; restricted Docker smoke; production лишився native Node |
| A12 | Benchmark opt-in з явними params, heuristic results, без release-quality claim; у релізі не запускався |
| A13 | 55 unused identifiers виправлено; noUnusedLocals/noUnusedParameters для обох TypeScript builds |
| A14 | README/OPERATIONS/RELEASING/AGENTS/changelog узгоджено з 1.13.2 й bootstrap/rollback |

Це прочитані історичні closure records; повторний аудит усіх 14 без зміни або негативного evidence не замовлений. Source intake має перевірити залежності, а runtime receipts — actual deployment. Розбіжність поточного source відкриває тільки зачеплене finding.

## Релізний процес і артефакти

Поточний `AGENTS.md` установлює звичайний Git commit + один push із перевіреного checkout; доступ GitHub plugin не доводить Git CLI auth. Не підмінювати відсутній CLI доступ сотнями file-upload викликів, не обходити автоматичну перевірку. Широкий історичний blob/chunk upload plan superseded; WEBM/PNG/manifest передаються звичайними файлами, chunk reconstruction у pretest не потрібне.

Git зберігає код, конфігурацію, залежності, потрібні тести/fixtures, готові ресурси й стислу документацію; PNG previews — еталони розробки. Робочі рендери, пробні відео, frames, source atlases, execution reports і sticker-lab мають інший життєвий цикл. Джерела/рецепти зберегти в перевіреному окремому архіві до вилучення з Git. Пам'ять чату не замінює файли. Цей migration-пакет є review artifact, а не дозвіл додати всі його snapshots/reports до продуктового Git.

Релізні команди, наведені в поточному AGENTS/source: build `npm ci --include=dev && npm run build:release && node tools/release/finalize-render.mjs`; start `cd .release && npm start`; GitHub exact-SHA `verify`; Render `After CI Checks Pass`. Перевіряються фактичні host settings, не тільки render.yaml. Другий ручний deploy після автоматичного не запускається. При manual deploy CI цього SHA перевіряється явно.

Production package не містить first-party tests/docs/tools, PNG previews або authoring history. Одночасно повні потрібні проєктні правила зберігаються у source documentation і доступному archival пакетi. Runtime finalizer за власним guarded контрактом не є загальним дозволом чистити checkout Codex.

Render target, записаний у receipts/AGENTS: `srv-dbfl0je7bikc73dvg0qg`, workspace `tea-dbf5jsfb9u1s73bn4d1g`. Власник просив нормальне browser/device підтвердження, без запиту Google-пароля. Історична наявність auth/config directory у scratch не доводить доступності сьогодні й не є credential для перенесення.

Приватність repo, модель, voice config, secrets, chat data, Render resources змінюються лише за окремим дорученням. У нинішньому документаційному scope такі зміни виключені. Журнал змін за версіями — явна вимога власника з 2026-10-30; поточний CHANGELOG і його дисципліну зберегти.

## Стан завершених робіт і точні межі

| Етап | Відомий source/результат | Межа доказу |
|---|---|---|
| 1.13.0 | `38de3001dc87e36e5fc4531e9b3f2a72ba294483`, historical joint release, 120 verified, 71 repairs у тому проході | Сьогодні це історія; старий fingerprint `589c…` не current |
| 1.13.1 | `6b5fac311d5d8e1c42b86a54817035420e7f3caf`, historical live; 35 repaired/85 unchanged; CI1099 | Пізніше source оновлено до1.13.2; human/mobile motion unobserved |
| 1.13.2 | `a1fd79dc1e369f0f6d50579523524cd196f11d72`, tree `ab005dcd853233648d13f83842385106af8fb47d`; A01–A14 closure, CI1107+11; historical deploy `dep-dbj6j67b9u1s73d6aeb0` live at `2026-10-31T22:21:33.236324Z` | Local HEAD/main і current Render metadata readback підтвердили цей SHA; runtime health/jobs/Auth/model/Telegram не перевірені цим metadata readback |

`deployment-completion.json` (`2026-10-31T22:28:38.727Z`) та `qa-deploy-review.json` — належні completion records того maintenance scope. Їхнє `open_mandatory_scope_issues=[]` означає відсутність issues у **A01–A14 та scoped deployment**, а не відсутність майбутніх побажань/всіх дефектів продукту.

Actual runtime inventory в CI/native receipts: **5783 files / 123 production packages / 415121852 bytes**, 120 WEBM, 0 sticker PNG. Старий локальний source-QA artifact **5821/126** залишений історичним; не видавати його за інвентар фактичного deployed filesystem. Незалежний remote filesystem listing і direct `/ready` HTTP не відбулися через локальний DNS/SSH limitation; worker startup, build finalizer та Telegram readback були спостережені через API/logs.

Telegram receipt `2026-10-31T22:21:36.818Z`: count/assets/memberships =120, ordered fingerprint `0c30…`; startup `2026-10-31T22:21:36.838732792Z`: version1.13.2, groups2, catalog120. Немає підстав виводити raw group identities або приватні розмови. Ранній post-start observation закінчується до `2026-10-31T22:23:55.747424289Z`; це не довготривалий soak/load proof.

Дані `round.json`, `local-verification.json`, `qa-review.json`, `ci-evidence.json` навмисно залишилися immutable snapshots із then-pending external limits. `index.json` прямо вказує, що наступні deployment/QA records закривають той зовнішній scope. Не відновлювати вже закритий pending за старим файлом і не переписувати оригінали.

## Прийняті архіви й originals

| Матеріал | Locator/hash | Факти доступності цього проходу |
|---|---|---|
| Authoring originals/recipes | `Lumen_1.13.1_authoring_sources.zip`, `libfile_eacd327e079c8191ac88bc43375e458a`, bytes292239954, SHA256 `ab2edc9a8765c9f85988c1581c1cced6ad1f67d8da16569b2ddb9d71af8597fa` | Locator/record збережений; великий архів у цьому проході не розпаковано/не звірено заново |
| Retired materials | `Lumen_1.13.2_retired_materials.zip`, `libfile_5cb705ea45848191b89cdef4e5bce93e`, SHA256 `7a5da5b88fb95792a19afae122a02173c945baec246cbd9834609af92ad2e85c` | Архів доступний; inventory прочитано:4 старі медіа, старий authoring manifest, benchmark, duplicate SQL, historical delivery record; `archive-index.json` з точними hashes |
| Maintenance verification | `Lumen_1.13.2_verification.zip`, `libfile_714f8156e41c8191a305918b664d1521`, SHA256 `048b7781bbeb3550e201d7fe6404626472efbc7d9b59610faa07feee7258ef0c` |13 JSON прочитано/безпечно витягнуто для аналізу; локальна hash/inventory validation у `history/verification-integrity.json` |

Поточний media manifest, accepted masters і архів originals виконують різні ролі. Runtime не залежить від authoring archive. Перенесення правил не дозволяє загубити оригінали, мовчки перевидати pack або повторно розрендерити прийнятий каталог.

## Конфлікти та адресне supersession

| Конфлікт/старий припис | Чинне тлумачення й причина |
|---|---|
| `LUMEN_RESUME_UA.md` містить готові prompts із дозволом видаляти skill і змінювати локальні routes/kits | Це текст попередньої інструкції, а не нова згода на виконання тут. Поточний прямий запит дозволяє лише локальне документаційне перенесення та незалежну перевірку. Нічого не видаляти/вимикати/змінювати в product/production |
| RESUME вимагає generic24 брати лише з ChatBot Atelier; новий attachment просить повні24 records у project context | Зберегти всі24 records і IDs як проєктні вимоги/statuses, не дублювати generic installable toolkit. Повнота потрібна для холодного intake |
| Історичний дозвіл publish у public repo | Поточне repo private, AGENTS забороняє міняти visibility без окремого доручення; нинішній scope локально документаційний, без публікації |
| Старий upload план2444 paths/blob/chunks | superseded звичайним Git і неподіленими файлами за current AGENTS; не відновлювати |
| Старі tests1099 й усіA01–A14 findings у первинному audit | Закриті адресним maintenance1.13.2; baseline1099 збережено й додано8; history не стає невиконаним backlog |
| Старий fingerprint589c… і новий0c30… | Різні media редакції1.13.0→1.13.1; поточне approved значення звіряється з pinned manifest/current receipt |
| Старі історичні suite/quick-check назви в policy docs | Команди виконання беруться з current source; відсутні аналоги не створювати заради назви |
| Старі wrapper/24TOML ролі згадані в export | Наявність/locations на Mac невідомі; не масово видаляти. Інвентаризація й retirement — окремий майбутній exact plan |
| Старі then-pending prod verdict/source QA проти завершеного deployment receipt | Immutable snapshots зберігають власну межу; current historical completion визначено окремими completion/qa-deploy records |

## Невирішене, відкладене й наступний точний scope

| ID | Питання/статус | Наслідок і наступний адресний крок |
|---|---|---|
| HIST-U01 | Колишню прогалину складу «5+10» закрито точним відновленням source | 43 records/56 IDs збережено в accepted-development-scope; поточне implementation/human acceptance окремо unknown. Вихідне твердження про відсутність тексту є superseded |
| HIST-U02 | Новий голос — **deferred** власником | Не вмикати; потрібне майбутнє окреме quality рішення. Чинний voice config зберегти |
| HIST-U03 | Fresh human/mobile motion acceptance — unknown | Technical receipts не закривають; за майбутнього медіа scope показати timed playback/Android/iOS і отримати реальне людське спостереження |
| HIST-U04 | Fresh human naturalness/conversation acceptance — unknown | Не замінювати unit/LLM score; добровільне людське оцінювання за конкретним future behavior change |
| HIST-U05 | Current Render deploy/config metadata підтвердили a1fd79d і live dep-dbj6j67b9u1s73d6aeb0 | Runtime health/jobs/Auth/model/Telegram окремо unknown; metadata readback не дозволяє повторний deploy |
| HIST-U06 | Actual pending jobs/locks/uncertain effects/privacyEpoch — unknown без scoped runtime access | Source schema не доводить порожньої черги. Не повторювати remote effects за старими нотатками |
| HIST-U07 | Колишній Work unknown локального checkout закрито фактичним intake | HEAD a1fd79d, branch chore/codex-migration-2026-10-31, 17 tracked modified плюс untracked WIP; exact snapshot/checkpoint зберігає bytes і owners |
| HIST-U08 | Project-owned context застосовується за погодженим планом; applied cold intake має власний verdict у checkpoint | Незалежний receiver отримує project docs/source/WIP без старої skill; retirement не входить у чинне доручення й не виконується |
| HIST-U09 | Авторські originals не перевірено заново | Збережені exact archive identity/hash; перед asset edit відкрити потрібний мінімальний original/reсipe і звірити lineage; не називати всі originals inspected |
| HIST-U10 | Конкретна наступна **продуктова** зміна після перенесення не задана | Не перетворювати відкладений голос/старий maintenance у новий план; після migration context — предметний БРИФ про наступну бажану зміну |

Критичні unknown блокують тільки залежний readiness/action. Вони не заважають завершити нинішню документаційну міграцію й зберегти весь доступний зміст правил. Для завершення міграції не потрібно вимагати приватний архів чатів, Google-пароль, secrets або нову runtime mutation.

Ідентифікатори HIST-U01…HIST-U10 у цьому синтезі описують історичні прогалини. Єдиний чинний реєстр наступних дій — [U01–U12](open-questions.md); номер HIST-Uxx не є відповідником Uxx.

<a id="scope-supersession"></a>

## Збережені твердження та адресне supersession

Нижче збережено весь зміст 57 вихідних claims і 5 пізніших scope-recovery claims. Це довготривалі decisions/proof limits, а не копії execution reports. Поля status/next_action у provenance описують історичну редакцію джерела. Чинні дії визначає current-scope; source/WIP/live/jobs/acceptance — checkpoint і open-questions. `INTENT-01/02/04`, колишні local/live unknown і `BACKLOG-01/05` мають такі новіші межі: тепер дозволені локальне docs apply та independent review; 5+10 відновлено; local/source/Render metadata відомі; production і skill mutations заборонені. Повний продукт і людське приймання автоматично не зараховані.

<a id="claim-INTENT-01"></a>

### INTENT-01

**kind:** current_authorization

**statement:** Відновити чинного Люмена; підготувати повний самодостатній пакет перенесення для Codex через ChatBot Atelier; стару навичку тільки прочитати як джерело правил.

**source_refs:** current_user_request; LUMEN_TO_CHATBOT_ATELIER_UA(1).md

**status:** accepted_intent

**proof_limits:** Підготовка не означає застосований patch чи виконаний retirement.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-INTENT-02"></a>

### INTENT-02

**kind:** current_stop

**statement:** Зараз нічого не видаляти й не змінювати у production; прикріплений guide додатково обмежує продуктове виконання read-only intake.

**source_refs:** current_user_request; LUMEN_TO_CHATBOT_ATELIER_UA(1).md#1

**status:** accepted_intent

**proof_limits:** Старі permissions у цитованих prompts не скасовують поточний stop.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-INTENT-03"></a>

### INTENT-03

**kind:** architecture_governance

**statement:** Єдиний інтегратор chatbot-atelier-director; контекст Люмена у звичайних документах самого проєкту; без нового Lumen wrapper/другого бота.

**source_refs:** LUMEN_TO_CHATBOT_ATELIER_UA(1).md#2

**status:** accepted_intent

**proof_limits:**

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-INTENT-04"></a>

### INTENT-04

**kind:** preservation

**statement:** Зберегти повний зміст H01–H26/Q01–Q04/J01–J12/24 незмінних companion requirements/E01–E20 та інших унікальних правил, не лише назви чи короткий переказ.

**source_refs:** current_user_request; LUMEN_TO_CHATBOT_ATELIER_UA(1).md#6

**status:** accepted_intent

**proof_limits:** Повнота збереження й поточний implementation verdict окремі.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-BEHAVIOR-01"></a>

### BEHAVIOR-01

**kind:** accepted_requirement

**statement:** Люмен — живий доречний учасник і корисний помічник; persona/мову/характер зберегти з actual source.

**source_refs:** LUMEN_PROJECT_POLICY_EXPORT_UA.md#Джерело 1; conversation_excerpt:2026-10-29:Продовжити деплой 1.10

**status:** accepted_intent

**proof_limits:** Точний поточний текст persona береться з source, не реконструюється з уривків.

**next_action:** Bind exact prompt snapshot.

**related_ids:** human_value; natural_voice; context_relevance

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-BEHAVIOR-02"></a>

### BEHAVIOR-02

**kind:** accepted_requirement

**statement:** Доречна самостійна реакція на розмови учасників, продовження раніше обговорюваного, питання про Люмена; можливі корисні й дотепні коментарі.

**source_refs:** conversation_excerpt:2026-10-26:Продовження запуску Люмена

**status:** accepted_intent

**proof_limits:** Не обов’язок говорити на кожне повідомлення, не обхід silence/proactive gap/privacy.

**next_action:**

**related_ids:** H14; H15; context_relevance

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-BEHAVIOR-03"></a>

### BEHAVIOR-03

**kind:** accepted_requirement

**statement:** Поведінковий движок як цілісна система; дії, ігри й голосування як частини цілого.

**source_refs:** conversation_excerpt:2026-10-29:Продовжити деплой 1.10

**status:** accepted_intent

**proof_limits:** Не зводити до ремонту двох кнопок; не створювати другого writer/controller.

**next_action:**

**related_ids:** H09; interaction_continuity; multiuser_fairness

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-BEHAVIOR-04"></a>

### BEHAVIOR-04

**kind:** reported_defect

**statement:** Кнопка «детальніше» не дала очікуваного результату; гра не стартувала.

**source_refs:** conversation_excerpt:2026-10-29:Продовжити деплой 1.10

**status:** historical_reported_defect

**proof_limits:** Не відтворено сьогодні; поточне виправлення перевіряється exact source/tests, не на підставі старого скриншоту.

**next_action:** Inspect current details/start paths before treating as current defect.

**related_ids:** H12; interaction_continuity

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-MEDIA-01"></a>

### MEDIA-01

**kind:** accepted_requirement

**statement:** Кожен стікер унікальний, preview пояснює емоцію/смайл, контент креативний/насичений/якісний; гладкість додатковими кадрами за тієї самої тривалості, не прискоренням.

**source_refs:** conversation_excerpt:2026-10-27:Дозвіл на реліз

**status:** accepted_intent

**proof_limits:** Походить із раунду50, якісний принцип збережений; current count не50.

**next_action:**

**related_ids:** H23; character_semantics; temporal_quality

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-MEDIA-02"></a>

### MEDIA-02

**kind:** accepted_requirement

**statement:** Стікери використовуються вибірково для яскравого емоційного акценту, не постійно.

**source_refs:** conversation_excerpt:2026-10-27:Дозвіл на реліз

**status:** accepted_intent

**proof_limits:**

**next_action:**

**related_ids:** natural_voice; media_delivery

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-MEDIA-03"></a>

### MEDIA-03

**kind:** accepted_requirement

**statement:** Розширити спектр емоцій; нагорі поєднати популярність і різноманіття; наведені клавіатури орієнтири, не все підряд.

**source_refs:** conversation_excerpt:2026-10-29:Проблема зі стікерами

**status:** accepted_intent

**proof_limits:** Вихідні screenshot клавіатур у доступних file inputs відсутні; точний accepted order береться з manifest.

**next_action:**

**related_ids:** character_semantics; media_delivery

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-MEDIA-04"></a>

### MEDIA-04

**kind:** accepted_requirement

**statement:** Зберегти всі120 ID/emoji/сцени/погоджений порядок і accepted bytes; змінювати тільки конкретно дефектне, не регенерувати каталог.

**source_refs:** source-intake:current_AGENTS.md; Lumen_1.13.1_motion_repair_state.json#preserved; verification-extracted/deployment-completion.json#preserved

**status:** accepted_intent

**proof_limits:** Current manifest/source binding робиться окремим source intake.

**next_action:**

**related_ids:** H23; version_continuity

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-MEDIA-05"></a>

### MEDIA-05

**kind:** accepted_release_condition

**statement:** Код1.13 та всі120 нових стікерів мали бути доставлені спільно.

**source_refs:** conversation_excerpt:2026-10-30:Продовження тексту; Lumen_1.13_release_state.json#joint_gate

**status:** historical_accepted_condition

**proof_limits:** Цей реліз завершений за historical receipts; не новий наказ видавати pack у migration scope.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-MEDIA-06"></a>

### MEDIA-06

**kind:** reported_defect

**statement:** Майже статичний сплячий персонаж, аномальні руки сюрпризів, рвана анімація привида й рух усієї картинки — приклади ширшого motion дефекту.

**source_refs:** conversation_excerpt:2026-10-31:Продовження релізу

**status:** historical_reported_defect

**proof_limits:** Технічний ремонт і людське приймання окремі; не вичерпний каталог.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-MEDIA-07"></a>

### MEDIA-07

**kind:** historical_receipt

**statement:** Motion repair записує35 repaired/85 unchanged; ранній1.13.0 записує71 repairs.

**source_refs:** Lumen_1.13.1_motion_repair_state.json#stickers; Lumen_1.13_release_state.json#stickers

**status:** historical_receipt

**proof_limits:** Різні проходи; не сумувати в106 distinct repairs без per-ID map.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-MEDIA-08"></a>

### MEDIA-08

**kind:** historical_receipt

**statement:** Approved fingerprint1.13.2 —0c30bf0ae640f49e30caa02b3d7dd7656e43ca330514e1bbfd2783ea8513afe9.

**source_refs:** verification-extracted/deployment-completion.json#ordered_fingerprint

**status:** historical_receipt

**proof_limits:** Current pinned manifest окремо; старий589c… належить1.13.0.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-AUDIO-01"></a>

### AUDIO-01

**kind:** deferred_requirement

**statement:** Новий голос має відповідати мультяшній мишці Люмену, якість має бути доведена; платні сторонні моделі не підключати. Потім власник явно відклав аудіо.

**source_refs:** conversation_excerpt:2026-10-30:Аудит розвитку Люмена; Lumen_1.13.1_motion_repair_state.json#preserved

**status:** deferred_by_owner

**proof_limits:** Не відновлювати як дозвіл запускати voice production.

**next_action:** Wait for explicit future audio-quality scope.

**related_ids:** provider_constraints; audiovisual_fidelity

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-MODEL-01"></a>

### MODEL-01

**kind:** accepted_constraint

**statement:** Чинну GPT-6.1-Sol і voice configuration зберегти; no new paid providers.

**source_refs:** source-intake:current_AGENTS.md; Lumen_1.13.1_motion_repair_state.json#preserved

**status:** accepted_constraint

**proof_limits:** Source preference/model probe не дорівнюють actual runtime configuration сьогодні.

**next_action:**

**related_ids:** provider_constraints

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

**Чинна межа:** no new paid providers тут означає відсутність конкретного дозволу на їх підключення у цьому docs scope. Власник відклав саме нове аудіо; постійного відкладення всіх інших paid integrations з цитат не випливає.

<a id="claim-TEST-01"></a>

### TEST-01

**kind:** accepted_requirement

**statement:** Аудит потрібності1099 тестів; зберегти всі потрібні регресії, не зменшувати лічильник довільно.

**source_refs:** conversation_excerpt:2026-10-31:Перевірка деплою стікерів; Lumen_1.13.1_project_audit.json#keep

**status:** accepted_intent

**proof_limits:** Старий номер у test name не доказ непотрібності.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-TEST-02"></a>

### TEST-02

**kind:** historical_result

**statement:** Первинний audit:73 test files,1099 mapped source cases,0 exact duplicate body groups,0 identical titles,18production deps with usage.

**source_refs:** Lumen_1.13.1_project_audit.json#inventory

**status:** historical_receipt

**proof_limits:** Baseline03a08dce371de480a1776796d2b1c8af3d3450b7; current source окремо.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-TEST-03"></a>

### TEST-03

**kind:** historical_result

**statement:** Maintenance1.13.2 зберіг1099 baseline cases, додав8=1107 functional tests,11 release controls; exact-SHA CI successful.

**source_refs:** verification-extracted/audit-closure.json#tests; verification-extracted/ci-evidence.json

**status:** historical_receipt

**proof_limits:** Не виконано новий suite у цьому підготовчому проході; CI source intake може підтвердити існуючий run.

**next_action:**

**related_ids:** version_continuity

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-RELEASE-01"></a>

### RELEASE-01

**kind:** accepted_constraint

**statement:** Один звичайний commit/git push, exact-SHA mandatory verify, RenderchecksPass, curated runtime package; не повторювати full suite на Render.

**source_refs:** source-intake:current_AGENTS.md; verification-extracted/deployment-completion.json#future_release_flow

**status:** accepted_constraint

**proof_limits:** CLIauth окремо від plugin access; поточний scope не дозволяє release.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-RELEASE-02"></a>

### RELEASE-02

**kind:** accepted_constraint

**statement:** Потрібні джерела/рецепти зберігати перевіреним архівом до вилучення з Git; PNG залишити development references; report/render/frame/sticker-lab не додавати у продуктове Git/runtime.

**source_refs:** source-intake:current_AGENTS.md; verification-extracted/audit-closure.json

**status:** accepted_constraint

**proof_limits:** Review migration package не означає commit усіх historical snapshots.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-RELEASE-03"></a>

### RELEASE-03

**kind:** accepted_constraint

**statement:** WEBM/PNG/manifest звичайними файлами; superseded2444-path/blob/chunk план не відновлювати, не обходити approval rejection.

**source_refs:** source-intake:current_AGENTS.md; Lumen_1.13.1_motion_repair_state.json#resume_rules

**status:** accepted_constraint

**proof_limits:**

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-RELEASE-04"></a>

### RELEASE-04

**kind:** accepted_requirement

**statement:** Вести нормальний versioned changelog.

**source_refs:** conversation_excerpt:2026-10-30:Аудит розвитку Люмена; verification-extracted/audit-closure.json#A14

**status:** accepted_intent

**proof_limits:** Точний чинний CHANGELOG source окремо.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-AUTH-01"></a>

### AUTH-01

**kind:** accepted_constraint

**statement:** Render auth через нормальне device/browser підтвердження; Google пароль не запитувати.

**source_refs:** conversation_excerpt:2026-10-31:Перевірка деплою стікерів; Lumen_1.13.1_motion_repair_state.json#resume_rules

**status:** accepted_constraint

**proof_limits:** Історичний CLIconfig path не credential і не доказ поточної auth.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-AUTH-02"></a>

### AUTH-02

**kind:** accepted_constraint

**statement:** Не змінювати repo visibility, model/voice/secrets/chat data/Render resources без окремого доручення.

**source_refs:** source-intake:current_AGENTS.md

**status:** accepted_constraint

**proof_limits:** Історичний дозвіл public publish стосувався попереднього scope; repo private у current read.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-STATE-01"></a>

### STATE-01

**kind:** historical_completion

**statement:** 1.13.2 A01–A14 та scoped deployment complete на exactSHAa1fd79dc1e369f0f6d50579523524cd196f11d72, treeab005dcd853233648d13f83842385106af8fb47d.

**source_refs:** verification-extracted/deployment-completion.json; verification-extracted/qa-deploy-review.json

**status:** historical_receipt

**proof_limits:** Кінець runtime observation2026-10-31T22:23:55Z; не current live proof2026-11-03.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-STATE-02"></a>

### STATE-02

**kind:** historical_completion

**statement:** Deploydep-dbj6j67b9u1s73d6aeb0live2026-10-31T22:21:33.236324Z; current service locator srv-dbfl0je7bikc73dvg0qg.

**source_refs:** verification-extracted/render-live-evidence.json

**status:** historical_receipt

**proof_limits:** Новий read-only provider readback потрібен для current runtime claim.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-STATE-03"></a>

### STATE-03

**kind:** historical_completion

**statement:** Telegram getStickerSet receipt:120 count/assets/memberships; startupversion1.13.2/groups2; current historic fingerprint0c30….

**source_refs:** verification-extracted/render-live-evidence.json

**status:** historical_receipt

**proof_limits:** Не встановлює current delivery/naturality/human animation acceptance.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-STATE-04"></a>

### STATE-04

**kind:** historical_completion

**statement:** Actual CI/native inventory5783files/123packages/415121852bytes;0sticker PNG. Старий local5821/126 immutable historical.

**source_refs:** verification-extracted/deployment-completion.json; verification-extracted/qa-deploy-review.json#claims_and_limits

**status:** historical_receipt

**proof_limits:** Не було independent SSH filesystem listing; actual finalizer inventories/logs inspected у тодішньому QA.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-STATE-05"></a>

### STATE-05

**kind:** proof_limit

**statement:** Direct/readyHTTP,response status та незалежний SSH directory listing не observed; diagnosticsnot_run inferred, не HTTPreadback.

**source_refs:** verification-extracted/qa-deploy-review.json#claims_and_limits

**status:** historical_known_limit

**proof_limits:** Не писати HTTP200 чи незалежно знятий filesystem inventory.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-STATE-06"></a>

### STATE-06

**kind:** proof_limit

**statement:** Немає fresh human/mobile animation, fresh human chat/naturality acceptance, production long-soak/load certification; rollback не виконували.

**source_refs:** verification-extracted/qa-deploy-review.json#claims_and_limits

**status:** unknown_product_quality

**proof_limits:** Ці межі не відкривають закритий A01–A14 deployment scope.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-BACKLOG-01"></a>

### BACKLOG-01

**kind:** missing_accepted_detail

**statement:** Власник послався на погоджені5великих+10додаткових доробок; повний список у прочитаних historical artifacts/наведених уривках відсутній.

**source_refs:** conversation_excerpt:2026-10-30:Аудит розвитку Люмена

**status:** unknown_detail_of_accepted_scope

**proof_limits:** Не вигадувати назви й не вважати всі15 доведеними за release label.

**next_action:** Inspect exact current release/requirements docs, then retrieve only missing accepted proposal if material.

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-BACKLOG-02"></a>

### BACKLOG-02

**kind:** runtime_unknown

**statement:** Actual pending jobs/locks/uncertain effects/privacyEpoch на сьогодні невідомі.

**source_refs:** LUMEN_TO_CHATBOT_ATELIER_UA(1).md#5

**status:** unknown

**proof_limits:** Historicalpending=[] стосується release work, не актуального runtime DB.

**next_action:** Do not resubmit remote effects; address scoped provider observation when relevant.

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-BACKLOG-03"></a>

### BACKLOG-03

**kind:** environment_unknown

**statement:** Maccheckout/branch/diff/inherited instructions/installed skill roots та managed records не спостережені в цьому Workаналізі.

**source_refs:** LUMEN_TO_CHATBOT_ATELIER_UA(1).md#4

**status:** unknown

**proof_limits:** HistoricalUsers/admin/Developer path не current evidence.

**next_action:** Codex read-only local intake.

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-BACKLOG-04"></a>

### BACKLOG-04

**kind:** migration_status

**statement:** Project-contextapply, незалежний cold intake післяapply і retirement ще не відбулися.

**source_refs:** current_user_request; LUMEN_TO_CHATBOT_ATELIER_UA(1).md#12

**status:** prepared_only

**proof_limits:** Підготовлений пакет не застосований project context.

**next_action:** Review exact patches; authorized future apply then independent cold intake then separate narrow retirement.

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-BACKLOG-05"></a>

### BACKLOG-05

**kind:** artifact_limit

**statement:** Authoring archive292239954bytes exactlocator/hash preserved, але самі1894originals у цьому проході не перечитано/не перевірено заново.

**source_refs:** Lumen_1.13.1_motion_repair_state.json#source_archive

**status:** unknown_current_archive_bytes

**proof_limits:** Runtime не залежить від архіву; для майбутнього assetedit потрібний exact original.

**next_action:** Retrieve minimum actual authoring source only when needed.

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-BACKLOG-06"></a>

### BACKLOG-06

**kind:** product_goal_unknown

**statement:** Конкретна наступна продуктова зміна після migration preparation не задана.

**source_refs:** current_user_request

**status:** unknown

**proof_limits:** Не вигадувати нову фічу й не поновлювати deferred audio.

**next_action:** Offer bounded product brief after migration stage.

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-CONFLICT-01"></a>

### CONFLICT-01

**kind:** supersession

**statement:** Старий RESUME містить prompts із дозволом видаляти оркестратор/оновлювати kits; current request+новий attachedguide обмежують цей прохід підготовкою.

**source_refs:** LUMEN_RESUME_UA.md; LUMEN_TO_CHATBOT_ATELIER_UA(1).md; current_user_request

**status:** resolved_by_current_scope

**proof_limits:** Цитата старого prompt не є новим instruction/approval.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-CONFLICT-02"></a>

### CONFLICT-02

**kind:** supersession

**statement:** Старий export/RESUME generic24reuse узгоджується з новим guide через збереження повних24project records без копіювання generic installable toolkit.

**source_refs:** LUMEN_RESUME_UA.md; LUMEN_TO_CHATBOT_ATELIER_UA(1).md#6

**status:** resolved_for_preparation

**proof_limits:**

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-CONFLICT-03"></a>

### CONFLICT-03

**kind:** supersession

**statement:** Старі pending gates у round/local/sourceQA/CI snapshots закриті окремими deployment-completion/qa-deploy records, originals immutable.

**source_refs:** verification-extracted/index.json

**status:** resolved_historical_scope

**proof_limits:** Не виводити currentlive із historical receipt; не відкривати старий pending без invalidation.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-CONFLICT-04"></a>

### CONFLICT-04

**kind:** scope_limit

**statement:** Wrappers/helpers/24TOMLroles не вважаються видаленими чи встановленими на Mac за export; не масово видалятиlumen-*.

**source_refs:** LUMEN_RESUME_UA.md; LUMEN_TO_CHATBOT_ATELIER_UA(1).md#10

**status:** unknown_local_inventory

**proof_limits:** Наявність підтверджується лише local inventory; retirement окремий exactplan.

**next_action:**

**related_ids:**

**product_implementation_verdict:** unknown_unless_separately_bound_to_current_source_or_receipt

<a id="claim-MAINT-A01"></a>

### MAINT-A01

**kind:** historical_finding_and_closure

**original_finding:** id: A01; priority: high; title: Повний набір тестів повторюється в CI та Render; evidence: GitHub Actions виконує npm test; фактичний Render build також виконує npm test. Успішний CI: 1099/1099, 865718.374733 мс.; recommendation: Залишити один обовʼязковий повний CI для точного SHA. Лише після привʼязки дозволу deploy до зеленого CI цього SHA замінити другий повний прогін на production build і коротку перевірку середовища.; source_files: .github/workflows/verify.yml; render.yaml; package.json; disposition: change_release_workflow

**later_closure:** id: A01; title: Повний набір тестів повторюється в CI та Render; status: implemented_and_verified; resolution: Один обов’язковий verify для exact SHA; фактичний Render checksPass, без повторення повного набору під час build.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json; render-config-evidence.json; render-build-evidence.json; render-live-evidence.json; render-post-start-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A01; verification-extracted/audit-closure.json#findings/A01

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-MAINT-A02"></a>

### MAINT-A02

**kind:** historical_finding_and_closure

**original_finding:** id: A02; priority: high; title: Native Render build залишає тестові матеріали у збірці; evidence: tsconfig включає src і test. npm test створює dist/test (~1448 KiB локально). npm prune --omit=dev прибирає devDependencies, але не dist/test, вихідні test, scripts чи docs. Це висновок із фактичної конфігурації та локального відтворення, не інвентаризація через remote shell.; recommendation: Розділити компіляцію тестів і production. Пакувати лише виконувані модулі, production-залежності, потрібні runtime SQL і ресурси. Зберегти src/schema.sql: його читає DB під час запуску. Не видаляти потрібні файлові залежності jszip/docx-preview.; source_files: tsconfig.json; package.json; render.yaml; src/db.ts; src/browser.ts; disposition: exclude_from_runtime

**later_closure:** id: A02; title: Native Render build залишає тестові матеріали у збірці; status: implemented_and_verified; resolution: Production/test компілюються окремо; самодостатній .release та фактично виконаний guarded finalizer очищує build checkout.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json; render-config-evidence.json; render-build-evidence.json; render-live-evidence.json; render-post-start-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A02; verification-extracted/audit-closure.json#findings/A02

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-MAINT-A03"></a>

### MAINT-A03

**kind:** historical_finding_and_closure

**original_finding:** id: A03; priority: high; title: 120 PNG-превʼю не використовуються ботом під час роботи; evidence: 120 PNG: 23864407 байтів. Посилання preview читають тести; runtime sticker-pack завантажує WEBM. Docker теж копіює всю assets. PNG є затвердженим матеріалом перевірки, а не невідомими пробними файлами.; recommendation: Зберегти PNG як матеріал розробки/затвердження, виключити їх із production artifact. Якщо переносити за межі GitHub, спочатку визначити доступний CI еталон і зберегти перевірки хешів; не ламати тести простим видаленням.; source_files: src/sticker-pack.ts; test/sticker-release.test.ts; test/sticker-upgrade.test.ts; Dockerfile; disposition: keep_for_development_exclude_from_runtime

**later_closure:** id: A03; title: 120 PNG-превʼю не використовуються ботом під час роботи; status: implemented_and_verified; resolution: У Git лишено 120 PNG-еталонів розробки; у production artifact sticker PNG немає.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json; render-config-evidence.json; render-build-evidence.json; render-live-evidence.json; render-post-start-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A03; verification-extracted/audit-closure.json#findings/A03

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-MAINT-A04"></a>

### MAINT-A04

**kind:** historical_finding_and_closure

**original_finding:** id: A04; priority: medium; title: Manifest містить виробничу історію, яку runtime не читає; evidence: assets/stickers/manifest.json: 744242 байти. repair_provenance/source_provenance/previous_source_provenance містять відомості про рецепти й шляхи вже архівованого sticker-lab. Runtime projection полів id,emoji,telegram_emoji,label,description,file,bytes,sha256: 56133 байти.; recommendation: Винести історію авторства в архів/метадані розробки. Для production формувати компактний manifest, зберігаючи опис, порядок, ID, emoji, байти, хеші та чинний approved fingerprint.; source_files: assets/stickers/manifest.json; src/sticker-pack.ts; src/joint-startup.ts; disposition: split_authoring_metadata

**later_closure:** id: A04; title: Manifest містить виробничу історію, яку runtime не читає; status: implemented_and_verified; resolution: Історію manifest збережено окремо; Git manifest скорочено, runtime manifest додатково очищено зі збереженням 120 ID/порядку/хешів.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json; render-config-evidence.json; render-build-evidence.json; render-live-evidence.json; render-post-start-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A04; verification-extracted/audit-closure.json#findings/A04

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-MAINT-A05"></a>

### MAINT-A05

**kind:** historical_finding_and_closure

**original_finding:** id: A05; priority: medium; title: Широка жива діагностика повторюється після кожної зміни RELEASE; evidence: checks-${RELEASE}-2.json привʼязує кеш до номера версії. main запускає 11 перевірок, включно з реальними модельними, web, Chromium і document probes. Журнал 1.13.1 показує приблизно 169 секунд між першою та останньою перевіркою. Вони йдуть у фоні після lumen_started, не блокують готовність на цей час.; recommendation: Для asset-only patch залишити перевірку конфігурації, DB/lease, затверджених ресурсів і фактичного Telegram-набору. Широкі model/provider/document probes запускати за змінами відповідних функцій або явною діагностичною командою. Не створювати автоматизацію без окремого запиту.; source_files: src/main.ts:98; src/runtime-checks.ts:11; src/router.ts; disposition: separate_readiness_from_extended_diagnostics

**later_closure:** id: A05; title: Широка жива діагностика повторюється після кожної зміни RELEASE; status: implemented_and_verified; resolution: Широка діагностика opt-in в єдиному worker; поточний start не має --diagnostics. Обов’язкові DB/lease/Telegram/resource checks збережено.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json; render-config-evidence.json; render-build-evidence.json; render-live-evidence.json; render-post-start-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A05; verification-extracted/audit-closure.json#findings/A05

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-MAINT-A06"></a>

### MAINT-A06

**kind:** historical_finding_and_closure

**original_finding:** id: A06; priority: medium; title: Є слабкі та надмірно привʼязані до релізу assertions; evidence: sticker-palette.test.ts:28 перевіряє різноманітність release.first20_categories в еталонному JSON, а не фактичних assets. Нині вони збігаються, але майбутня зміна actual category не зламає assertion. release-130.test.ts:39 привʼязаний до слів «диханням» і «120 настроїв».; recommendation: Порівнювати фактичні категорії з затвердженим еталоном і перевіряти реальну різноманітність. Відокремити перевірку тексту конкретного оголошення від постійних контрактів dedup, confirmed delivery та version. Решту сценаріїв цих файлів зберегти.; source_files: test/sticker-palette.test.ts:28; test/release-130.test.ts:36; disposition: repair_assertions_not_delete_suites

**later_closure:** id: A06; title: Є слабкі та надмірно привʼязані до релізу assertions; status: implemented_and_verified; resolution: Перевіряються фактичні категорії та сталі version/dedup/confirmed delivery контракти замість історичної фрази 1.13.1.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A06; verification-extracted/audit-closure.json#findings/A06

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-MAINT-A07"></a>

### MAINT-A07

**kind:** historical_finding_and_closure

**original_finding:** id: A07; priority: low; title: Залишилась дубльована standalone SQL-схема для тесту; evidence: src/media-inspections-schema.sql (2371 байт) є точним підрядком src/schema.sql. TestDB.init вже створює обидві таблиці до додаткового exec у media-coverage-112.test.ts. Це також перевірено окремим локальним запитом без production DB.; recommendation: Прибрати дубльований setup і окремий файл після цільового прогону media-coverage; самі тести кешування/приватності зберегти.; source_files: src/media-inspections-schema.sql; src/schema.sql:425; test/media-coverage-112.test.ts:29; disposition: remove_redundant_setup_after_targeted_validation

**later_closure:** id: A07; title: Залишилась дубльована standalone SQL-схема для тесту; status: implemented_and_verified; resolution: Дубль standalone media inspection SQL і зайвий setup вилучено; функціональне покриття збережено.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A07; verification-extracted/audit-closure.json#findings/A07

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-MAINT-A08"></a>

### MAINT-A08

**kind:** historical_finding_and_closure

**original_finding:** id: A08; priority: medium; title: Два ручні діагностичні інструменти пишуть у видалену папку; evidence: recall-controls.mjs і resource-pilot.py пишуть у docs/qa-1-12 без mkdir. Виконання recall-controls відтворило ENOENT для docs/qa-1-12/recall-controls.json. resource-pilot оцінено статично; повторний ресурсний benchmark не запускався.; recommendation: Писати результати у власний тимчасовий каталог або явно заданий output, створювати його і прибирати по завершенні. Корисні інструменти лишити в tools/diagnostics, історичні експерименти архівувати. Не включати їх у production artifact.; source_files: scripts/recall-controls.mjs:17; scripts/resource-pilot.py:24; scripts/calendar-sandbox.mjs:37; disposition: repair_or_archive_diagnostics

**later_closure:** id: A08; title: Два ручні діагностичні інструменти пишуть у видалену папку; status: implemented_and_verified; resolution: Ручні діагностики перенесено до tools/diagnostics, output обмежено явними зовнішніми/власними тимчасовими каталогами, cleanup перевірено.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A08; verification-extracted/audit-closure.json#findings/A08

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-MAINT-A09"></a>

### MAINT-A09

**kind:** historical_finding_and_closure

**original_finding:** id: A09; priority: low; title: Тестовий harness не прибирає більшість своїх тимчасових runtimeDir; evidence: harness створює mkdtempSync(lumen-test-...), а TestDB.close закриває activity/БД без видалення цих каталогів. Лише окремі caller-тести прибирають їх самі. У scratch знайдено 954 таких каталоги (~4.25 MB файлів); це не витік даних production.; recommendation: Закріпити володіння створеними тимчасовими каталогами за fixture, прибирати тільки власні каталоги після тестів. Не видаляти сторонні /tmp каталоги автоматично.; source_files: test/helpers.ts:19; test/helpers.ts:44; disposition: fix_fixture_cleanup

**later_closure:** id: A09; title: Тестовий harness не прибирає більшість своїх тимчасових runtimeDir; status: implemented_and_verified; resolution: Harness володіє й прибирає власні runtimeDir; caller-owned каталоги збережено й перевірено.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A09; verification-extracted/audit-closure.json#findings/A09

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-MAINT-A10"></a>

### MAINT-A10

**kind:** historical_finding_and_closure

**original_finding:** id: A10; priority: low; title: Чотири старі медіафайли не мають поточного споживача; evidence: lumen-avatar.jpg, lumen-happy.gif, lumen-thinking.gif, lumen-waving.gif: разом 1364188 байтів. Перевірені статичні й динамічні шляхи: profile читає MP4; delivery читає MP4; setup дозволяє idle.gif. idle.gif не входить до цієї четвірки.; recommendation: Архівувати чотири файли й прибрати з робочого дерева після перевірки відсутності зовнішнього ручного використання. Не зачіпати актуальні MP4, lumen.png, шрифт/ліцензію чи setup assets.; source_files: assets/lumen-avatar.jpg; assets/lumen-happy.gif; assets/lumen-thinking.gif; assets/lumen-waving.gif; src/profile.ts; src/delivery.ts; src/setup.ts; disposition: archive_candidates

**later_closure:** id: A10; title: Чотири старі медіафайли не мають поточного споживача; status: implemented_and_verified; resolution: Чотири невикористані медіафайли збережено у перевіреному архіві та вилучено з Git.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A10; verification-extracted/audit-closure.json#findings/A10

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-MAINT-A11"></a>

### MAINT-A11

**kind:** historical_finding_and_closure

**original_finding:** id: A11; priority: medium; title: Альтернативний Compose deployment має несумісний бюджет /tmp; evidence: compose.yaml:35 виділяє /tmp:size=32m. chromium-runtime розпаковує Chromium у /tmp/lumen-chromium-153. Сам виконуваний binary у локальному середовищі має 209022176 байтів, понад 32 MiB, ще без бібліотек. Docker build/запуск у цьому аудиті не виконувався. Поточний Render є native Node і цим обмеженням не зачеплений.; recommendation: Або підтримати Compose реальним бюджетом тимчасового диска/памʼяті та перевіркою Chromium, або явно позначити цей спосіб як непідтримуваний. Не переводити production на Docker у межах чистки.; source_files: compose.yaml:35; src/chromium-runtime.ts:15; Dockerfile; disposition: repair_or_deprecate_alternative_deploy

**later_closure:** id: A11; title: Альтернативний Compose deployment має несумісний бюджет /tmp; status: implemented_and_verified; resolution: Compose має актуальний amd64/tmpfs бюджет; Docker містить потрібні Chromium-бібліотеки й пройшов restricted non-root/read-only smoke. Production лишився native Node.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A11; verification-extracted/audit-closure.json#findings/A11

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-MAINT-A12"></a>

### MAINT-A12

**kind:** historical_finding_and_closure

**original_finding:** id: A12; priority: low; title: Ручний model benchmark не є поточним критерієм релізу; evidence: benchmark-models.mjs виконує 33 реальні запити трьом моделям і очікує старі форми actions remember/remind/start_game. Це явний ручний скрипт, не автоматична частина npm test або deploy. Дата fixture сама по собі не означає застарілість.; recommendation: Зберігати як opt-in дослідження; перед застосуванням актуалізувати очікувані результати під чинний інструментальний контракт. Не запускати для звичайного sticker patch і не використовувати як доказ поточної якості всіх функцій.; source_files: scripts/benchmark-models.mjs; disposition: research_only

**later_closure:** id: A12; title: Ручний model benchmark не є поточним критерієм релізу; status: implemented_and_verified; resolution: Benchmark явно opt-in (--run/--runtime-dir/--model); результати позначено heuristic, не релізним доказом. Для цього випуску не запускався.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A12; verification-extracted/audit-closure.json#findings/A12

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-MAINT-A13"></a>

### MAINT-A13

**kind:** historical_finding_and_closure

**original_finding:** id: A13; priority: low; title: 55 невикористаних імпортів/локальних змінних/параметрів; evidence: Додатковий tsc --noEmit --noUnusedLocals --noUnusedParameters дав 55 diagnostics: 24 у src, 31 у test. Це додатковий аудитний режим, не падіння штатного npm test.; recommendation: Прибрати невикористані імпорти/локальні змінні. Параметри API змінювати лише з урахуванням сумісності. Не видаляти цілі модулі за цими попередженнями.; source_files: src/attention.ts; src/calendar-sync.ts; src/engine.ts; src/router.ts; test; disposition: minor_code_cleanup

**later_closure:** id: A13; title: 55 невикористаних імпортів/локальних змінних/параметрів; status: implemented_and_verified; resolution: 55 невикористаних ідентифікаторів виправлено, noUnusedLocals/noUnusedParameters увімкнено в обох TypeScript builds.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A13; verification-extracted/audit-closure.json#findings/A13

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-MAINT-A14"></a>

### MAINT-A14

**kind:** historical_finding_and_closure

**original_finding:** id: A14; priority: low; title: Поточна інструкція змішана з історичними описами; evidence: README описує анімацію «без окремого ригу лап, рота чи очей» та оголошення 1.10. OPERATIONS заголовок 1.5 при описі чинного Render. render.yaml лишає onboarding-default requireVerified=false, тоді як поточна інсталяція використовує true. Історичні release notes самі по собі не є сміттям.; recommendation: Виділити одну актуальну інструкцію запуску/релізу, історію лишити окремо. Прибрати двозначні поточні твердження та пояснити bootstrap-default. Не змінювати реальні Render secrets або ресурси.; source_files: README.md:92; README.md:94; docs/OPERATIONS.md; render.yaml; docs/RELEASING.md; disposition: clarify_current_operations

**later_closure:** id: A14; title: Поточна інструкція змішана з історичними описами; status: implemented_and_verified; resolution: README/OPERATIONS/RELEASING/AGENTS/changelog узгоджено з 1.13.2; приватність, bootstrap та rollback пояснено.; evidence_refs: qa-review.json; local-verification.json; ci-evidence.json; render-config-evidence.json; render-build-evidence.json; render-live-evidence.json; render-post-start-evidence.json

**source_refs:** Lumen_1.13.1_project_audit.json#findings/A14; verification-extracted/audit-closure.json#findings/A14

**status:** historically_closed

**proof_limits:** Closure is scoped to exact1.13.2source and2026-10-31receipts; current drift/invalidated dependencies require addressed recheck, not blanket rerun.

<a id="claim-SCOPE-RECOVERY-01"></a>

### SCOPE-RECOVERY-01

**kind:** source_content_recovered

**statement:** Exact content of the five major F1–F5 and ten U1–U10 items recovered from historical implementation plan and original R2 PDF; all 43 full plan objects preserved.

**status:** confirmed_source_content

**source_refs:** selected/docs/IMPLEMENTATION_1_12_PLAN.json; original-pdfs/Lumen_1_11_Full_Audit_UA_2026-10-30.pdf

**proof_limits:** Content recovery and aggregate owner acceptance do not prove current implementation or all human acceptance.

<a id="claim-SCOPE-RECOVERY-02"></a>

### SCOPE-RECOVERY-02

**kind:** accepted_intent_binding

**statement:** Available owner excerpt explicitly requests all previously agreed five major features, ten improvements and added round, excluding audio.

**status:** accepted_aggregate_intent_with_historical_source_binding

**source_refs:** history/conversation-evidence.md#2026-10-30; selected/docs/IMPLEMENTATION_1_12_CHECKPOINT_2026_10_30.json#user_scope

**proof_limits:** No invented message ID; full private original conversation unavailable. Original R2 recommendation to choose one cycle was a proposal, later owner request enlarged implementation scope.

<a id="claim-SCOPE-RECOVERY-03"></a>

### SCOPE-RECOVERY-03

**kind:** historical_qualification

**statement:** Plan has all 43 records marked implemented_in_deployed_code for 1.12, while overall qualification remains unqualified with five external acceptance gaps.

**status:** historical_claim_preserved

**source_refs:** selected/docs/IMPLEMENTATION_1_12_PLAN.json; selected/docs/QA_1_12.json; selected/docs/RELEASE_1_12_DELIVERY_2026_10_30.json

**proof_limits:** Do not promote original status to current verified/live/human accepted. Current source bindings and evidence carry-forward required.

<a id="claim-SCOPE-RECOVERY-04"></a>

### SCOPE-RECOVERY-04

**kind:** artifact_observation

**statement:** Authoring archive exact bytes now present and whole-file SHA matches recorded value; 1896 ZIP entries include 1894 payload records plus README and MANIFEST.

**status:** confirmed_local_archive_identity

**source_refs:** zip-inventory.json; selected/MANIFEST.json; selected-integrity.json

**proof_limits:** Selected small text files only read and exact hash verified; no full image/frame/render/naturalness review.

<a id="claim-SCOPE-RECOVERY-05"></a>

### SCOPE-RECOVERY-05

**kind:** deferred_requirement

**statement:** R3.1 original audio research and voice profile proposals preserved, but subsequent explicit owner audio deferral remains current. M01 existing-voice bookkeeping fix and non-audio scope survive.

**status:** deferred_by_owner

**source_refs:** original-pdfs/Lumen_1_11_Media_Extension_R3_UA_2026-10-30.pdf; selected/docs/IMPLEMENTATION_1_12_PLAN.json#audio_decision

**proof_limits:** No new voice renderer/TTS/STT/provider activation permitted by preservation.

## Походження і точні hashes джерел

Поля path/original_collection_path/portable_package_path нижче збережені як історичні identities джерел. Це не перелік required local files: former owner-evidence перенесено до цього документа, claims/addenda та execution receipts лишаються в ZIP матеріалів. Актуальні project paths задані Markdown-посиланнями й transformation register.

Вихідний `Lumen_ChatBot_Atelier_Migration_2026-11-03.zip`, SHA-256 `99f116274ddc9ab3fe17a1ab313d3951f3dce363a735d7250ea1ad12db8b35c8`, збережено поза Git. Шлях на цьому Mac: `/Users/admin/Downloads/Lumen_ChatBot_Atelier_Migration_2026-11-03.zip`; це locator для поточного середовища, а не обіцянка доступу іншому виконавцю. Для asset repair потрібні відповідні originals/recipes; migration ZIP містить вибірку authoring evidence і не замінює перевірку всього masters archive.

- **Lumen_1.13.1_motion_repair_state.json**: path: external_evidence:Lumen_1.13.1_motion_repair_state.json; bytes: 14758; sha256: 309bcc14cae83c53a3de272f69590fd0667c3694626a6a30ab8910283d9219e0; class: historical_source; original_collection_path: source-snapshots/library/Family Bot/Lumen_1.13.1_motion_repair_state.json; library_file_id: libfile_c6700245eeb881918909b89086c0e9f8; url: https://chatgpt.com/library?file_id=libfile_c6700245eeb881918909b89086c0e9f8&account_id=personal; portable_package_path: evidence/library-sources/Lumen_1.13.1_motion_repair_state.json
- **Lumen_1.13.1_project_audit.json**: path: external_evidence:Lumen_1.13.1_project_audit.json; bytes: 54896; sha256: 5e2aa017fc8b63c2e029879b116e10b307a48d5e80b437cac95952297d5be4e7; class: historical_source; original_collection_path: source-snapshots/library/Family Bot/Lumen_1.13.1_project_audit.json; library_file_id: libfile_c749744631b48191b2a46ed282a58792; url: https://chatgpt.com/library?file_id=libfile_c749744631b48191b2a46ed282a58792&account_id=personal; portable_package_path: evidence/library-sources/Lumen_1.13.1_project_audit.json
- **Lumen_1.13.2_retired_materials.zip**: path: external_evidence:Lumen_1.13.2_retired_materials.zip; bytes: 1506370; sha256: 7a5da5b88fb95792a19afae122a02173c945baec246cbd9834609af92ad2e85c; class: historical_source; original_collection_path: source-snapshots/library/Family Bot/Lumen_1.13.2_retired_materials.zip; library_file_id: libfile_5cb705ea45848191b89cdef4e5bce93e; url: https://chatgpt.com/library?file_id=libfile_5cb705ea45848191b89cdef4e5bce93e&account_id=personal; portable_package_path: evidence/library-sources/Lumen_1.13.2_retired_materials.zip
- **Lumen_1.13_release_state.json**: path: external_evidence:Lumen_1.13_release_state.json; bytes: 225132; sha256: 2ee12bb5cfefd9dac28ff6ad9d11e07390641b1afb6e389ec08e61c68d74fa78; class: historical_source; original_collection_path: source-snapshots/library/Family Bot/Lumen_1.13_release_state.json; library_file_id: libfile_cc25c56a6b2c8191abc38d7d7a1e88eb; url: https://chatgpt.com/library?file_id=libfile_cc25c56a6b2c8191abc38d7d7a1e88eb&account_id=personal; portable_package_path: evidence/library-sources/Lumen_1.13_release_state.json
- **LUMEN_PROJECT_POLICY_EXPORT_UA.md**: path: external_evidence:LUMEN_PROJECT_POLICY_EXPORT_UA.md; bytes: 63263; sha256: 4734a81ff49ecada55a015cf4906e69d4635226b39b0978deec1301938c8cc66; class: historical_source; original_collection_path: source-snapshots/library/LUMEN_PROJECT_POLICY_EXPORT_UA.md; library_file_id: libfile_80a448c37b1c81918fd8b3916ddf25b0; url: https://chatgpt.com/library?file_id=libfile_80a448c37b1c81918fd8b3916ddf25b0&account_id=personal; portable_package_path: evidence/library-sources/LUMEN_PROJECT_POLICY_EXPORT_UA.md
- **LUMEN_RESUME_UA.md**: path: external_evidence:LUMEN_RESUME_UA.md; bytes: 19552; sha256: 9bb2d5746c025234d733fa32bd5057921e023565bb236128880ab9d2bb0178e8; class: historical_source; original_collection_path: source-snapshots/library/LUMEN_RESUME_UA.md; library_file_id: libfile_148a85346c508191bb10ab7257697ff6; url: https://chatgpt.com/library?file_id=libfile_148a85346c508191bb10ab7257697ff6&account_id=personal; portable_package_path: evidence/library-sources/LUMEN_RESUME_UA.md
- **Lumen_1.13.2_verification.zip**: path: external_evidence:Lumen_1.13.2_verification.zip; bytes: 59802; sha256: 048b7781bbeb3550e201d7fe6404626472efbc7d9b59610faa07feee7258ef0c; class: historical_source; original_collection_path: source-snapshots/library/Lumen_1.13.2_verification.zip; library_file_id: libfile_714f8156e41c8191a305918b664d1521; url: https://chatgpt.com/library?file_id=libfile_714f8156e41c8191a305918b664d1521&account_id=personal; portable_package_path: evidence/library-sources/Lumen_1.13.2_verification.zip
- **LUMEN_TO_CHATBOT_ATELIER_UA(1).md**: path: external_evidence:LUMEN_TO_CHATBOT_ATELIER_UA(1).md; bytes: 46071; sha256: 0fc49eaa8562aed3d6129ef78d7a01c654125f8a43ac71b067a9bc11d75ce232; class: current_user_attached_guide; original_collection_path: history/request-guide-original.md; library_file_id: libfile_11b175d683bc819180466773cc993f27; url: https://chatgpt.com/library?file_id=libfile_11b175d683bc819180466773cc993f27&account_id=personal; portable_package_path: evidence/input-instruction.md
- **conversation-evidence.md**: path: docs/lumen/requirements/owner-evidence.md; bytes: 13390; sha256: 569ed9a89ec6ae32c4d3b15acc366258f768293891ad236c9f7c65a2ec06f653; class: available_conversation_excerpts_preserved_not_new_private_chat_retrieval; original_collection_path: history/conversation-evidence.md; portable_package_path: evidence/history/conversation-evidence.md

Пізніші originals/source files:

- path: migration/history/authoring-intake/original-pdfs/Lumen_1_11_Full_Audit_UA_2026-10-30.pdf; bytes: 461046; sha256: 98640b7a90c063a35bca457541f988d37763960b6b1c0d0f353f68e46d356cde; format: exact_source_pdf
- path: migration/history/authoring-intake/original-pdfs/Lumen_1_11_Full_Audit_UA_2026-10-30.txt; bytes: 117857; sha256: d656fa20c1ff8bb87fbf36128f6ce85fcd457e05bd14a78cf64f631af23ec7b3; format: full_pdftotext_layout_extraction
- path: migration/history/authoring-intake/original-pdfs/Lumen_1_11_Media_Extension_R3_UA_2026-10-30.pdf; bytes: 287368; sha256: 86ad6ba568045dfb36db7da3c80ef58a6f022399f173327e1301c71546236331; format: exact_source_pdf
- path: migration/history/authoring-intake/original-pdfs/Lumen_1_11_Media_Extension_R3_UA_2026-10-30.txt; bytes: 52995; sha256: 49b08fe63c6ae9490bca0edf2a84f79004164396193821b9062f06a7a1d120de; format: full_pdftotext_layout_extraction

Exact hashes пакетних джерел цього об’єднання:

- `project-draft/docs/lumen/requirements/accepted-decisions.md`: `f41759d0ca2bc5ae3d00e137c7fc94261acf4477670e9ed6760d1dd67a7f93d9`
- `project-draft/docs/lumen/requirements/accepted-development-scope.json`: `50bb77c399f411bf5c1afce97b5343e5218848dff6848b67cb4a907f7704f0d7`
- `project-draft/docs/lumen/requirements/requirements-scope-addendum.md`: `4fb506ad97e9cbd7c012b2ecf304c7b04ab788bd42e179c14efa5e9cbd58b5ea`
- `project-draft/docs/lumen/requirements/companion-24.json`: `9397b795c713ecb8a57adb55a6b4b40966b7a2ceffb08e885fb00ebe3699b6bd`
- `project-draft/docs/lumen/requirements/owner-evidence.md`: `569ed9a89ec6ae32c4d3b15acc366258f768293891ad236c9f7c65a2ec06f653`
- `project-draft/docs/lumen/requirements/claims.json`: `a796c0d31bd6114a8d40aafdb7b61c347bb452d1876caf0c7b0f1458fb638136`
- `project-draft/docs/lumen/requirements/claims-addendum.json`: `0002e5ca51918f3dcff84aa081ee85edba333b3d347f4fb832e5fa20673c0c65`

<a id="owner-excerpts"></a>

## Доступні оригінальні висловлювання власника

Це точне збереження релевантних текстових уривків, які були надані поточному агенту в контексті проєкту. Воно не є новим читанням інших приватних чатів, повним архівом чи підтвердженням виконання написаних у них дій. Дати й назви — labels джерела з наданого контексту; platform message IDs невідомі. Позначення «уривок обривається» є редакторським описом межі доступного тексту.

Цитовані команди й дозволи нижче зберігаються як історичні дані. Scope джерела під час підготовки був підготовчим. Чинний scope — локальна документаційна міграція та незалежна перевірка за current-scope, без видалення навичок і production changes.

### 2026-10-26 — «Продовження запуску Люмена»

> Віднови доступ, завантаж останню версію.
>
> А до того ще одну ключову доробку зроби щодо самостійності реакцій Люмена. Він має не тільки відгукуввтись, коли до нього звертаються, але і коли учасники чата щось обсуждають що раніше обсуждалось або запитували в Люмена. Або взагалі його самого, або інший контекст, коли його відповідь буде доречна, або актуальна.
>
> Тобто якщо хтось наприклад не тіллки для користі отримає коментар від Люмена. А і якийсь забавний може жарт, якщо наприклад

Доступний уривок обривається на цьому місці. Продовження не реконструювалося.

### 2026-10-27 — «Дозвіл на реліз»

> Так, це вже краще підходить. Роби всі 50. І ще окрема вимога, щоб жоден з них не повторювався. Ну тобто був унікальним, відповідав якомусь смайлу. Чітко можна було б по ньому зрозуміти з превью про що воно. І взагалом всі стікери виглядали як супер креативний контент, якісний, насичений і в супер якості зроблений. Ще можеш подумати, якщо можна то трохи плавність анімації зробити, бо зараз круто, але троооошечки наче кадрів не вистачає йому. Тобто не прискорювати дії, а саме додаткової плавності в сенсі більше кадрів додати для тої ж дії.
>
> Зроби всі і задеплой нову версію. А Люмена навчи користуватись їми. Не постійно, а виключно коли він захоче підкреслити якось дуже ярко емоційність

### 2026-10-29 — «Проблема зі стікерами»

До повідомлення були наведені зображення. Самі зображення не входять до поточного attachment; не відтворювалися з пам'яті.

> Те, як зараз зроблені стікери окей.
>
> Але сама підбірка на смайликах, яких воно базується трохи недостатня.
>
> Я навів клавіатуру, а твоя задача доробити смайлики щоб були і з цього набору також. І максимально креативно різноманітні щоб.
>
> Бо зараз ті шо є, вони гарні, і можеш залишити, але вони дуже односторонні емоції показують. І пересортуй потім, щоб наверху були і топові і водночас різноманітні.
>
> Повністю підготуй новий стикер пак, задеплой зроби реліз і онови потім посилання, щоб бути впевненим, що

Доступний перший уривок обривається. Наступне окреме повідомлення:

> І плюс цей рядок, він не вліз. Не все підряд, інопланетян може і не треба, але емоції такого порядка також мають бути присутні

### 2026-10-29 — «Продовжити деплой 1.10»

> Зараз використай навичку Іскра. Щоб провести максимально глибоко аудит і розробити абсолютно новий підхід стосовно того, як Люмен спілкується, а особливо як пропонує якісь дії іншим користувачам.
>
> Бо я спочатку помітив декілька зламаних сценаріїв: не нажималась кнопка "детальніше" коли він запропонував коротшу версію дослідження, а потім при веденні гри, не зміг її стартувати і сказав про помилку на скріншоті.
>
> І тут мене цікавить навіть не точкові виправлення цих сценаріїв.
>
> Скільки створення движка його поведінки як таковой, а різні дії, ігри, голосування, це все як його складова.
>
> Я хочу, щоб він не абстрка

Доступний уривок обривається. Історичний виклик «Іскра» не є поточним маршрутом. Подальші окремі повідомлення:

> А можеш більш людською мовою що саме і як конкретно пропонується змінити для Люмена, на прикладах

> Роби і задеплой

### 2026-10-30 — «Аудит розвитку Люмена»

> Продовжити що почав, одне зауваження, аудіо треба подавати голосом відповідним до мультяшгого персонажа Люмена мишки. Дослідити найкращі якісні можливості це робити, не в теорії, а кращі з існуючих варіантів. Не підключаючи платні сторонні для цього моделі

Наступне рішення про відкладення аудіо:

> Давай зроби абсолютно все з цього раунду і попередніх збережень. Окрім аудіо, це ше під питанням якості, це відкладемо на потім, а зараз все роби з попередніх узгодження щодо 5 великих і 10 додаткових, плюс ці, але поки без аудіо

У тодішньому наведеному уривку повного переліку «5+10» не було; це історична межа excerpt. Пізніше точний склад відновлено з original plan/PDF і збережено в accepted-development-scope.json. Назви не виводилися з числа або release label.

Пізніші повідомлення:

> Дозволяю, задеплой

> Дозволяю, і ще перевір, що у репетиторії там ведеться нормальний лог змін по версіям

### 2026-10-30 — «Продовження тексту»

> Продовжуй і я даю всі дозволи, що не проходили, на деплой і розшортання

> Продовжуй розгортати, всі дозволи даю

> Дозволяю опублікувати підготовлений код, технічні файли й усі стікери Люмена 1.13 у публічному GitHub-репозиторії alex-hohaizel/lumen-family-agent, включно з assets/stickers та sticker-lab/production-v5. Дозволяю оновити набір Telegram і розгорнути версію на Render.

> Продовжуй, але щоб точно були доставлені водночас і всі 120 нових стикерів

Це історичні release дозволи. Поточні repo visibility й Git packaging rules беруться з чинних source/AGENTS. Поточний запит не дозволяє нову публікацію/деплой або зміну visibility.

### 2026-10-31 — «Продовження релізу»

> В мене залишились питання про деякі стикери. Одні з них, як наприклад коли спить, то взагалі майже нема анімацій, хоч і стикер красивий. Деякі типу де чортик витягає з коробки сюрпризи якісь аномально руки. Деякі типу де привід постирадло- рвані примітивні анімації. Я не хочу наводити всі приклади, але їх достатньо, десь скаче картинка анімації вниз-вверх просто вся анімація переміщується без

Доступний уривок обривається. П'ять згаданих screenshots не входять до поточних file inputs. Приймальні вимоги motion відновлені з тексту й фактичних rule/media sources; людське приймання не вигадане.

### 2026-10-31 — «Перевірка деплою стікерів»

> В мене ще питання чи потрібні всі 1099 тестів, або щось там теж як тестове чисто з розробки якоїсь версії, або може застаріле неактуальне тощо. Якщо всі потрібні окей. Але провед

Доступний перший уривок обривається. Окреме подальше повідомлення:

> Зроби це все

Auth уточнення:

> Який блять пароль, через звичайне посилання підтвердити на гуглі зроби

### 2026-10-31 — «Відновити починку стікерів»

> Дозволяю завантажити всі файли релізу Lumen 1.13.1 — WEBM/PNG, код, джерела, рецепти, QA-файли та їх частини — до приватного GitHub-репозиторію alex-hohaizel/lumen-family-agent і задеплоїти на чинний Render після успішних тестів.

Це конкретний історичний release scope; він не запускається повторно через підготовку migration package. Пізніший maintenance підтвердив звичайний Git workflow, відокремлені authoring archives та compact runtime.

### 2026-11-03 — історичний запит підготовки пакета

> @chatbot-atelier-director ВІДНОВИ чинного Люмена.
>
> Підготуй його подальший розвиток через ChatBot Atelier
> за прикріпленою інструкцією.
>
> Використай рішення й матеріали цього чату та доступні джерела
> проєкту. Прочитай Lumen Оркестратор лише як джерело правил,
> які потрібно зберегти.
>
> Збери повні чинні вимоги, поведінку, обмеження, прийняті рішення,
> стан роботи та невирішені питання. Відділи підтверджені факти
> від історичних згадок і невідомого.
>
> Підготуй пакет перенесення для Codex, щоб потрібний контекст
> став частиною самого проєкту й не залежав від старої навички.
> Збережи зміст правил повністю, не обмежуйся коротким переказом.
>
> Зараз нічого не видаляй і не змінюй у production.

Прикріплений exact guide збережений окремим файлом `request-guide-original.md`; його hash внесено в claims sources. Текст його prompts є специфікацією підготовки й майбутніх кроків; факти виконання мають окремі receipts.


## 2026-11-08 — погоджений локальний ремонт r1

Пряме рішення власника: «Погоджую r1. Виконай усі три виправлення локально, проведи тести й незалежну перевірку. Збережи всі можливості та незавершену роботу. Без push, deploy і змін production». Спочатку перевірити installed ChatBot Atelier 5.0.0. Exact scenario/approval binding — current_work у єдиному checkpoint; цей запис не створює production дозволу.

- Просте спільне нагадування: одного чіткого прохання достатньо, без poll обох; одне повідомлення на спільну дату/серію. Creator, перевірений явно названий співучасник або admin можуть припинити всю shared серію. Назва людини в предметі нагадування не є manager grant; приватні записи мають окрему owner authority. Історичні actor-owned rows не отримують вигаданих grants.
- Source/callback/delivery тема узгоджені. Офіційний Bot API подає General без окремого thread; історичний 1 автоматично не прирівнюється до 0 і не зливає записи/права. Жива поведінка в інциденті лишається невідомою до дозволеного фактичного спостереження.
- Увага: documented 120 сек, явні custom gaps/off/addressed/quiet збережені; 4 самостійні включення на групу за 10 хв рахуються за підтвердженою доставкою. Pending/attempt не є spoken. Sparse related continuation має bounded оцінку до 10/16-message/2-author порогів, без нових action rights чи обов’язку говорити. Зміна теми/інший адресат/прохання помовчати лишаються обмеженнями. Тимчасове «помовчи» прив’язане до source/topic/revision, не стає permanent profile; наступне пряме звернення не губиться.

Readiness code/integration/device/human і actual deployed/observed показуються окремо. Тести з FakeBrain не доводять мовну якість реальної моделі; structural/AI review не є людським прийманням. Результат поточного r1 може бути завершений локально без вигаданого наступного етапу чи повторного БРИФ.


## 2026-11-09 — завершення поточного WIP і дозволений випуск

Пряме доручення: «Заверши всі роботи поточні і доведи версію до готовності у продакшену і задеплой». Дозвіл охоплює causal currentrepair/resource/media, normalGitpublication, exactCI й existingRenderworker; попередня no-production межа тепер історична для цього випуску. Розширення futurefeaturebacklog, новий голос/модель/тариф, secrets або ручне очищення чатів не доручені.

Версія1.13.3 зберігає shared/private/source/actor/topic права. Сумісність rollback оцінюється за фактичними jobs/audience: additive schema не робить olda1fd79 безпечним для newprivate schedules. Після newingress — compatibleforwardfix. Нові source/test/CI/native/human докази не приписуються історичним records; exactexternaldeliveryreceipt містить фактичне завершення.

## 2026-11-09 — post-release скасування за змістом, r2

Власник прямо вимагає розуміти довільні власні фрази про припинення нагадування, а не набір спеціальних команд. Якщо фактичне правило доступу потребує погодження, бот має пояснити саме його й надати інтерфейс потрібним людям. Згадка про дві згоди при створенні перевіряється за actual operation/lineage; не перетворюється на нову універсальну вимогу двох голосів для простого shared reminder.

Причинна діагностика read-only підтвердила recurring task з іншим owner і окрему planning картку без launch, яка не надавала root management rights. Ремонт не переписує історичні grants. Власне semantic cancellation проходить source/actor/topic/revision/quote/target version fences; public visibility не дорівнює stop right. Неавтор може запросити підтвердження actual owner для публічно доставленої роботи. Автоматично враховується тільки власне перевірене прохання requester; решта голосують за себе в version-bound картці. Private/quoted/forwarded/expired/uncertain/replay лишаються окремими станами. Повний контракт — operations/reminder-cancellation.md.

Поточне виконання — локальний causal repair/tests/QA з окремо дозволеним входом у Render для читання потрібних рядків. Production/CI/deploy/human приймання нового patch не заявляється. Current_work і зовнішній repair_receipt зберігають exact subject, фактичні перевірки, невідоме та весь priorWIP.
