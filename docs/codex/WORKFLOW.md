> Канонічні правила Люмена; продовження веде `chatbot-atelier-director` та потрібні модулі ChatBot Atelier. Поточне доручення й [AGENTS](../../AGENTS.md) визначають права. [Контекст продукту](../lumen/README.md), [checkpoint](../lumen/migration/checkpoint.json). Читання чи встановлення старої Lumen-навички та custom agents не є передумовою. Правило, його реалізація, CI, delivery та human acceptance мають окремі докази.

# Робочий процес: один стандарт для маленьких і великих задач

## 0. Класифікація ризику

- T0: локальна, очевидна, без зовнішніх ефектів; main + targeted tests.
- T1: один сценарій або невеликий модуль; main + domain expert/QA, негативні тести.
- T2: кросдоменна зміна, нова можливість або складний state; ADR + lead + independent QA + інтеграційні тести.
- T3: privacy/consent, DB migration, irreversible effects, Telegram sticker publication, prod runtime/deploy, architecture rewrite; evidence judges, full regression, rollback, human approval.

## 1. Intake і contract

Завжди сформулювати: user value; scope/non-goals; поточна версія й фактичний дефект; істотні невідомі; touched modules; інваріанти; user journeys; failure/cancel/retry/recovery; acceptance; evidence; cost/latency budget; release/rollback.

Уточнювати тільки те, що змінює архітектуру, дозвіл або результат. За достатніх даних — діяти без анкети. Для великої нової функції запропонувати 2–3 варіанти з tradeoffs і визначити обраний.

## 2. План і декомпозиція

Оркестратор призначає один owner на зміну. Product lead перевіряє користь і взаємодію; Tech lead — data/API/state/ownership; QA lead — негативні сценарії; спеціалісти — лише зачеплені домени. Кожен агент повертає структуровані findings, а не довгі стенограми.

Роботи можуть іти паралельно **тільки** якщо немає спільного mutable ownership. Max 3 concurrent. Merge виконує головний агент, а не незалежні зміни в тих самих файлах.

## 3. Реалізація

Вертикальний зріз від вхідного Telegram event до підтвердженого результату або чесного repair. Модульні тести не замінюють end-to-end. Не створювати нові мікросервіси/черги/платні залежності без ADR.

## 4. Верифікація

1. `git diff --check`; production build (`npm run build`) і тестова збірка (`npm run build:test`, вихід `.test-build`).
2. Точкові unit/integration тести + негативні контрприклади.
3. Independent reviewer, який бачить вимоги, diff і тести, але не отримує «усе добре» як підказку.
4. T2/T3: `npm test`; для релізу один повний GitHub job `verify` виконує `npm run verify` на точному SHA; T3: hard invariants, rollback, privacy/consent races, provider uncertainty.
5. Якщо зміни зачіпають природність: frozen contexts, blind comparison і людський тест — **окремо** від механічних тестів.

## 5. Доказовий звіт

Поля: changed files, behavior diff, source version, executed commands/results, limitations, hard gates pass/fail/unknown, review findings, residual risks, CI status, PR link (якщо існує), production state (лише якщо фактично перевірено).

## 6. Випуск

Git-публікація за дозволеним scope: перевірений checkout → commit → один `git push`. Доступ плагіна не підтверджує авторизацію Git CLI. Після публікації — один обов’язковий GitHub `verify` на точному SHA → Render `After CI Checks Pass` → live health/logs → Telegram readback усіх 120 стікерів, порядок і `lumen_started` → один короткий зовнішній запис стану. Не запускати другий ручний deploy після автоматичного. Ручний deploy потребує окремого дозволу та перевірки CI цього SHA. Див. `AGENTS.md`, `docs/RELEASING.md` і `RELEASE_RUNBOOK.md`; локальна задача не дозволяє зовнішні кроки.

## Чинний маршрут і source authority

Єдиний інтегратор — `chatbot-atelier-director`; conversation/knowledge/integrations/media/build/qa/release/operations виконують відповідні предметні етапи. Перенесення не створює другого router/behavior controller чи writer стану. Поточна точна згода успадковується; назва T3 сама не вимагає повторного дозволу на вже доручену дію. Приватність, згода й irreversible effects не стають T0 через малий diff.

Загальну методику, формати, platform adapters, team policy та validators брати з фактично доступного поточного ChatBot Atelier. Проєктні правила тут мають authority з доручення/AGENTS/прийнятих рішень, а не зі старого skill trigger. Загальні defaults не переписують persona, capabilities, accepted assets, дані й незавершену роботу. Один source of truth; exact requirement IDs зберігаються. Unknown не є unchanged чи pass.

Проєктна верхня межа Max 3 concurrent зберігається; actual slots/cost limits можуть її знизити. Числа ролей у ROLE_MAP не є вимогою встановлювати custom agents чи обов’язково запускати кожну роль; один mutable owner зберігається. 12 J-критеріїв не означають 12 викликів. Актуальна [карта ролей](ROLE_MAP.md) задає відповідальності без обов’язкового встановлення старих agents.

Для документаційного scope без зміни runtime достатні content/ID/hash/link/JSON/diff checks і незалежне review. Build/full suite розширюють за фактичним code/shared impact, не автоматично через перенесення тексту. Release gate exact SHA залишається обов’язковим для майбутньої публікації. Підготовка чи встановлення навички не дозволяє deploy.

