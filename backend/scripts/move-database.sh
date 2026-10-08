#!/usr/bin/env bash
# Copies every table and row from one Postgres database to another, for example from a Neon
# project in one region to a new Neon project in the same region as the API.
#
#   OLD_DATABASE_URL='postgres://…' NEW_DATABASE_URL='postgres://…' backend/scripts/move-database.sh
#
# - Needs only Docker: pg_dump/pg_restore run from the official postgres image.
# - Use Neon's *direct* host for both URLs (without "-pooler"); dumps don't work through the pooler.
# - The old database is only read. The new one must be empty unless you pass --force, which
#   drops and recreates any objects that already exist there.
# - A copy of the dump is kept in backend/backups/ (git-ignored) so nothing depends on the old
#   database still existing afterwards.
set -euo pipefail

FORCE=false
[[ "${1:-}" == "--force" ]] && FORCE=true
: "${OLD_DATABASE_URL:?Set OLD_DATABASE_URL to the current database}"
: "${NEW_DATABASE_URL:?Set NEW_DATABASE_URL to the new, empty database}"
IMAGE="${PG_IMAGE:-postgres:18-alpine}" # pg_dump must be at least the old server's major version; 18 matches new Neon projects

for name in OLD_DATABASE_URL NEW_DATABASE_URL; do
  if [[ "${!name}" == *-pooler* ]]; then
    echo "$name points at a Neon pooler host. Use the direct host (remove \"-pooler\" from the hostname)." >&2
    exit 1
  fi
done
if [[ "$OLD_DATABASE_URL" == "$NEW_DATABASE_URL" ]]; then
  echo "OLD_DATABASE_URL and NEW_DATABASE_URL are the same database." >&2
  exit 1
fi

here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$here/backups"
dump="lightex-$(date +%Y%m%d-%H%M%S).dump"

pg() { # runs a postgres client tool with the backups folder mounted at /backups
  MSYS_NO_PATHCONV=1 docker run --rm -i --network "${PG_NETWORK:-host}" -v "$here/backups:/backups" "$IMAGE" "$@"
}
psql_q() { pg psql "$1" -X -At -v ON_ERROR_STOP=1 -c "$2"; }

# Row counts of every table in the public schema, one "table count" line each.
COUNT_SQL="select string_agg(format('select %L as t, count(*) as n from public.%I', tablename, tablename), ' union all ' order by tablename) from pg_tables where schemaname = 'public'"
counts() {
  local q
  q="$(psql_q "$1" "$COUNT_SQL")"
  [[ -z "$q" ]] && return 0
  psql_q "$1" "select t || ' ' || n from ($q) c order by t"
}

echo "Checking both databases…"
echo "  old: $(psql_q "$OLD_DATABASE_URL" "select current_database() || ' on Postgres ' || current_setting('server_version')")"
echo "  new: $(psql_q "$NEW_DATABASE_URL" "select current_database() || ' on Postgres ' || current_setting('server_version')")"
existing="$(psql_q "$NEW_DATABASE_URL" "select count(*) from pg_tables where schemaname = 'public'")"
if [[ "$existing" != "0" && "$FORCE" != true ]]; then
  echo "The new database already has $existing tables. Point at an empty database, or pass --force to overwrite." >&2
  exit 1
fi

echo "Dumping the old database to backend/backups/$dump…"
pg pg_dump "$OLD_DATABASE_URL" --format=custom --no-owner --no-privileges --file "/backups/$dump"
echo "  $(du -h "$here/backups/$dump" | cut -f1) written."

echo "Restoring into the new database…"
restore_flags=(--no-owner --no-privileges --exit-on-error --single-transaction)
$FORCE && restore_flags+=(--clean --if-exists)
pg pg_restore --dbname "$NEW_DATABASE_URL" "${restore_flags[@]}" "/backups/$dump"

echo "Comparing row counts…"
old_counts="$(counts "$OLD_DATABASE_URL")"
new_counts="$(counts "$NEW_DATABASE_URL")"
if [[ "$old_counts" == "$new_counts" ]]; then
  echo "  All $(wc -l <<<"$old_counts" | tr -d ' ') tables match:"
  awk '$2 > 0 { printf "    %-45s %s\n", $1, $2 }' <<<"$new_counts"
  echo "Done. Point the API's DATABASE_URL at the new database (the -pooler host is fine there)."
else
  echo "  Row counts differ (old vs new):" >&2
  diff <(echo "$old_counts") <(echo "$new_counts") >&2 || true
  exit 1
fi
