#!/usr/bin/env bash
#
# Make a failing scheduled job reach a human — readiness 1.6, "non-zero exit on any of the six cron
# jobs reaches a human".
#
# ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────────────────────────────────
#
# Every line in `crontab -l` today ends `>> /home/ubuntu/aihr-cron-logs/<x>.log 2>&1`. cron's ONLY
# built-in alerting is "mail me anything the job wrote to stdout or stderr", and that redirect takes
# both away from it. So a job that dies — a bad migration, a revoked GRANT, an OOM, a typo in a path —
# fails at 03:00, writes its stack trace into a file, exits non-zero, and NOTHING happens. Verified on
# the box on 2026-09-16: all six lines redirect, and `journalctl -u aihr -p err` over seven days
# returns zero entries.
#
# This wrapper puts the redirect INSIDE the job and keeps the outside channel free, so cron's own mail
# path works again, and adds two channels that do not depend on an MTA being installed.
#
# ── INSTALL (the owner does this; this file does not install itself) ─────────────────────────────
#
#   chmod +x /opt/ai-hr/deploy/cron-alert.sh        # already +x in git; rsync preserves the bit
#   crontab -e
#
# and rewrite each job so the wrapper owns the log file and cron gets the stdout back. Before:
#
#   * * * * * cd /opt/ai-hr && /opt/node20/bin/node --env-file=.env.production --import tsx \
#       scripts/provision-runner.ts >> /home/ubuntu/aihr-cron-logs/provision.log 2>&1
#
# after — NOTE there is no `>>` and no `2>&1` any more, that is the whole point:
#
#   MAILTO=ops@example.com
#   * * * * * cd /opt/ai-hr && deploy/cron-alert.sh provision \
#       /home/ubuntu/aihr-cron-logs/provision.log \
#       /opt/node20/bin/node --env-file=.env.production --import tsx scripts/provision-runner.ts
#
# Then verify by READING IT BACK (`crontab -l`), never by trusting the install command — this repo has
# shipped a crontab line that was not there before.
#
#   usage: cron-alert.sh <job-name> <logfile> <command> [args...]
#
# ── THE THREE CHANNELS, AND WHY THREE ────────────────────────────────────────────────────────────
#
#   1. THE JOURNAL, at priority err. `logger -p user.err` writes a real priority-3 line, and priority 3
#      on this box is currently EMPTY — every application error Next writes lands at priority 6
#      (info), because systemd files plain stdout there. That makes `-p err` a channel with no
#      pre-existing noise: `journalctl -p err --since -1d` is either empty or is an incident. A Zabbix
#      agent already runs here, and a log/systemd item pointed at that is the cheapest real alert
#      available without adding a dependency to package.json.
#   2. STDOUT, so cron mails it. Costs nothing when there is no MTA and nothing when MAILTO is unset;
#      restores the mechanism the redirect removed for anyone who has either.
#   3. AIHR_ALERT_COMMAND, optional, receives the summary on STDIN. This is the seam for whatever the
#      owner actually uses — `mail`, a curl to a webhook, ntfy, an SMS gateway. Nothing is chosen here
#      on the owner's behalf and no credential is required to install the wrapper.
#
#   PRIVACY: the summary carries the TAIL OF THE JOB'S OUTPUT. In the journal that is already behind
#   ssh. If you point AIHR_ALERT_COMMAND at a third party, you are sending it there — set
#   AIHR_ALERT_TAIL=0 to send the exit code and the log path only.
#
# ── WHAT THIS DOES NOT CATCH, AND THE ANSWER TO IT ───────────────────────────────────────────────
#
# A job that STOPS RUNNING has no exit code, so no wrapper can alert on it. That is not hypothetical
# here: `scripts/review-sweep.ts` records that it was absent from the crontab for six weeks while
# every log looked fine. So each SUCCESSFUL run touches a heartbeat file, and staleness — not failure
# — is the signal for that class. See deploy/DEPLOY.md for the one-line staleness check to schedule.
set -uo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: cron-alert.sh <job-name> <logfile> <command> [args...]" >&2
  exit 64
fi

JOB=$1
LOGFILE=$2
shift 2

TAG=${AIHR_ALERT_TAG:-aihr-cron}
LOGDIR=$(dirname "$LOGFILE")
HEARTBEAT_DIR=${AIHR_HEARTBEAT_DIR:-$LOGDIR/heartbeat}
TAIL_LINES=${AIHR_ALERT_TAIL:-20}

mkdir -p "$LOGDIR" "$HEARTBEAT_DIR"

OUT=$(mktemp "${TMPDIR:-/tmp}/aihr-cron-$JOB.XXXXXX")
trap 'rm -f "$OUT"' EXIT

STARTED=$(date +%Y-%m-%dT%H:%M:%S%z)
START_EPOCH=$(date +%s)

# The redirect that used to be in the crontab now lives HERE, which is exactly what frees stdout for
# cron's mail path. `set +e` is belt and braces — errexit is not on (see `set -uo pipefail` above) —
# because a non-zero exit is the case this script is FOR, not an error in it, and a future edit that
# adds `set -e` to the header must not turn a detected failure into an undetected one.
set +e
"$@" >"$OUT" 2>&1
STATUS=$?

FINISHED=$(date +%Y-%m-%dT%H:%M:%S%z)
ELAPSED=$(( $(date +%s) - START_EPOCH ))

# One bracketed, dated block per run. The existing logs have NO timestamps at all — provision.log is
# 81,847 identical "· nothing to do" lines with nothing to date them by — so after a rotation there is
# no way to say when anything happened. Two `date` calls per run buys that back; per-line timestamping
# was rejected because it needs either a bash 4.2 builtin or a fork per line.
{
  echo "==== $STARTED  $JOB  start ===="
  cat "$OUT"
  echo "==== $FINISHED  $JOB  exit=$STATUS  ${ELAPSED}s ===="
} >>"$LOGFILE"

if [ "$STATUS" -eq 0 ]; then
  # Proof of life for the staleness check. Touched ONLY on success: a job failing every minute must
  # not look alive.
  : >"$HEARTBEAT_DIR/$JOB"
  exit 0
fi

SUMMARY="AI HR scheduled job FAILED: $JOB exit=$STATUS after ${ELAPSED}s on $(hostname -s 2>/dev/null || echo unknown) at $FINISHED. Full output: $LOGFILE"
if [ "$TAIL_LINES" -gt 0 ]; then
  SUMMARY="$SUMMARY
--- last $TAIL_LINES lines ---
$(tail -n "$TAIL_LINES" "$OUT")"
fi

# 1. The journal, at a priority nothing else on this box uses.
if command -v logger >/dev/null 2>&1; then
  printf '%s\n' "$SUMMARY" | logger -t "$TAG" -p user.err || true
fi

# 2. stdout — cron mails this if MAILTO is set and an MTA exists. Silent on success, so a healthy
#    box sends no mail at all.
printf '%s\n' "$SUMMARY"

# 3. Whatever the owner actually reads. Never allowed to change the exit status: an alerting channel
#    that is itself down must not turn a failed job into a differently-failed job.
if [ -n "${AIHR_ALERT_COMMAND:-}" ]; then
  printf '%s\n' "$SUMMARY" | sh -c "$AIHR_ALERT_COMMAND" || true
fi

exit "$STATUS"