При продовженні зберігати accepted masters, IDs/emotions/scenes/order, jobs/remote IDs/uncertain effects й completed independent results. Перед повторним submit спочатку reconcile; невідомий outcome не перетворюється на новий dispatch. Не починати нового бота чи повний research поверх локального ремонту.

# Актуальний intake Люмена

## Джерела істини

1. User instruction/authorization і поточні constraints.
2. Current AGENTS.md, source tree/config/test scripts/approved asset masters і фактичний diff.
3. Executed tests/CI на exact source; installed dependencies/tool capabilities.
4. Provider service/deploy/commit/status/logs і Telegram readback/receipts там, де доступно й доручено.
5. Checkpoint/historical docs як підказка до звірки, не live truth.

Історичний repo alex-hohaizel/lumen-family-agent не означає автоматичного доступу, чинної гілки чи права міняти production. Якщо repo недоступне, виконати analysis/контракти/самодостатній handoff, точно позначити code/live unknown. Не просити копіювати secrets або реальні приватні бесіди. Синтетичні fixtures за замовчуванням; використання наданих приватних даних тільки в потрібному дозволеному scope із мінімізацією.

## Знімок проєкту

Вести project identity/repo locator, source branch/SHA/tree/dirty changes, deployed identity/observation age, runtime interfaces, model/tools/version, schemas/jobs/queues, platform entrypoints, capabilities/promises, memory/privacy scopes, media master/fingerprint, test commands/deps, allowed actions/cost/model, user intent/known defects, pending jobs/locks. Unknown не робити unchanged.

Звірити доступні Work connector/API/local executor/Codex native interfaces окремо. Production DB не використовувати для тестів. Незавершений remote upload/build/generation має свій actual job ID; перед повторним submit перевірити status.

## Обсяг і приймання

Описати exact change, baseline reproduction, before/after, affected source/components/requirement IDs, formal states, receiver, acceptance/negative probes, rollback, budget/stop, unresolved. Вимога про живість не виправдовує зняття privacy/consent/action truth; ремонт стікера не прибирає календарі й ігри. Розумне скорочення orchestration не змінює повноту вимог.

Під час продовження звірити checkpoint із current tree/provider; зберегти завершені independent results, відкрити лише реально invalidated dependencies. Не починати весь аудит через нову формулювальну правку.

# Ведення чинного Люмена через ChatBot Atelier у Work і Codex

Work-версія потрібна як доступний власнику проєктний директор: сформулювати проблему за наданими матеріалами, відновити історію рішень без вигадування current state, дослідити практики, узгодити UX/character/media, перевірити доступні connectors, підготувати exact implementation/release package й прийняти повернений результат. За доступного executor/repo/API Work може виконувати і code/test/provider операції. Codex-версія діє в локальному checkout: trace source, diff/build/test, tooling/runtime integration, native media checks і контрольована передача/реліз за правами.

Одна поточна методика, різні перевірені capabilities. Work не бачить автоматично Telegram, production DB або Mac; Codex не має автоматичного контексту Work й прав провайдера. Немає синхронізації приватних чатів у два боки за самим встановленням навички. Доступ і data lineage доводити конфігурацією/кодом/фактичною операцією, не теорією.

Cold handoff: user intent/approval, source IDs/versions, current source/deploy observation,24/H/J impact, formal domain contract, owned paths/locks, recipes/effective parameters, assets masters/manifest, existing reviews/evidence, failed attempts/causes, actual remote IDs, commands/deps без секретів, recipient and next acceptance. Отримувач звіряє input hashes з current files і повертає result/diff/proof/limitations; оркестратор перевіряє returned package before accepting.

Наявні repo-local lumen-* helper routes й custom agents інвентаризувати по поточному checkout. Наявні project wrappers можна адресно зберігати після перевірки повного покриття, маючи одного integration owner; новий Lumen wrapper або другий координатор для переходу не створюється. Не створювати дублікати frontmatter і не перезаписувати AGENTS/config/docs без предметного аналізу. Для старту достатні актуальний repo й мета; повний маршрут `references/resume-current-project.md` фактично доступного ChatBot Atelier визначає intake та current handoff. Новий директор не залежить від старого установчого пакета або прихованих sibling paths.


## Discovery команд і форматів

Перед запуском знайти команду в actual checkout або поточному ChatBot Atelier і прочитати її поведінку; наявність назви у старому тексті не є виконуваним інструментом. Missing historical command — gap, а не дозвіл створити stub чи виконати архів. Формати й toolkit version різні: використовувати поточні contracts фактично доступного ChatBot Atelier. `lumen.handoff/3` залишається current у його `assets/project-handoff.template.json`; перейменовувати його як legacy не потрібно. Unsupported machine format відхиляється/перестворюється з авторитетних фактів без видалення original або bot data/stable IDs. Методичні шаблони не копіюються в project runtime.

## Збережені правила архітектурного спеціаліста

Для T2/T3 порівняти 2–3 здійсненні варіанти, спочатку використовуючи чинні TypeScript/PostgreSQL/Telegram/Render. Визначити bounded contexts, одного owner, state machine, data schema, API/events, idempotency, operation receipts, privacy lineage, crash/retry/cancel/uncertain, load bounds, observability, migration та rollback.

Використати короткий ADR з явними tradeoffs і найсильнішим запереченням. Не додавати нові сервіси/Temporal/Redis/vector DB лише заради елегантності. Звірити ERD↔API↔events↔tests↔rollout. Для hard invariants потрібне незалежне security/QA review. Ці правила не дозволяють production mutation або deploy. Джерело — колишній lumen-architecture; повний оригінал у перевіреному архіві сімейства.
