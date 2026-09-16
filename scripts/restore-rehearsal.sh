#!/usr/bin/env bash
# AI HR — restore a backup into a scratch database and prove the result is USABLE, not merely present.
#
# THIS IS THE HALF THAT HAS NEVER WORKED HERE. The only restore rehearsal anyone has run on the
# production box is /home/ubuntu/rehearsal-restore.log, dated 2026-09-11, and it ends:
#
#     pg_restore: error: connection to server at "localhost" (127.0.0.1), port 5432 failed:
#     FATAL:  database "ai_hr_rehearsal" does not exist
#
# Nobody had created the target. The log contains no verdict line, so "the rehearsal failed" and "the
# rehearsal was never run" look identical in it. Both of those are addressed below and neither by
# accident: this script CREATES the target itself and proves it can connect to it before pg_restore is
# invoked (step 3), and every exit — including a crash — writes RESTORE_REHEARSAL_RESULT= and a status
# file (the EXIT trap).
#
# WHAT "USABLE" MEANS HERE, AND WHY THAT DEFINITION
# ------------------------------------------------
# "The restore finished" is not a fact worth having. pg_restore exits 0 on a database that is missing
# every grant, on a database whose policies did not come back, and on a database that is three tables
# short of the one that was dumped. So a restore passes here only if ALL of the following hold, and
# each one is here because its absence is a way this product would be broken after a recovery:
#
#   1. THE ARCHIVE IS THE ONE THE MANIFEST DESCRIBES — sha256, byte length. Note that `pg_restore
#      --list` is NOT this check: it reads only the header, and it succeeds unchanged on a dump
#      truncated to half its length and on a dump with its middle overwritten. Both were tried.
#   2. THE TARGET EXISTS AND IS REACHABLE before the restore starts. (The 2026-09-11 failure.)
#   3. pg_restore RUNS TO COMPLETION under --exit-on-error. No "mostly restored".
#   4. THE SCHEMA CAME BACK WHOLE — same tables, same drizzle migration watermark, same RLS flags,
#      same policy counts. Compared by DIFF against the manifest, so a table that appeared, a table
#      that vanished and a policy that was dropped are all caught without anyone having to predict them.
#   5. EVERY ROW CAME BACK — exact per-table counts, not "greater than zero" and not an estimate.
#   6. THE APPLICATION ROLE CAN READ IT. This is the check that separates usable from present, and it
#      is the one a superuser's inspection can never make: the app connects as ai_hr_app, which is
#      NOBYPASSRLS and holds only the privileges the migrations granted it. A restore that loses the
#      GRANTs — the exact hazard CLAUDE.md §6 names, "a dev restore has no default privileges", and
#      the defect migrations 0345 and 0354 shipped — gives a database a superuser reads perfectly and
#      the product cannot read at all. So the rehearsal reproduces, as that role and with a tenant
#      context, the per-table counts recorded at backup time.
#   7. TENANT ISOLATION CAME BACK WITH THE DATA. Same role, no tenant context, every tenant-scoped
#      table must return zero rows. A restore that brings back the rows without the policies is not a
#      recovered system; it is a cross-tenant leak with the customer's data already in it. Readiness
#      1.7 had just closed the last table in this schema with RLS off — a restore is exactly where
#      that would silently come undone.
#   8. IT IS TIMED, AND WRITTEN DOWN. A recovery-time objective is a number or it is nothing.
#
# WHY NOT A LOOSER DEFINITION. "Row counts are at least what they were" was rejected: a backup is a
# point-in-time copy, so equality is available and anything weaker hides a partial restore. "Spot
# check a few tables" was rejected: the tables nobody thinks to name are the ones a new migration adds.
#
# WHAT IT DOES NOT PROVE. It does not prove the application BOOTS against the restored database, and
# it does not prove business logic is correct on it — that is the test suite's job, against a schema,
# not a backup. It does not test point-in-time recovery, which does not exist on this deployment
# (archive_mode=off, wal_level=replica as of 2026-09-16): the recovery point is the last dump and
# nothing finer. And it does not sanitise: a restore of production data is real people's salaries and
# identity numbers, so the scratch cluster must be treated as production (see PDPA note below).
#
# USAGE
#   REHEARSAL_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres \
#   REHEARSAL_APP_DATABASE_URL=postgres://ai_hr_app@127.0.0.1:5433/postgres \
#     scripts/restore-rehearsal.sh --dump /path/to/ai_hr-…-20260916T010000Z.dump
#
#   --dump FILE       the archive to restore. REQUIRED.
#   --manifest FILE   default: the .manifest beside the dump. Without one there is nothing to verify
#                     the restore AGAINST, which is why it is required rather than optional.
#   --scratch NAME    scratch database (default ai_hr_restore_rehearsal). Must contain "rehearsal"
#                     unless REHEARSAL_ALLOW_ANY_NAME=1 — this script DROPs it.
#   --keep            keep the scratch database after a pass (it is always kept after a failure)
#   --skip-checksum   verify a dump whose manifest checksum cannot match (e.g. one re-compressed in
#                     transit). Downgrades the verdict to PASS-UNCHECKSUMMED; never silent.
#
#   REHEARSAL_LOG     where the outcome line is appended (default $TMPDIR/ai-hr-backup/rehearsal.log)
#   PG_BIN            force a specific postgres client bin directory
#
# PDPA. Restoring a production dump puts real employee data on whatever machine runs this. Run it on
# the server or on a machine you would be willing to call production — not on a laptop because it was
# convenient. scripts/upgrade-rehearsal.sh makes the same point and refuses to copy production data
# for the same reason.
#
# EXIT CODES: 0 ok · 2 configuration · 3 dump/manifest integrity · 4 client version · 5 roles missing
#             6 could not create or reach the scratch database · 7 pg_restore failed · 8 verification
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/backup-lib.sh
. "$ROOT/scripts/backup-lib.sh"

