#!/usr/bin/env python3
"""Render the new 4x4 mouse pose atlas as constant-rate Telegram animations.

Requires Pillow and FFmpeg. A fixed 12 fps source timeline and scene detection
prevent smearing across different poses when interpolating to 60 fps.
"""
import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

JOBS = {
    "avatar": (800, [0] * 14 + [0, 1, 2, 3, 1, 4, 5, 6, 7, 8, 9, 10, 11, 0] + [0] * 20),
    "idle": (512, [0] * 18 + [0, 1, 2, 3, 1, 0] + [0] * 18),
    "waving": (512, [0] * 8 + [0, 4, 5, 6, 7, 8, 9, 10, 11, 0] + [0] * 12),
    "happy": (512, [0] * 10 + [0, 11, 14, 14, 14, 11, 0] + [0] * 13),
    "thinking": (512, [0] * 10 + [0, 12, 12, 12, 13, 13, 13, 12, 12, 12, 13, 13, 13, 0] + [0] * 12),
}


def run(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def inspect(path):
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path),
    ]))
    video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
    return {
        "file": path.name, "width": video["width"], "height": video["height"],
        "fps": video["avg_frame_rate"], "frames": int(video["nb_frames"]),
        "seconds": float(probe["format"]["duration"]), "bytes": path.stat().st_size,
        "codec": video["codec_name"], "pixel_format": video["pix_fmt"],
        "audio_streams": sum(s["codec_type"] == "audio" for s in probe["streams"]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("atlas", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with Image.open(args.atlas) as image:
        width, height = image.size
    with tempfile.TemporaryDirectory(prefix="lumen-new-frames-") as temp:
        work = Path(temp)
        for n in range(16):
            col, row = n % 4, n // 4
            x, y = col * width // 4, row * height // 4
            cell_w = (col + 1) * width // 4 - x
            cell_h = (row + 1) * height // 4 - y
            run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "color=c=0xf3f6fa:s=320x320:r=1", "-i", str(args.atlas),
                "-filter_complex",
                f"[1:v]crop={cell_w}:{cell_h}:{x}:{y},scale=320:320:flags=lanczos[mouse];"
                "[0:v][mouse]overlay=shortest=1:format=auto,format=rgb24[out]",
                "-map", "[out]", "-frames:v", "1", str(work / f"{n:02}.png"),
            ])
        report = []
        for name, (size, order) in JOBS.items():
            sequence = work / name
            sequence.mkdir()
            for i, pose in enumerate(order):
                shutil.copyfile(work / f"{pose:02}.png", sequence / f"{i:03}.png")
            target = args.output / f"lumen-{name}.mp4"
            filters = (
                "tpad=stop_mode=clone:stop_duration=0.5,"
                "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:me=epzs:"
                "mb_size=8:vsbmc=1:scd=fdiff:scd_threshold=3,"
                f"scale={size}:{size}:flags=lanczos,format=yuv420p"
            )
            print(f"Rendering {name}", flush=True)
            run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-framerate", "12",
                "-i", str(sequence / "%03d.png"), "-vf", filters, "-t", str(len(order) / 12),
                "-an", "-c:v", "libx264", "-crf", "17", "-preset", "slow",
                "-movflags", "+faststart", str(target),
            ])
            entry = inspect(target)
            entry.update({
                "source": args.atlas.name, "source_keyframes": 16,
                "timeline_fps": 12, "timeline": order, "new_poses": True,
            })
            report.append(entry)
            print(json.dumps(entry), flush=True)
        (args.output / "animation-report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
