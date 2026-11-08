#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
SUITE="${1:-core}"
if [[ "$SUITE" == all ]]; then
  npm test
  exit $?
fi
case "$SUITE" in
  core) tests=(behavior-111 interactions-170 conversation-113 action-truth-closure-v3);;
  behavior) tests=(behavior behavior-111 conversation-113 attention-140 personalization-scheduling);;
  actions) tests=(interactions-170 action-recovery-113 action-truth-closure-v3 state-111);;
  privacy) tests=(groups-topics source-authority-v4 request-context-v4 migration-113);;
  media) tests=(media-execution-113 media-integration-r3 media-closure-v3 live-media);;
  stickers) tests=(sticker-release sticker-palette sticker-policy-180 sticker-upgrade);;
  release) tests=(release-130 joint-startup runtime-113 migration-113);;
  *) echo "Unknown suite: $SUITE (core|behavior|actions|privacy|media|stickers|release|all)" >&2; exit 2;;
esac
npm run build
npm run build:test
files=()
for name in "${tests[@]}"; do
  path=".test-build/test/${name}.test.js"
  [[ -f "$path" ]] || { echo "ERROR: expected compiled test missing: $path" >&2; exit 3; }
  files+=("$path")
done
node --test --test-concurrency=1 "${files[@]}"
