#!/usr/bin/env bash
# AI HR — take a consistent, verified, off-box database backup with a retention policy.
#
# THE PROBLEM THIS IS FOR (readiness 1.5). There is no dump job on the production box: `crontab -l`,
# /etc/cron.d, /etc/cron.daily and `systemctl list-timers` contain none (re-checked 2026-09-16).
# `archive_mode=off` and `wal_level=replica`, so there is no point-in-time recovery either. Every dump
# on that box is an ad-hoc pre-migration artefact sitting on the SAME DISK as the database it came
# from, which means the one failure a backup exists for — losing that disk — loses the backups too.
# The recovery-point objective is "whenever somebody last dumped by hand".
#
# THIS SCRIPT IS NOT INSTALLED. It is in the repo, runnable, and scheduled by nobody. Installing it
# needs two decisions only the owner can make (see "WHAT THE OWNER MUST DECIDE" below), and inventing
# either of them here would produce exactly the thing this item is about: a backup arrangement that
# looks real and is not.
#
# WHAT IT DOES
#   1. resolves a pg_dump whose major version is >= the server's, and refuses if there is none
#   2. holds ONE repeatable-read snapshot and, inside it, both dumps the database AND measures it
#   3. writes a manifest beside the dump: per-table row counts, RLS flags, policy counts, the ACL
#      grantee roles, and what the application role can see through RLS
#   4. ships both to an OFF-BOX destination and reads back the size to prove they arrived
#   5. prunes old backups AT THE DESTINATION, by the timestamp in the filename, never below a floor
#   6. exits non-zero and writes a machine-readable status file on every failure
#
# The manifest is the half that matters. A dump nothing can be checked against is not a backup, it is
# a file; scripts/restore-rehearsal.sh restores this dump and diffs the restored database against this
# manifest, and that is what makes the pair of them a tested backup rather than an untested one.
#
# CONSISTENCY. pg_dump already takes a repeatable-read snapshot of its own, so the DUMP is internally
# consistent with no help. What needs help is the MANIFEST: counted in a separate transaction it would
# disagree with the dump whenever a write landed in between, and the rehearsal would then fail for a
# reason that is not a backup defect. False alarms are how backup monitoring stops being read. So the
# snapshot is exported with pg_export_snapshot() and pg_dump joins it with --snapshot; the counts and
# the bytes describe the same instant by construction.
#
# SAFE TO RUN REPEATEDLY AND DURING A DEPLOY. It takes a lock (an atomic mkdir, so no flock(1) and no
# Linux-only dependency), so a second copy refuses instead of dumping in parallel; it never overwrites
# an existing dump; and it holds no locks a migration would block on — pg_dump takes ACCESS SHARE,
# which conflicts only with ACCESS EXCLUSIVE. Worth naming: a migration doing ALTER TABLE mid-dump
# will BLOCK behind the dump's ACCESS SHARE lock. That is the correct order of harm (a deploy waits;
# a backup is not silently half-written), but it is a reason to schedule this away from deploy windows.
#
# WHAT THE OWNER MUST DECIDE — this script deliberately refuses until both are answered:
#   • WHERE the backups live. BACKUP_DEST has no default and localhost is refused unless explicitly
#     allowed, because "beside the database" is today's arrangement and is the thing being fixed.
#   • WHEN it runs, and who hears about a failure (readiness 1.6). Nothing here schedules anything.
#
# USAGE
#   BACKUP_DATABASE_URL=… BACKUP_DEST=backups@host:/srv/ai-hr-backups  scripts/backup-db.sh
#
#   BACKUP_DATABASE_URL   read connection (falls back to MIGRATION_DATABASE_URL). REQUIRED.
#   BACKUP_APP_DATABASE_URL  the APPLICATION role's connection (falls back to DATABASE_URL). Optional,
#                         but without it the manifest cannot record what the app can see through RLS
#                         and the rehearsal's strongest check is skipped.
#   BACKUP_DEST           REQUIRED. `user@host:/path` (rsync over ssh), or a local path (refused
#                         unless BACKUP_ALLOW_LOCAL_DEST=1), or anything at all when BACKUP_SHIP_CMD
#                         is set.
#   BACKUP_SHIP_CMD       optional shipper: run as `sh -c "$CMD" _ <local-file> <dest>` for each file.
#                         This is the hook for object storage — S3, B2, rclone, restic. Nothing of the
#                         sort is assumed or configured here.
#   BACKUP_PRUNE_CMD      optional pruner for a custom shipper: `sh -c "$CMD" _ <dest> <cutoff-stamp>
#                         <keep-min> <name-prefix>`. Without it, retention is SKIPPED and said so.
#   BACKUP_RETAIN_DAYS    default 14.   BACKUP_RETAIN_MIN  default 7 (a floor, see "RETENTION").
#   BACKUP_STAGING        local working directory (default ${TMPDIR:-/tmp}/ai-hr-backup)
#   BACKUP_STATUS_FILE    machine-readable outcome (default $BACKUP_STAGING/backup-status.txt)
#   BACKUP_SSH_OPTS       default "-o BatchMode=yes"; put a non-default port here (e.g. "-p 8288").
#   BACKUP_KEEP_LOCAL=1   keep the staged copy after a successful ship (default: delete it, so the
#                         box does not slowly refill with the dumps this item is about).
#   PG_BIN                force a specific postgres client bin directory.
#
# EXIT CODES — distinct on purpose, so readiness 1.6 can alert on WHAT failed, not just THAT it did.
#   0 ok · 2 configuration · 3 destination · 4 lock or refusing to overwrite · 5 client version
#   6 dump · 7 verification · 8 ship · 9 retention
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/backup-lib.sh
. "$ROOT/scripts/backup-lib.sh"

RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
RETAIN_MIN="${BACKUP_RETAIN_MIN:-7}"
STAGING="${BACKUP_STAGING:-${TMPDIR:-/tmp}/ai-hr-backup}"
STATUS_FILE="${BACKUP_STATUS_FILE:-$STAGING/backup-status.txt}"
SSH_OPTS="${BACKUP_SSH_OPTS:--o BatchMode=yes}"
LOCK_DIR="$STAGING/.lock"

STAGE=init
RESULT=FAIL
MESSAGE='the script exited before it reached a verdict'
LOCK_HELD=0
FINISHED=0

say()  { printf '\n== %s\n' "$1"; }
ok()   { printf '   ok: %s\n' "$1"; }
warn() { printf '   WARNING: %s\n' "$1" >&2; }

# THE VERDICT IS ALWAYS WRITTEN. The rehearsal that failed on this box on 2026-09-11 left a log ending
# in a pg_restore error and no verdict line at all, so "it failed" and "it never ran" looked the same.
# An EXIT trap means every path — including `set -u` blowing up on an unset variable, and a kill —
# lands on a status file and a BACKUP_RESULT line.
# The exit code is taken as an ARGUMENT where one is passed, not from $? — because the second EXIT
# trap below runs a cleanup first, and that cleanup's own success would overwrite the failing status
# on the way in. The symptom was a `die 8 ship` that reported exit=1: right message, wrong code, and
# readiness 1.6 alerting on the stage-specific code would have been told the wrong thing.
finish() {
  local rc="${1:-$?}"
  [ "$FINISHED" = "1" ] && return
  FINISHED=1
  [ "$LOCK_HELD" = "1" ] && rmdir "$LOCK_DIR" 2>/dev/null
  if [ "$RESULT" != "PASS" ] && [ "$rc" = "0" ]; then rc=1; fi
  # One line per run in the status file and on stdout: the refusal messages are paragraphs for the
  # operator, but a monitor that counts failures cannot have one run become eight lines.
  local MSG_FLAT
  MSG_FLAT="$(printf '%s' "$MESSAGE" | tr '\n\t' '  ' | tr -s ' ')"
  mkdir -p "$(dirname "$STATUS_FILE")" 2>/dev/null
  {
    printf 'result\t%s\n' "$RESULT"
    printf 'stage\t%s\n' "$STAGE"
    printf 'exit_code\t%s\n' "$rc"
    printf 'at\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'host\t%s\n' "$(hostname 2>/dev/null || echo unknown)"
    printf 'database\t%s\n' "${DB_NAME:-unknown}"
    printf 'dump\t%s\n' "${DUMP_NAME:-none}"
    printf 'message\t%s\n' "$MSG_FLAT"
  } > "$STATUS_FILE" 2>/dev/null
  printf 'BACKUP_RESULT=%s stage=%s exit=%s dump=%s message=%s\n' \
    "$RESULT" "$STAGE" "$rc" "${DUMP_NAME:-none}" "$MSG_FLAT"
  exit "$rc"
}
trap finish EXIT

