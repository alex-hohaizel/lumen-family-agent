# Люмен: контекст і продовження

Люмен — живий доречний Telegram-співрозмовник і корисний помічник груп/тем та приватних доручень. Це чинний продукт, а не новий bootstrap. Єдиний інтегратор розвитку — `chatbot-atelier-director`; потрібні модулі ChatBot Atelier виконують предметні етапи. Старі Lumen skills, custom agents і приватна історія чату для продовження не потрібні.

Authority: поточне пряме доручення → [AGENTS](../../AGENTS.md) й прийняті рішення → current source/contracts/dirty → належні фактичні докази. Збережене правило, source inspection, локальний тест, CI, provider metadata, delivery та human acceptance — різні факти. Unknown не є pass чи unchanged.

Читати послідовно:

1. [Поточний стан](current-context.md), [єдиний checkpoint](migration/checkpoint.json), [чинне доручення](migration/current-scope.md).
2. [Рішення та походження](requirements/accepted-decisions.md), [повні43records/56IDs](requirements/accepted-development-scope.json), [повний зміст5+10/R3.1](requirements/requirements-scope-addendum.md), [невирішене](requirements/open-questions.md).
3. [Persona/CORE](product/persona-source.md), [capabilities](product/capabilities.md), [канонічний inventory](product/capabilities.json), [повний source tool catalog](product/tool-catalog.json).
4. [H01–H26/Q01–Q04](../codex/INVARIANTS.md), [J01–J12](../codex/QUALITY_MATRIX.md), [24повніcriteria](requirements/companion-24.json), [E01–E20](quality/acceptance-scenarios-E01-E20.json), [coverage](quality/criterion-source-destination-coverage.json).
5. [Workflow](../codex/WORKFLOW.md), [ролі](../codex/ROLE_MAP.md), [feature contract](../codex/FEATURE_TEMPLATE.md), [докази й cold acceptance](../codex/PROOF_PROTOCOL.md), [витрати](../codex/COST_POLICY.md), [тести](../codex/TEST_MAP.md).
6. [State/jobs](operations/state-and-jobs.md), [source limits](operations/source-bounds.json), [SQL declarations](operations/schema-inventory.json), [accepted assets](media/accepted-assets.md).
7. Канонічні [OPERATIONS](../OPERATIONS.md), [RELEASING](../RELEASING.md), [release gates](../codex/RELEASE_RUNBOOK.md); [local-only resource WIP](../RESOURCE_MEMORY.md).

JSON capabilities є канонічним inventory, capabilities.md — його читабельне представлення. current-context.md представляє checkpoint, а не веде другий журнал. Persona-codeblock є hashed source projection; виконуваний CORE належить src/personality.ts. Assets manifest/fixture та operational runbooks використовуються за посиланням. Загальні method/contracts/scripts беруться з поточного ChatBot Atelier, не з копії старих policy templates.

Цей checkout містить незакомічений resource WIP. Для повного handoff потрібні його bytes+hashes: чистий clone сам їх не містить. Checkpoint і [трансформації](migration/transformation-register.json) фіксують inputs та окремі зовнішні snapshot/archive locators. Звіти виконання, оригінали старої навички та авторські матеріали зберігаються поза Git. Відсутній архів masters перед ремонтом/вилученням — gap, не дозвіл регенерувати accepted assets.

Для наступного входу: `$chatbot-atelier-director ВІДНОВИ чинного Люмена з цього checkout. Прочитай AGENTS.md та docs/lumen/README.md, звір checkpoint із source/WIP, збережи всі правила, capabilities, дані, jobs і accepted assets. Наступна мета: [конкретна задача]. Чинні права/stop: [межі]. Виконай уже дозволений scope; поверни exact diff/checks/unknowns/checkpoint та receiving acceptance.`

Нову продуктову мету визначає наступний БРИФ. Саме перенесення документації не дозволяє deploy, нові витрати чи skill retirement. Нове аудіо відкладене; чинний голос і GPT-6.1-Sol зберігаються.

Work: `@chatbot-atelier-director`; Codex: `$chatbot-atelier-director`. Доступ до source та права кожного середовища перевіряються окремо; старий агентський пакет і Work-сеанс не є передумовою Codex-продовження.

Після останнього окремого доручення власника фізично видалено обидві копії `lumen-orchestrator` і сім підпорядкованих навичок. Повний незалежно перевірений backup115файлів, exact scope/receipt та доступність нового директора — у checkpoint. Загальні правила й усі можливості Люмена продовжуються через ChatBot Atelier.
