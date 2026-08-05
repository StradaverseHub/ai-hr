#!/usr/bin/env bash
# Rebuild the LOCAL PostgreSQL 16 cluster used by dev and the test suite.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# This project spent rounds r83 through r142 fighting a "wedge": DROP DATABASE would hang at
# CheckpointStart, every other DROP would queue behind it, and the whole cluster became unusable for
# testing. It was blamed on Trend Micro, on SIGKILL during teardown, and on leaked databases. Those
# were contributing factors at most.
#
# THE ACTUAL CAUSE, measured 2026-08-05: DROP DATABASE forces an IMMEDIATE, WAITED checkpoint. With
# fsync on, that checkpoint fsyncs every dirty file before it returns, and the previous advice in this
# repo made it worse by raising max_wal_size to 4GB so that MORE dirty data accumulated between
# checkpoints. On an IDLE, freshly-rebuilt cluster, four CREATE/DROP DATABASE statements did not
# complete in five minutes. With the settings below the same four take 0.47s, and a full harness cycle
# (11 creates + 11 drops) takes 2.3s.
#
# THE TRADE, STATED PLAINLY: fsync=off means a crash or power loss can corrupt this cluster. That is
# acceptable HERE and nowhere else — it holds vitest worker databases and a reseedable ai_hr_dev, and
# the correct response to corruption is to run this script again. PRODUCTION IS A DIFFERENT MACHINE
# and none of this touches it. Never copy these settings to a server.
#
#   ./scripts/dev-db-rebuild.sh          rebuild (moves the old cluster aside, does not delete it)
#   ./scripts/dev-db-rebuild.sh --purge  rebuild and delete previously-moved-aside clusters
set -uo pipefail

PG16="${PG16:-/opt/homebrew/opt/postgresql@16/bin}"   # keg-only: PG14 shadows psql/initdb on PATH
DATA="${PGDATA_AIHR:-/opt/homebrew/var/aihr-pg16}"
PORT="${PGPORT_AIHR:-5433}"

[ -x "$PG16/initdb" ] || { echo "no PostgreSQL 16 at $PG16"; exit 1; }

echo "▸ stopping any running cluster (immediate — everything here is disposable)"
"$PG16/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1
sleep 1
pkill -f "postgres.*$(basename "$DATA")" 2>/dev/null
sleep 1

if [ -d "$DATA" ]; then
  # mv, not rm -rf: instant, and it leaves the old cluster available if you need to look at it.
  OLD="$DATA.wedged-$(date +%Y%m%d-%H%M%S)"
  mv "$DATA" "$OLD"
  echo "▸ old cluster moved to $OLD"
fi

echo "▸ initdb"
"$PG16/initdb" -U postgres -D "$DATA" --encoding=UTF8 --locale=en_US.UTF-8 >/dev/null || exit 1

cat >> "$DATA/postgresql.conf" <<'CONF'

# === ai-hr disposable-cluster tuning — see scripts/dev-db-rebuild.sh for the measurements ===
# DROP DATABASE forces an immediate, waited checkpoint. fsync=on makes that checkpoint fsync every
# dirty file, and every other DROP queues behind it. That is the wedge. Measured: 4 CREATE/DROP took
# >5 minutes with fsync on, 0.47s with it off.
fsync = off
synchronous_commit = off
full_page_writes = off
wal_level = minimal
max_wal_senders = 0

# SMALLER, NOT BIGGER. Raising max_wal_size to "relieve" the checkpoint is backwards — it lets more
# dirty data accumulate, so the FORCED checkpoint has more to flush. It also let WAL reach 5GB, at
# which point resetDb()'s ~100-table TRUNCATE started losing lock races and produced 32 false test
# failures across files unrelated to the change under test.
max_wal_size = 1GB
min_wal_size = 256MB
checkpoint_timeout = 5min
checkpoint_completion_target = 0.9

shared_buffers = 512MB
CONF

echo "▸ starting on port $PORT"
"$PG16/pg_ctl" -D "$DATA" -o "-p $PORT" -l "$DATA/server.log" start >/dev/null || exit 1
for _ in $(seq 1 30); do psql -p "$PORT" -U postgres -d postgres -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done

# NOBYPASSRLS is the detail that costs an hour: a superuser ai_hr_app bypasses row-level security and
# ~18 tests fail in a way that reads as a security regression in the application. deploy/bootstrap-db.sql
# is the authority on these roles.
psql -p "$PORT" -U postgres -d postgres -q \
  -c "CREATE ROLE ai_hr_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;" \
  -c "CREATE DATABASE ai_hr_dev  OWNER ai_hr_app;" \
  -c "CREATE DATABASE ai_hr_test OWNER ai_hr_app;" || exit 1

echo "▸ verifying"
psql -p "$PORT" -U postgres -d postgres -At -F'|' \
  -c "select 'role', rolname, 'super='||rolsuper::text, 'bypassrls='||rolbypassrls::text from pg_roles where rolname='ai_hr_app'" \
  -c "select 'fsync', setting from pg_settings where name='fsync'" \
  -c "select 'databases', count(*)::text from pg_database"

if [ "${1:-}" = "--purge" ]; then
  echo "▸ purging previously moved-aside clusters"
  rm -rf "$DATA".wedged-* 2>/dev/null
fi

cat <<'DONE'

▸ done. Next: pnpm db:migrate && pnpm db:seed

  If DROP DATABASE ever hangs again, do NOT wait and do NOT kill -9 mid-teardown — just run this
  script. It is under a minute and it is deterministic.
DONE
