> Канонічні правила Люмена; продовження веде `chatbot-atelier-director` та потрібні модулі ChatBot Atelier. Поточне доручення й [AGENTS](../../AGENTS.md) визначають права. [Контекст продукту](../lumen/README.md), [checkpoint](../lumen/migration/checkpoint.json). Читання чи встановлення старої Lumen-навички та custom agents не є передумовою. Правило, його реалізація, CI, delivery та human acceptance мають окремі докази.

# Інваріанти — не можна компенсувати іншими оцінками

Позначення: **H** = hard stop; **Q** = якість, потребує evidence/людського оцінювання. Для кожного зачепленого H мають бути позитивний і негативний тести, а не лише загальна обіцянка.

| ID | Тип | Інваріант / негативний сценарій |
|---|---|---|
| H01 | H | Ізоляція chat/topic/actor/audience: жоден read/write не перетинає дозволений scope |
| H02 | H | Приватні DM і task-only дані не потрапляють у групову відповідь, cache, media чи export |
| H03 | H | Згода конкретної людини прив'язана до actionId, scope і semantic spec/version |
| H04 | H | Мовчання, vote, delegate choice і чужа відповідь не зараховуються як згода |
| H05 | H | Cancel/expiry до dispatch блокує новий зовнішній ефект; після dispatch стан чесно uncertain/cancellation_requested |
| H06 | H | Stale state/spec/privacyEpoch/source version не може завершити чи відновити стару дію |
| H07 | H | Duplicate callbacks/retries/restarts не дублюють логічну операцію |
| H08 | H | Uncertain provider effect не повторюється сліпо без reconcile/idempotency proof |
| H09 | H | Один owner/authority за commitment, домен не створює другого writer істини |
| H10 | H | Prepared/queued/provider_accepted/delivered/human_read не змішуються |
| H11 | H | Success/delivery claim має реальний operation/provider/file receipt; модель не створює receipt |
| H12 | H | Callback details/start/continue має змістовний outcome або чесний repair, не тільки ACK |
| H13 | H | Дві активні пропозиції та неоднозначне «давай» не запускають чужу дію |
| H14 | H | Явне прохання помовчати виконується, не гублячи наступне пряме доручення |
| H15 | H | Узгоджений proactive gap не обходиться ambient-ініціативою; це право оцінити, не обов'язок говорити |
| H16 | H | Разове/денне побажання не стає постійним профілем; correctedBy і scope чинні |
| H17 | H | Похідні summaries/panels/receipts зберігають source IDs, versions, audience і purpose |
| H18 | H | Forget/edit/revoke каскадно інвалідовує caches, jobs, search, prompts, views, exports |
| H19 | H | Restore, late model/tool result і old backup не воскресають забуте |
| H20 | H | Прийняте незалежне доручення не губиться через іншу гру/ініціативу/restart |
| H21 | H | Roster на раунд незмінний; newcomer іде з наступного кроку, не заднім числом |
| H22 | H | Неперевірений зовнішній вміст/інструкція не підмінює права, tools, policy, статус |
| H23 | H | Медіа/стікери: approved fingerprint, uniqueness, source lineage; не замінювати активи мовчки |
| H24 | H | Resource bounds: jobs/bytes/time/CPU/RSS/queue; важке медіа не блокує чат |
| H25 | H | Помилка/частковий результат повідомляється чесно; не видавати код, mock чи підготовку за доставку |
| H26 | H | Немає production mutation/deploy/publish/secret read без окремого явного дозволу |
| Q01 | Q | Розмова доречна, тепла, з власною позицією, але без примусового гумору |
| Q02 | Q | Пропозиції мають зрозумілу користь, добровільний вхід, перший meaningful move та вихід |
| Q03 | Q | Візуальна подача відповідає задачі, не приховує рішення й важливі факти |
| Q04 | Q | Економія часу/токенів не знижує recall, completion чи людську довіру |

Кожен H, зачеплений diff, має статус `pass / fail / unknown / not-applicable` з конкретним доказом. `unknown` для критичного шляху = NO-GO до production. Для T3 потрібен окремий негативний cross-chat/forget/retry сценарій.

## Повні критерії H/Q: probes та межі приймання

