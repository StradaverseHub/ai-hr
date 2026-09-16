#!/usr/bin/env bash
# AI HR — DEPLOY STATE. r291 / readiness 7.1, bullets 2 and 3.
#
# WHY THIS EXISTS
#
# Until r291 a deploy was observable only through the pipe that started it. `improve:release` ran
# `ssh … ./deploy/deploy.sh` attached (scripts/improve/release.ts), so the only evidence a deploy had
# happened was the local process's exit code — and on 2026-09-16 that evidence was lost twice in one
# session: the SSH socket died, the local release hung on it forever, and the box meanwhile built,
# restarted and went healthy. Both times the board had to be transitioned by hand.
#
# From OUTSIDE the box, three completely different situations look identical — no output, a URL that
# still answers, a service that is still up:
#
#   • a deploy is RUNNING       (the build takes minutes; the old service serves throughout)
#   • a deploy FINISHED CLEANLY (the new build is live)
#   • a deploy DIED PARTWAY     (new source sits on disk beside a `.next` built from the OLD source —
#                                the readiness item's "mixed" state; nothing detected or reported it)
#
# This script is where the box answers that question about itself, because the box is the only place
# that knows. `deploy.sh` stamps its progress here; `deploy-state.sh status` reports it.
#
# THE STATES, AND THE SIGNAL FOR EACH
#
#   running      current record has no `result` and its recorded pid is a live deploy.sh
#   ok           result=ok AND the `.next/BUILD_ID` on disk is still the one this deploy built
#                AND the source ref on disk is the one it built from
#   failed       result=failed — deploy.sh's EXIT trap caught a non-zero exit (OOM in `next build`,
#                a refused preflight, a migration error). `exit_code` says which.
#   died         no `result`, and the recorded pid is gone — SIGKILL, the OOM killer, or a reboot.
#                No trap ran, so the record was never finalized. THIS is the interrupted-deploy state.
#   incomplete   a release announced itself (`pending`) and deploy.sh never began: the rsync was
#                interrupted, or the local process died between rsync and launch. Source on disk may
#                be half-new.
#   unknown      nothing recorded here at all (first deploy after r291, or the state dir was cleared).
#                Deliberately NOT "ok": absence of evidence is not evidence of a clean deploy.
#
# `stale_build` is printed in EVERY state and is the mixed-tree signal on its own: 1 whenever the
# source ref on disk differs from the ref `.next` was built from, or the `.next/BUILD_ID` on disk is
# not the one the last clean deploy recorded. During a `running` deploy it is legitimately 1.
#
# WHERE THE STATE LIVES, AND WHY NOT IN THE REPO
#
# `/var/tmp/aihr-deploy` (override with AIHR_DEPLOY_STATE_DIR — the tests do). NOT under /opt/ai-hr:
# `improve:release` rsyncs that tree with `--delete`, so a state directory there would either be
# deleted at the start of every deploy or need a new `--exclude` — and the excludes are duplicated in
# CLAUDE.md §3's "does production run main?" dry-run, where an unexcluded directory would print a
# deletion line and break the zero-lines check. /var/tmp rather than /tmp because systemd-tmpfiles
# cleans /tmp and we want a deploy that died before a reboot to still be readable after it.
#
# NO `set -e`. This script is instrumentation on the deploy path: it must never be the reason a deploy
# fails. Every write is best-effort and every read has a default.
set -uo pipefail

STATE_DIR="${AIHR_DEPLOY_STATE_DIR:-/var/tmp/aihr-deploy}"
CUR="$STATE_DIR/current"
LAST_OK="$STATE_DIR/last-ok"
PENDING="$STATE_DIR/pending"

# The repo root, from this script's own location — deploy.sh cd's there but `status` may be invoked
# from anywhere (an operator's SSH session, the release poller).
REPO="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)" || REPO="."

# Separates the streamed log bytes from the status block in `follow`. Deliberately not a word that
# could appear in build output; `follow`'s reader splits on the LAST occurrence, so even if a build
# somehow echoed it the status block would still be found.
SENTINEL='<<<AIHR-DEPLOY-STATE-9d3f41>>>'

mkdir -p "$STATE_DIR" 2>/dev/null || true

# ── tiny key=value store ─────────────────────────────────────────────────────
# Flat `key=value` lines, not JSON: this has to be written from bash under `set -u` on a box whose
# only guaranteed tools are coreutils, and a half-written JSON file is unparseable where a missing
# key is merely absent. Values are sanitised to a character set that needs no quoting.

