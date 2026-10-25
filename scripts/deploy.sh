#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
task_target="${1:-}"
if ! [[ "$task_target" =~ ^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.:-]+$ ]]; then
  echo 'Використання: ./scripts/deploy.sh user@your-server'; exit 1
fi
if [ ! -f runtime/config.json ]; then echo 'Спочатку пройдіть локальний майстер і вхід у ChatGPT.'; exit 1; fi
ssh "$task_target" 'if [ -f ~/lumen-telegram/runtime/config.json ]; then echo "Люмен уже встановлений на цьому сервері. Для оновлення збережіть наявні runtime і базу; deploy.sh призначений для першого запуску." >&2; exit 1; fi'
export LUMEN_UID="$(id -u)" LUMEN_GID="$(id -g)"
# A laptop and VM must not refresh the same renewable session concurrently.
docker compose stop bot backups 2>/dev/null || true
task_dump=''
if [ -n "$(docker compose ps -q db)" ]; then
  task_dump="$(mktemp /tmp/lumen-migration.XXXXXX.dump)"
  chmod 600 "$task_dump"
  docker compose exec -T db pg_dump -U lumen -d lumen -Fc > "$task_dump"
fi
task_archive="$(mktemp /tmp/lumen-source.XXXXXX.tar.gz)"
tar --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env --exclude=runtime --exclude=backups --exclude='*.log' -czf "$task_archive" .
ssh "$task_target" 'umask 077; mkdir -p ~/lumen-telegram/runtime ~/lumen-telegram/backups'
scp "$task_archive" "$task_target:~/lumen-telegram/source.tar.gz"
ssh "$task_target" 'cd ~/lumen-telegram && tar -xzf source.tar.gz && chmod 700 runtime backups && { if [ ! -f runtime/postgres.env ]; then (umask 077; touch runtime/postgres.env); fi; }'
ssh "$task_target" 'cd ~/lumen-telegram && docker compose build bot'
# Keep the VM host identity; only selected protected credentials and config move.
scp runtime/config.json "$task_target:~/lumen-telegram/runtime/config.json"
scp runtime/postgres.env "$task_target:~/lumen-telegram/runtime/postgres.env"
if [ -f runtime/accounts.json ]; then scp runtime/accounts.json "$task_target:~/lumen-telegram/runtime/accounts.json"; fi
if [ -f runtime/setup-complete ]; then scp runtime/setup-complete "$task_target:~/lumen-telegram/runtime/setup-complete"; fi
ssh "$task_target" 'cd ~/lumen-telegram && chmod 600 runtime/*.json runtime/postgres.env && export LUMEN_UID=$(id -u) LUMEN_GID=$(id -g) && docker compose run --rm --no-deps bot node dist/src/auth.js init-host && docker compose up -d --wait db'
if [ -n "$task_dump" ]; then
  scp "$task_dump" "$task_target:~/lumen-telegram/runtime/migration.dump"
  ssh "$task_target" 'cd ~/lumen-telegram && chmod 600 runtime/migration.dump && docker compose exec -T db pg_restore -U lumen -d lumen --no-owner --exit-on-error < runtime/migration.dump'
fi
ssh "$task_target" 'cd ~/lumen-telegram && export LUMEN_UID=$(id -u) LUMEN_GID=$(id -g) && docker compose up -d --wait bot backups'
echo 'Люмен перенесений на сервер. Перевірте /status у групі. Локальний бот залишайте вимкненим.'
