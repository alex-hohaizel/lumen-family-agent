> Канонічні правила Люмена; продовження веде `chatbot-atelier-director` та потрібні модулі ChatBot Atelier. Поточне доручення й [AGENTS](../../AGENTS.md) визначають права. [Контекст продукту](../lumen/README.md), [checkpoint](../lumen/migration/checkpoint.json). Читання чи встановлення старої Lumen-навички та custom agents не є передумовою. Правило, його реалізація, CI, delivery та human acceptance мають окремі докази.

# Економія ресурсів без деградації результату

1. **Progressive disclosure:** AGENTS.md короткий; читати конкретні skills і docs лише за scope.
2. **Tier routing:** T0 без субагентів; T1 1–2; T2 2–3; T3 кілька хвиль, max 3 concurrent.
3. **Context discipline:** `rg`/symbol search/diff замість повного dump; передавати агентам лише релевантні фрагменти.
4. **Evidence reuse:** зберігати task IDs, commits, test receipts; не перезапускати перевірки незмінних assets.
5. **Selective tests:** build + цільові тести для T0/T1; full suite для T2/T3; для release один CI `verify` (`npm run verify`) на точному SHA, без дублювання повного suite на Render. Невідомий ризик → ширший suite.
6. **Heavy media:** content hash, manifest, per-asset diff, preview; не рендерити 120 стікерів через одну аномалію.
7. **Review loop:** максимум 2 суттєві ітерації без нових доказів; далі змінити гіпотезу або ескалювати.
8. **Model choice:** доступну легшу модель для exploration/test triage; сильнішу — для архітектури, приватності й критичних рішень. Не фіксувати неіснуючі entitlement.
9. **External tools:** не додавати MCP/paid API без доказової потреби; production mutation потребує окремого дозволу.
10. **Metric honesty:** вимірювати AI usage, elapsed time, CI minutes, Render build і якість окремо. Не заявляти економію без baseline.

**Non-negotiable:** економія ніколи не виправдовує порушення H01–H26, fabricated evidence чи пропущений required release gate.

## Чинні межі вибору

Моделі й overrides беруться з поточних правил середовища та явних уподобань користувача; не змінювати встановлену модель довільно. Нове аудіо відкладене; це не означає історичного відкладення всіх платних integrations. Нові витрати/resources потребують конкретного чинного доручення. Бот зберігає GPT-6.1-Sol і чинний voice config.

Делегування за actual slots/cost/ownership у межах проєктного max 3 concurrent; fixed role labels не означають обов’язкової кількості моделей. Для docs-only без product impact — адресна structural/content перевірка; не повторювати broad suites після pass без нової причини. Resource admission/sampler/browser recovery у [RESOURCE_MEMORY](../RESOURCE_MEMORY.md) — local-only WIP із checkpoint hashes, не доказ придатності Render512MiB чи фактичної економії. ArrayBuffers входить у external; sampled peak не гарантує відсутності OOM. Logger не повинен розкривати тексти/IDs/URL/secrets або змінювати outcome.

## Збережене правило вибірки cost audit

Порівнювати before/after щонайменше на 5 задачах подібної складності. Фіксувати фактичні значення або unknown; не вигадувати відсотків економії. Для кожної задачі зберігати scope/tier, agent count, джерело AI usage, wall time, прочитані/змінені файли, тести та дефекти після review. Це критерій майбутнього вимірювання, не твердження, що п’ять задач уже перевірено. Джерело — колишній lumen-cost-audit, повний оригінал збережено в перевіреному архіві сімейства.
