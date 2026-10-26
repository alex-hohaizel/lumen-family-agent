#!/usr/bin/env python3
"""Package an updated transfer page for an Android installation that is already signed in."""
from pathlib import Path
import base64
import hashlib
import json
import sys
import textwrap

root = Path(__file__).resolve().parents[1]
source = root / 'dist/src/phone-login.js'
if not source.is_file():
    raise SystemExit('Run npm run build first')
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root.parent / 'Lumen_ChatGPT_Manual_Copy.sh'
raw = source.read_bytes()
sha = hashlib.sha256(raw).hexdigest()
launcher = '''#!/data/data/com.termux/files/usr/bin/bash
# Lumen: update the local transfer page using the sign-in already saved on this phone.
# This script contains program code only, no account session or bot token.
set -eu
umask 077
LUMEN_PHONE_DIR="$HOME/lumen-phone-login"
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js недоступний. Спочатку запустіть основний файл входу Люмена.'
  exit 1
fi
if [ ! -f "$LUMEN_PHONE_DIR/runtime/accounts.json" ] || [ ! -f "$LUMEN_PHONE_DIR/dist/src/auth.js" ] || [ ! -f "$LUMEN_PHONE_DIR/dist/src/config.js" ]; then
  echo 'Збережений вхід або програма Люмена не знайдені. Повідомте цей текст без секретів.'
  exit 1
fi
LUMEN_PHONE_PATCH=$(mktemp "$LUMEN_PHONE_DIR/dist/src/.copy-page.XXXXXX")
trap 'rm -f "$LUMEN_PHONE_PATCH"' EXIT
awk '/^__LUMEN_COPY_PAGE__$/ {found=1;next} found {print}' "$0" | base64 -d > "$LUMEN_PHONE_PATCH"
LUMEN_PHONE_SHA=$(sha256sum "$LUMEN_PHONE_PATCH")
if [ "${LUMEN_PHONE_SHA%% *}" != '__EXPECTED_SHA__' ]; then
  echo 'Файл завантажився не повністю. Завантажте його знову.'
  exit 1
fi
mv "$LUMEN_PHONE_PATCH" "$LUMEN_PHONE_DIR/dist/src/phone-login.js"
cd "$LUMEN_PHONE_DIR"
echo 'Відкриваю ручне копіювання вже збереженого підключення. Новий вхід не потрібний.'
exec node dist/src/phone-login.js
exit 1
__LUMEN_COPY_PAGE__
'''.replace('__EXPECTED_SHA__', sha)
out.write_text(launcher + '\n'.join(textwrap.wrap(base64.b64encode(raw).decode(), 76)) + '\n')
out.chmod(0o700)
print(json.dumps({'file': str(out), 'bytes': out.stat().st_size, 'payload_sha256': sha, 'secrets_included': False}))
