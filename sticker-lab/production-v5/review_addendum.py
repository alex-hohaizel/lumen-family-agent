#!/usr/bin/env python3
"""Create and validate a separate immutable review-video repair addendum."""
import argparse, hashlib, json, os, subprocess
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
import repair as core


def verify(video, views, speed):
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames',
                      '-show_streams','-show_format','-of','json',str(video)]))
    assert video.stat().st_size>2000 and len(probe['streams'])==1
    assert int(probe['streams'][0]['nb_read_frames'])==84
    assert abs(float(probe['format']['duration'])-2.8*speed)<.001
    raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(video),'-f','rawvideo','-pix_fmt','rgb24','-'])
    decoded=np.frombuffer(raw,np.uint8).reshape(84,536,512,3)
    maes=[float(np.abs(decoded[i].astype(float)-np.asarray(Image.open(views/f'{i:03d}.png').convert('RGB'),float)).mean()) for i in range(84)]
    assert max(maes)<5
    return {'ffprobe':probe,'full_decode_frames':84,'rgb_mae_by_frame':maes,'maximum_rgb_mae':max(maes)}


def create(package_path,candidate_path,invalid_path,output,speed):
    assert not output.exists(),'Write a fresh addendum; never overwrite frozen artifacts'
    package=json.loads(package_path.read_text());entry=next(e for e in package['files'] if e['path']==str(candidate_path))
    invalid=next(e for e in package['files'] if e['path']==str(invalid_path))
    assert core.sha(candidate_path)==entry['sha256'] and core.sha(invalid_path)==invalid['sha256']
    output.mkdir(parents=True);native=output/'native';core.decode(candidate_path,native)
    assert len(list(native.glob('*.png')))==84
    views=output/'views';views.mkdir()
    for i in range(84):
        rgba=Image.open(native/f'{i:03d}.png').convert('RGBA');canvas=Image.new('RGB',(512,536),'#e9edf4')
        canvas.paste(rgba,(0,24),rgba);ImageDraw.Draw(canvas).text((6,5),f'{candidate_path.parent.name} f{i:03d} native {i/30:.3f}s',fill='#101820')
        canvas.save(views/f'{i:03d}.png')
    target=output/f'review-{speed}x-duration.mp4';temporary=output/'review-building.mp4'
    # Input cadence changes, so the slowed review contains84 actual frames,
    # not an undocumented collection of repeated interpolated output frames.
    core.run(['ffmpeg','-v','error','-y','-framerate',30/speed,'-start_number',0,'-i',views/'%03d.png',
              '-c:v','libx264','-threads',2,'-crf',16,'-an','-frames:v',84,'-pix_fmt','yuv420p',
              '-movflags','+faststart',temporary])
    before=verify(temporary,views,speed);os.replace(temporary,target)
    # Verify the final artifact after the atomic move as well as the temporary.
    final=verify(target,views,speed)
    assert final['maximum_rgb_mae']==before['maximum_rgb_mae']
    report={'schema_version':1,'reason':'Frozen review MP4 invalid; separate immutable artifact repair, not a candidate animation change.',
            'original_package_path':str(package_path),'original_package_sha256':core.sha(package_path),
            'original_invalid_review':invalid,'source_candidate':entry,'replacement_path':str(target),
            'replacement_sha256':core.sha(target),'replacement_bytes':target.stat().st_size,
            'native_decoded_png_sha256':[core.sha(native/f'{i:03d}.png') for i in range(84)],
            'actual_checks':final,'verified_after_final_atomic_move':True,'process_completion_awaited':True,
            'candidate_changed':False,'original_frozen_files_changed':False,
            'native_realtime_playback':'not_observed','native_slow_playback':'not_observed','device_playback':'not_observed',
            'approval_inferred':False,'helper_path':str(Path(__file__)),'helper_sha256':core.sha(__file__)}
    (output/'addendum.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return report


def main():
    p=argparse.ArgumentParser();p.add_argument('package',type=Path);p.add_argument('candidate',type=Path)
    p.add_argument('invalid_review',type=Path);p.add_argument('output',type=Path);p.add_argument('--speed',type=int,choices=[1,2],default=2);a=p.parse_args()
    r=create(a.package,a.candidate,a.invalid_review,a.output,a.speed)
    print(json.dumps({k:r[k] for k in ['replacement_path','replacement_sha256','replacement_bytes','verified_after_final_atomic_move']}))


if __name__=='__main__':main()
