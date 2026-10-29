import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent
REPO=ROOT.parents[1]
FACES='😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 🫠 😉 😊 😇 🥰 😍 🤩 😘 😗 ☺️ 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🫢 🫣 🤫 🤔 🫡 🤐 🤨 😐 😑 😶 🫥 😶‍🌫️ 😏 😒 🙄 😬 😮‍💨 🤥 🫨 🙂‍↔️ 🙂‍↕️ 😌 😔 😪 🤤 😴 🫩 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 😵‍💫 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 🫤 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😫 😩 🥱 🫪 😤'.split()
EXTRA='😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👻 🤖'.split()
GESTURES='❤️ 👍 🙏 🤦 🤷'.split()
DATA='''😀|Сонячне привітання|joy|Huge open happy smile, both arms welcoming wide, standing on a tiny springy cushion with cape opening like a sunrise; a cheerful little bounce. Different from waving hello.
😄|Щоки до вух|joy|Sitting on his haunches with eyes squeezed into happy crescents and lifted cheeks, open delighted smile, paws holding cheeks, two little golden sunlight sparkles; gentle shoulder giggles.
🙃|Світ догори дриґом|irony|ENTIRE full body curled upside down in midair in a compact playful somersault. BOTH rear paws visible near the TOP, round belly and whole cape in the middle, front paws curled to chest, inverted head and ears at the BOTTOM. Calm ironic little smile, small rocking motion only. At least 18 percent padding around the complete silhouette. No external rope, ribbon or support. No cropped torso or limbs.
🫠|Я розтанув|awkward|Literally slumped into a soft fluffy cream-and-turquoise puddle, ears drooping out sideways, navy cloak pooled around, crooked embarrassed smile, tired half-lidded eyes; golden medallion on the puddle and one tiny ice cube beside the cheek. Body settles and softly regathers a little.
😇|Я нічого не робив|innocence|An innocent halo hovers over the large ears, paws tucked behind his back, sweet closed-eye smile, tiny feather wings pinned onto his navy cloak. The slightly crooked halo wobbles as he makes a small innocent bow.
🤩|Очі сяють|wonder|Sparkling golden star shapes reflected in his huge blue eyes, delighted open mouth, paws reaching toward a tiny floating faceted turquoise comet; cape lifted behind by excitement. Small eager lift onto his toes.
😗|Просто цьом|affection|Standing three-quarter profile, eyes gently open and round puckered kiss mouth, both paws behind his back, leaning forward to give a simple kiss. No heart and no wink, expressive little forward-and-back movement.
😚|Ніжний цьом|affection|Curled sideways in his own cloak like a shy soft bundle, eyes squeezed closed with rosy cheeks and puckered kiss mouth, paws hugging his chest. Gentle head tilt into the kiss, no floating hearts.
😙|Цьом із усмішкою|affection|Standing on one rear paw in a graceful pose, eyes softly smiling closed, lips puckered, one little front paw raised elegantly and the other holding a tiny plain flower. Light airy sway as if whistling a kiss, no hearts.
🥲|Усмішка крізь сльози|mixed|A brave small smile with one big clear blue tear on one cheek, ears slightly low, holding his patched cape together over his heart. He straightens up while carefully wiping the single tear, visibly bittersweet rather than crying loudly.
😛|Язик-пустун|playful|Mischievous open eyes, short round pink tongue stuck out, one paw on hip and the other holding a tiny turquoise ice pop. Slight teasing forward lean with a small ear flick.
😜|Дражнюся|playful|One eye tightly winking and the other bright open, tongue sticking out playfully; one paw tosses a small golden toy star upward while his cape curls around his hip. A cheeky little side step.
🤪|Мене понесло|silly|Wild silly face with one eye comically larger, tongue peeking to one side, ears at different angles; he is tangled harmlessly in a loose turquoise yarn spool and laughing at himself. Wobbles sideways while keeping all anatomy coherent.
😝|Бешкетний регіт|silly|Both eyes scrunched shut, tongue stuck out with an exuberant grin, paws spreading his navy cape like carnival wings. A gleeful little hop, entirely different silhouette from the other tongue faces.
🤑|Очі на монетки|money|Gleaming gold coin-shaped reflections in the eyes, excited money-mouth grin, tongue showing a tiny gold coin; hugging an open small treasure chest of toy golden coins. He tips the chest a little and catches one coin, no written currency symbols.
🤭|Тихий хіхік|secret|Eyes curved in suppressed laughter, one soft paw covers the smiling mouth, other paw presses his belly, shoulders hunched forward and cape drawn inward. Small concealed giggles.
🫢|Ой, я це сказав|surprise|Both eyes wide open, surprised eyebrows and a paw firmly over the mouth; the other paw has just dropped a tiny acorn beside his foot. A startled little recoil with frozen shocked expression, not a laughing face.
🫣|Страшно, але дивлюся|shy|Crouched in a rounded navy cloak bundle, both paws cover the face but one eye peeks between them, giant ears poking out. He peeks and hides slightly without becoming fully invisible.
🤫|Тихіше|secret|One small paw held vertically to his puckered lips in a clear hush gesture, other paw closes the cloak over his chest, alert gentle eyes. A small crescent-moon charm hangs near one ear; slow quiet forward lean.
🫡|Прийняв, зроблю|respect|Proud upright stance, one paw touching his brow in a crisp playful salute, another tucked behind his back, sincere closed-mouth smile; a tiny polished extra medal on the cloak. Small respectful nod, no military insignia or weapon.
🤐|Рот на замочок|silence|A small neat gold zipper motif closes across the muzzle without changing the nose, one paw holds a tiny golden key, the other points to the zipper. Firm tight-lipped expression with wide honest eyes, gently turns the key at his chest.
🤨|Є питання|skeptic|One eyebrow sharply raised, other lowered, mouth slightly skeptical, arms folded with one paw touching the chin; one folded blank blue note held under the arm. Suspicious small side-eye and head tilt, no magnifying glass.
😐|Без коментарів|neutral|Perfectly straight neutral mouth, open unamused eyes, rigid upright body and paws hanging straight down; one tiny stopped hourglass at his feet. Barely perceptible slow blink and breathing, restrained motion.
😑|Ну так, звісно|neutral|Eyes are two flat closed lines, mouth flat and unimpressed, sitting with paws resting on his knees while a lopsided little pancake stack tilts beside him. A slow dry head dip, no smile.
😶|Слів немає|silence|No visible mouth at all on the fluffy muzzle, but the original blue nose and cheeks remain; eyes wide, both open paws lifted in a speechless shrug. Blank paper slips rest near his feet, no text or punctuation.
🫥|Мене тут немає|withdrawal|The fluffy character shyly fades into a delicate dotted turquoise contour while the cloak and medallion stay recognizable; one paw makes a tiny awkward wave. Gentle partial fade and return, never an empty frame and never a new background.
😶‍🌫️|Голова в тумані|confusion|His face and large ears peek out of a small fluffy cream mist cloud wrapped around his hood; two tired eyes visible through the haze, paws parting the fog at his cheeks. Mist drifts gently and the body sways a little.
😒|Оце все?|displeasure|Deep unimpressed sideways gaze, heavy eyelids and slightly downturned mouth, one cheek resting on a paw, leaning on one tiny empty turquoise teacup. A slow skeptical side glance with a low slouched silhouette.
😬|Ох, незручно|awkward|Tense stretched closed grin with just his natural two small front teeth, wide worried eyes, gripping the edges of his cloak as his feet are caught in a loose gift ribbon. A small stiff embarrassed shudder, no extra rows of human teeth.
😮‍💨|Видихнув|relief|Long visible soft sigh of pale air from his mouth, shoulders visibly dropping, tired eyes softening; leaning on his folded navy cloak like a rolled bolster. Slow exhale and relaxed settling, no smoke rectangle.
🤥|Ну майже правда|lying|Comic little wooden Pinocchio extension sits over the original blue nose, guilty sideways eyes, paws hiding a small empty cookie jar behind his back with one crumb at his foot. Nose wiggles slightly as he avoids eye contact.
🫨|Мене трусить|shock|Huge startled open eyes and round open mouth, ears stiff out sideways, paws splayed; small turquoise motion dashes show a comic whole-body tremble. One coherent character shaking slightly side to side, no duplicated heads or ghost characters.
🙂‍↔️|Ні, дякую|no|Gentle clear no gesture, eyes peacefully closed and a tiny polite smile, arms folded low across the belly. His head alternates only slightly left and right while the body stays planted and the cape softly follows.
🙂‍↕️|Саме так|yes|Gentle affirmative nod, soft closed eyes and content little smile, both paws resting together over his medallion. Head moves slightly down and up in a respectful bow while feet stay planted.
😌|Нарешті спокій|calm|Eyes softly closed, relaxed satisfied smile and shoulders low, sitting on a tiny navy cushion with a warm plain turquoise teacup held at his belly. A peaceful small breath and slow head tilt.
😪|Вже засинаю|sleep|Very heavy half-shut eyelids, drooping ears and a translucent little sleep bubble at his nose; one small pillow under his arm, standing sleepily. The bubble gently grows and shrinks as his head nods.
🤤|Аж слинки течуть|appetite|Dreamy half-closed eyes and a tiny clear drool strand at one corner of the open smile, both paws presenting a delicious cinnamon bun on a small plain plate. Leans slowly toward the bun and blinks in anticipation.
😴|Солодких снів|sleep|Sleeping deeply curled in his navy cloak as a blanket, eyes fully closed and medallion softly dimmed, giant ears tucked comfortably; two tiny moon-shaped sparkles above. Gentle breathing throughout, no Z letters or written sound effects.
🫩|Ніч була довга|fatigue|Clearly tired open eyes with pronounced soft dark under-eye bags, rumpled turquoise tuft and drooping ears; slumped between two tiny empty coffee mugs with a nearly burned candle. A slow exhausted head wobble and blink, no sleeping bubble.
😷|Бережу вас|illness|Plain pale-turquoise medical mask covering the muzzle, original blue eyes tired but gentle, soft paws pulling his navy cloak around his shoulders. A small careful breath and cough into the elbow, no words or medical cross logo.
🤒|Температурю|illness|Small thermometer tucked to the side of his mouth, warm rosy cheeks and tired eyes, wrapped in a folded turquoise blanket under his navy cloak. Checks the plain thermometer with no readable numbers and shivers gently.
🤕|Трохи побитий життям|illness|One neat white bandage wrapped around the forehead and across one ear, dazed unhappy eyes and a small pouting mouth; sitting against a tiny soft pillow. Gently touches the bandage, no blood or wound.
🤢|Щось недобре|disgust|Queasy green-tinted cheeks on his otherwise cream fur, lips pressed tight, both paws on the belly and ears low; a small empty teal bucket sits beside him. His cheeks puff and shoulders hunch as he holds it in.
🤮|Все, не можу|disgust|Bent forward over a tiny teal bucket, eyes scrunched tight and mouth aimed into it, a simple comic green ribbon-like splash inside the bucket, no realistic bodily detail. He retches gently and wipes his mouth with a soft cloth, cute exaggerated cartoon staging.
🤧|Апчхи|illness|Eyes squeezed closed during a sneeze into an oversized soft white handkerchief held by both paws, ears lifted by the sneeze and cape flaring slightly. Tissue billows in small coherent steps, no written sound effects.
🥵|Плавлюся від спеки|temperature|Hot rosy face with a large sweat bead, tongue a little out and exhausted eyes; navy cloak open, one paw fans himself with a large cool green leaf. Gently panting and fanning, original cream fur remains recognizable.
🥶|Змерз до кісточок|temperature|Shivering inside a transparent small blue ice block around the lower body, frost crystals on the cloak hem and huge trembling ears, worried wide eyes and clenched two front teeth. Both paws hug his chest for warmth.
🥴|Щось мене хитає|dizzy|Asymmetric woozy eyes, wavy crooked mouth and one folded ear, leaning sideways against a giant loose turquoise drinking straw like a walking stick. Slow comical unsteady sway, no alcoholic branding.
😵|Вимкнувся|dizzy|Soft cartoon X shapes over the eyes, mouth slack and ears flopped, lying dramatically sideways on a tiny navy mat with one golden toy star near his head. A harmless dazed wobble and tiny paw twitch, no injury or gore.
😵‍💫|Світ закрутився|dizzy|Blue spiral reflections in both wide eyes, mouth small and stunned, paws bracing his dizzy head; a turquoise top spins beside his feet with a small orbiting golden star. Gentle whole-head wobble, no separate flying body parts.
🤯|Мозок вибухнув|wonder|A soft cloud of turquoise fluff bursts upward above the head like a magical thought explosion, eyes huge and mouth open in astonishment, both paws spread outward. Golden crystal confetti lifts and settles; skull intact, no brain or gore.
🤠|Ну що, ковбої|playful|A tiny brown cowboy hat above the big turquoise ears, confident cheerful grin, one paw twirls a small soft golden rope loop while another hooks the cloak at the hip. A jaunty gentle bounce, no weapon.
🥸|Мене не впізнаєте|disguise|Comically oversized round glasses with a clearly fake black moustache and bushy false eyebrows, original fluffy ears and navy cloak visible, peeking over a small folded blank newspaper. He lowers the paper slightly and glances sideways.
🤓|Зараз поясню|clever|Oversized square black spectacles magnify the bright blue eyes, proud two-tooth smile; one paw holds an open blank navy book and another raises a tiny golden light bulb on a handle. An eager explaining nod, no letters or equations.
🧐|Роздивлюся уважно|curious|A single polished brass monocle on one eye with its gold cord, other eyebrow raised, head leaning forward to inspect a small turquoise crystal held in one paw. Slowly lifts the crystal and tilts his head, no hand-held magnifying glass.
😕|Не зрозумів|confusion|Puzzled uneven eyebrows and slight frown, head canted, both paws holding one turquoise puzzle piece beside an empty round puzzle frame it clearly does not fit. Slowly rotates the piece with a confused little shrug.
🫤|І так, і ні|ambivalence|Clearly diagonal slanted mouth, one eyebrow uncertain, both paws holding two differently tilted tiny teacups as if weighing options. He alternates the cup heights in a small indecisive balance, ears at uneven angles.
😟|Тривожуся|worry|Worried upward inner eyebrows, small tight frown and big concerned eyes, paws clutching the medallion while an unopened small navy umbrella rests against his leg. Hunched posture with a small nervous breath.
🙁|Трохи прикро|sadness|Small simple downturned mouth and quietly sad eyes, ears gently drooping; standing with folded paws and one tiny drooping flower at his feet. A soft small head dip, restrained rather than dramatic crying.
☹️|Зовсім невесело|sadness|A deep clear downturned frown, large sad blue eyes, sitting low with knees tucked in and cloak wrapped into a rounded bundle; one small translucent raincloud with a few blue drops above an ear. Slow sad sway, no broad background.
😮|Ого|surprise|Round open O mouth, eyebrows raised and wide eyes, both paws hovering above a small tilted empty teacup. A modest surprised backward lean and ear lift, less extreme than astonishment.
😯|Нічого собі|surprise|Hushed small round mouth and very wide attentive eyes, one paw half-raised as if pausing a conversation, other palm open low by his belly. Upright stillness with a tiny intake of breath, no dropped prop.
😲|Щелепа відпала|surprise|Huge astonished open mouth showing only the natural two upper teeth, eyes wide and brows high, body balanced backward on one rear paw with both front paws flung out. Navy cape curls behind, a blank scroll slipping from one paw.
🥹|Ледь стримую сльози|mixed|Both blue eyes glossy and welling with clear tears, tiny grateful trembling smile, paws carefully holding one little forget-me-not flower to his chest. He blinks gently and hugs the flower, no large tear streams.
😦|Ой, щось сталося|worry|Open worried mouth with raised inner brows, eyes fixed anxiously forward, one paw at his cheek while the other holds a folded turquoise comfort blanket. A small concerned forward lean and ear drop.
😧|Тепер я хвилююся|worry|Anxious open mouth, tense upward eyebrows and big alarmed eyes, both paws gripping the sides of his hood with knees slightly bent. He pulls the hood closer and recoils a little, no laughter.
😨|Мені страшно|fear|Pale shocked expression with wide eyes and a small open mouth, ears stiff out sideways, body shrinking behind one oversized plain navy book used as a shield. Paws grip the book edge as he peeks and trembles.
😰|Холодний піт|fear|Frightened wide eyes, blue sweat drop at the forehead and anxious open mouth; both paws grip a small turquoise life ring around his belly. Tiny full-body nervous tremble, cape tucked close.
😥|Пронесло, але боляче|mixed|Sad relieved eyes with a single blue tear and a small downturned mouth, ears weary, paws wringing a tiny damp cloth in front of the chest. Slowly exhales and lowers his shoulders, visibly bittersweet.
😱|Ааа, що це|fear|Both paws pressed to his cheeks, mouth wide in a clear silent scream and huge white-rimmed blue eyes, ears standing upright, cape stretched by the backward recoil. Three tiny pale fright sparks above his head, no written scream.
😖|Як же неприємно|strain|Scrunched squeezed-shut eyes, wavy tight mouth and tense cheeks, both paws pushing outward at chest height while loose thread harmlessly tangles around his feet. He recoils and tries to untangle one foot.
😣|Тримаюся з останніх сил|strain|Eyes tightly pinched, determined strained closed mouth, body leaning forward with both paws pushing an oversized turquoise round button like a heavy wheel. Feet planted wide and cloak trailing behind; small effortful rocking.
😞|Не так сподівався|disappointment|Eyes lowered in disappointment and ears drooped, sitting with a small opened empty gift box between his paws. Looks into the box and lets his shoulders sink slowly, no tear stream.
😓|Ох і ніяково|awkward|Downcast closed eyes, one large cold-sweat bead on the forehead and a tight embarrassed frown, paw wiping the brow with his cape sleeve. Shoulders hunched and the other paw fidgeting at the medallion.
😫|Я більше не вивожу|fatigue|Exhausted eyes squeezed shut with an open weary groan, ears drooping, dragging his feet under an oversized stack of soft turquoise pillows tied loosely with ribbon. Slowly staggers one small step, no strain on detached limbs.
🥱|Позіхаю на весь світ|sleep|One paw politely covers a huge yawning mouth while the other holds the edge of a small pillow, sleepy half-closed eyes and ears drooping backward. A slow big yawn and tiny stretch, standing in his navy cloak.
🫪|Мене перекосило|absurd|Comically bulging very wide eyes with uneven pupils, squashed fluffy cheeks and a wobbly open mouth, his face gently squeezed between two oversized marshmallow pillows held in his own paws. Body and anatomy stay intact; a small rubbery cheek squeeze and release, recognizable original character.
😤|Зараз як зберуся|anger|Determined deeply furrowed eyebrows, tight mouth and two tiny puffs of pale steam from his nostrils; arms folded firmly and feet planted wide, navy cloak bristling behind. A little indignant stamp, not a happy smile.
😡|Закипаю|rage|Furiously lowered eyebrows, vivid red blush across the cream cheeks and glaring blue eyes, both paws squeeze a red stress ball while the navy cloak flares outward. Small boiling angry shudder, two natural teeth only, no violent act.
😠|Мене це дратує|anger|Angry flat frown and sharply lowered brows, paws firmly on hips, one foot tapping with impatience, ears held low and sideways. A small turquoise kettle beside the foot emits one indignant puff; cream fur remains original.
🤬|Слова закінчилися|rage|Extremely frustrated glaring face with puffed cheeks, a small floating black rounded censor strip directly before the mouth bearing only the white punctuation symbols @#$!, front paws clenched by the chest. Angry comic foot stamp, no real slur or letters.
😈|Є капосний план|mischief|Playful violet hood with two soft toy horns sits over the original large ears, unmistakable sly crooked grin, rubbing his paws above a tiny harmless prank gift box with a spring peeking out. Mischievous little forward lean, original cream fur and medallion visible.
👿|Я вже не жартую|dark_anger|Violet hood with two soft toy horns, angry deep frown and glaring eyes, arms folded tight and one foot stomping once beside a little crumpled blank paper. Clearly sulking irritated impish mood, original Lumen body and cream fur intact.
💀|Я помер зі сміху|dark_humor|Dramatic harmless meme flop: Lumen lies sprawled on his back on a tiny navy pillow, a small ivory theatrical skull half-mask resting above his face, eyes cartoon X-shaped and one paw hanging limply. Tiny ivory bone-shaped pillow beside him; a faint exhausted chuckle twitch, no real death or gore.
☠️|Обережно, токсично|warning|Lumen cautiously recoils from a tiny sealed purple potion cauldron with a bold simple ivory skull-and-crossbones emblem, eyebrows worried and one paw holding his nose, the other holding a little plain black pirate flag with the same emblem. Small comic purple vapor curl, no realistic poison or instructions.
💩|Ну й результат|disgust|Deep unimpressed half-lidded face, one paw pinching his blue nose, another holding a small silver tray with a tiny glossy brown poop-shaped gag plush with simple button eyes. Wry disgusted lean away, cute symbolic joke, no realistic bodily detail or defecation.
🤡|Цирк приїхав|clown|A small round red clown nose over his blue nose, tiny colorful soft jester bow tie and a little tilted party hat between his original ears; sheepish smile, presenting a paper flower that bends backward. A self-mocking bow, fluffy body and navy cloak remain unchanged.
👻|Бу, це знову я|spooky|Lumen playfully hides under a small draped white ghost-sheet hood, but his enormous turquoise-lined ears poke through neatly, turquoise paws and navy cloak bottom and gold medallion remain visible. Cheeky open-mouth smile and one raised waving paw, a light spooky peek-and-reveal, no alien.
🤖|Вмикаю автопілот|robotic|A homemade square pale-blue cardboard robot helmet sits lifted above his fluffy face so his identity remains visible, tiny round antenna and two simple bolts; arms held stiffly forward with a blank neutral mouth. Small mechanical step and head nod, navy cloak and gold medallion intact, no alien or new metal character.'''

