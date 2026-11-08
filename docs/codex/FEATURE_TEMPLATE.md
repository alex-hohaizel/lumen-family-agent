> Канонічні правила Люмена; продовження веде `chatbot-atelier-director` та потрібні модулі ChatBot Atelier. Поточне доручення й [AGENTS](../../AGENTS.md) визначають права. [Контекст продукту](../lumen/README.md), [checkpoint](../lumen/migration/checkpoint.json). Читання чи встановлення старої Lumen-навички та custom agents не є передумовою. Правило, його реалізація, CI, delivery та human acceptance мають окремі докази.

# Feature/change contract (копіювати тільки для T1+)

**Мета / користувацький результат:**
**Поточний стан / відтворення:**
**Scope / non-goals:**
**Ризик T0–T3 і причина:**
**Доменні власники / зачеплені API/DB/events:**
**Інваріанти Hxx:**
**Альтернативи і tradeoffs (T2+):**
**Happy path:**
**Failure / cancel / retry / expiry / restart / duplicate / privacy:**
**Acceptance і негативні сценарії:**
**Докази E0–E5 / необхідні зовнішні перевірки:**
**Тести targeted/full, CI, manual smoke:**
**Вартість/час/ризики:**
**Rollout/rollback:**
**Хто й що затверджує:**

## Binding поточного етапу

Requirement IDs і повний чинний текст: [розвиток](../lumen/requirements/accepted-development-scope.json), [companion24](../lumen/requirements/companion-24.json), [H/Q](INVARIANTS.md), [J](QUALITY_MATRIX.md), [E01–E20](../lumen/quality/acceptance-scenarios-E01-E20.json). Для кожного active must: source/version/hash, owner, formal domain contract, states/guards/audience, operation/recipe/actual attempt, output consumer, positive/negative acceptance та evidence limits.

Handoff включає exact source/dirty hashes, прийняті незалежні результати, unresolved/jobs/remote IDs, cancel/expiry/retry/reconcile, privacy/forget/restore, дозволи/budget/stop, receiver/next action та return validation. Старий агентський output format не імпортувати автоматичним reader; потрібний намір відновити з авторитетних джерел у поточний формат ChatBot Atelier. Runtime/DB compatibility — окремий предметний контракт.