DUMP=''; MANIFEST=''; SCRATCH="${REHEARSAL_SCRATCH_DB:-ai_hr_restore_rehearsal}"
KEEP=0; SKIP_CHECKSUM=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dump) DUMP="${2:-}"; shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --scratch) SCRATCH="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --skip-checksum) SKIP_CHECKSUM=1; shift ;;
    *) echo "✗ Unknown argument: $1 (expected --dump, --manifest, --scratch, --keep, --skip-checksum)" >&2; exit 2 ;;
  esac
done

LOG="${REHEARSAL_LOG:-${TMPDIR:-/tmp}/ai-hr-backup/rehearsal.log}"
STATUS_FILE="${REHEARSAL_STATUS_FILE:-$(dirname "$LOG")/rehearsal-status.txt}"
RESULT=FAIL
STAGE=init
MESSAGE='the rehearsal exited before it reached a verdict'
FAILURES=0
RESTORE_SECONDS=''
VERIFY_SECONDS=''
TOTAL_SECONDS=''
SCRATCH_KEPT=no
WORK=''
T0="$(blib_now)"

say()  { printf '\n== %s\n' "$1"; }
ok()   { printf '   ok: %s\n' "$1"; }
bad()  { printf '   FAIL: %s\n' "$1"; FAILURES=$((FAILURES+1)); }
warn() { printf '   WARNING: %s\n' "$1" >&2; }

