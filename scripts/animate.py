#!/usr/bin/env python3
"""Retime the original animation keyframes and interpolate video at 60 fps.

Requires Pillow and FFmpeg with minterpolate/libx264. No character redraw,
third-party generation, or runtime dependencies for the deployed bot.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
from PIL import Image
import argparse
import json
import subprocess

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'assets'


def run(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def animate(name, source, size, lead, tail):
    im = Image.open(ASSETS / source)
    durations = []
    with TemporaryDirectory(prefix='lumen-animation-') as folder:
        folder = Path(folder)
        for i in range(im.n_frames):
            im.seek(i)
            durations.append(im.info.get('duration', 140) / 1000)
            im.convert('RGB').save(folder / f'{i:03}.png')
        # Still holds give the eye a rest; the original gestures retain their timing.
        durations[0] += lead
        order = list(range(len(durations))) + [0]
        durations.append(tail)
        sequence = ['ffconcat version 1.0']
        for i, duration in zip(order, durations):
            sequence += [f"file '{folder / f'{i:03}.png'}'", 'option framerate 60', f'duration {duration:.6f}']
        sequence += [f"file '{folder / '000.png'}'", 'option framerate 60']
        (folder / 'frames.txt').write_text('\n'.join(sequence) + '\n')
        total = sum(durations)
        filters = (
            f'scale={size}:{size}:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=0.5,'
            'minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:'
            'me=epzs:vsbmc=1:scd=none,'
            'format=yuv420p'
        )
        target = ASSETS / f'lumen-{name}.mp4'
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
             '-i', str(folder / 'frames.txt'), '-vf', filters, '-t', f'{total:.4f}',
             '-an', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow',
             '-movflags', '+faststart', '-threads', '2', str(target)])
        result = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(target)]))
        stream = result['streams'][0]
        return {'file': target.name, 'source': source, 'width': stream['width'], 'height': stream['height'],
                'fps': stream['avg_frame_rate'], 'frames': int(stream['nb_frames']),
                'seconds': float(result['format']['duration']), 'bytes': target.stat().st_size,
                'source_keyframes': im.n_frames}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', choices=['idle', 'avatar', 'waving', 'happy', 'thinking'])
    args = parser.parse_args()
    jobs = [('idle', 'lumen-idle.gif', 512, 2.0, 0.8),
            ('avatar', 'lumen-avatar-source.gif', 800, 2.0, 0.8),
            ('waving', 'lumen-waving.gif', 512, 0.4, 0.6),
            ('happy', 'lumen-happy.gif', 512, 0.3, 0.6),
            ('thinking', 'lumen-thinking.gif', 512, 0.8, 0.6)]
    report = []
    for job in jobs:
        if args.only and job[0] != args.only:
            continue
        print(f'Interpolating {job[0]}...', flush=True)
        report.append(animate(*job))
        print(json.dumps(report[-1]), flush=True)
    if not args.only:
        (ASSETS / 'animation-report.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
