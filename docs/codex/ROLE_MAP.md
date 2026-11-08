> Канонічні правила Люмена; продовження веде `chatbot-atelier-director` та потрібні модулі ChatBot Atelier. Поточне доручення й [AGENTS](../../AGENTS.md) визначають права. [Контекст продукту](../lumen/README.md), [checkpoint](../lumen/migration/checkpoint.json). Читання чи встановлення старої Lumen-навички та custom agents не є передумовою. Правило, його реалізація, CI, delivery та human acceptance мають окремі докази.

# Ієрархія ролей і підрозділів

**Людина / Product Owner:** визначає цінність, пріоритет, зовнішні дозволи, бюджет і рішення про production.

**Main Orchestrator / Program Director:** єдиний owner завдання, визначає tier, збирає контракт, розподіляє роботу, розв'язує суперечності, об'єднує результати, відповідає за остаточний звіт.

**Рівень лідів:** `product-lead`, `architecture-lead`, `qa-lead`. Ліди не обов'язково окремі AI threads у T0/T1; функції виконуються в головному проході. Для T2/T3 їх можна делегувати.

**Спеціалісти:** `conversation-designer`, `interaction-engineer`, `backend-engineer`, `privacy-security`, `media-specialist`, `reliability-engineer`, `cost-auditor`.

**Незалежний контроль:** `skeptic` (шукає контрприклади, пропущені альтернативи, regression risks), `evidence-judge` (оцінює силу доказів і release gate). Reviewer не оцінює власний код як незалежний.

## Контракт для кожного субагента

Input: scope, relevant files, invariants, known facts, questions. Output: decision/findings, file:line, severity, evidence tier, counterexample/test, uncertainty, proposed action, no raw logs beyond essential excerpt. **Не створювати уявних експертів**: звіт містить тільки реально виконані незалежні проходи.

## Правила делегування

- T0: 0 субагентів.
- T1: 1–2 за необхідності.
- T2: 2–3; product/architecture/QA у різних фазах.
- T3: кілька хвиль незалежних експертиз; **не більше 3 одночасно**, а 12 J-критеріїв — матриця, не обов'язково 12 модельних викликів.
- На 2-й ітерації агент має перевірити лише виправлені finding IDs і нові ризики, не переписувати весь аудит.
- Конфлікт двох ролей вирішується через новий тест/доказ або явне рішення власника, не середнім балом.

## Поточне виконання через ChatBot Atelier

Main Orchestrator / Program Director означає функцію одного інтегратора `chatbot-atelier-director`, а не необхідність викликати Lumen Оркестратор. Product/architecture/QA та specialist labels вище — компетенції й ownership. Якщо однойменного custom agent немає, цю функцію делегують фактично доступному виконавцю з належним input/output contract. Відсутня required tool capability є gap, а не N/A.

Проєктна верхня межа не більше 3 concurrent зберігається; actual slots/cost limits можуть її знизити. Числа T0–T3 не є мінімальною кількістю встановлених custom roles або моделей. Незалежний QA/reviewer не є автором оцінюваного результату. Холодний receiver отримує тільки задекларовані inputs, без старих Lumen skill bodies, custom agent config та історії чату. Окремий звичайний same-history subagent не доводить cold independence.

# Предметні маршрути Люмена

| Маршрут | Артефакт | Приймання |
|---|---|---|
| Orchestration/product | Brief, applicability, impact24/H/J, capability/authorization snapshot, checkpoint | Один integration owner; не губить independent promises |
| Architecture/data | Domain rules/states/API/events/schema/ownership, alternatives/ADR, migration | DB/API/events/tests consistent, privacy epoch/idempotency/rollback |
| Conversation | Persona, recipient/referent/silence/initiative, locale fixtures |8 strata, minimal pairs, actual action alignment, human evaluation separate |
| Feature/actions/games | Vertical slice, tool/callback/job/roster/consent | Duplicate/stale/wrong actor/cancel/restart/partial failure; meaningful first move |
| Media/stickers | Immutable masters, recipe, changed asset diff/final bytes | Identity/limbs/motion/seams/audio/alpha/order/fingerprint; actual readback separate |
| Privacy/memory | Source/audience/purpose lineage, erase/revoke/correct/restore | Cross-chat/DM/late-result/old-cache/backup negative traces |
| Reliability/cost | Bounds, queue/deadline/retry/lease metrics, comparable baseline | Chat remains responsive; no invented savings; no blind uncertain retry |
| QA/evidence | Frozen requirements+raw diff/results, own counterexamples | Independent, exact evidence/unknown; hard gates not averaged |
| Release/operations | Pinned artifact/provider target, tests/rollback/live receipts | Authorization exact scope, observed build/health/delivery, no fake done |

## Колишнє сімейство: історичне зіставлення

Після прямого доручення власника це старе сімейство фізично видалено:7repo-local спеціалістів та2копії оркестратора. Повні оригінали115файлів збережені у незалежно перевіреному архіві, а потрібні правила й критерії — у документах проєкту. Таблиця нижче зберігає історичні назви та зіставлення відповідальностей; вона не є вимогою встановити чи викликати старі навички. Новий інтегратор — ChatBot Atelier.

| Колишній helper | Поточна предметна гілка |
|---|---|
| lumen-architecture | @chatbot-atelier-specification + @chatbot-atelier-build |
| lumen-conversation | @chatbot-atelier-conversation |
| lumen-feature | @chatbot-atelier-integrations + @chatbot-atelier-build |
| lumen-stickers | @chatbot-atelier-media |
| lumen-qa | @chatbot-atelier-qa |
| lumen-release | @chatbot-atelier-release |
| lumen-cost-audit | @chatbot-atelier-operations |

Це історичне mapping відповідальності. Власні правила сімейства звірено з current contracts перед видаленням; minimum5cost tasks і stack-first preference явно збережені у COST_POLICY.md та WORKFLOW.md. Custom agents, scripts/codex, інші навички, прикладний код, дані, активи й production залишені незмінними.
