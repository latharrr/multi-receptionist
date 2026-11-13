#!/bin/sh
# Backs up the database, its login roles and the data folder into ./backups (or $BACKUP_DIR).
# Read-only against the running system. The files contain customer data and password hashes:
# keep them private and off the app host. MASTER_KEY is deliberately not in them.
set -eu
cd "$(dirname "$0")"
out=${BACKUP_DIR:-./backups}
ts=$(date -u +%Y%m%dT%H%M%SZ)
umask 077
mkdir -p "$out"
docker compose exec -T db pg_dump -U postgres -Fc receptionist > "$out/db-$ts.dump"
docker compose exec -T db pg_dumpall -U postgres --roles-only > "$out/roles-$ts.sql"
# Uploads and QR session files; skipped with a note when the web container is not running.
docker compose exec -T web tar -C /data -cf - . > "$out/data-$ts.tar" 2>/dev/null || { rm -f "$out/data-$ts.tar"; echo "data folder not backed up (web is not running)"; }
[ -s "$out/db-$ts.dump" ] || { echo "backup failed: empty dump" >&2; exit 1; }
echo "$out/db-$ts.dump"