definitions={}
for line in DATA.splitlines():
    emoji,title,category,scene=line.split('|',3)
    assert emoji not in definitions
    definitions[emoji]={'emoji':emoji,'label':title,'category':category,'scene_prompt':scene}
archive=REPO/'assets/stickers/archive-50-v18.json'
old=json.loads((archive if archive.exists() else REPO/'assets/stickers/manifest.json').read_text())
selected=set(FACES+EXTRA+GESTURES)
assert len(FACES)==104 and len(EXTRA)==11 and len(selected)==120
kept=[dict(a,category='gesture' if a['emoji'] in GESTURES else 'face',origin='approved_1_8') for a in old if a['emoji'] in selected]
new=[]
for emoji in FACES+EXTRA:
    if any(a['emoji']==emoji for a in kept):continue
    assert emoji in definitions,emoji
    new.append(dict(definitions[emoji],id=f'lumen_{51+len(new):02d}',origin='generated_1_10',source=f'sources/lumen_{51+len(new):02d}.png'))
assert len(kept)==31 and len(new)==89,(len(kept),len(new))
assert next(x['id'] for x in new if x['emoji']=='🫠')=='lumen_54'
front='😂 😏 🥰 🤔 😤 🫠 👍 😱 🙄 🥹 🤭 🫡 😭 😎 🤨 🙃 🥳 😴 🤗 😬 🫣 🤯 😌 🤐 🥴 😡 💀 😅 🤡 ❤️ 😒 🫩 🤬 😈 😋 👻 🤦 🙏 🤷 😮‍💨'.split()
allrows=kept+new
ordered=[next(a for a in allrows if a['emoji']==e) for e in front]
remaining=[a for a in allrows if a['emoji'] not in front]
# Alternate the rest of the palette instead of placing similar faces together.
while remaining:
    last=ordered[-1]['category'];index=next((i for i,a in enumerate(remaining) if a['category']!=last),0)
    ordered.append(remaining.pop(index))
for i,a in enumerate(ordered):a['display_order']=i
plan={'release':'1.10.0','target_count':120,'face_keyboard':FACES,'extra_emotions':EXTRA,'extra_omitted':['👹','👺','👽','👾','😺'],'retained_gestures':GESTURES,'retained_approved_scenes':len(kept),'new_scenes':len(new),'canonical_set':'Lumen_120_Emotions_by_lumen_family_agent','previous_50_set_preserved':True,'order_basis':'Editorial mix of frequently useful reactions and emotional diversity, not a measured 2026 popularity ranking.','art_method':'Built-in image_gen, one transparent whole-pose sheet per sticker; local RIFE interpolation and VP9 encoding.','stickers':ordered}
(ROOT/'plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n')
(ROOT/'new.json').write_text(json.dumps(new,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'count':len(ordered),'new':len(new),'kept':len(kept),'first':front[:15]},ensure_ascii=False))