die() { STAGE="$2"; MESSAGE="$3"; printf '\n✗ %s\n' "$3" >&2; exit "$1"; }

# ── 1. configuration ─────────────────────────────────────────────────────────────────────────────
STAGE=config
DB_URL="${BACKUP_DATABASE_URL:-${MIGRATION_DATABASE_URL:-}}"
[ -n "$DB_URL" ] || die 2 config \
  'BACKUP_DATABASE_URL is not set (and neither is MIGRATION_DATABASE_URL). Nothing to back up.'
APP_URL="${BACKUP_APP_DATABASE_URL:-${DATABASE_URL:-}}"
DB_NAME="$(blib_url_db "$DB_URL")"
DUMP_NAME=''

case "$RETAIN_DAYS" in ''|*[!0-9]*) die 2 config "BACKUP_RETAIN_DAYS must be a whole number of days, got '$RETAIN_DAYS'." ;; esac
case "$RETAIN_MIN"  in ''|*[!0-9]*) die 2 config "BACKUP_RETAIN_MIN must be a whole number, got '$RETAIN_MIN'." ;; esac
[ "$RETAIN_MIN" -ge 1 ] || die 2 config 'BACKUP_RETAIN_MIN must be at least 1: a retention policy that can delete every backup is not a retention policy.'

# ── 2. the destination, which is the whole point ─────────────────────────────────────────────────
# SILENT SUCCESS IS THE FAILURE MODE THAT MAKES BACKUPS FICTION. Every branch below either produces a
# destination this script can read back from, or exits non-zero. There is no path on which an unset,
# unreachable or unwritable destination ends in exit 0.
STAGE=destination
DEST="${BACKUP_DEST:-}"
[ -n "$DEST" ] || die 3 destination \
'BACKUP_DEST is not set, so there is nowhere off-box to put the backup, so this script will not take one.

  A dump written beside the database it came from does not survive the failure a backup exists for,
  and that is precisely the arrangement on the production box today. Set BACKUP_DEST to one of:

    user@host:/srv/ai-hr-backups   an ssh/rsync destination on ANOTHER machine (no extra software)
    /mnt/elsewhere/ai-hr-backups   a local path — allowed only with BACKUP_ALLOW_LOCAL_DEST=1, and
                                   only sane when it is a mount of something that is not this disk
    anything                       with BACKUP_SHIP_CMD set to your own uploader (S3, B2, rclone…)

  Choosing the destination, and paying for it, is the owner'"'"'s decision. This script does not have one.'

DEST_KIND=custom
DEST_HOST=''
DEST_PATH=''
if [ -n "${BACKUP_SHIP_CMD:-}" ]; then
  DEST_KIND=custom
elif printf '%s' "$DEST" | grep -q '://'; then
  die 3 destination "BACKUP_DEST='$DEST' names a transport this script has no uploader for.
  Set BACKUP_SHIP_CMD to the command that uploads a file there. Nothing here knows, or will guess,
  how to authenticate to an object store."
elif printf '%s' "$DEST" | grep -qE '^[^/:]+:'; then
  DEST_KIND=remote
  DEST_HOST="${DEST%%:*}"
  DEST_PATH="${DEST#*:}"
else
  DEST_KIND=local
  DEST_PATH="$DEST"
  [ "${BACKUP_ALLOW_LOCAL_DEST:-0}" = "1" ] || die 3 destination \
"BACKUP_DEST='$DEST' is a local path on this machine, and this script refuses that by default.

  It is the current arrangement on the production box — every dump on the same disk as the database —
  and it is the reason those dumps are worth nothing. If this path really is somewhere else (a
  network mount, an attached volume on a different device) say so explicitly:

    BACKUP_ALLOW_LOCAL_DEST=1"
fi

# One place that runs a command AT the destination, so retention is the same code whether the backups
# are on this filesystem or across ssh. There is no second implementation to drift.
# `bash -s` on both sides rather than `ssh host "<cmd>"` / `sh -c`: the remote login shell may be dash,
# ash or fish, and the retention script below is the same text in both cases. Naming the interpreter
# is what makes "the same code runs at either kind of destination" true rather than aspirational.
dest_run() {
  case "$DEST_KIND" in
    remote) printf '%s\n' "$1" | ssh $SSH_OPTS "$DEST_HOST" bash -s ;;
    local)  printf '%s\n' "$1" | bash -s ;;
    *)      return 97 ;;
  esac
}

