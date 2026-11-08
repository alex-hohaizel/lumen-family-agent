# Стан, jobs і відновлення Люмена

Канонічний операційний runbook — [docs/OPERATIONS.md](../../OPERATIONS.md), випуск/відкат — [docs/RELEASING.md](../../RELEASING.md). Цей документ фіксує контракт та межі відновлення, а не копію runbook. [Capabilities](../product/capabilities.json), [tool registration graph](../product/tool-catalog.json), [source bounds](source-bounds.json), [SQL inventory](schema-inventory.json) доповнюють його.

Поточні DB schema_version/data, queue rows, locks/leases, pending remote IDs та uncertain effects не читалися. SQL-source містить 133 table declarations; це не DB introspection. Жодна історична job не dispatch-иться через перенесення документації. Actual jobs/lease/Auth лишаються unknown; перед resume потрібний read/reconcile за exact identity, не сліпий submit.

Read-only Render metadata підтверджують service `srv-dbfl0je7bikc73dvg0qg`, deploy `dep-dbj6j67b9u1s73d6aeb0` live з HEAD `a1fd79dc1e369f0f6d50579523524cd196f11d72`, один instance, not suspended, `autoDeployTrigger=checksPass`, чинні build/start із AGENTS. Це не перевірка `/ready`, group runtime, model/voice config, jobs чи Telegram delivery. Production у цьому документаційному етапі не змінюється.

## Незмінні правила state і recovery

- Один процес володіє Telegram poller/advisory lock/Auth refresh; втрата lease зупиняє його. Другий worker із тією самою renewable session не запускається. Чинна поновлена сесія має пріоритет над імпортованим seed; повторний login не потрібний без фактичної втрати/відкликання.
- Кожна група має окрему схему; topic, actor, private DM, task-only дані й audience зберігають межі в read, jobs, результатах, progress/errors, caches і exports. Owner/admin мають лише визначені кодом права. Чужа відповідь/мовчання не створює consent.
- Telegram offset зберігається після приймання update. Durable acceptance, prepared/queued, running, готовий файл, provider_accepted, доставлено й прочитано людиною — різні факти. Success/delivery claim має реальний operation/file/provider receipt; модель його не створює.
- Незавершена робота поновлюється за власним контрактом після рестарту; незалежні прийняті частини зберігаються. Cancel/expiry до dispatch блокує новий ефект; після dispatch outcome може бути uncertain/cancellation_requested. Невідома зовнішня доставка не повторюється як нова дія без reconcile/idempotency proof. Buttons/panels/announcements зберігають dedup/receipts; старі callback-и й дані підтримуються чинним кодом.
- Pause/forget/edit/revoke інвалідують залежні черги, cached prompts/search/summaries/views/exports та output notices. Revision/privacy epoch/source lineage перевіряються й для late model/tool result. Старий backup не воскресає забуте; відновлення лишається за privacy fence. Резервуються всі групові схеми, transport registry та захищені ключі диска; Docker Compose backup-loop не є заявою про Render schedule.
- Cleanup не видаляє originals, provenance, receipts чи dedup keys під виглядом кешу. Runtime/backups/secrets не входять до `.release`, не копіюються з checkout і не друкуються в logs. Code rollback не відкочує DB/disk.
- Broad diagnostics — лише явний `npm run diagnostics`/`--diagnostics` у тому самому worker/lease/Auth. Звичайний запуск зберігає `not_run`; для документації або asset-only підтвердження їх не запускають. Finalizer призначено для Render build і заборонено запускати в локальному checkout.

## Локальний WIP ресурсів

Збережено незакомічений resource-memory repair: sampler cgroup v1/v2/node-only, bounded heavy admission/queues, Chromium cleanup, numeric-only telemetry та resource-denial recovery. Повний чинний local-only контракт — [RESOURCE_MEMORY](../../RESOURCE_MEMORY.md); exact hashes source/tests — `CAP-25.local_wip.source_paths_sha256` у [inventory](../product/capabilities.json).

`needs_input` після ресурсної відмови не запускає наступний model-step автоматично; claimed effect залишається uncertain; media зберігає repair/materials; visual повертається у pending без decode-attempt і з cooldown30s. Cancel/forget/revision fences чинні. Admission не є allocation cap; measured sampled peak не гарантує відсутності OOM. Новий source/tests WIP не оголошується accepted чи deployed.

RESOURCE_MEMORY та частина source/tests є untracked. Для cold receiver потрібні самі незмінні WIP bytes із hashes; чистого clone committed HEAD недостатньо. Production DB, live diagnostics, scheduler dispatch, paid provider або нове аудіо тут не запускаються. Наступна продуктова мета визначається окремим дорученням за checkpoint.
