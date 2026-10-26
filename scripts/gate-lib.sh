#!/usr/bin/env bash
# r417 (ADR-0094) — shared by scripts/gate-chunked.sh and scripts/gate-affected.sh. Sourced, not run.

# The machine's load average, printed at the start of every gate so a slow run explains itself. Measured
# 2026-10-08: another project on this machine was running ~35 vitest workers (load ~73 on 12 cores), and
# a gate that would take 25 minutes uncontended took far longer for reasons nothing in its log showed.
gate_print_load() {
  local la cores
  la=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{print $1" "$2" "$3}')
  [ -n "$la" ] || la=$(uptime | sed 's/.*load averages*: //')
  cores=$(sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo '?')
  echo "▸ load average (1/5/15 min): ${la}  on ${cores} cores"
}

# A UTF-8 locale, or postmaster start-up dies with "became multithreaded" inside dev-db-rebuild.sh.
gate_export_locale() {
  export LANG="${GATE_LANG:-en_US.UTF-8}" LC_ALL="${GATE_LANG:-en_US.UTF-8}"
}

# How many test-lock slots are held by THIS process or one of its ancestors. Lets a gate script take the
# lock itself without deadlocking when the caller already wrapped it in the documented nested form
# (`testlock.sh gate-a -- testlock.sh gate-b -- bash scripts/gate-chunked.sh`): testlock.sh records its
# own pid in the slot and runs the command as its child, so the holders are on our ancestor chain.
gate_slots_held_by_ancestors() {
  local lockdir="${AIHR_LOCK_DIR:-$HOME/.aihr-gate-state/locks}" chain=" " p=$$ n=0 d pid
  while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
    chain="$chain$p "
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  for d in "$lockdir"/slot.*; do
    [ -f "$d/pid" ] || continue
    pid=$(cat "$d/pid" 2>/dev/null)
    case "$chain" in *" $pid "*) n=$((n + 1)) ;; esac
  done
  echo "$n"
}

# Gate entry points reserve the complete memory+database set before starting.
# Already complete legacy callers remain compatible; partial upgrades refuse instead
# of holding one resource while waiting for another. No shared host script is replaced.
gate_hold_both_slots() {
  local lock="${AIHR_TESTLOCK:-$HOME/.aihr-gate-state/testlock.sh}" held database launcher
  if [ ! -f "$lock" ]; then
    echo "▸ WARNING: no test lock at $lock — running unlocked (not this machine's normal setup)"
    return 0
  fi
  held=$(AIHR_LOCK_DIR="$HOME/.aihr-gate-state/locks" gate_slots_held_by_ancestors)
  database=$(AIHR_LOCK_DIR="$HOME/.aihr-gate-state/devdb-locks" gate_slots_held_by_ancestors)
  if [ "$held" -ge 2 ] && [ "$database" -ge 1 ]; then
    echo "▸ gate resources: complete ancestor reservation held"
    return 0
  fi
  if [ "$held" -gt 0 ] || [ "$database" -gt 0 ]; then
    echo "Gate resource upgrade refused: release partial outer leases and call this entry directly, or reserve both test slots and the database atomically." >&2
    exit 78
  fi
  launcher="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local-resource-lock.py"
  exec python3 "$launcher" --test-slots 2 --database final-gate -- bash "$@"
}