finish() {
  local rc="${1:-$?}"
  [ -n "${FINISHED:-}" ] && return
  FINISHED=1
  [ -n "$WORK" ] && rm -rf "$WORK"
  TOTAL_SECONDS="$(blib_elapsed "$T0" "$(blib_now)")"
  # The refusal messages are paragraphs on purpose — an operator reading a failure deserves sentences.
  # The LOG is one line per run, though, and a message with newlines in it would turn one run into
  # eight log entries, which is how a monitor loses the ability to count failures. Flattened here and
  # only here: stderr above keeps the paragraphs.
  local MSG_FLAT
  MSG_FLAT="$(printf '%s' "$MESSAGE" | tr '\n\t' '  ' | tr -s ' ')"
  case "$RESULT" in PASS*) : ;; *) [ "$rc" = "0" ] && rc=1 ;; esac
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) result=$RESULT stage=$STAGE exit=$rc dump=$(basename "${DUMP:-none}")"
  line="$line scratch=$SCRATCH restore_seconds=${RESTORE_SECONDS:-} verify_seconds=${VERIFY_SECONDS:-}"
  line="$line total_seconds=${TOTAL_SECONDS:-} scratch_kept=$SCRATCH_KEPT message=$MSG_FLAT"
  printf '%s\n' "$line" >> "$LOG" 2>/dev/null
  {
    printf 'result\t%s\n' "$RESULT"
    printf 'stage\t%s\n' "$STAGE"
    printf 'exit_code\t%s\n' "$rc"
    printf 'at\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'dump\t%s\n' "$(basename "${DUMP:-none}")"
    printf 'scratch\t%s\n' "$SCRATCH"
    printf 'restore_seconds\t%s\n' "${RESTORE_SECONDS:-}"
    printf 'verify_seconds\t%s\n' "${VERIFY_SECONDS:-}"
    printf 'total_seconds\t%s\n' "${TOTAL_SECONDS:-}"
    printf 'failed_checks\t%s\n' "$FAILURES"
    printf 'message\t%s\n' "$MSG_FLAT"
  } > "$STATUS_FILE" 2>/dev/null
  printf 'RESTORE_REHEARSAL_RESULT=%s stage=%s exit=%s restore_seconds=%s total_seconds=%s failed_checks=%s message=%s\n' \
    "$RESULT" "$STAGE" "$rc" "${RESTORE_SECONDS:-na}" "${TOTAL_SECONDS:-na}" "$FAILURES" "$MSG_FLAT"
  exit "$rc"
}
trap 'rc=$?; finish "$rc"' EXIT
die() { STAGE="$2"; MESSAGE="$3"; printf '\n✗ %s\n' "$3" >&2; exit "$1"; }

# ── 1. what we were handed ───────────────────────────────────────────────────────────────────────
STAGE=preflight
[ -n "$DUMP" ] || die 2 preflight '--dump is required. There is nothing to rehearse without one.'
[ -f "$DUMP" ] || die 3 preflight "no such dump: $DUMP"
[ -s "$DUMP" ] || die 3 preflight "$DUMP is zero bytes. That is not a backup; it is the absence of one."
[ -n "$MANIFEST" ] || MANIFEST="${DUMP%.dump}.manifest"
[ -f "$MANIFEST" ] || die 3 preflight \
"no manifest at $MANIFEST.

  A dump with no manifest cannot be VERIFIED — only restored, which is the thing that has always been
  possible and has never been proof of anything. The manifest records what the database held at the
  instant the dump was taken; without it this script could tell you the restore finished and nothing
  else. Every dump currently on the production box is in this category, and that is the finding, not
  an inconvenience. Take a fresh backup with scripts/backup-db.sh, or pass --manifest explicitly."

ADMIN_URL="${REHEARSAL_DATABASE_URL:-}"
[ -n "$ADMIN_URL" ] || die 2 preflight 'REHEARSAL_DATABASE_URL is not set (a superuser/owner connection to the SCRATCH cluster, maintenance database).'
APP_URL_TPL="${REHEARSAL_APP_DATABASE_URL:-}"

m() { awk -F'\t' -v k="$1" '$1==k {print $2; exit}' "$MANIFEST"; }
M_DB="$(m database)"; M_SHA="$(m dump_sha256)"; M_BYTES="$(m dump_bytes)"
M_CLIENT_MAJOR="$(m dump_client_major)"; M_SERVER_MAJOR="$(m server_major)"
M_APP_ROLE="$(m app_role)"; M_PROBE_STATUS="$(m probe_status)"; M_TAKEN="$(m taken_at)"
[ -n "$M_SHA" ] || die 3 preflight "$MANIFEST carries no dump_sha256; it is not a manifest this script wrote."

