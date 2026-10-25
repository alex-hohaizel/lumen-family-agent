#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p /backups
export PGPASSWORD="$POSTGRES_PASSWORD"
while true; do
  task_backup="/backups/lumen-$(date -u +%Y%m%dT%H%M%SZ).dump"
  if pg_dump -h db -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "$task_backup.partial"; then
    mv "$task_backup.partial" "$task_backup"
    find /backups -maxdepth 1 -type f -name 'lumen-*.dump' -mmin +10080 -delete
    echo '{"event":"backup_completed"}'
  else
    echo '{"event":"backup_failed"}' >&2
  fi
  sleep 21600 & wait $!
done