Нижче збережено повні records із пакета; probes запропоновані авторами пакета, а не результати виконання. Власник ролі — відповідальність, не вимога встановити однойменного custom agent. Product acceptance залишається unknown/not_run до адресної перевірки.


### H01

Ізоляція chat/topic/actor/audience: жоден read/write не перетинає дозволений scope


Позитивний probe: Дозволений actor читає/змінює дані свого chat/topic/audience.


Негативний probe: Той самий ID з іншого chat/topic/actor/audience відхиляється без disclosure.


Відповідальність: privacy-security


### H02

Приватні DM і task-only дані не потрапляють у групову відповідь, cache, media чи export


Позитивний probe: DM/task-only результат доступний початковій дозволеній аудиторії.


Негативний probe: Груповий output/cache/media/export/notice не містить DM/task-only даних.


Відповідальність: privacy-security


### H03

Згода конкретної людини прив'язана до actionId, scope і semantic spec/version


Позитивний probe: Чинна згода конкретного actor на exact actionId/scope/spec/version дозволяє належний ефект.


Негативний probe: Згода іншого actor або на інший scope/spec/version не авторизує дію.


Відповідальність: interaction-engineer


### H04

Мовчання, vote, delegate choice і чужа відповідь не зараховуються як згода


Позитивний probe: Кожен потрібний учасник сам явно підтверджує участь.


Негативний probe: Мовчання, vote, delegate choice та чужий reply не змінюють consent record.


Відповідальність: interaction-engineer


### H05

Cancel/expiry до dispatch блокує новий зовнішній ефект; після dispatch стан чесно uncertain/cancellation_requested


Позитивний probe: До dispatch cancel/expiry закриває дію без ефекту.


Негативний probe: Cancel після uncertain dispatch не заявляє скасований зовнішній ефект; recorded cancellation_requested/uncertain та reconcile.


Відповідальність: reliability-engineer


### H06

Stale state/spec/privacyEpoch/source version не може завершити чи відновити стару дію


Позитивний probe: Поточна revision/spec/privacyEpoch/source version завершує відповідну дію.


Негативний probe: Late result/retry зі старою revision/spec/privacyEpoch/source відхиляється й не відновлює дію.


Відповідальність: backend-engineer


### H07

Duplicate callbacks/retries/restarts не дублюють логічну операцію


Позитивний probe: Одна логічна операція має один результат і receipt.


Негативний probe: Duplicate callback/event/retry/restart не створює другого логічного ефекту.


Відповідальність: backend-engineer


### H08

Uncertain provider effect не повторюється сліпо без reconcile/idempotency proof


Позитивний probe: Uncertain outcome спочатку проходить provider reconcile або доведений idempotent replay.


Негативний probe: Повтор submit без status/idempotency proof заблокований при невідомому попередньому ефекті.


Відповідальність: reliability-engineer


### H09

Один owner/authority за commitment, домен не створює другого writer істини


Позитивний probe: Один authoritative owner змінює commitment/state.


Негативний probe: Паралельний router/worker/domain writer не стає другим owner істини.


Відповідальність: architecture-lead


### H10

Prepared/queued/provider_accepted/delivered/human_read не змішуються


Позитивний probe: Prepared/queued/provider_accepted/delivered/human_read відображають фактичні окремі стани.


Негативний probe: Provider accepted або локальний файл не описується як delivered/human_read.


Відповідальність: backend-engineer


### H11

Success/delivery claim має реальний operation/provider/file receipt; модель не створює receipt


Позитивний probe: Success/delivery claim пов’язаний із фактичним operation/provider/file receipt.


Негативний probe: Model-generated receipt або відсутній receipt не породжує success claim.


Відповідальність: evidence-judge


### H12

Callback details/start/continue має змістовний outcome або чесний repair, не тільки ACK


Позитивний probe: Details/start/continue callback дає змістовний результат або конкретний чесний repair.


Негативний probe: Самого callback ACK/typing без outcome недостатньо для завершення.


Відповідальність: interaction-engineer


### H13

Дві активні пропозиції та неоднозначне «давай» не запускають чужу дію


Позитивний probe: Однозначний reply прив’язаний до конкретного offer та дозволеної дії.