# ── 3. the lock ──────────────────────────────────────────────────────────────────────────────────
# mkdir, not flock: flock(1) is Linux-only and this has to behave the same on a laptop. mkdir is
# atomic on every filesystem that matters, which is the only property a lock needs.
STAGE=lock
mkdir -p "$STAGING" || die 2 lock "cannot create the staging directory $STAGING"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  HOLDER="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo unknown)"
  die 4 lock "another backup is running (lock $LOCK_DIR, pid $HOLDER). Refusing to run two dumps at once.
  If that process is gone, remove the lock directory and re-run."
fi
LOCK_HELD=1
echo "$$" > "$LOCK_DIR/pid"

# ── 4. the postgres client, chosen rather than inherited ─────────────────────────────────────────
STAGE=client
SERVER_VNUM="$(blib_server_version_num "$DB_URL")"
case "${SERVER_VNUM:-}" in ''|*[!0-9]*)
  die 2 client "cannot reach the database to read its version. Connection: ${DB_URL%%:*}://…/$DB_NAME" ;;
esac
SERVER_MAJOR=$(( SERVER_VNUM / 10000 ))
if [ -n "${PG_BIN:-}" ]; then
  PGBIN="$PG_BIN"
  [ -x "$PGBIN/pg_dump" ] || die 5 client "PG_BIN='$PG_BIN' has no executable pg_dump in it."
  CLIENT_MAJOR="$(blib_bin_major "$PGBIN/pg_dump")" || die 5 client "PG_BIN='$PG_BIN': pg_dump would not report a version."
  [ "$CLIENT_MAJOR" -ge "$SERVER_MAJOR" ] || die 5 client \
    "PG_BIN='$PG_BIN' holds pg_dump $CLIENT_MAJOR, but the server is PostgreSQL $SERVER_MAJOR.
  pg_dump refuses a server newer than itself, and an older client cannot be talked round."
else
  PGBIN="$(blib_pg_bin_for_major "$SERVER_MAJOR")" || die 5 client \
    "no pg_dump on this machine is new enough for a PostgreSQL $SERVER_MAJOR server.
  Clients found:
$(blib_describe_clients)
  Install a client of at least $SERVER_MAJOR, or point PG_BIN at one. Do NOT dump with an older
  client 'to see if it works': it will not, and on the days it appears to, the archive it wrote is
  one no pg_restore of that vintage can read."
  CLIENT_MAJOR="$(blib_bin_major "$PGBIN/pg_dump")"
fi
CLIENT_VERSION="$("$PGBIN/pg_dump" --version 2>/dev/null | sed -E 's/^pg_dump \(PostgreSQL\) //')"
say "ai-hr backup"
echo "   database:    $DB_NAME (server $SERVER_MAJOR, version_num $SERVER_VNUM)"
echo "   pg_dump:     $PGBIN/pg_dump ($CLIENT_VERSION)"
echo "   destination: $DEST  [$DEST_KIND]"
echo "   retention:   older than ${RETAIN_DAYS}d, never fewer than ${RETAIN_MIN}"

# ── 5. names, and refusing to overwrite ──────────────────────────────────────────────────────────
STAGE=name
PREFIX="ai_hr-$DB_NAME"
STAMP="$(blib_stamp)"
DUMP_NAME="$PREFIX-$STAMP.dump"
MANIFEST_NAME="$PREFIX-$STAMP.manifest"
DUMP="$STAGING/$DUMP_NAME"
MANIFEST="$STAGING/$MANIFEST_NAME"
# Refuse, never clobber. Two runs inside the same second, or a re-run after a half-finished one, must
# not quietly replace a file another process is reading or shipping.
[ -e "$DUMP" ] && die 4 name "$DUMP already exists. Refusing to overwrite a backup; move it aside or wait a second."
[ -e "$MANIFEST" ] && die 4 name "$MANIFEST already exists. Refusing to overwrite it."

# ── 6. dump and measure, in ONE snapshot ─────────────────────────────────────────────────────────
STAGE=dump
say "1/5  dumping and measuring in one snapshot"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ai-hr-backup-work.XXXXXX")" || die 6 dump 'cannot create a work directory'
cleanup_work() { rm -rf "$WORK"; }
trap 'rc=$?; cleanup_work; finish "$rc"' EXIT