# THE SCRATCH DATABASE IS DROPPED BY THIS SCRIPT, so its name is guarded rather than trusted. The name
# check is cheap and the mistake it prevents — a rehearsal pointed at the database it is rehearsing —
# is unrecoverable.
case "$SCRATCH" in
  *rehearsal*) : ;;
  *) [ "${REHEARSAL_ALLOW_ANY_NAME:-0}" = "1" ] || die 2 preflight \
      "--scratch '$SCRATCH' does not contain 'rehearsal'. This script DROPS the scratch database, so it
  refuses names that do not announce themselves as scratch. Set REHEARSAL_ALLOW_ANY_NAME=1 if you
  are certain." ;;
esac
[ "$SCRATCH" != "$M_DB" ] || die 2 preflight "--scratch is '$SCRATCH', which is the name of the database the dump came FROM. Refusing."
# A PLAIN IDENTIFIER, and nothing else. The scratch name is interpolated into a connection URL, where
# `#`, `?`, `/`, `@` and a space all mean something to the URL and nothing to Postgres. A name that
# survives CREATE DATABASE and then addresses a DIFFERENT database — or no database — through the URL
# is the 2026-09-11 failure wearing a disguise, and it is cheaper to refuse the name than to detect it.
case "$SCRATCH" in
  *[!A-Za-z0-9_]*|'') die 2 preflight "--scratch '$SCRATCH' is not a plain identifier (letters, digits and
  underscores). The name goes into a connection URL; anything else can quietly address a different
  database than the one that was created." ;;
esac

say "restore rehearsal"
echo "   dump:      $DUMP"
echo "   manifest:  $MANIFEST  (taken $M_TAKEN from '$M_DB')"
echo "   scratch:   $SCRATCH"

# ── 2. is this archive the one the manifest describes? ───────────────────────────────────────────
STAGE=integrity
say "1/6  archive integrity"
ACTUAL_BYTES="$(blib_bytes "$DUMP")"
if [ "$ACTUAL_BYTES" != "$M_BYTES" ]; then
  die 3 integrity "the dump is $ACTUAL_BYTES bytes; the manifest says $M_BYTES. It was truncated, padded or replaced in transit."
fi
ok "$ACTUAL_BYTES bytes, as recorded"
ACTUAL_SHA="$(blib_sha256 "$DUMP")"
if [ "$SKIP_CHECKSUM" = "1" ]; then
  warn "--skip-checksum: the archive was NOT checked against the manifest's sha256. The verdict will say so."
elif [ "$ACTUAL_SHA" = 'sha256-unavailable' ]; then
  die 3 integrity 'no sha256sum or shasum on this machine, so the archive cannot be checked. Install one or pass --skip-checksum knowingly.'
elif [ "$ACTUAL_SHA" != "$M_SHA" ]; then
  die 3 integrity "sha256 mismatch.
    manifest: $M_SHA
    file:     $ACTUAL_SHA
  The bytes are not the bytes that were dumped. Do not restore this and do not delete the manifest."
else
  ok "sha256 matches the manifest"
fi

# ── 3. the client, chosen rather than inherited ──────────────────────────────────────────────────
# An archive written by pg_dump N can only be read by pg_restore N or newer, and a server older than
# the one that was dumped cannot take the schema. Both are checked BEFORE the scratch database is
# created, so a version problem is a clean refusal rather than a half-restored database.
STAGE=client
say "2/6  postgres client"
NEED_MAJOR="$M_CLIENT_MAJOR"
if [ -n "${PG_BIN:-}" ]; then
  PGBIN="$PG_BIN"
  [ -x "$PGBIN/pg_restore" ] || die 4 client "PG_BIN='$PG_BIN' has no pg_restore."
else
  PGBIN="$(blib_pg_bin_for_major "$NEED_MAJOR")" || die 4 client \
    "this archive was written by pg_dump $NEED_MAJOR and no client here is that new.
  Clients found:
