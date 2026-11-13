#!/bin/sh
# Restores a dump into a NEW database. It never overwrites or drops an existing one.
#   ./restore.sh backups/db-<time>.dump                 restore test: scratch database, verified, then only that scratch database is dropped
#   ./restore.sh backups/db-<time>.dump receptionist_r1 recovery: keeps it; then point the DATABASE_URL_* names at it and restart
# On a brand-new server, load the roles first:  docker compose exec -T db psql -U postgres < backups/roles-<time>.sql
set -eu
cd "$(dirname "$0")"
dump=$1
name=${2:-}
target=${name:-restore_check_$(date -u +%Y%m%d%H%M%S)_$$}
case "$target" in *[!a-z0-9_]*) echo "database name: lowercase letters, digits and _ only" >&2; exit 1 ;; esac
psql() { docker compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -At "$@"; }
[ "$(psql -c "SELECT count(*) FROM pg_database WHERE datname = '$target'")" = 0 ] || { echo "$target already exists; choose another name" >&2; exit 1; }
psql -c "CREATE DATABASE $target" > /dev/null
docker compose exec -T db pg_restore -U postgres --exit-on-error -d "$target" < "$dump"
echo "restored into $target: latest migration $(psql -d "$target" -c 'SELECT max(name) FROM schema_migrations'), $(psql -d "$target" -c 'SELECT count(*) FROM workspaces') workspaces, $(psql -d "$target" -c 'SELECT count(*) FROM messages') messages"
if [ -z "$name" ]; then
  psql -c "DROP DATABASE $target" > /dev/null
  echo "restore test passed; scratch database $target removed"
fi
