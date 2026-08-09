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
#   ./scripts/dev-db-rebuild.sh          rebuild ON DISK (default since 2026-08-10)
#   ./scripts/dev-db-rebuild.sh --purge  also delete previously-moved-aside on-disk clusters
#   AIHR_RAMDISK_GB=8 ./scripts/dev-db-rebuild.sh   rebuild on an 8 GB RAM disk (targeted runs only)
#
# SIZING: 8 GB by default on an 18 GB machine. Steady state is well under 1 GB of WAL (see the block below)
# plus ~0.4 GB of worker databases, so about 1 GB in use and the rest is headroom. Two LARGER WAL settings
# were tried and FILLED this 8 GB volume on 2026-08-10 — see the max_wal_size note below; volume size
# was never the fix. If Postgres dies with "No space left on device", LOWER max_wal_size — do not check
# for "recycled" vs "removed", which is an on-disk concern that does not apply in RAM.
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

# DEFAULT 0 = ON DISK. Changed 2026-08-10 after three consecutive gates died with the 8 GB RAM disk
# full of WAL — see the WAL-sizing block below for the measurement. Set AIHR_RAMDISK_GB=8 to opt back in
# for short, targeted runs (a single test file never comes close to the ceiling); a FULL suite must not.
RAMDISK_GB="${AIHR_RAMDISK_GB:-0}"
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

# ⚠️ WAL SIZING ON A RAM DISK IS THE OPPOSITE OF WAL SIZING ON A SPINNING VOLUME. KEEP IT SMALL.
#
# An earlier version of this block said "min_wal_size IS THE SETTING THAT MATTERED ALL ALONG. RAISE IT.
# DO NOT SHRINK IT." That advice was correct FOR THE ON-DISK CLUSTER IT WAS MEASURED ON, and it is wrong
# here. Both halves of the story are kept because the reasoning is what transfers, not the number.
#
# WHAT WAS TRUE ON DISK. Every checkpoint reported "N removed, 0 recycled". `removed` means the segment
# was UNLINKED; `recycled` means it was renamed and reused. PostgreSQL keeps segments for reuse only up to
# min_wal_size and unlinks the rest, so min_wal_size = 128MB unlinked essentially every segment the
# workload produced. Each unlink cost ~8s on the SSD — consistent with on-access AV scanning — so
# checkpoints could not finish inside checkpoint_timeout, WAL grew, and there was more to unlink next time.
# WAL reached 10.7GB. Raising min_wal_size was the right answer THERE: recycling is a rename, and a rename
# is invisible to a scanner.
#
# WHY IT INVERTS ON A RAM DISK. The cost that justified a large pool — the ~8s scanned unlink — does not
# exist in memory, where an unlink is a few microseconds and no scanner can see the file. So a large
# retained pool buys nothing, and it is charged directly against a volume that is only 8GB. The setting
# stopped being a latency knob and became a capacity knob, and nobody re-derived it after the move.
#
# MEASURED on 2026-08-10, twice, on the 8GB RAM disk:
#   • min 3GB / max 1GB (a floor ABOVE the ceiling — Postgres does not reject the pair because pacing
#     reads max_wal_size while retention reads min_wal_size): pg_wal hit 6.9GB against 340MB for all 16
#     databases combined. WAL was 95% of the volume.
#   • min 1GB / max 2GB, coherent but still generous: pg_wal hit 7.0GB and filled the volume again.
#     Checkpoints still said "85 removed, 0 recycled" — the pool never even got used.
# Both runs ended with "could not extend file: No space left on device" (SQLSTATE 53100), a dead cluster
# mid-gate, and ~2,766 failures across ~344 files, NONE of them real. The first of the two is also why the
# cluster was found down at the start of that session, and it left a worker database in `invalid` state.
#
# THE ACTUAL LEVER IS max_wal_size, AND IT IS A TRIGGER, NOT A THROTTLE. It does not cap WAL; it decides
# when a checkpoint STARTS. This suite writes faster than a checkpoint retires segments, so WAL settles at
# roughly (write rate x checkpoint duration), and 2GB of slack before the checkpointer even wakes up was
# enough to overrun 8GB. Small values make checkpoints frequent and cheap — which on a RAM disk with
# fsync=off they genuinely are — and hold pg_wal near half a gigabyte instead of seven.
#
# VERIFY, don't assume: `du -sm $PGDATA/pg_wal` during a full run should sit well under 1GB. If it climbs
# past a couple of GB, lower max_wal_size further or drop to AIHR_RAMDISK_GB=0, where the volume is the
# SSD and there is no ceiling at all (slower unlinks, but nothing dies).
checkpoint_completion_target = 0.5

shared_buffers = 512MB
CONF

# ── AND THE WAL SIZES DEPEND ON WHICH VOLUME WE JUST BUILT, so they are appended separately ──────────
#
# THE MEASUREMENT THAT FORCED THIS SPLIT (2026-08-10). The full suite generates roughly 130 MB/s of WAL
# across its 10 workers. WAL cannot be retired until a checkpoint completes, so pg_wal settles at about
# (write rate x checkpoint interval) NO MATTER WHAT max_wal_size says — max_wal_size only decides when a
# checkpoint STARTS, it does not throttle writers. checkpoint_timeout has a hard floor of 30s in
# PostgreSQL ("15 s is outside the valid range ... (30 .. 86400)"), so the arithmetic floor for this
# workload is ~4 GB of WAL and in practice it ran to 7 GB.
#
# An 8 GB RAM disk therefore CANNOT hold a full-suite run at any setting. Three gates died proving it
# (min 3GB/max 1GB, then min 1GB/max 2GB, then min 192MB/max 512MB): each ended with "could not extend
# file: No space left on device", a dead cluster mid-run, and ~2,700 failures across ~344 files, none of
# them real. Lowering max_wal_size made pg_wal grow more slowly and did not change the outcome.
#
# So the two volumes get opposite tuning, for reasons that are genuinely opposite:
#
#   ON DISK  — no ceiling (hundreds of GB), but unlinks were the original bottleneck at ~8s each under
#              on-access AV scanning. A LARGE pool is right: PostgreSQL recycles (renames) segments up to
#              min_wal_size and unlinks only beyond it, and a rename is invisible to a scanner. This is
#              what the "RAISE IT. DO NOT SHRINK IT." note above was measured on, and it is correct HERE.
#
#   RAM DISK — unlinks are free (memory, no scanner), so the large pool buys nothing, and every byte of
#              it is charged against a volume that cannot grow. Small is right; it still is not small
#              enough to survive a full suite, which is why the default below is now the SSD.
#
# THE DEFAULT IS NOW AIHR_RAMDISK_GB=0. A gate that finishes slowly beats a gate that dies at 90%.
if [ "$RAMDISK_GB" != "0" ]; then
  cat >> "$DATA/postgresql.conf" <<'CONF'
min_wal_size = 192MB
max_wal_size = 512MB
checkpoint_timeout = 30s
CONF
else
  cat >> "$DATA/postgresql.conf" <<'CONF'
min_wal_size = 3GB
max_wal_size = 4GB
checkpoint_timeout = 5min
CONF
fi

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