san() { printf '%s' "${1:-}" | tr -c 'A-Za-z0-9._:/+=@-' '_'; }

kv_get() { # file key → value ('' when absent)
  [ -f "${1:-}" ] || return 0
  sed -n "s/^${2}=//p" "$1" 2>/dev/null | tail -n 1
}

kv_set() { # file key value
  local f="$1" k="$2" v="$3" tmp
  tmp="$f.tmp.$$"
  { [ -f "$f" ] && grep -v "^${k}=" "$f" 2>/dev/null; printf '%s=%s\n' "$k" "$v"; } > "$tmp" 2>/dev/null
  mv -f "$tmp" "$f" 2>/dev/null || true
}

now() { date +%s 2>/dev/null || echo 0; }

# The `.next` build id physically on disk right now, or '-'. This is the half of the comparison the
# deploy cannot lie about: whatever wrote `.next` last, wrote this.
disk_build_id() {
  if [ -f "$REPO/.next/BUILD_ID" ]; then
    tr -d ' \t\r\n' < "$REPO/.next/BUILD_ID" 2>/dev/null
  else
    printf '-'
  fi
}

# Is the recorded pid still a running deploy?
#
# `kill -0` alone is not enough: pids are reused, and a reused pid would report a long-dead deploy as
# `running` forever. The command line has to still be a deploy.sh. A pid that exists but is something
# else is treated as DEAD, which is the conservative direction — it reports a problem that may have
# resolved, rather than reporting success over a deploy that was killed.
alive() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 1
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  ps -p "$pid" -o command= 2>/dev/null | grep -q 'deploy\.sh' || return 1
  return 0
}

cmd="${1:-status}"
shift 2>/dev/null || true

