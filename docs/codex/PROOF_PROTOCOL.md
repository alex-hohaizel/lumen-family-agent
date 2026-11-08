> Канонічні правила Люмена; продовження веде `chatbot-atelier-director` та потрібні модулі ChatBot Atelier. Поточне доручення й [AGENTS](../../AGENTS.md) визначають права. [Контекст продукту](../lumen/README.md), [checkpoint](../lumen/migration/checkpoint.json). Читання чи встановлення старої Lumen-навички та custom agents не є передумовою. Правило, його реалізація, CI, delivery та human acceptance мають окремі докази.

# Протокол доказів і незалежної перевірки

## Рівні доказів

- E0 Hypothesis: припущення, яке ще не перевіряли.
- E1 Inspected code: конкретна гілка й `file:line`; це не гарантія runtime.
- E2 Isolated replay: реальні функції або синтетична реляційна модель; чітко назвати mocks.
- E3 Integration: перевірено наскрізний локальний шлях, реальну БД/transport або точний контракт провайдера.
- E4 Live observed: перевірено Render SHA/status, Telegram provider readback, конкретний delivery receipt.
- E5 Human validated: добровільне blind оцінювання живості/користі; не замінює E4.

## Формат finding

`ID | severity | requirement/invariant | file:line | reproduction | evidence tier | actual vs expected | impact | proposed fix | retest result | residual unknown`.

## Незалежність

QA не повинен покладатися на висновок implementer; отримує frozen spec, diff, тестові результати, готує власні негативні сценарії. Skeptic перевіряє альтернативні пояснення й найсильніші контрприклади. Evidence judge відділяє «підготовлено», «запущено», «отримано receipt», «користувач отримав» та «користувач задоволений».

## Коли можна сказати «готово»

Тільки коли всі обов'язкові acceptance criteria мають докази, hard gates pass, незакриті unknown не блокують заявлену функцію. Якщо Render deploy live, але Telegram pack readback не підтверджено, писати «код live; sticker delivery pending verification», не «все опубліковано».

# Виробництво й перевірка Люмена

Кожна promise має requirement→formal contract→operation→recipe→actual attempt→integrated journey→evidence. На вході user intent/source/version; на виході exact consumer і належний результат. Цей маршрут адаптований до чатового runtime; не переносить фізику/монетизацію/ігровий catalog у companion.

Паспорт tool/model/encoder/deploy operation фіксує effective parameters, version, limits, право/ціну, editable inputs, outputs, date/proof. Рецепт визначає кроки й negative checks; actual attempt зберігає реальні job IDs, command/params, input/output hashes, return/result, logs/receipt і limitation. Невідомий tool, schema mismatch чи ignored parameter є gap до залежної роботи.

Runtime causal path: ingress→recipient/reference→authorization/current spec/privacy epoch→one authoritative state→effect dispatch/reconcile→persisted outcome→scoped feedback/delivery→resume. ACK, queued, provider accepted, delivered і human read різні. Cancel до dispatch має блокувати effect; після uncertain dispatch — reconcile. Forget/revoke інвалідує derived prompts/summaries/jobs/media/cache й old restore; late tool/model result не воскресає стерте.

Приймання: exact source/build/assets/env/model, synthetic input, actual state/effect/delivery trace, crash/duplicate/stale/wrong actor/privacy/forget/limits probes. Для медіа — перевірити final frozen bytes, decode/timing, full animation motion, audio by listening, character/scene match, manifest/order/fingerprint; локальна валідність не є Telegram publication/readback. До масового набору перевірити виробництво одного репрезентативного елемента до integration/QA і виміряти спроможність.

Naturalness: frozen contexts8 strata, мінімальні пари, підтримані мови, false speech/silence denominators; незалежне human blind evaluation окремо. Зелені unit tests або LLM judge не доводять теплу доречну участь. H/J та24 Work criteria кожен зберігають verdict/evidence scope.

Код перевіряти за current package scripts і meaningful tests; missing pdftotext/ffmpeg/Chromium/DB не називати regression коду без діагностики. Не витрачати весь suite на кожну оборотну зміну; невідомий shared impact розширює перевірку. Після pass не повторювати broad suites без нової причини.

Release: підготовка exact target/source/effects, tests/checks/migrations/rollback → чинна authorization → supported deploy/publication → actual provider identity/logs → targeted Telegram smoke/readback. Пряме authorization чинного scope діє без повтору. Висновок лише фактичний: prepared/locally_verified/independently_reviewed/deployed/observed_in_chat/human_validated. Непідтверджена live межа лишається unknown.

Carry-forward: old review immutable, new artifact dependency snapshot, current tool/env/version/freshness check. Зміна shared generator/router/prompt/schema/privacy policy інвалідує залежне транзитивно. У checkpoint записати зміни, completed work, exact next action/receiver, remote IDs, незгоду й можливість відкату.


## Приймання перенесення і холодне продовження

Content gate зберігає H26/Q4/J12/24/E20=86 критеріїв, 43 development records/56 вихідних ID й усі додаткові унікальні clauses. Counts без повного тексту недостатні. Звіряти source→criterion/contract→owner→destination/anchor→probe→evidence. Намисно вилучене поле companion або orphan clause повинно дати fail; unknown→pass також fail.

Cold input: current checkout з незмінними WIP bytes і hashes, project-owned docs, чинна мета/дозволи та актуальний ChatBot Atelier. Передавати ізольовану view без `.agents`, `.codex`, old-skill backups, `.env`, runtime/secrets/production DB та приватної історії чату. Reviewer новий, без успадкованих old-skill bodies/routes чи попереднього висновку автора; назва навички в каталозі сама не є її використанням. Input manifest фіксує фактично надані файли, source/WIP і exclusions.

Receiver сам відтворює місію/persona, групи/теми/DM, inventory, H/Q/J/24/E, 43/56 scope, accepted120 assets, source/CI/WIP/live, jobs/uncertain unknowns, права й exact next action. Повертає source-backed intake, hashes, findings/verdict. Відсутнє правило, функція, прихована залежність на стару навичку або помилкова авторизація дають fail. Якщо немає реального нового контексту чи належної input isolation, силу перевірки позначити limited.

Звіти/attempt receipts лишаються поза Git; checkpoint містить короткий результат, source digest і locator. Реальне product acceptance, live Telegram delivery та людська якість не доводяться документаційним PASS. Старі reviews immutable; переносимість evidence потребує незмінних exact dependencies і актуального environment/freshness.
