#!/usr/bin/env bash
#
# Fresh-migration check — build the schema from 0000 to latest on an EMPTY database.
#
# This is what the per-round clean-room used to do. It moved here (nightly) because of what it can and
# cannot prove:
#
#   CAN prove  — the migration chain still builds a working schema from nothing. That is exactly what
#                happens when a NEW tenant or a new environment is provisioned, so it must keep passing.
#   CANNOT prove — that migrations apply cleanly to a database that already exists. On an empty database
#                every journal entry clears drizzle's watermark by construction, so the silent-skip class of
#                bug is green here 100% of the time. scripts/shadow-migrate.sh covers that, per round.
#
# Running this nightly rather than per-round keeps the guarantee without paying for it on every deploy.
#
# Usage:  bash scripts/fresh-migrate.sh
set -uo pipefail
PGHOST=127.0.0.1; PGPORT=5433; SUPER=postgres; APPROLE=ai_hr_app; FRESHDB=ai_hr_fresh
ROOT="$(pwd)"; ENVFILE="$ROOT/.env.local"; BACKUP="$ROOT/.env.local.fresh.bak"

cleanup() {
  [ -f "$BACKUP" ] && mv -f "$BACKUP" "$ENVFILE"
  psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d postgres -v ON_ERROR_STOP=0 >/dev/null 2>&1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$FRESHDB' AND pid<>pg_backend_pid();
DROP DATABASE IF EXISTS $FRESHDB WITH (FORCE);
SQL
}
trap cleanup EXIT

echo "== (re)create empty $FRESHDB =="
psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL || { echo "FRESH_RESULT=FAIL (create)"; exit 1; }
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$FRESHDB' AND pid<>pg_backend_pid();
DROP DATABASE IF EXISTS $FRESHDB WITH (FORCE);
CREATE DATABASE $FRESHDB OWNER $SUPER;
SQL
psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d "$FRESHDB" -v ON_ERROR_STOP=1 >/dev/null <<SQL || { echo "FRESH_RESULT=FAIL (grant)"; exit 1; }
GRANT CONNECT ON DATABASE $FRESHDB TO $APPROLE;
GRANT USAGE, CREATE ON SCHEMA public TO $APPROLE;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $APPROLE;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO $APPROLE;
SQL

echo "== migrate 0000 -> latest =="
cp -f "$ENVFILE" "$BACKUP"
{ grep -vE '^(MIGRATION_DATABASE_URL)=' "$BACKUP"
  echo "MIGRATION_DATABASE_URL=postgres://$SUPER@$PGHOST:$PGPORT/$FRESHDB"
} > "$ENVFILE"
pnpm exec drizzle-kit migrate 2>&1 | tail -15; MIG=${PIPESTATUS[0]}
mv -f "$BACKUP" "$ENVFILE"
[ "$MIG" -ne 0 ] && { echo "FRESH_RESULT=FAIL (migrate)"; exit 1; }

APPLIED=$(psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d "$FRESHDB" -tAc "SELECT count(*) FROM drizzle.__drizzle_migrations")
JOURNAL=$(node -e "console.log(require('./db/migrations/meta/_journal.json').entries.length)")
if [ "$APPLIED" -ne "$JOURNAL" ]; then
  echo "FRESH_RESULT=FAIL (applied $APPLIED of $JOURNAL journal entries)"
  exit 1
fi
echo "FRESH_RESULT=PASS ($APPLIED/$JOURNAL applied from empty)"