case "$cmd" in

  # Called by improve:release BEFORE the rsync. Closes the window in which the local process dies
  # between "new source is being written to the box" and "deploy.sh has started": deploy.sh removes
  # this file the moment it begins, so a `pending` that is still here means no deploy ever ran
  # against the source now on disk.
  pending)
    kv_set "$PENDING" ref "$(san "${1:-unknown}")"
    kv_set "$PENDING" at "$(now)"
    ;;

  # deploy.sh, first thing. begin <ref> <pid> <log>
  #
  # WRITTEN IN ONE ATOMIC RENAME, not field by field. A `status` landing between a field-by-field
  # `ref=` and `pid=` would read a record with no pid, conclude the process was gone, and report
  # `died` over a deploy that had just started — observed while building this (the poller saw
  # `phase=-`, which is the same window). One `mv` means every reader sees either the previous
  # record or this whole one.
  begin)
    rm -f "$PENDING" 2>/dev/null || true
    tmp="$CUR.tmp.$$"
    {
      printf 'ref=%s\n'        "$(san "${1:-unknown}")"
      printf 'pid=%s\n'        "$(san "${2:-}")"
      printf 'log=%s\n'        "$(san "${3:-}")"
      printf 'started_at=%s\n' "$(now)"
      printf 'phase=%s\n'      'preflight'
      printf 'result=\n'
      printf 'exit_code=\n'
      printf 'build_id=\n'
    } > "$tmp" 2>/dev/null
    mv -f "$tmp" "$CUR" 2>/dev/null || true
    ;;

  phase)
    kv_set "$CUR" phase "$(san "${1:-}")"
    ;;

  # deploy.sh, immediately after a SUCCESSFUL `pnpm build`. Records which build id this deploy's
  # source produced, so a later `.next` that is not this one is detectable as stale.
  built)
    kv_set "$CUR" build_id "$(disk_build_id)"
    kv_set "$CUR" built_at "$(now)"
    ;;

  # deploy.sh's EXIT trap. finish <rc>
  #
  # ORDER MATTERS ON SUCCESS: `last-ok` is published BEFORE `current` is marked ok. `status` decides
  # `ok` vs `stale-build` by comparing current against last-ok, so marking current first would leave a
  # window in which a clean deploy reads as `stale-build` — and the release follower treats that as a
  # terminal failure. Write the evidence, then the verdict.
  finish)
    rc_arg="${1:-1}"
    kv_set "$CUR" exit_code "$(san "$rc_arg")"
    kv_set "$CUR" finished_at "$(now)"
    if [ "$rc_arg" = "0" ]; then
      cp -f "$CUR" "$LAST_OK.tmp.$$" 2>/dev/null && mv -f "$LAST_OK.tmp.$$" "$LAST_OK" 2>/dev/null || true
      kv_set "$CUR" result ok
    else
      kv_set "$CUR" result failed
    fi
    ;;

  status)
    d_build_id="$(disk_build_id)"
    [ -n "$d_build_id" ] || d_build_id='-'
    ref="$(kv_get "$CUR" ref)";              [ -n "$ref" ] || ref='-'
    phase="$(kv_get "$CUR" phase)";          [ -n "$phase" ] || phase='-'
    pid="$(kv_get "$CUR" pid)"
    result="$(kv_get "$CUR" result)"
    exit_code="$(kv_get "$CUR" exit_code)";  [ -n "$exit_code" ] || exit_code='-'
    started_at="$(kv_get "$CUR" started_at)"; [ -n "$started_at" ] || started_at='-'
    finished_at="$(kv_get "$CUR" finished_at)"; [ -n "$finished_at" ] || finished_at='-'
    log="$(kv_get "$CUR" log)"
    built_ref="$(kv_get "$LAST_OK" ref)";           [ -n "$built_ref" ] || built_ref='-'
    built_build_id="$(kv_get "$LAST_OK" build_id)"; [ -n "$built_build_id" ] || built_build_id='-'

    if [ -f "$PENDING" ]; then
      state=incomplete
      # The announced ref is the source now on disk; there is no `current` record naming it, because
      # that is precisely what did not happen.
      pending_ref="$(kv_get "$PENDING" ref)"
      [ -n "$pending_ref" ] && ref="$pending_ref"
    elif [ ! -f "$CUR" ]; then
      state=unknown
    elif [ -z "$result" ]; then
      if alive "$pid"; then state=running; else state=died; fi
    elif [ "$result" = "ok" ]; then
      if [ "$d_build_id" != '-' ] && [ "$d_build_id" = "$built_build_id" ] && [ "$ref" = "$built_ref" ]; then
        state=ok
      else
        # Finished cleanly, but what is on disk is no longer what it built. Something replaced the
        # source or the build afterwards; `.next` and the source do not agree.
        state=stale-build
      fi
    else
      state=failed
    fi

    if [ "$d_build_id" != '-' ] && [ "$d_build_id" = "$built_build_id" ] && [ "$ref" = "$built_ref" ] && [ "$ref" != '-' ]; then
      stale_build=0
    else
      stale_build=1
    fi

    log_size=0
    if [ -n "$log" ] && [ -f "$log" ]; then
      log_size="$(wc -c < "$log" 2>/dev/null | tr -d ' \t\r\n')"
      [ -n "$log_size" ] || log_size=0
    fi

    printf 'state=%s\n'          "$state"
    printf 'phase=%s\n'          "$phase"
    printf 'ref=%s\n'            "$ref"
    printf 'pid=%s\n'            "${pid:--}"
    printf 'exit_code=%s\n'      "$exit_code"
    printf 'started_at=%s\n'     "$started_at"
    printf 'finished_at=%s\n'    "$finished_at"
    printf 'now=%s\n'            "$(now)"
    printf 'log=%s\n'            "${log:--}"
    printf 'log_size=%s\n'       "$log_size"
    printf 'build_id=%s\n'       "$d_build_id"
    printf 'built_ref=%s\n'      "$built_ref"
    printf 'built_build_id=%s\n' "$built_build_id"
    printf 'stale_build=%s\n'    "$stale_build"
    ;;

  # follow <byte-offset> — the streaming half. Prints the log bytes the caller has not seen, then the
  # sentinel, then the status block. One round trip per poll, and every round trip is independent:
  # that is what makes the follower survive a dropped connection (it simply reconnects and asks
  # again from the same offset) where a held-open pipe cannot.
  follow)
    off="${1:-0}"
    case "$off" in ''|*[!0-9]*) off=0 ;; esac
    log="$(kv_get "$CUR" log)"
    # A `pending` marker means the `current` record belongs to the PREVIOUS deploy — its log is not
    # the one the caller is waiting on, and replaying it would show the last deploy's output as if it
    # were this one's. Stay silent until deploy.sh has begun and cleared the marker.
    if [ ! -f "$PENDING" ] && [ -n "$log" ] && [ -f "$log" ]; then
      tail -c "+$((off + 1))" "$log" 2>/dev/null
    fi
    printf '%s\n' "$SENTINEL"
    "$0" status
    ;;

  sentinel)
    printf '%s\n' "$SENTINEL"
    ;;

  *)
    echo "usage: deploy-state.sh <pending REF | begin REF PID LOG | phase NAME | built | finish RC | status | follow OFFSET>" >&2
    exit 2
    ;;
esac
exit 0
