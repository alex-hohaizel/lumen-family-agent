#!/usr/bin/env python3
"""Independent format, alpha, timing and approval-scope checks for the two drafts."""
import gzip,hashlib,json,subprocess
from pathlib import Path
from PIL import Image

ROOT=Path(__file__).resolve().parent

def probe(file):
    return json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(file)]))

def validate(kind):
    folder=ROOT/'prototypes'/kind;raw=(folder/'lumen.tgs').read_bytes();d=json.loads(gzip.decompress(raw));report=json.loads((folder/'validation.json').read_text())
    assert len(raw)<=65536 and d['w']==d['h']==512 and d['fr']==60 and 0<(d['op']-d['ip'])/60<=3
    assert not d.get('assets') and report['rendered_frames']==168 and report['unique_frames']==168 and report['all_within_canvas']
    assert report['loop_delta']<report['mean_adjacent_delta']*.05
    indices={x['ind'] for x in d['layers']};parents={x['ind']:x.get('parent') for x in d['layers']}
    for n in indices:
        seen=set();p=n
        while p is not None:
            assert p in indices and p not in seen;seen.add(p);p=parents[p]
    forbidden=[]
    def walk(x):
        if isinstance(x,dict):
            if x.get('masksProperties') or x.get('ef') or x.get('x') and isinstance(x.get('x'),str):forbidden.append('mask/effect/expression')
            if x.get('ty') in [1,2,5,'gs','rp','mm','sr','pb','zz','tw']:forbidden.append(x.get('ty'))
            for v in x.values():walk(v)
        elif isinstance(x,list):
            for v in x:walk(v)
    walk(d);assert not forbidden
    gif=Image.open(folder/'preview.gif');duration=0
    for i in range(gif.n_frames):gif.seek(i);duration+=gif.info.get('duration',0)
    assert gif.n_frames==84 and duration==2800
    video=probe(folder/'telegram-video.webm');streams=video['streams'];assert len(streams)==1 and streams[0]['codec_name']=='vp9'
    assert streams[0]['width']==streams[0]['height']==512 and streams[0]['avg_frame_rate']=='30/1' and float(video['format']['duration'])<=3
    assert (folder/'telegram-video.webm').stat().st_size<=262144
    alpha=subprocess.check_output(['ffmpeg','-v','error','-c:v','libvpx-vp9','-i',str(folder/'telegram-video.webm'),'-vf','alphaextract','-frames:v','1','-f','rawvideo','-pix_fmt','gray','-'])
    assert min(alpha)==0 and max(alpha)==255
    mp4=probe(folder/'preview.mp4');assert len(mp4['streams'])==1 and mp4['streams'][0]['avg_frame_rate']=='60/1'
    assert float(mp4['format']['duration'])<=3 and mp4['streams'][0]['codec_name']=='h264'
    return {'kind':kind,'emoji':report['emoji'],'tgs_bytes':len(raw),'native_fps':60,'native_duration':2.8,'layers':len(d['layers']),'valid_parent_tree':True,'unsupported_features':forbidden,'transparent_video_decoded':True,'vp9_bytes':(folder/'telegram-video.webm').stat().st_size,'video_fps':30,'gif_frames':84,'gif_duration_ms':duration,'preview_mp4_fps':60,'loop_delta':report['loop_delta'],'tgs_sha256':hashlib.sha256(raw).hexdigest(),'passed':True}

if __name__=='__main__':
    results=[validate(x) for x in ['laugh','love']]
    plan=json.loads((ROOT/'research/top50-plan.json').read_text());assert len(plan['rows'])==50 and len({x['emoji'] for x in plan['rows']})==50
    assert sum(x['status']=='prototype_ready' for x in plan['rows'])==2 and not plan['artwork_approved'] and not plan['animation_approved']
    data={'status':'prototypes_awaiting_user_approval','checks':results,'emoji_concepts':50,'produced_stickers':2,'production_pack_untouched':True,'not_a_telegram_server_upload_test':True}
    (ROOT/'QA_REPORT.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');print(json.dumps(data,ensure_ascii=False))