$(blib_describe_clients)
  A pg_restore older than the archive does not degrade gracefully — it cannot read the file header."
fi
RESTORE_MAJOR="$(blib_bin_major "$PGBIN/pg_restore")" || die 4 client "$PGBIN/pg_restore will not report a version."
[ "$RESTORE_MAJOR" -ge "$NEED_MAJOR" ] || die 4 client \
  "pg_restore $RESTORE_MAJOR cannot read an archive written by pg_dump $NEED_MAJOR."
TARGET_VNUM="$(blib_server_version_num "$ADMIN_URL")"
case "${TARGET_VNUM:-}" in ''|*[!0-9]*) die 6 client "cannot reach the rehearsal cluster with REHEARSAL_DATABASE_URL." ;; esac
TARGET_MAJOR=$(( TARGET_VNUM / 10000 ))
[ "$TARGET_MAJOR" -ge "$M_SERVER_MAJOR" ] || die 4 client \
  "the dump came from PostgreSQL $M_SERVER_MAJOR and this cluster is $TARGET_MAJOR. A restore into an
  older server is not supported and the failures it produces are misleading."
ok "pg_restore $RESTORE_MAJOR reading a pg_dump $NEED_MAJOR archive into a PostgreSQL $TARGET_MAJOR cluster"

PSQL="$PGBIN/psql"
admin() { "$PSQL" -X -q -At -v ON_ERROR_STOP=1 -d "$ADMIN_URL" "$@"; }
SCRATCH_URL="$(blib_url_with_db "$ADMIN_URL" "$SCRATCH")"
scratch() { "$PSQL" -X -q -At -v ON_ERROR_STOP=1 -d "$SCRATCH_URL" "$@"; }

# ── 4. the roles the ACLs name ───────────────────────────────────────────────────────────────────
# A GRANT to a role this cluster has never heard of aborts the restore part-way with an error that
# reads like archive corruption. Checking first turns it into one clear sentence.
STAGE=roles
say "3/6  roles the dump's grants refer to"
MISSING=''
while read -r _ role; do
  [ -z "$role" ] && continue
  [ "$role" = 'PUBLIC' ] && continue
  if [ "$(admin -c "SELECT count(*) FROM pg_roles WHERE rolname = '$role'")" != "1" ]; then
    MISSING="$MISSING $role"
  fi
done < <(grep '^role	' "$MANIFEST")
[ -z "$MISSING" ] || die 5 roles \
  "this cluster is missing role(s):$MISSING
  The dump's GRANT statements name them. Create them (they need no password and no privileges of
  their own for a rehearsal) and run again:
$(for r in $MISSING; do echo "    CREATE ROLE \"$r\" NOLOGIN;"; done)"
ok "every ACL role exists here"

# ── 5. the target database — created, then PROVEN to exist ───────────────────────────────────────
STAGE=target
say "4/6  scratch database"
admin -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null 2>&1
admin -c "CREATE DATABASE \"$SCRATCH\"" >/dev/null || die 6 target "CREATE DATABASE \"$SCRATCH\" failed."
# THE 2026-09-11 FAILURE, MADE IMPOSSIBLE. That rehearsal ran pg_restore against a database nobody had
# created and discovered it from pg_restore's own connection error. Here the target is created by this
# script and then CONNECTED TO before pg_restore is invoked; if that connection fails the run stops
# with a named stage and a verdict line rather than an error buried in a log.
[ "$(scratch -c 'SELECT 1')" = "1" ] || die 6 target \
  "created \"$SCRATCH\" but cannot connect to it. This is the failure the 2026-09-11 rehearsal died of,
  caught before pg_restore rather than inside it."
