#!/usr/bin/env bash
# Moves the minute maintenance jobs from cron / the notification user timer to the resident
# aihr-scheduled-jobs.service (deploy/scheduled-jobs/README.md). Run by an administrator, AS THE DEPLOY USER that owns
# /opt/ai-hr and its crontab (e.g. `sudo -iu ubuntu`), from /opt/ai-hr, inside the installation's release window.
#
#   deploy/scheduled-jobs/install.sh check      read-only: what install would change
#   deploy/scheduled-jobs/install.sh install    start the service, then retire the old schedules
#   deploy/scheduled-jobs/install.sh rollback   stop the service, then restore the old schedules exactly
#
# What install changes, in this order, and nothing else:
#   1. backs up the current crontab byte for byte (to $LOG_DIR/crontab-before-scheduled-jobs-<time>);
#   2. installs the unit into ~/.config/systemd/user/, enables and starts it (Type=notify: the start returns once
#      every job has loaded), refusing before any schedule is touched if it does not start;
#   3. comments out (never deletes) each ACTIVE crontab line that runs scripts/provision-runner.ts (except the separate
#      --installed-internal-reports-only capability) or scripts/notification-email-sweep.ts, prefixed with MARKER;
#   4. stops and disables aihr-notification-email.timer if it is enabled (its unit files stay for rollback);
#   5. reads the crontab back and refuses if any matching active line remains.
# The heartbeat staleness lines stay: the service touches the same heartbeat files.
# Both old and new schedules take the same PostgreSQL advisory lock per job (scripts/lib/scheduled-job-lock.ts), so
# the order above can never run a job twice at once, and a partial install leaves a working schedule.
set -euo pipefail

MODE=${1:-}
UNIT=aihr-scheduled-jobs.service
TIMER=aihr-notification-email.timer
ROOT=${AIHR_ROOT:-/opt/ai-hr}
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
LOG_DIR=${AIHR_CRON_LOG_DIR:-$HOME/aihr-cron-logs}
STATE=$LOG_DIR/scheduled-jobs-install.state
MARKER='# MOVED to aihr-scheduled-jobs.service:'
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
SYSTEMCTL=${AIHR_SYSTEMCTL:-systemctl}
CRONTAB=${AIHR_CRONTAB:-crontab}
LOGINCTL=${AIHR_LOGINCTL:-loginctl}
NODE20=${AIHR_NODE20:-/opt/node20/bin/node}

