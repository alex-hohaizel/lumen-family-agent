#!/usr/bin/env python3
"""Package the existing OAuth client and pure JS dependencies for a phone-only login."""
from pathlib import Path
import base64
import hashlib
import io
import json
import sys
import tarfile
import textwrap

root = Path(__file__).resolve().parents[1]
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root.parent / 'Lumen_ChatGPT_Phone.sh'
payload = io.BytesIO()
with tarfile.open(fileobj=payload, mode='w:gz') as archive:
    for name in ['auth.js', 'config.js', 'phone-login.js']:
        source = root / 'dist/src' / name
        if not source.is_file():
            raise SystemExit('Run npm run build first')
        archive.add(source, arcname=f'dist/src/{name}')
    for package in ['jose', 'zod']:
        archive.add(root / 'node_modules' / package, arcname=f'node_modules/{package}')
    content = b'{"type":"module","private":true}\n'
    info = tarfile.TarInfo('package.json')
    info.mode = 0o600
    info.size = len(content)
    archive.addfile(info, io.BytesIO(content))
raw = payload.getvalue()
sha = hashlib.sha256(raw).hexdigest()
launcher = '''#!/data/data/com.termux/files/usr/bin/bash
# Lumen Telegram: one-time personal ChatGPT login. No bot token or API key inside.
# Source: https://github.com/alex-hohaizel/lumen-family-agent
set -eu
umask 077
if ! command -v pkg >/dev/null 2>&1; then
  echo 'Цей файл потрібно запускати в Termux на Android.'
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' || ! command -v tar >/dev/null 2>&1; then
  echo 'Установлюю безкоштовний Node.js із пакетів Termux…'
  pkg update -y
  pkg install -y nodejs-lts tar
fi
LUMEN_PHONE_DIR="$HOME/lumen-phone-login"
mkdir -p "$LUMEN_PHONE_DIR"
chmod 700 "$LUMEN_PHONE_DIR"
LUMEN_PHONE_ARCHIVE="$LUMEN_PHONE_DIR/client.tar.gz"
awk '/^__LUMEN_CLIENT_PAYLOAD__$/ {found=1;next} found {print}' "$0" | base64 -d > "$LUMEN_PHONE_ARCHIVE"
LUMEN_PHONE_SHA=$(sha256sum "$LUMEN_PHONE_ARCHIVE")
if [ "${LUMEN_PHONE_SHA%% *}" != '__EXPECTED_SHA__' ]; then
  echo 'Файл завантажився не повністю. Завантажте його знову.'
  exit 1
fi
tar -xzf "$LUMEN_PHONE_ARCHIVE" -C "$LUMEN_PHONE_DIR"
cd "$LUMEN_PHONE_DIR"
exec node dist/src/phone-login.js
exit 1
__LUMEN_CLIENT_PAYLOAD__
'''.replace('__EXPECTED_SHA__', sha)
out.write_text(launcher + '\n'.join(textwrap.wrap(base64.b64encode(raw).decode(), 76)) + '\n')
out.chmod(0o700)
print(json.dumps({'file':str(out),'bytes':out.stat().st_size,'payload_sha256':sha,'secrets_included':False}))
