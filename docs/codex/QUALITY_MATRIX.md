> Канонічні правила Люмена; продовження веде `chatbot-atelier-director` та потрібні модулі ChatBot Atelier. Поточне доручення й [AGENTS](../../AGENTS.md) визначають права. [Контекст продукту](../lumen/README.md), [checkpoint](../lumen/migration/checkpoint.json). Читання чи встановлення старої Lumen-навички та custom agents не є передумовою. Правило, його реалізація, CI, delivery та human acceptance мають окремі докази.

# 12 напрямів незалежної експертизи (J01–J12)

Матриця відновлена за аудитом Люмена 1.11. **Це критерії**, а не наказ запускати 12 AI-субагентів для кожної зміни.

| Напрям | Питання оцінки | Доказ |
|---|---|---|
| J01 Соціальна увага | Чи правильно бот обирає мовчати/відповідати і адресата? | Контрастні діалоги, direct/other reply |
| J02 Прив'язка й уточнення | Чи не плутає два offers і не перепитує відоме? | old answer, ambiguous referent |
| J03 Характер | Чи впізнаваний, не шаблонний, без нав'язливого гумору? | Blind human A/B, ties/both bad |
| J04 Ініціативи | Чи є реальна користь, добровільний старт і вихід? | Activity experience, first meaningful move |
| J05 Згода | Чи не приписує участь іншому, чи зберігає авторство? | Named/open roster, revoke |
| J06 Виконання/recovery | Чи відновлюється робота після crash/timeout? | Dispatch/restart/cancel traces |
| J07 Telegram UX | Чи кнопки/деталі/мова/видимі факти правильні? | Callback, Android/iOS smoke |
| J08 Творча композиція | Чи причинно впливають вибори людей, а не лише декор? | Frozen registry, novel composition |
| J09 Пам'ять | Чи коректні тимчасові preferences, scope і forget? | 1/5/20-turn replay, privacy tests |
| J10 Правда/repair | Чи немає fabricated success, чи є чесний recovery? | Outcome receipts, negative controls |
| J11 Приватність | Чи безпечні forget, late result, restore, DM? | Cross-chat, revoke, erasure cascade |
| J12 Реалізація/ресурси | Чи немає подвійних owner, неконтрольованої ціни? | Profiling, load, tests, CI, limits |

Оцінки 1–5 допустимі для Q, але **hard gate завжди окремий**. За відсутності реальних користувацьких спостережень статус «людська природність» = unknown, навіть якщо LLM judge дав 5/5. Для великої зміни порівнювати frozen old/new на 8 типах контексту й фіксувати negatives. Не оголошувати відсотки успіху без знаменників.

## Повні J01–J12: питання та належні докази


### J01

Соціальна увага

Чи правильно бот обирає мовчати/відповідати і адресата?

Доказ: Контрастні діалоги, direct/other reply


### J02

Прив'язка й уточнення

Чи не плутає два offers і не перепитує відоме?

Доказ: old answer, ambiguous referent


### J03

Характер

Чи впізнаваний, не шаблонний, без нав'язливого гумору?

Доказ: Blind human A/B, ties/both bad


### J04

Ініціативи

Чи є реальна користь, добровільний старт і вихід?

Доказ: Activity experience, first meaningful move


### J05

Згода

Чи не приписує участь іншому, чи зберігає авторство?

Доказ: Named/open roster, revoke


### J06

Виконання/recovery

Чи відновлюється робота після crash/timeout?

Доказ: Dispatch/restart/cancel traces


### J07

Telegram UX

Чи кнопки/деталі/мова/видимі факти правильні?

Доказ: Callback, Android/iOS smoke


### J08

Творча композиція

Чи причинно впливають вибори людей, а не лише декор?

Доказ: Frozen registry, novel composition


### J09

Пам'ять

Чи коректні тимчасові preferences, scope і forget?

Доказ: 1/5/20-turn replay, privacy tests


### J10

Правда/repair

Чи немає fabricated success, чи є чесний recovery?

Доказ: Outcome receipts, negative controls


### J11

Приватність

Чи безпечні forget, late result, restore, DM?

Доказ: Cross-chat, revoke, erasure cascade


### J12

Реалізація/ресурси

Чи немає подвійних owner, неконтрольованої ціни?

Доказ: Profiling, load, tests, CI, limits
