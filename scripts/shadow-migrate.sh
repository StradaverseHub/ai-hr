#!/usr/bin/env bash
#
# Shadow migration gate — apply this branch's pending migrations to a COPY OF THE LIVE SCHEMA.
#
# WHY THIS EXISTS (and why the clean-room could not do this job)
# -------------------------------------------------------------
# The clean-room migrates an EMPTY database 0000 -> latest. That proves the chain builds a schema from
# scratch, which matters when provisioning a new tenant. It cannot, even in principle, catch the failure
# mode that has actually bitten this project twice:
#
#   drizzle's incremental migrator reads the single most recent applied row ONCE, up front, then applies
#   every journal entry whose `when` is greater than that snapshot. An entry added later with a LOWER `when`
#   than something already applied is silently SKIPPED — no error, no warning. It surfaces weeks later as a
#   missing column in production.
#
# On an empty database every entry clears the gate, so a fresh migrate is green BY CONSTRUCTION. That is
# exactly why R44's 0240 and the dev box's missing 0220/0225/0240 stayed invisible to a passing gate.
#
# What actually catches it is migrating against the state the server is really in. This script pulls the
# live schema (structure only — no rows, nothing sensitive leaves the box), restores it to a scratch local
# database including drizzle's bookkeeping table, and applies only what is pending. If a migration would be
# skipped, would collide with an existing object, or would fail against real-world state, it fails HERE.
#
# Usage:  bash scripts/shadow-migrate.sh
# Env:    IMPROVE_SSH_HOST (default 203.142.6.241), IMPROVE_SSH_PORT (8288), IMPROVE_SSH_USER (ubuntu)
set -uo pipefail

HOST="${IMPROVE_SSH_HOST:-203.142.6.241}"
PORT="${IMPROVE_SSH_PORT:-8288}"
USER="${IMPROVE_SSH_USER:-ubuntu}"
REMOTE_DIR="${IMPROVE_REMOTE_DIR:-/opt/ai-hr}"
PGHOST=127.0.0.1; PGPORT=5433; SUPER=postgres; SHADOWDB=ai_hr_shadow
ROOT="$(pwd)"; ENVFILE="$ROOT/.env.local"; BACKUP="$ROOT/.env.local.shadow.bak"
DUMP="$(mktemp -t aihr-shadow-XXXXXX).sql"

cleanup() {
  [ -f "$BACKUP" ] && mv -f "$BACKUP" "$ENVFILE"
  rm -f "$DUMP"
  psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d postgres -v ON_ERROR_STOP=0 >/dev/null 2>&1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$SHADOWDB' AND pid<>pg_backend_pid();
DROP DATABASE IF EXISTS $SHADOWDB WITH (FORCE);
SQL
}
trap cleanup EXIT

echo "== dump live schema from $HOST (structure only, no rows) =="
# --schema-only: no employee data, no payroll figures, nothing personal is copied to this machine.
# drizzle.__drizzle_migrations is included WITH data — it is the watermark the whole test depends on.
ssh -p "$PORT" -o BatchMode=yes -o ConnectTimeout=12 "$USER@$HOST" \
  "cd $REMOTE_DIR && set -a && . ./.env.production && set +a && \
   pg_dump --schema-only --no-owner --no-privileges \"\$MIGRATION_DATABASE_URL\" && \
   pg_dump --data-only --table=drizzle.__drizzle_migrations --no-owner --no-privileges \"\$MIGRATION_DATABASE_URL\"" \
  > "$DUMP" 2>/dev/null || { echo "SHADOW_RESULT=FAIL (dump — is the server reachable?)"; exit 1; }

echo "   dumped $(wc -l < "$DUMP" | tr -d ' ') lines"

