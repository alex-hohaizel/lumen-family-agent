> Канонічні правила Люмена; продовження веде `chatbot-atelier-director` та потрібні модулі ChatBot Atelier. Поточне доручення й [AGENTS](../../AGENTS.md) визначають права. [Контекст продукту](../lumen/README.md), [checkpoint](../lumen/migration/checkpoint.json). Читання чи встановлення старої Lumen-навички та custom agents не є передумовою. Правило, його реалізація, CI, delivery та human acceptance мають окремі докази.

# Карта цільових тестів (за поточним репозиторієм)

Базові команди 1.13.2: `npm run build` (production), `npm run build:test` (тести), `npm test` (повний suite). Релізний gate: `npm run verify` (повний suite + пакування та перевірка runtime-пакета). Для цільової перевірки після обох builds запускайте конкретні `.test-build/test/*.test.js` через `node --test --test-concurrency=1`.

| Suite | Тести |
|---|---|
| `core` | `behavior-111`, `interactions-170`, `conversation-113`, `action-truth-closure-v3` |
| `behavior` | `behavior`, `behavior-111`, `conversation-113`, `attention-140`, `personalization-scheduling` |
| `actions` | `interactions-170`, `action-recovery-113`, `action-truth-closure-v3`, `state-111` |
| `privacy` | `groups-topics`, `source-authority-v4`, `request-context-v4`, `migration-113` |
| `media` | `media-execution-113`, `media-integration-r3`, `media-closure-v3`, `live-media` |
| `stickers` | `sticker-release`, `sticker-palette`, `sticker-policy-180`, `sticker-upgrade` |
| `release` | `release-130`, `joint-startup`, `runtime-113`, `migration-113` |
| `all` | `npm test` |

**Важливо:** це статичні вибірки для зручності, не аналіз залежностей. Нові файли, DB migration, shared core, невідома зона впливу або T2/T3 → `npm test`. Тести без реального Telegram не доводять фактичний readback. Опційний local-only `scripts/codex/quick-check.sh` запускає `npm run build`, потім `npm run build:test` перед цільовими тестами. `all` делегує `npm test`, який також запускає тести `tools/release` і `tools/diagnostics`; targeted suites не замінюють повний gate.

У 1.13.2 `npm run build` очищає власний `dist` і компілює лише `src` через `tsconfig.json`. `npm run build:test` очищає власний `.test-build` і компілює `src` та `test` через `tsconfig.test.json` у `.test-build/test/*.test.js`. Перевірку готових 120 пар WEBM/PNG, порядку та хешів виконує `sticker-release`; npm-команди `stickers:validate:strict` тут немає. Для перевірки без БД можна після збірки запустити `node --test --test-concurrency=1 .test-build/test/sticker-release.test.js .test-build/test/sticker-palette.test.js` (Telegram у palette замінено локальним mock). Повний suite `stickers` також використовує тестову PGlite БД.

`npm run build:release` створює `.release` за allowlist із production-залежностями. Тести, docs/tools, PNG-прев’ю та авторська історія залишаються поза пакетом. Не запускати локально `tools/release/finalize-render.mjs`. Широка жива діагностика `npm run diagnostics` / `--diagnostics` потребує окремого явного доручення й не є локальним тестом. Статичний валідатор Kit потребує Python 3.11+ (`tomllib`).

`choose-tests.mjs` — лише порада за шляхами; зміни `tsconfig.test.json` та `tools/release` / `tools/diagnostics` потребують повного набору. Локальні перевірки не доводять зелений GitHub gate або фактичний стан Render.


## Відсутність залежності на старий Kit

`scripts/codex` — допоміжні локальні команди, не prerequisite ChatBot Atelier. `verify_pack.py` перевіряє project-owned контекст, збережені25 CAP/24 criteria й посилання без залежності на видалені skills/custom agents; structural PASS не приймає фактичне незалежне продовження. `choose-tests.mjs`/quick-check зручні лише за наявності локального overlay; прямі package scripts та node --test достатні без нього.

Локальний resource WIP має шість targeted tests: resource-memory, resource-recovery, work-slots-memory, browser-memory, scheduling-memory, visual-resource. Їхні bytes/статус у checkpoint, а не в committed CI baseline. Під час docs migration product suites, broad diagnostics і production DB не запускаються. Старі 1099/1107/+release-controls належать різним historical scopes; exact CI result pinned у checkpoint.