die(){ echo "✗ $*" >&2; exit 1; }
# An active (uncommented) line that schedules one of the moved jobs. The dedicated report capability is not moved.
is_moved_job_line(){
  local line=$1
  [[ $line =~ ^[[:space:]]*# ]] && return 1
  [[ $line == *--installed-internal-reports-only* ]] && return 1
  [[ $line == *scripts/provision-runner.ts* || $line == *scripts/notification-email-sweep.ts* ]]
}
current_crontab(){ "$CRONTAB" -l 2>/dev/null || true; }
moved_lines(){ local line; while IFS= read -r line || [ -n "$line" ]; do is_moved_job_line "$line" && printf '%s\n' "$line"; done < <(current_crontab); return 0; }
timer_enabled(){ "$SYSTEMCTL" --user is-enabled "$TIMER" >/dev/null 2>&1; }

preflight(){
  [ "$(id -u)" -ne 0 ] || die "run as the deploy user that owns $ROOT and its crontab, not as root (sudo -iu <user>)."
  [ "$(pwd -P)" = "$(cd "$ROOT" && pwd -P)" ] || die "run from $ROOT."
  [ -f "$ROOT/scripts/scheduled-jobs.ts" ] || die "$ROOT does not contain scripts/scheduled-jobs.ts: deploy the release that ships it first."
  [ -f "$ROOT/.env.production" ] || die "$ROOT/.env.production is missing."
  [ -x "$NODE20" ] || die "$NODE20 is missing (the unit pins it, as the crontab lines do)."
  # Without lingering, a user service stops when the user's last session ends.
  [ "$("$LOGINCTL" show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" = "yes" ] \
    || die "user lingering is off for $(id -un): an administrator runs 'sudo loginctl enable-linger $(id -un)' first."
}

case "$MODE" in
check)
  preflight
  echo "Unit:      $UNIT_DIR/$UNIT ($([ -f "$UNIT_DIR/$UNIT" ] && { cmp -s "$ROOT/deploy/scheduled-jobs/$UNIT" "$UNIT_DIR/$UNIT" && echo 'installed, current' || echo 'installed, DIFFERS from this release'; } || echo 'not installed'))"
  echo "Service:   $("$SYSTEMCTL" --user is-active "$UNIT" 2>/dev/null || true)"
  echo "Timer:     $TIMER $("$SYSTEMCTL" --user is-enabled "$TIMER" 2>/dev/null || echo 'not installed')"
  echo "Crontab lines install would comment out:"
  moved_lines | sed 's/^/  /'
  ;;
install)
  preflight
  mkdir -p "$LOG_DIR" "$UNIT_DIR"
  stamp=$(date +%Y%m%dT%H%M%S)
  backup=$LOG_DIR/crontab-before-scheduled-jobs-$stamp
  current_crontab >"$backup"
  # A repeated install must not forget that an earlier one disabled the timer, or rollback would leave it off.
  timer_was=no
  if timer_enabled || { [ -f "$STATE" ] && grep -qx 'timer_was_enabled=yes' "$STATE"; }; then timer_was=yes; fi
  { echo "backup=$backup"; echo "timer_was_enabled=$timer_was"; } >"$STATE"
  echo "▸ Crontab backed up to $backup"

  install -m 0644 "$ROOT/deploy/scheduled-jobs/$UNIT" "$UNIT_DIR/$UNIT"
  "$SYSTEMCTL" --user daemon-reload
  "$SYSTEMCTL" --user enable "$UNIT" >/dev/null
  # Type=notify: this returns only after the process has loaded every job and started its scheduler.
  "$SYSTEMCTL" --user restart "$UNIT" || die "$UNIT did not start; the old schedules are untouched. Read: journalctl --user -u $UNIT"
  echo "✓ $UNIT is running."

  if [ -n "$(moved_lines)" ]; then
    new=$(mktemp); trap 'rm -f "$new"' EXIT
    while IFS= read -r line || [ -n "$line" ]; do
      if is_moved_job_line "$line"; then printf '%s %s\n' "$MARKER" "$line"; else printf '%s\n' "$line"; fi
    done < <(current_crontab) >"$new"
    "$CRONTAB" "$new"
  fi
  [ -z "$(moved_lines)" ] || die "the crontab still schedules a moved job after the edit; read it with crontab -l (backup: $backup)."
  echo "✓ Crontab: moved jobs commented out ($(current_crontab | grep -c -F "$MARKER" || true) line(s) carry the marker)."

  if timer_enabled; then "$SYSTEMCTL" --user disable --now "$TIMER" >/dev/null; echo "✓ $TIMER stopped and disabled (unit files kept for rollback)."; fi
  echo "Done. Verify: journalctl --user -u $UNIT -f; tail $LOG_DIR/provision.log; ls -l $LOG_DIR/heartbeat"
  ;;
rollback)
  [ "$(id -u)" -ne 0 ] || die "run as the deploy user, not as root."
  "$SYSTEMCTL" --user disable --now "$UNIT" >/dev/null 2>&1 || true
  echo "✓ $UNIT stopped and disabled."
  if current_crontab | grep -q -F "$MARKER"; then
    new=$(mktemp); trap 'rm -f "$new"' EXIT
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ $line == "$MARKER "* ]]; then printf '%s\n' "${line#"$MARKER "}"; else printf '%s\n' "$line"; fi
    done < <(current_crontab) >"$new"
    "$CRONTAB" "$new"
    echo "✓ Crontab lines restored."
  fi
  if [ -f "$STATE" ] && grep -qx 'timer_was_enabled=yes' "$STATE"; then
    "$SYSTEMCTL" --user enable --now "$TIMER" >/dev/null; echo "✓ $TIMER re-enabled."
  fi
  ;;
*)
  echo "usage: deploy/scheduled-jobs/install.sh check|install|rollback" >&2; exit 64 ;;
esac