DUMP_RC="$WORK/dump.rc"; PROBE_RC="$WORK/probe.rc"
TABLES_OUT="$WORK/tables.tsv"; ROLES_OUT="$WORK/roles.tsv"; HEAD_OUT="$WORK/head.tsv"
PROBE_OUT="$WORK/probe.tsv"; PROBE_ERR="$WORK/probe.err"
: > "$DUMP_RC"; : > "$PROBE_RC"; : > "$PROBE_OUT"

blib_write_probe_sql "$WORK/probe.sql"

export AIHR_PGBIN="$PGBIN" AIHR_DUMP="$DUMP" AIHR_DUMP_RC="$DUMP_RC" AIHR_DB_URL="$DB_URL"
export AIHR_APP_URL="${APP_URL:-}" AIHR_PROBE_SQL="$WORK/probe.sql" AIHR_PROBE_OUT="$PROBE_OUT"
export AIHR_PROBE_ERR="$PROBE_ERR" AIHR_PROBE_RC="$PROBE_RC"

# The owner session opens a repeatable-read transaction, exports its snapshot, shells out to pg_dump
# AND to the application-role probe with that snapshot, and only then counts. Everything below the
# BEGIN describes one instant.
"$PGBIN/psql" -X -q -At -v ON_ERROR_STOP=1 -d "$DB_URL" > "$WORK/psql.log" 2>&1 <<PSQLEOF
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_export_snapshot() AS snap \gset
SELECT coalesce((SELECT id::text FROM public.tenant ORDER BY id LIMIT 1), '') AS probe_tenant \gset
\setenv AIHR_SNAP :snap
\setenv AIHR_TENANT :probe_tenant
\! "\$AIHR_PGBIN/pg_dump" --format=custom --compress=9 --no-password --snapshot="\$AIHR_SNAP" --file="\$AIHR_DUMP" "\$AIHR_DB_URL"; echo \$? > "\$AIHR_DUMP_RC"
\! if [ -n "\$AIHR_APP_URL" ]; then "\$AIHR_PGBIN/psql" -X -q -At -v ON_ERROR_STOP=1 -v snap="\$AIHR_SNAP" -v tenant="\$AIHR_TENANT" -d "\$AIHR_APP_URL" -f "\$AIHR_PROBE_SQL" > "\$AIHR_PROBE_OUT" 2> "\$AIHR_PROBE_ERR"; echo \$? > "\$AIHR_PROBE_RC"; else echo skipped > "\$AIHR_PROBE_RC"; fi
\o $TABLES_OUT
$(blib_tables_sql)
\o $ROLES_OUT
$(blib_roles_sql)
\o $HEAD_OUT
$(blib_head_sql)
\o
COMMIT;
PSQLEOF
PSQL_RC=$?
[ "$PSQL_RC" = "0" ] || die 6 dump "the snapshot session failed (psql exit $PSQL_RC):
$(tail -20 "$WORK/psql.log")"
[ "$(cat "$DUMP_RC")" = "0" ] || die 6 dump "pg_dump exited $(cat "$DUMP_RC"). See:
$(tail -20 "$WORK/psql.log")"
[ -s "$DUMP" ] || die 6 dump "pg_dump exited 0 but produced no bytes at $DUMP. Treating that as a failure."
ok "dump written ($(blib_bytes "$DUMP") bytes)"

PROBE_STATUS=ok
PROBE_RC_V="$(cat "$PROBE_RC" 2>/dev/null || echo missing)"
if [ "$PROBE_RC_V" = "skipped" ]; then
  PROBE_STATUS=skipped
  warn "no BACKUP_APP_DATABASE_URL / DATABASE_URL: the manifest cannot record what the application role can
   see through RLS, and the rehearsal will report PASS-WEAK-PROBE rather than PASS."
elif [ "$PROBE_RC_V" != "0" ]; then
  PROBE_STATUS=failed
  warn "the application-role probe failed (exit $PROBE_RC_V): $(tail -3 "$PROBE_ERR" 2>/dev/null)"
else
  ok "application-role probe recorded ($(grep -c '^probe' "$PROBE_OUT" 2>/dev/null || echo 0) tables)"
fi