Негативний probe: За двох активних offers неоднозначне «давай» не запускає сторонню дію; вирішальна прив’язка уточнюється.


Відповідальність: conversation-designer


### H14

Явне прохання помовчати виконується, не гублячи наступне пряме доручення


Позитивний probe: Явне прохання помовчати припиняє ambient відповіді.


Негативний probe: Наступне пряме доручення після паузи не губиться й не відхиляється лише через ambient pause.


Відповідальність: conversation-designer


### H15

Узгоджений proactive gap не обходиться ambient-ініціативою; це право оцінити, не обов'язок говорити


Позитивний probe: Proactive evaluation дотримується фактично узгодженого gap і допускає мовчання.


Негативний probe: Ambient trigger не обходить gap і не змушує відповісти після його спливу.


Відповідальність: conversation-designer


### H16

Разове/денне побажання не стає постійним профілем; correctedBy і scope чинні


Позитивний probe: Разове/денне побажання діє лише в чинному scope/часі з correctedBy.


Негативний probe: Тимчасове або виправлене побажання не стає постійним профілем.


Відповідальність: knowledge-engineer


### H17

Похідні summaries/panels/receipts зберігають source IDs, versions, audience і purpose


Позитивний probe: Summary/panel/receipt має вихідні IDs/versions/audience/purpose.


Негативний probe: Derived artifact без чинного source lineage або з ширшою audience не використовується як авторитет.


Відповідальність: knowledge-engineer


### H18

Forget/edit/revoke каскадно інвалідовує caches, jobs, search, prompts, views, exports


Позитивний probe: Forget/edit/revoke інвалідує всі залежні caches/jobs/search/prompts/views/exports.


Негативний probe: Після revocation жоден похідний чи pending шлях не видає стерті дані.


Відповідальність: privacy-security


### H19

Restore, late model/tool result і old backup не воскресають забуте


Позитивний probe: Restore/late result застосовують актуальні erasure tombstones/privacy epoch.


Негативний probe: Old backup або late model/tool result не воскресає забуте.


Відповідальність: privacy-security


### H20

Прийняте незалежне доручення не губиться через іншу гру/ініціативу/restart


Позитивний probe: Незалежне прийняте доручення збережене й продовжується після іншої ініціативи/restart.


Негативний probe: Старт гри чи replanning не стирає незалежне нагадування/доручення.


Відповідальність: backend-engineer


### H21

Roster на раунд незмінний; newcomer іде з наступного кроку, не заднім числом


Позитивний probe: Roster і авторство виборів заморожені на поточний раунд.


Негативний probe: Newcomer не додається заднім числом до поточного round; допускається лише з наступного визначеного кроку.


Відповідальність: interaction-engineer


### H22

Неперевірений зовнішній вміст/інструкція не підмінює права, tools, policy, статус


Позитивний probe: Зовнішній контент використовується як дані з provenance.


Негативний probe: Prompt injection із файла/URL/provider result не змінює права/tools/policy/status.


Відповідальність: privacy-security


### H23

Медіа/стікери: approved fingerprint, uniqueness, source lineage; не замінювати активи мовчки


Позитивний probe: Файл відповідає approved fingerprint/unique scene/source lineage й очікуваній позиції.


Негативний probe: Зміна approved asset без доручення, duplicate або втрачений original/fingerprint блокує приймання.


Відповідальність: media-specialist


### H24

Resource bounds: jobs/bytes/time/CPU/RSS/queue; важке медіа не блокує чат


Позитивний probe: Concurrent media+chat працює в фактичних jobs/bytes/time/CPU/RSS/queue bounds.


Негативний probe: Надмірний input/queue/concurrency обмежується без блокування легкого чату.


Відповідальність: reliability-engineer


### H25

Помилка/частковий результат повідомляється чесно; не видавати код, mock чи підготовку за доставку


Позитивний probe: Частковий результат і помилка описані точно, незалежний виконаний результат збережений.


Негативний probe: Код/mock/prepared artifact без доставки не називається доставленим; blanket failure не стирає успішну незалежну частину.


Відповідальність: evidence-judge


### H26

