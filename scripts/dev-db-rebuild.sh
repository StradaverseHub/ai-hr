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
# CAUSE #1, measured 2026-08-05: DROP DATABASE forces an IMMEDIATE, WAITED checkpoint. With fsync on,
# that checkpoint fsyncs every dirty file before it returns, and the previous advice in this repo made it
# worse by raising max_wal_size to 4GB so that MORE dirty data accumulated between checkpoints. On an
# IDLE, freshly-rebuilt cluster, four CREATE/DROP DATABASE statements did not complete in five minutes.
# With `fsync = off` below the same four take 0.47s.
#
# ── CAUSE #2, measured 2026-08-06, AND THE REASON THIS SCRIPT NOW BUILDS A RAM DISK ──────────────────
#
# `fsync = off` was NOT sufficient, and the note above was read for a whole round as if it were. Settings
# verified live (fsync off, synchronous_commit off, wal_level minimal, max_wal_size 1GB) and a
# DROP DATABASE still sat on IPC/CheckpointDone for TEN MINUTES on an idle cluster, after a suite run of
# 2633s carrying nineteen ~900s timeouts. The checkpoint log says where the time actually goes:
#
#     distance   segments removed   write    sync     total
#     13 kB      0                  0.001s   0.001s   0.002s
#     538 MB     33                 12.7s    0.016s   72.6s
#     2.6 GB     159                15.0s    0.027s   405s
#     10.4 GB    632                18.7s    0.171s   5250s
#
#   • sync ~= 0        => fsync=off IS working. Cause #1 is genuinely fixed.
#   • write is FLAT    => flushing dirty buffers is not the bottleneck at any WAL size.
#   • total tracks WAL SEGMENT RETIREMENT — roughly 8 seconds per 16MB unlink, 632 of them.
#
# So the residual cost is UNLINKING WAL FILES, at a speed no SSD explains — consistent with on-access AV
# scanning that the 2026-08-04 path exclusion did not cover. And it is self-reinforcing: slow unlinks mean
# checkpoints do not finish, so WAL grows (it reached 10.7 GB), so there is more to unlink. Thirty-seven
# `aihr-pg16.wedged-*` directories in /opt/homebrew/var record how often this has cost a session.
#
# THE FIX: put the data directory on a RAM DISK. Unlinks become memory operations, no scanner can see the
# files, and the loop cannot start. Checkpoints then complete in seconds, so WAL settles near
# max_wal_size instead of climbing. This is safe precisely because the cluster is already disposable —
# see the trade below. A RAM disk does not survive a reboot; re-run this script and it is rebuilt.
#
# THE TRADE, STATED PLAINLY: fsync=off means a crash or power loss can corrupt this cluster. That is
# acceptable HERE and nowhere else — it holds vitest worker databases and a reseedable ai_hr_dev, and
# the correct response to corruption is to run this script again. PRODUCTION IS A DIFFERENT MACHINE
# and none of this touches it. Never copy these settings to a server.
#
#   ./scripts/dev-db-rebuild.sh          rebuild on a RAM disk (default)
#   ./scripts/dev-db-rebuild.sh --purge  also delete previously-moved-aside on-disk clusters
#   AIHR_RAMDISK_GB=0 ./scripts/dev-db-rebuild.sh   rebuild ON DISK (the old behaviour)
#   AIHR_RAMDISK_GB=8 ./scripts/dev-db-rebuild.sh   a bigger RAM disk
#
# SIZING: 5 GB by default on an 18 GB machine. Steady state is ~1 GB of worker databases plus WAL that
# now stays near max_wal_size (1 GB), so 5 GB is roughly 2x headroom. If Postgres ever PANICs with "No
# space left on device", raise AIHR_RAMDISK_GB rather than moving back to disk.
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

RAMDISK_GB="${AIHR_RAMDISK_GB:-5}"
MOUNT="${DATA}-ram"          # the RAM disk itself
REAL="$MOUNT/data"           # PGDATA lives one level DOWN — see below
is_mounted() { mount | grep -q " on $MOUNT "; }

# WHY THE SYMLINK. initdb REFUSES a mount point as the data directory: HFS puts .fseventsd and
# "HFS+ Private Directory Data" at the root of every volume, so the directory is never empty and initdb
# stops with "exists but is not empty ... perhaps due to it being a mount point". So the volume is
# mounted at <DATA>-ram, PGDATA is <DATA>-ram/data, and <DATA> is a SYMLINK to it — which keeps
# /opt/homebrew/var/aihr-pg16 working verbatim for pnpm db:start, pg_ctl and every other caller.
if [ "$RAMDISK_GB" != "0" ]; then
  if is_mounted; then
    echo "▸ RAM disk already mounted at $MOUNT — clearing it"
    rm -rf "${REAL:?}"
  else
    if [ -e "$DATA" ] && [ ! -L "$DATA" ]; then
      OLD="$DATA.predisk-$(date +%Y%m%d-%H%M%S)"
      mv "$DATA" "$OLD"
      echo "▸ old on-disk cluster moved to $OLD"
    fi
    mkdir -p "$MOUNT"
    BLOCKS=$((RAMDISK_GB * 1024 * 1024 * 2))     # 512-byte sectors
    # awk, not `tr -d ' '`: hdiutil pads the device with TABS, and a mangled path fails inside
    # newfs_hfs with a "No such file or directory" that looks like a missing disk.
    DEV=$(hdiutil attach -nomount "ram://$BLOCKS" | awk '{print $1}')
    [ -n "$DEV" ] || { echo "could not create a ${RAMDISK_GB}GB RAM disk"; exit 1; }
    newfs_hfs -v aihr-pg16 "$DEV" >/dev/null || { hdiutil detach "$DEV" -force; exit 1; }
    mount -t hfs "$DEV" "$MOUNT" || { hdiutil detach "$DEV" -force; exit 1; }
    echo "$DEV" > /tmp/aihr-ramdisk.dev
    echo "▸ ${RAMDISK_GB}GB RAM disk $DEV mounted at $MOUNT"
  fi
  mkdir -p "$REAL"
  rm -f "$DATA"
  ln -s "$REAL" "$DATA"
elif [ -d "$DATA" ]; then
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