# ── 7. verify what was written, before anything is called a backup ───────────────────────────────
STAGE=verify
say "2/5  verifying the archive"
TOC=$("$PGBIN/pg_restore" --list "$DUMP" 2>"$WORK/toc.err" | grep -c '^[0-9]')
[ "${TOC:-0}" -gt 0 ] || die 7 verify "pg_restore cannot read the archive it was just handed:
$(tail -5 "$WORK/toc.err")"
ok "archive parses; $TOC TOC entries"
DUMP_BYTES="$(blib_bytes "$DUMP")"
DUMP_SHA="$(blib_sha256 "$DUMP")"
# Worth being explicit, because it is the reason the manifest carries a checksum at all: `pg_restore
# --list` reads only the header, so it succeeds unchanged on a dump truncated to half its length and
# on a dump with its middle overwritten. Both were tried. The TOC count is a parse check and nothing
# more; the checksum below and the rehearsal's actual restore are what catch a damaged file.
ok "sha256 $DUMP_SHA"

TABLE_COUNT=$(grep -c '^table' "$TABLES_OUT" 2>/dev/null || echo 0)
[ "$TABLE_COUNT" -gt 0 ] || die 7 verify "the manifest measured 0 tables. Either the database is empty or the
  measurement query failed; either way this is not a backup of anything."

{
  printf '# ai-hr backup manifest\n'
  printf 'manifest_version\t1\n'
  printf 'database\t%s\n' "$DB_NAME"
  printf 'taken_at\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'stamp\t%s\n' "$STAMP"
  printf 'server_version_num\t%s\n' "$SERVER_VNUM"
  printf 'server_major\t%s\n' "$SERVER_MAJOR"
  printf 'dump_client_major\t%s\n' "$CLIENT_MAJOR"
  printf 'dump_client_version\t%s\n' "$CLIENT_VERSION"
  printf 'dump_file\t%s\n' "$DUMP_NAME"
  printf 'dump_bytes\t%s\n' "$DUMP_BYTES"
  printf 'dump_sha256\t%s\n' "$DUMP_SHA"
  printf 'toc_entries\t%s\n' "$TOC"
  printf 'app_role\t%s\n' "$([ -n "${APP_URL:-}" ] && blib_url_user "$APP_URL" || echo '')"
  printf 'probe_status\t%s\n' "$PROBE_STATUS"
  cat "$HEAD_OUT"
  sort "$ROLES_OUT"
  sort "$TABLES_OUT"
  [ "$PROBE_STATUS" = "ok" ] && sort "$PROBE_OUT"
} > "$MANIFEST"
ok "manifest written ($TABLE_COUNT tables, $(grep -c '^role' "$MANIFEST" || echo 0) ACL roles)"

# ── 8. ship it, and read it back ─────────────────────────────────────────────────────────────────
STAGE=ship
say "3/5  shipping to $DEST"
ship_one() {
  local local_file="$1" name="$2"
  case "$DEST_KIND" in
    remote)
      rsync -a --no-o --no-g -e "ssh $SSH_OPTS" "$local_file" "$DEST_HOST:$DEST_PATH/$name" ;;
    local)
      mkdir -p "$DEST_PATH" && cp "$local_file" "$DEST_PATH/$name.part" && mv "$DEST_PATH/$name.part" "$DEST_PATH/$name" ;;
    custom)
      sh -c "$BACKUP_SHIP_CMD" _ "$local_file" "$DEST" ;;
  esac
}
if [ "$DEST_KIND" != "custom" ]; then
  dest_run "mkdir -p '$DEST_PATH'" || die 8 ship "cannot create $DEST_PATH at the destination. The destination is unreachable or not writable — this is a FAILURE, not a backup taken locally."
fi
ship_one "$DUMP" "$DUMP_NAME" || die 8 ship "shipping $DUMP_NAME to $DEST failed. Nothing was pruned; the staged copy is kept at $DUMP."
ship_one "$MANIFEST" "$MANIFEST_NAME" || die 8 ship "shipping $MANIFEST_NAME to $DEST failed (the dump itself arrived). A dump with no manifest cannot be verified by the rehearsal, so this is a failure too."

