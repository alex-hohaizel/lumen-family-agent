from pathlib import Path
import argparse
import json
import subprocess
import time

parser = argparse.ArgumentParser(description='Sample the owned resource-pilot process tree on Linux.')
parser.add_argument('--output-dir', type=Path, help='Keep the JSON report in an external directory; otherwise print only.')
options = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
output_dir = options.output_dir.resolve() if options.output_dir else None
if output_dir and output_dir.is_relative_to(repo):
    parser.error('diagnostic output must be outside the repository')

started = time.monotonic()
proc = subprocess.Popen(['node', str(Path(__file__).with_suffix('.mjs'))], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
peak = 0
samples = 0
max_children = 0
resolved_root = None
try:
    self_host = int(dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)['Pid'])
    while proc.poll() is None:
        rows = {}
        for path in Path('/proc').glob('[0-9]*/status'):
            try:
                data = dict(line.split(':', 1) for line in path.read_text().splitlines() if ':' in line)
                rows[int(path.parent.name)] = (int(data['PPid']), int(data.get('VmRSS', '0 kB').split()[0]) * 1024)
                if int(data['PPid']) == self_host and int(data.get('NSpid', data['Pid']).split()[-1]) == proc.pid:
                    resolved_root = int(path.parent.name)
            except (OSError, ValueError, KeyError):
                pass
        tree = {resolved_root} if resolved_root is not None else set()
        for _ in range(20):
            old = len(tree)
            tree.update(pid for pid, (parent, _) in rows.items() if parent in tree)
            if len(tree) == old:
                break
        peak = max(peak, sum(rows.get(pid, (0, 0))[1] for pid in tree))
        max_children = max(max_children, len(tree) - 1)
        samples += 1
        time.sleep(.05)
    stdout, stderr = proc.communicate()
finally:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()

if proc.returncode:
    print(stderr.decode()[-2000:])
    raise SystemExit(proc.returncode)
result = json.loads(stdout)
result.update({
    'scope': 'Local DOCX->Chromium PDF, 3200x2400 photo decode and H264 encoding queued together; no PGlite or model requests',
    'combined_peak_rss_bytes': peak, 'maximum_children': max_children, 'samples': samples,
    'sample_interval_ms': 50, 'memory_limit_enforced': False, 'cpu_quota_enforced': False,
    'production_certification': False, 'process_tree_mapped': resolved_root is not None,
    'elapsed_ms': round((time.monotonic() - started) * 1000), 'rss_sum_shared_pages_may_repeat': True,
})
assert resolved_root is not None and peak > 0, 'RSS sampling unavailable; do not report zero as a measured peak'
if output_dir:
    output_dir.mkdir(parents=True, exist_ok=True)
    report = output_dir / 'resource-pilot.json'
    report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    report.chmod(0o600)
print(json.dumps(result))
