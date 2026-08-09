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
# SIZING: 8 GB by default on an 18 GB machine. Steady state is min_wal_size (1 GB) of recycled segments
# plus ~0.4 GB of worker databases, so about 3.5 GB in use and the rest is headroom. Two smaller volumes
# were tried and FILLED (5 GB, then 8 GB) before the real cause was found — see min_wal_size below; the
# volume size was never the fix. If Postgres dies with "No space left on device", check that checkpoints
# report "recycled" rather than "removed" BEFORE reaching for a bigger volume.
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

RAMDISK_GB="${AIHR_RAMDISK_GB:-8}"
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

# ⚠️ min_wal_size IS THE SETTING THAT MATTERED ALL ALONG. RAISE IT. DO NOT SHRINK IT.
#
# Every checkpoint in this cluster's history reported "N removed, 0 recycled". `removed` means the
# segment was UNLINKED; `recycled` means it was renamed and reused. PostgreSQL keeps segments for reuse
# only up to min_wal_size and unlinks everything beyond it — so min_wal_size = 128MB guaranteed that this
# workload unlinked essentially every segment it produced, thousands of them per run.
#
# That single fact explains the entire saga:
#   • checkpoint `total` tracked segments removed (~8s each on disk, ~0.7s each on a RAM disk) while
#     `write` stayed flat at ~3s and `sync` was ~0;
#   • slow checkpoints could not finish inside checkpoint_timeout, so WAL grew, so there was more to
#     unlink next time — 10.7GB on disk, and a filled 5GB then 8GB RAM disk;
#   • and the older advice in this repo to make max_wal_size/min_wal_size SMALLER made it strictly worse,
#     because a smaller min_wal_size unlinks more. The 4GB experiment that "made it worse" was misread:
#     WAL grew because checkpoints were slow, not because the setting was large.
#
# So: keep a large pool of segments in rotation. Recycling is a rename — no create, no unlink, and
# nothing for an on-access scanner to inspect. Expect "0 removed, N recycled" and a WAL directory that
# sits at a stable size instead of thrashing.
# ⚠️ AND max_wal_size MUST STAY ABOVE min_wal_size. It did not, and that filled the volume.
#
# This block used to read min_wal_size = 3GB / max_wal_size = 1GB — a floor ABOVE the ceiling. The two
# settings drive different machinery, so Postgres does not reject the pair, it just behaves incoherently:
# checkpoint PACING is computed from max_wal_size, while RemoveOldXlogFiles refuses to drop the pool below
# min_wal_size. WAL therefore had a 3GB floor it could never shed, while the checkpointer believed it was
# permanently over a 1GB budget.
#
# MEASURED on 2026-08-10, a full-suite gate on the 8GB RAM disk: pg_wal reached 6.9GB (444 segments)
# against 340MB for all 16 databases combined — WAL was 95% of the volume. Postgres died with
# "could not extend file: No space left on device" (SQLSTATE 53100) and took the gate with it: 2,766
# failures across 344 files, none of them real. It had already died the same way once before that run,
# which is why the cluster was found down at the start of the session.
#
# So: keep a recycled pool big enough to avoid the unlink thrash described above, but small enough that
# pool + one checkpoint interval of writes fits the volume with room to spare. 1GB is 64 segments — 8x
# the 128MB that caused the original saga, so recycling still dominates — and 2GB of pacing headroom
# above it keeps the steady state near 3GB on an 8GB disk.
#
# VERIFY, don't assume: after a full run, checkpoints in server.log must still say "N recycled" with
# `removed` at or near 0. If `removed` climbs again, the pool is too small — raise BOTH, keeping
# max_wal_size above min_wal_size, or drop to AIHR_RAMDISK_GB=0 where there is no ceiling at all.
min_wal_size = 1GB
max_wal_size = 2GB
checkpoint_timeout = 1min
checkpoint_completion_target = 0.5

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