# ARRIVAL IS PROVEN, NOT ASSUMED. rsync and cp both exit 0 on a destination that silently discarded
# the bytes (a full disk that reports success, a path that is a symlink into /dev/null, an ssh command
# that ran somewhere other than where you think). Read the size back.
STAGE=verify-arrival
if [ "$DEST_KIND" = "custom" ]; then
  if [ -n "${BACKUP_VERIFY_CMD:-}" ]; then
    sh -c "$BACKUP_VERIFY_CMD" _ "$DEST" "$DUMP_NAME" "$DUMP_BYTES" "$DUMP_SHA" \
      || die 8 verify-arrival "BACKUP_VERIFY_CMD says $DUMP_NAME did not arrive intact at $DEST."
    ok "arrival verified by BACKUP_VERIFY_CMD"
  else
    warn "BACKUP_SHIP_CMD is set but BACKUP_VERIFY_CMD is not: arrival is taken on the shipper's word.
   Set BACKUP_VERIFY_CMD to close this, or the first thing you will learn about a broken uploader is
   from the rehearsal."
  fi
else
  REMOTE_BYTES="$(dest_run "wc -c < '$DEST_PATH/$DUMP_NAME'" 2>/dev/null | tr -d ' ')"
  [ "$REMOTE_BYTES" = "$DUMP_BYTES" ] || die 8 verify-arrival \
    "$DUMP_NAME is $DUMP_BYTES bytes here and ${REMOTE_BYTES:-absent} bytes at the destination."
  ok "arrival verified: $REMOTE_BYTES bytes at the destination"
fi

# ── 9. retention ─────────────────────────────────────────────────────────────────────────────────
#
# RETENTION RUNS ONLY AFTER A VERIFIED ARRIVAL, and only over files this script's own naming produces
# (ai_hr-<db>-<UTC stamp>.dump and .manifest). Anything else in that directory is somebody else's.
#
# AGE COMES OUT OF THE FILENAME, not out of the filesystem. mtime is set by whatever copied the file
# last, so an rsync, a restore-from-tape or a `cp -r` can make every backup look new — and a
# find -mtime policy then keeps nothing or deletes everything. The UTC stamp in the name is written
# once, by the run that took the dump, and sorts lexicographically in time order.
#
# THE FLOOR IS THE POINT. `find -mtime +14 -delete` on a box that was off for a month deletes every
# backup it has. BACKUP_RETAIN_MIN newest files are kept whatever their age, so the policy can never
# empty the destination; only files that are BOTH older than the window AND outside the floor go.
STAGE=retention
say "4/5  retention"
CUTOFF="$(blib_cutoff_stamp "$RETAIN_DAYS")" || die 9 retention \
  "neither GNU nor BSD date could compute a cutoff. Refusing to guess: an empty cutoff deletes everything."
echo "   keeping: the newest $RETAIN_MIN always, plus everything stamped after $CUTOFF"
if [ "$DEST_KIND" = "custom" ]; then
  if [ -n "${BACKUP_PRUNE_CMD:-}" ]; then
    sh -c "$BACKUP_PRUNE_CMD" _ "$DEST" "$CUTOFF" "$RETAIN_MIN" "$PREFIX" \
      || die 9 retention 'BACKUP_PRUNE_CMD failed.'
    ok 'pruned by BACKUP_PRUNE_CMD'
  else
    warn "no BACKUP_PRUNE_CMD for this custom destination: NOTHING WAS PRUNED and the destination will
   grow without limit. That is a bill and then an outage."
  fi
else
  PRUNED="$(dest_run "$(blib_prune_script "$DEST_PATH" "$PREFIX" "$CUTOFF" "$RETAIN_MIN")")" \
    || die 9 retention "pruning at $DEST failed."
  if [ -n "$PRUNED" ]; then printf '%s\n' "$PRUNED" | sed 's/^/   deleted: /'; else echo "   deleted: nothing"; fi
fi

# ── 10. done ─────────────────────────────────────────────────────────────────────────────────────
STAGE=done
say "5/5  done"
if [ "${BACKUP_KEEP_LOCAL:-0}" = "1" ]; then
  ok "staged copy kept at $DUMP"
else
  rm -f "$DUMP" "$MANIFEST"
  ok "staged copies removed (BACKUP_KEEP_LOCAL=1 to keep them)"
fi
RESULT=PASS
MESSAGE="$DUMP_NAME ($DUMP_BYTES bytes, $TABLE_COUNT tables) verified at $DEST"
echo "   Rehearse it. A backup nobody has restored is a hypothesis:"
echo "     scripts/restore-rehearsal.sh --dump <copy of $DUMP_NAME>"
exit 0