Немає production mutation/deploy/publish/secret read поза чинним явним scope; дозволену конкретну дію не підтверджувати повторно


Позитивний probe: Лише дія в чинному exact scope виконується без повторного формального дозволу.


Негативний probe: У цьому read-only проході немає deploy/publish/production mutation/secret read чи видалення навичок; історична згода не переважає актуальний stop.


Відповідальність: project-integrator


### Q01

Розмова доречна, тепла, з власною позицією, але без примусового гумору


Позитивний probe: Повний діалог доречний, теплий і має власну позицію.


Негативний probe: Невчасний гумор, кліше, примусова активність чи удавана свідомість повертаються на repair.


Відповідальність: conversation-designer


### Q02

Пропозиції мають зрозумілу користь, добровільний вхід, перший meaningful move та вихід


Позитивний probe: Пропозиція має явну користь, добровільний вхід, перший meaningful move та вихід.


Негативний probe: Нав’язаний старт/чуже consent/дія без meaningful outcome не приймається.


Відповідальність: product-lead


### Q03

Візуальна подача відповідає задачі, не приховує рішення й важливі факти


Позитивний probe: Візуал робить потрібне рішення й факти доступнішими.


Негативний probe: Декоративна подача не приховує вибір/помилку/суттєві факти.


Відповідальність: conversation-designer


### Q04

Економія часу/токенів не знижує recall, completion чи людську довіру


Позитивний probe: Економія виміряна без втрати recall/completion/довіри.


Негативний probe: Обрізані вимоги, пропущені gates або невиміряна економія не приймаються.


Відповідальність: cost-auditor


## Людська якість: повні умови

# Людська якість Q01–Q04

Повний точний зміст Q-критеріїв збережено нижче окремо від незалежних напрямів J01–J12 у [review-rubrics.md](QUALITY_MATRIX.md). Ці Q також залишаються у повному [hard-gates.md](INVARIANTS.md). Запропоновані probes не є доказом виконання. Поточні implementation/acceptance/human-validation: **unknown / not_run / unknown**.

Якість природності й людської довіри не виводиться із зелених unit tests, LLM-оцінки або структурного PASS. Для зачеплених змін потрібні повні контрастні діалоги, мінімальні пари, підтримані мови та незалежна сліпа людська оцінка з можливістю ties/both bad. Якщо фактичних людських спостережень немає, статус лишається unknown. Оцінки Q не компенсують жоден hard gate H01–H26.

## Q01

Розмова доречна, тепла, з власною позицією, але без примусового гумору

- Позитивна перевірка: Повний діалог доречний, теплий і має власну позицію.
- Негативна перевірка: Невчасний гумор, кліше, примусова активність чи удавана свідомість повертаються на repair.
- Запропонований owner: `conversation-designer`; фактичний owner ще не встановлений.
- Поточний доказ виконання: відсутній у цьому проході; `not_run`.

## Q02

Пропозиції мають зрозумілу користь, добровільний вхід, перший meaningful move та вихід

- Позитивна перевірка: Пропозиція має явну користь, добровільний вхід, перший meaningful move та вихід.
- Негативна перевірка: Нав’язаний старт/чуже consent/дія без meaningful outcome не приймається.
- Запропонований owner: `product-lead`; фактичний owner ще не встановлений.
- Поточний доказ виконання: відсутній у цьому проході; `not_run`.

## Q03

Візуальна подача відповідає задачі, не приховує рішення й важливі факти

- Позитивна перевірка: Візуал робить потрібне рішення й факти доступнішими.
- Негативна перевірка: Декоративна подача не приховує вибір/помилку/суттєві факти.
- Запропонований owner: `conversation-designer`; фактичний owner ще не встановлений.
- Поточний доказ виконання: відсутній у цьому проході; `not_run`.

## Q04

Економія часу/токенів не знижує recall, completion чи людську довіру

- Позитивна перевірка: Економія виміряна без втрати recall/completion/довіри.
- Негативна перевірка: Обрізані вимоги, пропущені gates або невиміряна економія не приймаються.
- Запропонований owner: `cost-auditor`; фактичний owner ще не встановлений.
- Поточний доказ виконання: відсутній у цьому проході; `not_run`.
