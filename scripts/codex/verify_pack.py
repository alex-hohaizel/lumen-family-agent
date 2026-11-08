#!/usr/bin/env python3
"""Read-only project context validation. Does not require retired skills or agents."""
from pathlib import Path
import json
import re
import sys
import tomllib

root = Path(__file__).resolve().parents[2]
errors = []
required = [
    'AGENTS.md', 'docs/lumen/README.md', 'docs/lumen/current-context.md',
    'docs/lumen/migration/checkpoint.json', 'docs/lumen/migration/current-scope.md',
    'docs/lumen/requirements/accepted-decisions.md', 'docs/codex/INVARIANTS.md',
    'docs/codex/QUALITY_MATRIX.md', 'docs/codex/PROOF_PROTOCOL.md', 'docs/codex/COST_POLICY.md',
]
for name in required:
    if not (root / name).is_file():
        errors.append(f'missing {name}')
for path, key, expected in [
    ('docs/lumen/product/capabilities.json', 'capabilities', 25),
    ('docs/lumen/requirements/companion-24.json', 'requirements', 24),
]:
    try:
        entries = json.loads((root / path).read_text(encoding='utf-8'))[key]
        ids = [entry['id'] for entry in entries]
        if len(ids) != expected or len(set(ids)) != expected:
            errors.append(f'{path}: expected {expected} unique preserved IDs')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        errors.append(f'{path}: invalid inventory: {exc}')
for path in (root / 'docs/lumen').rglob('*.json'):
    try:
        json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        errors.append(f'{path.relative_to(root)}: invalid JSON: {exc}')
for path in (root / 'docs/lumen').rglob('*.md'):
    for target in re.findall(r'\]\(([^)]+)\)', path.read_text(encoding='utf-8')):
        if re.match(r'^(?:https?:|#|/)', target):
            continue
        target = target.split('#', 1)[0]
        if target and not (path.parent / target).exists():
            errors.append(f'{path.relative_to(root)}: missing link {target}')
# Local Codex preferences are optional; project context works without custom agents.
config = root / '.codex/config.toml'
if config.exists():
    try:
        data = tomllib.loads(config.read_text(encoding='utf-8'))
        if data.get('approval_policy') != 'on-request' or data.get('sandbox_mode') != 'workspace-write':
            errors.append('unsafe local approval/sandbox config')
        if data.get('agents', {}).get('max_concurrent_threads_per_session', 99) > 3:
            errors.append('local concurrency above3')
    except (OSError, ValueError) as exc:
        errors.append(f'optional Codex config: {exc}')
if errors:
    print('FAIL:')
    for error in errors:
        print(' -', error)
    sys.exit(1)
print('PASS: project context,25 capabilities,24 criteria and links; no retired skill dependency')
