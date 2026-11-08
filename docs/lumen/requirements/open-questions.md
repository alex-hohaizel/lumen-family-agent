# Невирішене й межі відновлення

| ID | Статус і джерело | Власник / due gate / наступний крок |
|---|---|---|
| U01 | **Resolved для local intake:** HEAD a1fd79dc1e369f0f6d50579523524cd196f11d72; branch chore/codex-migration-2026-10-31; 17 tracked modified, untracked resource/Codex WIP. Повнота clean clone без WIP-пакета не заявляється | Codex, exact hashes/bytes у snapshot/checkpoint; зберегти весь поза-allowlist WIP, передати його cold receiver |
| U02 | **Partially resolved:** current Render metadata підтверджує live dep-dbj6j67b9u1s73d6aeb0 для того самого SHA, checksPass, чинні build/start, один worker/not suspended. Runtime health/lease/Auth/actual model/group runtime лишаються unknown | Operations, metadata observation з checkpoint; перед окремим live-health/release claim потрібна адресна дозволена перевірка; повторний deploy не запускати |
| U03 | Pending jobs/remote IDs/uncertain effects/schema state unknown | Integrations/operations, до будь-якого resume/dispatch; reconcile за actual identity без сліпого submit |
| U04 | Human perception анімації, Android/iOS/native UX, довга ресурсна сесія та blind naturalness не підтверджені | Media/conversation/QA, перед відповідними quality claims; збережені технічні докази не замінюють human/device acceptance |
| U05 | Зміст погоджених «5+10» та R3.1 відновлено: 43 повні records / 56 вихідних IDs та первинні PDF23+11 сторінок. Current виконання кожного пункту й human/device/calendar/full-load acceptance не переатестовані | Product/QA, перед закриттям відповідного scope: звірити [повну карту](accepted-development-scope.json) та [первинні тексти](requirements-scope-addendum.md) із current source/evidence. Не повторювати історичну реалізацію автоматично |
| U06 | Authoring archive отриманий і hash звірений; повний індивідуальний inventory/приймання masters/recipes не переперевірені | Media, перед будь-яким видаленням/ремонтом оригіналів; використати exact locator/hash, перевірити повний архів. Не регенерувати прийняте |
| U07 | Поточна придатність кожного з 1107 історичних функціональних тестів не доведена лише CI success; verify success для committed a1fd79d не сертифікує local resource WIP | QA, лише якщо обрана нова задача test audit. Збережений аудит1.13.2 не означає вимогу знову переписати тести |
| U08 | Runtime availability кожного source tool і зовнішні account rights unknown | Integrations, перед конкретною операцією; scope/receipt за фактичним адаптером |
| U09 | Exact managed Work records/всі Mac copies/backup roots unknown | Skill retirement owner, лише після окремого доручення; зараз не блокують docs-перенесення |
| U10 | Product goal після docs-переходу не вибраний; нове аудіо deferred | Власник, наступний продуктовий БРИФ; не починати самовільно voice/нову фічу/деплой |
| U11 | Branch metadata protected=false не доводить усю policy enforcement | Release owner, до майбутнього release за потреби; required verify з AGENTS чинний незалежно від branch API |
| U12 | RELEASE1.13/CHANGELOG містять історичні pre-deploy абзаци поруч із completed narrative | Інтегратор, при зверненні до цього scope; не використовувати tail як current status. Current source/CI/historical receipt відділені |

Ці gaps не є дозволом звузити функції/приватність/якість. Unknown не є pass/unchanged/N/A. Матеріальне рішення запитується лише перед залежним кроком; незалежна документаційна робота продовжується.

Чинне доручення вже дозволяє застосування документації й незалежний intake. Поточні verdict/receipts — у [checkpoint](../migration/checkpoint.json); historical early-review gaps не поновлюють завершені ремонти. Новий голос відкладено, інші нові платні інтеграції потребують окремого конкретного доручення. Git CLI повідомляє invalid token: перед майбутньою публікацією перевірити доступ і за потреби використати підтримуваний gh auth login; це не перешкоджає локальному docs scope.
