#!/usr/bin/env bash
# Clean-room gate: migrate an EMPTY db 0000->latest + full vitest as ai_hr_app under RLS. Run from the
# repo/worktree root:  bash cleanroom-verify.sh
set -uo pipefail
PGHOST=127.0.0.1; PGPORT=5433; SUPER=postgres; APPROLE=ai_hr_app; CLEANDB=ai_hr_cleanroom
ROOT="$(pwd)"; ENVFILE="$ROOT/.env.local"; BACKUP="$ROOT/.env.local.cleanroom.bak"
APPPASS="$(grep -oE 'ai_hr_app:[^@]+@' "$ENVFILE" | head -1 | sed -E 's/ai_hr_app:(.*)@/\1/')"; [ -z "$APPPASS" ] && APPPASS="ai_hr_app"
cleanup() {
  [ -f "$BACKUP" ] && mv -f "$BACKUP" "$ENVFILE"
  ( psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d postgres -v ON_ERROR_STOP=0 >/dev/null 2>&1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$CLEANDB' AND pid<>pg_backend_pid();
DROP DATABASE IF EXISTS $CLEANDB WITH (FORCE);
SQL
  ) & WPID=$!; ( sleep 25; kill -9 $WPID >/dev/null 2>&1 ) & GUARD=$!; wait $WPID 2>/dev/null; kill $GUARD >/dev/null 2>&1
}
trap cleanup EXIT
echo "== (re)create empty $CLEANDB =="
psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d postgres -v ON_ERROR_STOP=1 <<SQL || { echo "CLEANROOM_RESULT=FAIL (create)"; exit 1; }
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$CLEANDB' AND pid<>pg_backend_pid();
DROP DATABASE IF EXISTS $CLEANDB WITH (FORCE);
CREATE DATABASE $CLEANDB OWNER $SUPER;
SQL
psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d "$CLEANDB" -v ON_ERROR_STOP=1 <<SQL || { echo "CLEANROOM_RESULT=FAIL (grant)"; exit 1; }
GRANT CONNECT ON DATABASE $CLEANDB TO $APPROLE;
GRANT USAGE, CREATE ON SCHEMA public TO $APPROLE;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $APPROLE;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO $APPROLE;
SQL
echo "== migrate 0000 -> latest as $SUPER =="
cp -f "$ENVFILE" "$BACKUP"
{ grep -vE '^(DATABASE_URL|MIGRATION_DATABASE_URL|TEST_DATABASE_URL|TEST_MIGRATION_DATABASE_URL)=' "$BACKUP"
  echo "MIGRATION_DATABASE_URL=postgres://$SUPER@$PGHOST:$PGPORT/$CLEANDB"
  echo "TEST_MIGRATION_DATABASE_URL=postgres://$SUPER@$PGHOST:$PGPORT/$CLEANDB"
  echo "DATABASE_URL=postgres://$APPROLE:$APPPASS@$PGHOST:$PGPORT/$CLEANDB"
  echo "TEST_DATABASE_URL=postgres://$APPROLE:$APPPASS@$PGHOST:$PGPORT/$CLEANDB"
} > "$ENVFILE"
pnpm exec drizzle-kit migrate 2>&1 | tail -20; MIG=${PIPESTATUS[0]}
[ "$MIG" -ne 0 ] && { echo "CLEANROOM_RESULT=FAIL (migrate)"; exit 1; }
echo "== full vitest as $APPROLE under RLS =="
# hookTimeout bumped to 120s: each file's beforeAll applies ~190 migrations; under load the default 30s flakes.
pnpm exec vitest run --hookTimeout=120000 --testTimeout=60000 2>&1 | tail -40; VT=${PIPESTATUS[0]}
[ "$VT" -ne 0 ] && { echo "CLEANROOM_RESULT=FAIL (vitest)"; exit 1; }
echo "CLEANROOM_RESULT=PASS"
