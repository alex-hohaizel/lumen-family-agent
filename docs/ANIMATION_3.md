# Анімація Люмена: ревізія 3

Поточний цикл триває 8 секунд. Поза змінюється безперервно: легке дихання, нахил голови до 1,65°, невеликі рухи вух і плаща. Ступні лишаються біля нерухомої контактної тіні. Одне моргання має плавне закривання й відкривання повік. Привітання використовує одну підняту лапку, яка повільно рухається навколо ліктя; кадри з різними положеннями руки не перемикаються. Радість — м’яка усмішка із закритими очима, роздуми — плавний нахил голови до 2,6°.

У відео немає статичної паузи з коротким швидким жестом посередині. Геометрія періодична: стан на 8-й секунді дорівнює стану на початку. Стик стисненого MP4 додатково перевірено за різницею декодованих кадрів. Усім кадрам властиві невеликі зміни руху; дублів сусідніх кадрів у перевірці немає. Це технічні перевірки, а не заміна візуальної оцінки темпу користувачем.

Аватар `lumen-avatar.mp4` — 800×800. `lumen-idle.mp4`, `lumen-waving.mp4`, `lumen-happy.mp4`, `lumen-thinking.mp4` — 512×512. Усі файли: 8 секунд, 60 кадрів/с, H.264, yuv420p, без звуку. Для перегляду окремо надано GIF із нескінченним повторенням; Telegram отримує MP4 через офіційний `setMyProfilePhoto`.

Основне зображення: `assets/lumen.png`. Допоміжні растрові текстури створені вбудованим imagegen за цим оригіналом: `assets/lumen-blink-closed-v3.png`, `assets/lumen-wave-pose-v3.png`. Для моргання використовуються лише локальні ділянки повік; решта обличчя й тіла лишається оригінальною. Сцену, темп і рух розраховує `scripts/animate-rig.py`.

## Відтворення

Встановіть FFmpeg і Python-пакети:

```sh
python3 -m pip install -r scripts/animation-requirements.txt
python3 scripts/animate-rig.py --mode avatar
python3 scripts/animate-rig.py --mode idle
python3 scripts/animate-rig.py --mode waving
python3 scripts/animate-rig.py --mode happy
python3 scripts/animate-rig.py --mode thinking
```

Генерація відео виконується лише при зміні графіки; вона не є частиною запуску бота на Render. При виробництві idle отримано зі зменшеного аватара; повторний прямий рендер може відрізнятися на рівні стиснення.

## Специфікація допоміжних текстур

Вбудований imagegen, режим редагування оригіналу, прозоре тло. Для обох текстур зафіксовані вигляд персонажа, ракурс, освітлення, синій плащ і золотий медальйон. Не використовувалися відеогенерація стороннього сервісу чи зміна персонажа між кадрами.

Повік: change ONLY the two open eyes into gently fully closed eyelids at exactly the same face coordinates; keep all other face and body geometry, original identity, fur, ears, cloak, pendant, hands, feet and framing. One single full-body pose, not a grid; transparent background.

Лапка: change only the right forearm on the viewer’s left; lift the small turquoise-tipped paw in a gentle hello beside the upper chest just below the left cheek; relaxed elbow, palm toward viewer. Preserve original face, body, feet, head position, costume and lighting. Keep the raised paw within the original silhouette width. One single pose, not an animation sheet; transparent background.
