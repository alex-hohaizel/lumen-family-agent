> Канонічні правила Люмена; продовження веде `chatbot-atelier-director` та потрібні модулі ChatBot Atelier. Поточне доручення й [AGENTS](../../AGENTS.md) визначають права. [Контекст продукту](../lumen/README.md), [checkpoint](../lumen/migration/checkpoint.json). Читання чи встановлення старої Lumen-навички та custom agents не є передумовою. Правило, його реалізація, CI, delivery та human acceptance мають окремі докази.

# Release runbook: ніякого уявного деплою

## Передумови

- Явно дозволений scope публікації/випуску; локальні правки не дозволяють push або production-дії. Для ручного deploy — окремий явний дозвіл.
- Злитий/затверджений PR, pinned Git SHA, без secrets у diff.
- Один обов’язковий GitHub job `verify` успішний на точному SHA: `npm run verify` включає функціональні тести, тести tools, пакування `.release` і перевірку runtime-пакета. Targeted/negative/integration перевірки доповнюють цей gate.
- Якщо змінено stickers: strict validation, approved order/uniqueness, per-file SHA manifest, fingerprint, preview audit. Старі не змінені без потреби.
- DB migrations additive/compatible, перевірено rollback та single-writer; backups/restore без resurrect forgotten data.
- Цільовий worker `srv-dbfl0je7bikc73dvg0qg`: Render Auto-Deploy `After CI Checks Pass`; build `npm ci --include=dev && npm run build:release && node tools/release/finalize-render.mjs`; start `cd .release && npm start`. Звірити фактичні налаштування сервісу/workspace read-only: `render.yaml` сам цього не доводить. Не змінювати ресурси без окремого доручення.

## Контрольований порядок

1. Почати з актуальних GitHub HEAD і стану чинного Render; не повторювати завершені етапи без нової причини. Зафіксувати SHA, поточний deploy ID, manifest і очікувані runtime flags.
2. Перевірити один успішний GitHub `verify` саме цього SHA. Не дублювати повний набір тестів на Render.
3. Після дозволеного push відстежувати один автоматичний deploy `After CI Checks Pass`. Не запускати другий ручний deploy. Для ручного випуску/відновлення — конкретний SHA, сервіс, stop conditions, окремий явний дозвіл і перевірений CI.
4. Дочекатися `live`, перевірити фактичні build/runtime logs, SHA, health/queue errors.
5. Звірити Telegram readback усіх 120 стікерів, fingerprint і погоджений порядок; `live` не доводить sticker publication. Підтвердити `sticker_pack_verified`, `sticker_pack_ready`, потім `lumen_started` і запущений груповий runtime.
6. За потреби виконати лише дозволений smoke із синтетичними даними. Широка жива діагностика `npm run diagnostics` / `--diagnostics` — тільки за окремим явним дорученням, в одному worker із чинними lease/Auth; для asset-only випуску не запускати.
7. Один короткий зовнішній запис: SHA, CI/deploy ID, перевірка пакета, Telegram readback, запуск, rollback readiness і unknowns. Не комітити журнали виконання.

## Межі локальної збірки

`npm run build` → production `dist/src`; `npm run build:test` → `.test-build`; `npm run build:release` → allowlist `.release` із production-залежностями. Тести, docs/tools, PNG-прев’ю й авторська історія не входять до runtime-пакета, але потрібні джерела/еталони зберігаються в Git або перевіреному авторському архіві за `AGENTS.md`. Не чистити сторонні каталоги чи symlink-залежності. Finalizer дозволений лише в штатному Render build-root; локально його не запускати.

## Stop / rollback

NO-GO якщо невизначений provider effect, чужа згода, leak, forgotten data resurrection, fabricated success, missing fingerprint, failing tests, unreviewed migration. Rollback маршрутизує нові дії назад на сумісну версію; не обіцяє відкликати вже надіслані повідомлення або скасувати зовнішній ефект. Чинні jobs мають pinned owner/engine version.

Для відкату до коміту раніше 1.13.2 потрібні його сумісні build/start-команди, бо він не створює `.release`. Дотримуватися `docs/RELEASING.md`; відкат коду не відкочує БД/диск і потребує контролю Auto-Deploy.

## Канонічний runbook і поточне доручення

Детальний operational procedure — [RELEASING](../RELEASING.md), супровід — [OPERATIONS](../OPERATIONS.md), authority — [AGENTS](../../AGENTS.md). Цей файл зберігає проєктні release gates та інваріанти. Конкретна наявна згода на дію не запитується повторно; наведені історичні PR/preflight формулювання не додають новий approval flow поза чинними правилами репозиторію.

Чинні права завжди читати з поточного прямого доручення й checkpoint.current_work. Доручення2026-11-09 дозволяє завершити поточний ремонт/WIP і випустити1.13.3 через normal Git→exactCI→чинний worker. Model/voice/secrets/accepted assets і тариф не змінюються. Попередній docs-only/no-push stop є історичним. Майбутній push може спричинити автоматичний Render deploy після CI; це врахувати до публікації. Read-only metadata live не доводять health/lease/Auth, старт груп або свіжий Telegram readback.

## Підготовка й smoke дозволеного майбутнього випуску

До dispatch підготувати dry-run plan: pinned SHA/build, конкретний service ID, очікувані flags/manifest, stop conditions і rollback; звірити чинний exact scope. Під час окремо дозволеного release smoke у test/prod групі перевіряє direct reply, callback details, consent, no false delivery, cancel/repair та optional sticker. Використовувати синтетичні дані; не витягати приватні чати для AI. Фактичний release smoke виконується тільки в чинному дозволеному scope; не створювати тестові нагадування в чужих групах. Для1.13.3 conditional rollback/forward-fix процедура — у канонічному RELEASING.