ok "\"$SCRATCH\" created and reachable"
# The database-level CONNECT grant is NOT in a single-database dump, so it has to be re-issued here —
# the same re-issue test/global-setup.ts makes for its worker databases. This is deliberately not part
# of what is being tested: what is tested is the TABLE privileges, which are in the dump.
if [ -n "$M_APP_ROLE" ]; then
  # An identifier, or nothing: this one is interpolated as a SQL IDENTIFIER rather than as a literal,
  # and it too comes out of a file that gets copied between machines.
  case "$M_APP_ROLE" in
    *[!A-Za-z0-9_]*) die 2 target "the manifest's app_role '$M_APP_ROLE' is not a plain identifier." ;;
  esac
  admin -c "GRANT CONNECT ON DATABASE \"$SCRATCH\" TO \"$M_APP_ROLE\"" >/dev/null 2>&1 \
    || warn "could not grant CONNECT on $SCRATCH to $M_APP_ROLE; the application-role check will fail."
fi

# ── 6. the restore ───────────────────────────────────────────────────────────────────────────────
STAGE=restore
say "5/6  restoring"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ai-hr-rehearsal.XXXXXX")"
R0="$(blib_now)"
# --exit-on-error, because the default is to keep going and exit 0 after printing errors nobody reads —
# which is how you get a "successful" restore that is missing objects. --no-owner, because the roles
# that own objects on the source need not exist here and ownership is not what is being rehearsed;
# PRIVILEGES are, so --no-privileges is deliberately NOT passed.
"$PGBIN/pg_restore" --exit-on-error --no-owner --dbname "$SCRATCH_URL" "$DUMP" > "$WORK/restore.log" 2>&1
RESTORE_RC=$?
RESTORE_SECONDS="$(blib_elapsed "$R0" "$(blib_now)")"
if [ "$RESTORE_RC" != "0" ]; then
  SCRATCH_KEPT=yes
  die 7 restore "pg_restore exited $RESTORE_RC after ${RESTORE_SECONDS}s. Scratch database \"$SCRATCH\" kept for inspection.
$(tail -15 "$WORK/restore.log")"
fi
ok "pg_restore completed in ${RESTORE_SECONDS}s with no errors"

# ── 7. verification ──────────────────────────────────────────────────────────────────────────────
STAGE=verify
say "6/6  is it usable?"
V0="$(blib_now)"

# 7a. schema + rows, measured with the SAME SQL the manifest was measured with (scripts/backup-lib.sh),
# and compared by diff so nothing has to be predicted in advance.
{ scratch -c "$(blib_head_sql)"; scratch -c "$(blib_tables_sql)"; } | sort > "$WORK/actual.tsv"
grep -E '^(migrations|table)	' "$MANIFEST" | sort > "$WORK/expected.tsv"
if diff -u "$WORK/expected.tsv" "$WORK/actual.tsv" > "$WORK/schema.diff"; then
  ok "schema and row counts identical to the manifest ($(grep -c '^table' "$WORK/expected.tsv") tables)"
else
  bad "the restored database does not match the manifest:"
  sed 's/^/        /' "$WORK/schema.diff"
fi

# 7b. the application role. Present is not usable; this is the difference.
if [ "$M_PROBE_STATUS" != "ok" ]; then
  warn "the manifest has no application-role probe (probe_status=$M_PROBE_STATUS), so the strongest
   check cannot run. Re-take the backup with BACKUP_APP_DATABASE_URL set."
  PROBE_VERDICT=weak
elif [ -z "$APP_URL_TPL" ]; then
  warn "REHEARSAL_APP_DATABASE_URL is not set, so nothing connected as '$M_APP_ROLE' and 'the product
   can read this' was not tested. That is the check this rehearsal exists for."
  PROBE_VERDICT=weak
