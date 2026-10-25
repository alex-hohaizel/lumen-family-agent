#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export LUMEN_UID="$(id -u)" LUMEN_GID="$(id -g)"
command -v docker >/dev/null || { echo 'Потрібен Docker з Compose. Встановіть його, потім запустіть start.sh.'; exit 1; }
docker compose version >/dev/null
mkdir -p runtime backups
chmod 700 runtime backups
if [ ! -f runtime/setup-complete ]; then
  # Compose validates env_file even for the setup profile. No credentials exist yet.
  if [ ! -f runtime/postgres.env ]; then
    (umask 077; : > runtime/postgres.env)
  fi
  docker compose build setup
  docker compose run --rm --service-ports setup
fi
if [ ! -f runtime/setup-complete ] || [ ! -s runtime/config.json ] || [ ! -s runtime/postgres.env ]; then
  echo 'Майстер не завершено. Підключіть Telegram, модель і перевірте відповідь.'; exit 1
fi
docker compose up -d --build --wait db bot backups
echo 'Люмен запущений. Додайте його у групу та виконайте команду з майстра.'
echo 'Стан: docker compose ps. Діагностика: docker compose exec bot node dist/src/doctor.js'
