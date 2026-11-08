from pathlib import Path
import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import time

parser = argparse.ArgumentParser(description='Sample a local synthetic Node/Chromium/FFmpeg process tree on Linux or macOS.')
parser.add_argument('--output-dir', type=Path, help='Keep JSON outside the repository; otherwise print only.')
options = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
output_dir = options.output_dir.resolve() if options.output_dir else None
if output_dir and output_dir.is_relative_to(repo):
    parser.error('diagnostic output must be outside the repository')
if sys.platform not in ('linux', 'darwin'):
    parser.error('process-tree RSS sampling supports Linux and macOS only')

interval = .05
timeout_seconds = 120


def process_rows():
    """Return numeric PID -> (PPID, resident bytes, namespace PID), never command lines."""
    if sys.platform == 'darwin':
        output = subprocess.run(
            ['/bin/ps', '-axo', 'pid=,ppid=,rss='], check=True,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=2,
        ).stdout
        rows = {}
        for line in output.splitlines():
            parts = line.split()
            if len(parts) == 3 and all(part.isdecimal() for part in parts):
                pid, parent, rss = map(int, parts)
                rows[pid] = (parent, rss * 1024, pid)
        return rows
    rows = {}
    for path in Path('/proc').glob('[0-9]*/status'):
        try:
            data = dict(line.split(':', 1) for line in path.read_text().splitlines() if ':' in line)
            pid = int(path.parent.name)
            rows[pid] = (
                int(data['PPid']), int(data.get('VmRSS', '0 kB').split()[0]) * 1024,
                int(data.get('NSpid', data['Pid']).split()[-1]),
            )
        except (OSError, ValueError, KeyError):
            pass  # Processes can exit during the snapshot.
    return rows


def owned_tree(rows, root):
    tree = {root} if root in rows else set()
    for _ in range(len(rows)):
        previous = len(tree)
        tree.update(pid for pid, (parent, _, _) in rows.items() if parent in tree)
        if len(tree) == previous:
            break
    return tree


def terminate_owned(proc, root):
    """Signal currently verified descendants while the parent still establishes ownership."""
    if proc.poll() is not None:
        return
    try:
        rows = process_rows()
        tree = owned_tree(rows, root)
    except (OSError, subprocess.SubprocessError):
        rows, tree = {}, set()
    for pid in tree - {root}:
        try:
            os.kill(rows[pid][2], signal.SIGTERM)
        except (OSError, ProcessLookupError):
            pass
    proc.terminate()  # JS also closes Chromium and its owned media children.
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            rows = process_rows()
            for pid in owned_tree(rows, root) - {root}:
                try:
                    os.kill(rows[pid][2], signal.SIGKILL)
                except (OSError, ProcessLookupError):
                    pass
        finally:
            proc.kill()
            proc.wait(timeout=5)


started = time.monotonic()
peak = samples = maximum_children = sample_errors = 0
maximum_gap = 0.0
previous_sample = None
resolved_root = None
timed_out = False
# Files avoid a telemetry-filled pipe stalling the workload. TMPDIR contains all
# owned JS media/browser outputs and is cleaned even after a process timeout.
with tempfile.TemporaryDirectory(prefix='lumen-resource-pilot-') as temporary, tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
    proc = subprocess.Popen(
        ['node', str(Path(__file__).with_suffix('.mjs'))], cwd=repo,
        stdout=stdout_file, stderr=stderr_file, start_new_session=True,
        env={**os.environ, 'TMPDIR': temporary},
    )
    self_host = os.getpid()
    if sys.platform == 'linux':
        try:
            data = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
            self_host = int(data['Pid'])
        except (OSError, ValueError, KeyError):
            pass
    try:
        while proc.poll() is None:
            if time.monotonic() - started >= timeout_seconds:
                timed_out = True
                break
            try:
                rows = process_rows()
                if resolved_root is None:
                    resolved_root = next((pid for pid, (parent, _, namespace_pid) in rows.items() if parent == self_host and namespace_pid == proc.pid), None)
                tree = owned_tree(rows, resolved_root)
                if tree:
                    measured_at = time.monotonic()
                    if previous_sample is not None:
                        maximum_gap = max(maximum_gap, measured_at - previous_sample)
                    previous_sample = measured_at
                    peak = max(peak, sum(rows[pid][1] for pid in tree))
                    maximum_children = max(maximum_children, len(tree) - 1)
                    samples += 1
            except (OSError, subprocess.SubprocessError):
                sample_errors += 1
            time.sleep(interval)
    finally:
        terminate_owned(proc, resolved_root)
    stdout_file.seek(0)
    stderr_file.seek(0)
    stdout = stdout_file.read(1024 * 1024).decode(errors='replace')
    stderr = stderr_file.read(16384).decode(errors='replace')

if timed_out or proc.returncode:
    timeout_failure = timed_out or proc.returncode == 124
    print(json.dumps({'status': 'failed', 'reason': 'resource_pilot_timeout' if timeout_failure else 'resource_driver_failed', 'exit_code': proc.returncode, 'stderr_tail': stderr[-2000:]}))
    raise SystemExit(124 if timeout_failure else 1)

# Runtime memory telemetry is JSONL too; select only the marked final report.
result = None
for line in reversed(stdout.splitlines()):
    try:
        candidate = json.loads(line)
    except json.JSONDecodeError:
        continue
    if isinstance(candidate, dict) and candidate.get('event') == 'resource_pilot_finished' and isinstance(candidate.get('jobs'), list):
        result = candidate
        break
if result is None or resolved_root is None or samples == 0 or peak <= 0:
    raise SystemExit('RSS sampling or final resource report unavailable; do not report zero as a measured peak')

result.update({
    'scope': 'Local synthetic DOCX->headless Chromium PDF, 3200x2400 photo decode and H264 encoding queued together; no PGlite, model calls or production workload',
    'measurement_platform': sys.platform,
    'measurement_method': 'Sum resident bytes of owned Node PID and recursively discovered current descendants; Linux procfs VmRSS/NSpid mapping or macOS ps numeric PID/PPID/RSS',
    'combined_peak_rss_bytes': peak, 'maximum_children': maximum_children, 'samples': samples,
    'sample_interval_ms': round(interval * 1000), 'maximum_observed_sample_gap_ms': round(maximum_gap * 1000), 'sampling_errors': sample_errors,
    'memory_limit_enforced': False, 'cpu_quota_enforced': False, 'production_certification': False,
    'process_tree_mapped': True, 'elapsed_ms': round((time.monotonic() - started) * 1000),
    'run_timeout_seconds': timeout_seconds, 'rss_sum_shared_pages_may_repeat': True,
    'sampling_may_miss_short_peaks': True, 'container_memory_comparison_valid': False,
})
if output_dir:
    output_dir.mkdir(parents=True, exist_ok=True)
    report = output_dir / 'resource-pilot.json'
    if report.resolve().is_relative_to(repo):
        raise SystemExit('diagnostic output symlink must not target the repository')
    report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    report.chmod(0o600)
print(json.dumps(result))
