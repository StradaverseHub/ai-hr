#!/usr/bin/env bash
# Run the FULL vitest suite in N chunks, rebuilding the disposable cluster between each one.
#
# WHY THIS EXISTS
# ---------------
# The suite generates more WAL than this machine can retire while it runs. Measured 2026-08-06: a full
# run produced 10.7 GB of WAL on disk, and filled a 5 GB and then an 8 GB RAM disk, at which point
# Postgres died with "No space left on device" and every remaining test failed for want of a database —
# 285 failed FILES that said nothing at all about the code under test.
#
# scripts/dev-db-rebuild.sh explains the WAL mechanics (min_wal_size, recycling vs unlinking) and makes
# each individual segment far cheaper to retire. It does not change how much WAL the suite GENERATES,
# and on this hardware that is the binding constraint. Until the harness stops doing a ~100-table
# TRUNCATE per test file — CREATE DATABASE ... TEMPLATE would write a fraction of the WAL — the reliable
# way to get a trustworthy full-suite result is to bound how much WAL any single run can accumulate.
#
# So: split the files into chunks, rebuild the cluster before each, and aggregate. Every file still runs
# exactly once, and no chunk gets near the volume limit.
#
#   ./scripts/gate-chunked.sh          3 chunks (default)
#   CHUNKS=4 ./scripts/gate-chunked.sh
#
# Reading the result: this prints a per-chunk summary and a FINAL total. A chunk that reports a
# non-zero exit, or a file count that does not add up to the whole suite, is a failed gate — read the
# per-chunk log named in the output, exactly as you would read one vitest run.
set -uo pipefail

CHUNKS="${CHUNKS:-3}"
OUT="${GATE_OUT:-/tmp/aihr-gate}"
mkdir -p "$OUT"

cd "$(dirname "$0")/.." || exit 1
echo "▸ tree: $(pwd)  branch: $(git branch --show-current)"

# macOS ships bash 3.2, which has no `mapfile` and no associative arrays. Read the list the portable
# way rather than assuming a modern bash — the script otherwise dies with "mapfile: command not found"
# only once someone actually runs it.
ALL=()
while IFS= read -r f; do ALL+=("$f"); done < <(ls test/*.test.ts | sort)
TOTAL=${#ALL[@]}
echo "▸ $TOTAL test files across $CHUNKS chunks"

FAILED=0
declare -a SUMMARY

for ((c = 0; c < CHUNKS; c++)); do
  FILES=()
  for ((i = c; i < TOTAL; i += CHUNKS)); do FILES+=("${ALL[$i]}"); done
  LOG="$OUT/chunk$((c + 1)).log"

  echo
  echo "════ chunk $((c + 1))/$CHUNKS — ${#FILES[@]} files ════"
  # A fresh cluster per chunk: this is what keeps WAL bounded, and it costs well under a minute.
  bash scripts/dev-db-rebuild.sh > "$OUT/rebuild$((c + 1)).log" 2>&1 || {
    echo "  cluster rebuild FAILED — see $OUT/rebuild$((c + 1)).log"; exit 1; }
  pnpm db:migrate > "$OUT/migrate$((c + 1)).log" 2>&1 || {
    echo "  migrate FAILED — see $OUT/migrate$((c + 1)).log"; exit 1; }

  pnpm vitest run "${FILES[@]}" > "$LOG" 2>&1
  RC=$?
  LINE=$(grep -E "^ *Test Files" "$LOG" | tail -1)
  TESTS=$(grep -E "^ *Tests " "$LOG" | tail -1)
  DUR=$(grep -E "^ *Duration" "$LOG" | tail -1)
  DISK=$(df -P /opt/homebrew/var/aihr-pg16-ram 2>/dev/null | awk 'NR==2{print $5}')
  echo "  exit=$RC  peak-disk=${DISK:-n/a}"
  echo "  $LINE"
  echo "  $TESTS"
  echo "  $DUR"
  SUMMARY+=("chunk $((c + 1)): exit=$RC ${LINE:-<no summary>}")
  [ "$RC" != "0" ] && FAILED=1
done

echo
echo "════ FINAL ════"
for s in "${SUMMARY[@]}"; do echo "  $s"; done
if [ "$FAILED" = "0" ]; then echo "  GATE GREEN across all $CHUNKS chunks"; else echo "  GATE RED — read the chunk logs in $OUT"; fi
exit "$FAILED"
