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

# == contention guard ==
# Cost this rule twice: R46 and R47 both produced a RED gate (deadlocks / 120s hook timeouts) that had
# nothing to do with the code under test. The cause was other clients on this Postgres instance — a running
# dev server, or a sibling build agent's focused vitest — competing for the same tables. R47's first run
# took 59 minutes and reported 3 phantom failures; with the instance quiet it passed in 13.
# A gate that can be poisoned by an unrelated process is not a gate, so refuse to start instead.
BUSY=$(psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d postgres -tAc \
  "SELECT count(*) FROM pg_stat_activity WHERE datname NOT IN ('postgres') AND pid <> pg_backend_pid() AND backend_type='client backend'" 2>/dev/null || echo 0)
if [ "${BUSY:-0}" -gt 0 ]; then
  echo "REFUSING TO RUN: $BUSY other client connection(s) to $PGHOST:$PGPORT."
  psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d postgres -tAc \
    "SELECT '  - '||datname||' ('||count(*)||' conn) '||coalesce(application_name,'?') FROM pg_stat_activity
     WHERE datname NOT IN ('postgres') AND pid <> pg_backend_pid() AND backend_type='client backend'
     GROUP BY datname, application_name" 2>/dev/null
  echo "Stop the dev server / other test runs first (they poison the gate — see R46/R47), then re-run."
  echo "CLEANROOM_RESULT=FAIL (contention)"
  exit 1
fi

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
# ADR-0077 C11: catalogs are code-seeded, so a clean room that only migrates is NOT a usable database.
echo "== seed module + setting catalogs =="
node --env-file="$ENVFILE" --import tsx scripts/seed-catalogs.ts; SC=$?
[ "$SC" -ne 0 ] && { echo "CLEANROOM_RESULT=FAIL (seed-catalogs)"; exit 1; }
echo "== full vitest as $APPROLE under RLS =="
# hookTimeout bumped to 120s: each file's beforeAll applies ~190 migrations; under load the default 30s flakes.
pnpm exec vitest run --hookTimeout=120000 --testTimeout=60000 2>&1 | tail -40; VT=${PIPESTATUS[0]}
[ "$VT" -ne 0 ] && { echo "CLEANROOM_RESULT=FAIL (vitest)"; exit 1; }

# == gate receipt ==
# Record WHICH commit just passed, so `improve:release` can skip re-running an identical suite. Before this,
# every round ran the full suite twice on the same tree — once here, once in release.ts's final gate — for
# no extra information. release.ts re-runs the suite itself whenever this sha doesn't match HEAD.
#
# A DIRTY TREE GETS NO RECEIPT. The suite that just passed ran against the WORKING TREE, not against
# HEAD — so stamping HEAD's sha when files are modified or untracked records PASS for a commit that
# does not contain the code under test, and release.ts then skips its own gate on that basis. Write
# "dirty" instead: the receipt is still informative, and it can never match `git rev-parse HEAD`.
SHA=$(git rev-parse HEAD 2>/dev/null || echo unknown)
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "⚠ working tree is dirty — the suite passed against uncommitted code, so the receipt is not"
  echo "  attributable to $SHA. Commit and re-run to earn a skippable receipt."
  SHA=dirty
fi
cat > "$ROOT/.gate-receipt.json" <<JSON
{"sha":"$SHA","result":"PASS","at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","suite":"cleanroom-verify.sh"}
JSON
echo "wrote .gate-receipt.json for $SHA"
echo "CLEANROOM_RESULT=PASS"
