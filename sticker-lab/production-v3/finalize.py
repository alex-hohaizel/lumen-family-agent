#!/usr/bin/env python3
"""Verify every native file, stage the 50-item release, and build review boards."""
import argparse,hashlib,json,shutil,subprocess
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import numpy as np

ROOT=Path(__file__).resolve().parent;REPO=ROOT.parents[1]
DESCRIPTIONS=[
'Стоячи щиро сміється, тримається лапками біля живота; на щоці маленька сльозинка радості. Для дуже смішного власного жарту.',
'Тримає велике червоне плюшеве серце двома лапками й тепло простягає його глядачеві. Любов, щира прихильність.',
'Регоче лежачи на боці, похитується, піднявши задні лапки; очі заплющені, видно сині сльозинки. Дуже сильний регіт.',
'Показує великий палець угору поруч з обличчям, привітно усміхається та схвально киває. Яскраве схвалення.',
'Сидить і гірко ридає: дві сині струмини сліз стікають у маленьку калюжку. Сильний сум, не сміх.',
'Складає дві лапки долонями разом перед грудьми й шанобливо вклоняється. Щира вдячність або прохання.',
'Підморгує, складає губи для поцілунку й тримає біля них відкриту лапку з маленьким червоним сердечком. Повітряний поцілунок.',
'Ніжно притискає рожеве оксамитове серце до щоки й обіймає його; навколо вух маленькі сердечка. Тепла ніжність.',
'У великих очах червоні зіниці-сердечка; обидві лапки біля щік, захоплена усмішка. Закоханість і сильне захоплення.',
'Сором’язливо усміхається й торкається рожевої щоки лапкою, трохи схиляючи голову. Тепло та збентежена радість.',
'Тримає смугасту хлопавку; над нею яскравий віялоподібний фонтан конфеті та стрічок. Святковий вибух радості.',
'Показує лапками на щоки та широко сяє усмішкою зі своїми двома передніми зубками. Весела щира радість.',
'Тримає два окремі сердечка зі з’єднаних рожево-червоних стрічок, по одному в кожній лапці. Ми удвох, близькість.',
'Притискає лапки під підборіддям, дивиться великими вологими синіми очима, опустивши вуха. Дуже лагідне прохання.',
'Ніяково всміхається й торкається чола біля великої бірюзової краплі поту. Фух, пронесло; збентежене полегшення.',
'У впевненій стійці тримає між лапками живий золотисто-помаранчевий вогонь. Це вогонь, запал і сильний захват.',
'Сидить на складеному плащі зі схрещеними лапками, спокійно прикривши очі. Тихе задоволення та внутрішній спокій.',
'Прикриває чоло й око однією лапкою та схиляє голову. Лагідне рукалице: ой, лишенько, ну як так.',
'Як маленький фокусник показує кремову гральну карту з великою червоною мастю серця й піднімає край плаща. Козирне серце.',
'Піднімає обидві відкриті лапки догори й знизує плечима, кумедно схиляючи голову. Не знаю, а що я можу сказати.',
'Стоїть зі схрещеними лапками, виразно закочує сині очі догори та зітхає. Легка іронія або втомлене «ну почалося».',
'Сидить, витягнувши лапки вперед, прикриває обома передніми лапками усмішку й стискає очі від хихотіння. Сміх без сліз.',
'Широко розкриває обидві лапки до глядача й тепло нахиляється вперед. Запрошення в обійми та підтримка.',
'Тримає пухнастий пальчик біля губ і змовницьки підморгує. Наш маленький секрет, дружній натяк.',
'Тримає полуничний торт із трьома свічками, дмухає на вогники й усміхається. День народження та побажання.',
'Однією лапкою підпирає підборіддя, іншою тримає золоту лупу біля ока; вдумливо придивляється. Роздум або цікава версія.',
'Радісно плескає лапками, між ними золотисті позначки руху та маленький блиск. Оплески, браво, велике схвалення.',
'Стоїть спокійно, ледь усміхається й тримає лапку біля медальйона, м’яко киваючи. Стримане доброзичливе запевнення.',
'Широко розкрив очі й почервонів, підтягує обома лапками комір плаща до щік. Збентеження: мене спіймали.',
'У святковому ковпачку дудить у смугастий язичок і грайливо танцює. Весела вечірка, без торта й хлопавки.',
'У темних синіх окулярах упевнено усміхається й поправляє оправу лапкою. Круто, впевненість, я на стилі.',
'Показує пухнастою лапкою виразне колечко ОК біля обличчя й задоволено прикриває очі. Ідеально, саме те.',
'Сидить біля відкритої фіолетової скриньки, з якої здіймається чарівне фіолетове серце та пелюстки. Магія ніжності.',
'Сидить засмучений, підпираючи щоку однією лапкою, з опущеними вухами й сумним поглядом. Тихий задумливий сум без сліз.',
'Підіймає маленьку бірюзово-золоту гантелю однією лапкою та гордо стискає іншу. Сила, зусилля, я зможу.',
'Тримає на піднятому пальчику яскраву золоту чотирипроменеву зірку з двома меншими іскрами. Трішки чарів і блиску.',
'Сидячи полірує маленькою серветкою грановане рожеве серце-коштовність; на ньому спалахує зірковий блиск. Ти моє диво.',
'Цікаво визирає великими синіми очима збоку з-за вертикальної складки свого плаща. Уважно стежу, ого, що там.',
'Тримає мисочку ягідного морозива й золоту ложечку, задоволено облизується. Дуже смачно, смакую.',
'Хитрувато примружується, усміхається куточком рота й потирає лапки біля згорнутого синьо-золотого плану. У мене є задум.',
'На сумній щоці одна синя сльозинка; він лагідно торкається її лапкою. Зворушення й тихий сум, не бурхливий плач.',
'Повернувшись праворуч, чітко показує туди витягнутою лапкою, погляд веде за жестом. Ось сюди, зверни увагу.',
'Визирає очима й великими вухами з-за величезного рожевого серця, тримаючи його за боки; серце росте й м’яко стискається. Любові все більше.',
'Виснажено лежить животиком на зім’ятій бірюзовій подушці, звісивши лапки й розпластавши вуха. Сил більше нема.',
'Гордо показує червоно-золоту табличку з великим числом 100 та двома рисками під ним. На всі сто, повна підтримка.',
'Сором’язливо вклоняється й пропонує одну червону троянду на довгому стеблі. Квітка для тебе, романтичний жест.',
'Проводить лапками танець двох рожево-червоних сердець на тонкій золотій стрічці-вісімці. Взаємна прихильність, завжди поруч.',
'Тримається за ниточку великої коралово-червоної кульки й радісно ширяє над землею, плащ м’яко звисає. Лечу від радості.',
'Дбайливо вкриває маленьке синє серце складкою свого плаща, ніби ковдрою, й лагідно його гладить. Спокій і турбота.',
'Широко й радісно всміхається великими відкритими очима та махає піднятою лапкою біля вуха. Дуже радий тебе бачити.'
]
CURATED={3:[0,1,2,3,2,1,0,7,0],18:[0,1,6,7,6,1,0,1,0],20:[0,7,6,7,0,7,6,7,0],28:[0,7,6,7,0,2,0,7,0],34:[0,1,5,7,5,1,0,1,0],35:[0,1,2,3,4,3,2,1,0]}

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def check(rank):
    d=ROOT/'work'/f'lumen_{rank:02d}';q=json.loads((d/'quality.json').read_text())
    assert q.get('cadence_version')==2 and q.get('encoding_version')==2,(rank,'outdated render')
    assert q['frames']==84 and q['unique_frames']==84 and q['trailing_repeated_frames']==0,(rank,'cadence')
    assert q['preview_phase']==({1:42,27:42,44:42}.get(rank,0)),(rank,'preview')
    if rank in CURATED:assert json.loads((d/'extraction.json').read_text())['sequence']==CURATED[rank],(rank,'unsafe discarded pose')
    f=d/f'lumen_{rank:02d}.webm';assert sha(f)==q['sha256'] and f.stat().st_size==q['bytes']<=262144
    info=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_streams','-show_format','-of','json',str(f)]))
    assert len(info['streams'])==1;v=info['streams'][0]
    assert v['codec_name']=='vp9' and v['width']==v['height']==512 and v['avg_frame_rate']=='30/1' and int(v['nb_read_frames'])==84
    assert 2.79<=float(info['format']['duration'])<=2.81
    raw=subprocess.check_output(['ffmpeg','-v','error','-threads','2','-c:v','libvpx-vp9','-i',str(f),'-frames:v','1','-pix_fmt','rgba','-f','rawvideo','-'])
    rgba=np.frombuffer(raw,dtype=np.uint8).reshape((512,512,4));assert rgba[:,:,3].min()==0 and rgba[:,:,3].max()==255
    Image.fromarray(rgba).save(d/'decoded-preview.png')
    md5=subprocess.check_output(['ffmpeg','-v','error','-threads','2','-c:v','libvpx-vp9','-i',str(f),'-pix_fmt','rgba','-f','framemd5','-'],text=True)
    hashes=[line.split(',')[-1].strip() for line in md5.splitlines() if line and not line.startswith('#')];assert len(hashes)==84
    tail=0
    for i in range(83,0,-1):
        if hashes[i]!=hashes[i-1]:break
        tail+=1
    assert tail<=1,(rank,'encoded hold')
    q.update(native_decoded_unique_frames=len(set(hashes)),native_decoded_tail_repeats=tail,native_decoded_alpha=True,preview_sha256=sha(d/'poster.png'))
    samples=[0,12,24,36,48,60,72,83];select='select='+ '+'.join('eq(n\\,'+str(i)+')' for i in samples)
    raw=subprocess.check_output(['ffmpeg','-v','error','-threads','2','-c:v','libvpx-vp9','-i',str(f),'-vf',select,'-vsync','0','-pix_fmt','rgba','-f','rawvideo','-'])
    images=np.frombuffer(raw,dtype=np.uint8).reshape((8,512,512,4));board=Image.new('RGB',(1024,512),'#e9edf4')
    for k,pixels in enumerate(images):
        im=Image.fromarray(pixels).resize((256,256),Image.Resampling.LANCZOS);board.paste(im,((k%4)*256,(k//4)*256),im)
    board.save(ROOT/'review'/f'native_motion_{rank:02d}.jpg',quality=96)
    return q

def boards(rows):
    font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',17)
    for start in range(0,50,10):
        board=Image.new('RGB',(1500,680),'#eef2f7');draw=ImageDraw.Draw(board)
        for k,row in enumerate(rows[start:start+10]):
            x=(k%5)*300;y=(k//5)*340;d=ROOT/'work'/row['id']
            im=Image.open(d/'decoded-preview.png').convert('RGBA').resize((288,288),Image.Resampling.LANCZOS);board.paste(im,(x+6,y+4),im)
            draw.text((x+12,y+300),str(row['rank']).zfill(2)+' · '+row['title'],fill='#18304d',font=font)
        board.save(ROOT/'review'/f'native_previews_{start+1:02d}_{min(50,start+10):02d}.jpg',quality=96)

def main():
    p=argparse.ArgumentParser();p.add_argument('--stage',action='store_true');args=p.parse_args()
    rows=json.loads((ROOT/'plan.json').read_text())['rows'];assert len(rows)==len(DESCRIPTIONS)==50
    proofs=[];assets=[];out=REPO/'assets/stickers';out.mkdir(exist_ok=True)
    for row in rows:
        rank=row['rank'];q=check(rank);d=ROOT/'work'/row['id'];source=ROOT.parent/'recovery-v2/keyframes-source.png' if rank==1 else ROOT/'sources'/(row['id']+'.png')
        a={'id':row['id'],'emoji':row['emoji'],'label':row['title'],'description':DESCRIPTIONS[rank-1],'scene':row['title'],'file':row['id']+'.webm','preview':row['id']+'.png','bytes':q['bytes'],'sha256':q['sha256'],'preview_sha256':q['preview_sha256'],'motion_version':3,'fps':30,'frames':84,'duration':2.8,'source_keyposes_sha256':sha(source),'unicode_rank_2021':rank}
        assets.append(a);proofs.append(q)
        if args.stage:shutil.copyfile(d/a['file'],out/a['file']);shutil.copyfile(d/'poster.png',out/a['preview'])
        print(json.dumps({'verified':rank,'native_frames':q['native_decoded_unique_frames'],'bytes':a['bytes']},ensure_ascii=False),flush=True)
    for key in ['id','emoji','scene','sha256','preview_sha256','source_keyposes_sha256']:assert len({a[key] for a in assets})==50,key
    if args.stage:
        previous=json.loads((out/'manifest.json').read_text());keep={a[k] for a in assets for k in ['file','preview']}
        for a in previous:
            for key in ['file','poster','preview']:
                name=a.get(key)
                if name and '/' not in name and name not in keep:(out/name).unlink(missing_ok=True)
        (out/'manifest.json').write_text(json.dumps(assets,ensure_ascii=False,indent=2)+'\n')
    review=ROOT/'visual-review.json';visual=json.loads(review.read_text()) if review.exists() else {}
    reviewed=0
    for q in proofs:
        item=visual.get(str(q['rank']),{})
        if item.get('approved') and item.get('sha256')==q['sha256']:
            q['visual_review']='reviewed_by_assistant';reviewed+=1
    report={'version':'1.8.0','count':50,'primary_emoji_unique':50,'native_files_unique':50,'previews_unique':50,'source_scenes_unique':50,'technical_checks_passed':True,'visually_reviewed':reviewed,'ranking_note':'Published Unicode2021 global frequency, not a 2026 Telegram ranking','reference':'User-approved fluffy whole-pose recovery-v2 based on assets/lumen.png','runtime':'rife-ncnn-vulkan20221029 / rife-v4.6 CPU, FFmpeg libvpx-vp9','native_constraints':'512×512;84frames;30fps;2.8s;alpha;noaudio;<=256KiB','assets':proofs}
    (ROOT/'quality.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');boards(rows)
    print(json.dumps({k:v for k,v in report.items() if k!='assets'},ensure_ascii=False),flush=True)
if __name__=='__main__':main()