else
  PROBE_VERDICT=ok
  blib_write_probe_sql_local "$WORK/probe.sql"
  APP_SCRATCH_URL="$(blib_url_with_db "$APP_URL_TPL" "$SCRATCH")"
  TENANT="$(scratch -c "SELECT coalesce((SELECT id::text FROM public.tenant ORDER BY id LIMIT 1), '')" 2>/dev/null)"
  if "$PGBIN/psql" -X -q -At -v ON_ERROR_STOP=1 -v snap=unused -v tenant="$TENANT" \
       -d "$APP_SCRATCH_URL" -f "$WORK/probe.sql" > "$WORK/probe.tsv" 2> "$WORK/probe.err"; then
    sort "$WORK/probe.tsv" > "$WORK/probe.sorted"
    grep -E '^probe_(ctx|noctx)	' "$MANIFEST" | sort > "$WORK/probe.expected"
    if diff -u "$WORK/probe.expected" "$WORK/probe.sorted" > "$WORK/probe.diff"; then
      ok "the application role '$M_APP_ROLE' sees exactly what it saw at backup time"
    else
      bad "what the application role can read has CHANGED. A line missing on the right is a table the
        role can no longer SELECT (a lost GRANT); a changed count is a policy or rows that did not
        come back:"
      sed 's/^/        /' "$WORK/probe.diff"
    fi
    LEAK="$(awk -F'\t' '$1=="probe_noctx"{s+=$4} END{print s+0}' "$WORK/probe.sorted")"
    CTX_TOTAL="$(awk -F'\t' '$1=="probe_ctx"{s+=$4} END{print s+0}' "$WORK/probe.sorted")"
    # ORDER MATTERS, AND THIS IS WHERE A VACUOUS GUARD WOULD LIVE. "Zero rows without a tenant context"
    # is trivially true of a database the role cannot read AT ALL — which is precisely the --no-privileges
    # failure this rehearsal is built to catch. Claiming isolation there would be a green tick on the
    # broken case. So the isolation claim is only made when the role demonstrably reads something first.
    if [ "$LEAK" = "0" ] && [ "$CTX_TOTAL" = "0" ]; then
      bad "the application role reads 0 rows WITH a tenant context and 0 without. Isolation cannot be
        claimed from that: it is what a database the role has no privileges on looks like."
    elif [ "$LEAK" = "0" ]; then
      ok "with a tenant context the application role reads $CTX_TOTAL rows; with none, 0 — isolation survived the restore"
    else
      SRC_LEAK="$(awk -F'\t' '$1=="probe_noctx"{s+=$4} END{print s+0}' "$MANIFEST")"
      if [ "$SRC_LEAK" != "0" ]; then
        bad "$LEAK rows readable with NO tenant context — and the SOURCE database leaked $SRC_LEAK the
        same way. This is a production RLS hole, not a restore defect. Fix it there first."
      else
        bad "$LEAK rows readable with NO tenant context, where the source leaked none. The restore lost
        row-level security. Do not put this database in front of the application."
      fi
    fi
  else
    bad "the application role could not run the probe at all: $(tail -3 "$WORK/probe.err")"
  fi
fi
VERIFY_SECONDS="$(blib_elapsed "$V0" "$(blib_now)")"

# ── 8. verdict ───────────────────────────────────────────────────────────────────────────────────
STAGE=verdict
if [ "$FAILURES" -eq 0 ]; then
  if [ "$SKIP_CHECKSUM" = "1" ]; then RESULT=PASS-UNCHECKSUMMED
  elif [ "${PROBE_VERDICT:-weak}" != "ok" ]; then RESULT=PASS-WEAK-PROBE
  else RESULT=PASS; fi
  MESSAGE="restored $M_DB from $(basename "$DUMP") and verified it against its manifest"
  if [ "$KEEP" = "1" ]; then
    SCRATCH_KEPT=yes
  else
    admin -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null 2>&1
  fi
else
  RESULT=FAIL
  SCRATCH_KEPT=yes
  MESSAGE="$FAILURES check(s) failed; scratch database \"$SCRATCH\" kept for inspection"
  STAGE=verify
  printf '\n✗ THE RESTORE IS NOT USABLE. %s\n' "$MESSAGE" >&2
  exit 8
fi
say "result"
echo "   $RESULT — restore ${RESTORE_SECONDS}s, verify ${VERIFY_SECONDS}s"
echo "   recovery point: $M_TAKEN (the instant the dump was taken; there is no PITR on this deployment)"
echo "   written to: $LOG"
exit 0