# Strip \restrict / \unrestrict. These are psql META-COMMANDS (not SQL) that recent pg_dump wraps the dump
# in to stop a hostile dump file from executing meta-commands during restore. The server dumps with
# pg_dump 16.x; an older local psql does not recognise them and aborts with "invalid command \restrict".
# Removing them is safe HERE specifically: the dump comes from our own server over an authenticated SSH
# connection and is restored into a throwaway local database. Do not copy this into a path that restores
# dumps from anywhere less trusted.
sed -i.bak -E '/^\\(restrict|unrestrict)[[:space:]]/d' "$DUMP" && rm -f "$DUMP.bak"

echo "== restore into scratch $SHADOWDB =="
psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL || { echo "SHADOW_RESULT=FAIL (create)"; exit 1; }
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$SHADOWDB' AND pid<>pg_backend_pid();
DROP DATABASE IF EXISTS $SHADOWDB WITH (FORCE);
CREATE DATABASE $SHADOWDB OWNER $SUPER;
SQL
# Keep stderr: a swallowed restore error costs a whole debug cycle to rediscover (it hid the \restrict
# incompatibility above). Show the real psql errors on failure.
RESTORE_LOG="$(mktemp -t aihr-restore-XXXXXX).log"
if ! psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d "$SHADOWDB" -v ON_ERROR_STOP=1 -f "$DUMP" >/dev/null 2>"$RESTORE_LOG"; then
  echo "   restore failed:"
  grep -iE "error|FATAL" "$RESTORE_LOG" | head -5 | sed 's/^/     /'
  echo "   (a local Postgres older than the server's can reject newer dump syntax — compare"
  echo "    'psql --version' here with 'pg_dump --version' on the server)"
  rm -f "$RESTORE_LOG"
  echo "SHADOW_RESULT=FAIL (restore)"
  exit 1
fi
rm -f "$RESTORE_LOG"

APPLIED_BEFORE=$(psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d "$SHADOWDB" -tAc \
  "SELECT count(*) FROM drizzle.__drizzle_migrations" 2>/dev/null || echo 0)
JOURNAL=$(node -e "console.log(require('./db/migrations/meta/_journal.json').entries.length)")
echo "   live has $APPLIED_BEFORE migrations applied; this branch's journal has $JOURNAL entries"

echo "== apply pending migrations against the live-shaped schema =="
cp -f "$ENVFILE" "$BACKUP"
{ grep -vE '^(MIGRATION_DATABASE_URL)=' "$BACKUP"
  echo "MIGRATION_DATABASE_URL=postgres://$SUPER@$PGHOST:$PGPORT/$SHADOWDB"
} > "$ENVFILE"
pnpm exec drizzle-kit migrate 2>&1 | tail -15; MIG=${PIPESTATUS[0]}
mv -f "$BACKUP" "$ENVFILE"
[ "$MIG" -ne 0 ] && { echo "SHADOW_RESULT=FAIL (migrate)"; exit 1; }

APPLIED_AFTER=$(psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d "$SHADOWDB" -tAc \
  "SELECT count(*) FROM drizzle.__drizzle_migrations" 2>/dev/null || echo 0)

# THE ASSERTION THAT MATTERS. A silently-skipped migration shows up here and nowhere else: the migrator
# exits 0, but the applied count lands short of the journal. Without this check the whole exercise would
# reproduce the original bug rather than catch it.
echo "   applied $APPLIED_BEFORE -> $APPLIED_AFTER (journal: $JOURNAL)"
if [ "$APPLIED_AFTER" -ne "$JOURNAL" ]; then
  echo ""
  echo "MIGRATION SILENTLY SKIPPED: $APPLIED_AFTER of $JOURNAL journal entries are applied after migrating."
  echo "drizzle exited 0 but did not apply everything — almost certainly a \`when\` value that is not"
  echo "strictly greater than the live watermark. Re-stamp the offending entry above the current maximum"
  echo "and re-run. (test/migration-journal-ordering.test.ts guards ordering within the repo.)"
  echo "SHADOW_RESULT=FAIL (silent skip)"
  exit 1
fi

echo "SHADOW_RESULT=PASS ($APPLIED_AFTER/$JOURNAL applied against live-shaped schema)"
