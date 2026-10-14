#!/usr/bin/env bash
# ADR-0114: one entry point for deterministic impact/full selection and persistent evidence.
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.." || exit 1
. scripts/gate-lib.sh
gate_export_locale
# devdb-lock exports its own slot directory; never mistake it for the two test slots.
unset AIHR_LOCK_DIR AIHR_TEST_SLOTS
gate_hold_both_slots "$SCRIPT" "$@"
DEVLOCK="${AIHR_DEVDB_LOCK:-$HOME/.aihr-gate-state/devdb-lock.sh}"
if [ -f "$DEVLOCK" ] && [ "$(AIHR_LOCK_DIR="$HOME/.aihr-gate-state/devdb-locks" gate_slots_held_by_ancestors)" = 0 ]; then
  exec bash "$DEVLOCK" impact-db -- env -u AIHR_LOCK_DIR -u AIHR_TEST_SLOTS bash "$SCRIPT" "$@"
fi
printf '▸ tree: %s  branch: %s  head: %s\n' "$(pwd)" "$(git branch --show-current)" "$(git rev-parse --short HEAD)"
gate_print_load
node --import tsx scripts/gate-impact-run.ts "$@"
