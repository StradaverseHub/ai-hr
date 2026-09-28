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
# RUNNING A RANGE, AND WHY IT EXISTS (r352). CLAUDE.md section 4 records that on this machine the
# harness KILLS a long background command when memory runs low — a six-chunk background gate died in
# chunk 3 twice — and that what runs clean is every chunk in the FOREGROUND, inside its own tool call.
# A foreground call is time-bounded, so a 16-chunk gate cannot fit in one. CHUNK_FROM/CHUNK_TO run a
# CONTIGUOUS SLICE of the same chunking, so the documented reliable workflow is actually executable:
#
#   CHUNKS=16 CHUNK_FROM=1  CHUNK_TO=4  ./scripts/gate-chunked.sh
#   CHUNKS=16 CHUNK_FROM=5  CHUNK_TO=8  ./scripts/gate-chunked.sh     # …and so on to 16
#
# CHUNKS must be IDENTICAL across the slices or they do not partition the suite: the split is
# `i = c; i < TOTAL; i += CHUNKS`, so a chunk's membership is a function of CHUNKS. Changing it
# mid-gate silently reruns some files and skips others, and the counts would still add up.
#
# A RANGE IS NOT A GATE. The footer says PARTIAL and the summary names the slice, because the one
# thing a reader must never do is read a green slice as a green gate. The gate is green when every
# slice reported exit 0 AND the counted files sum to the whole suite.
#
# Reading the result: this prints a per-chunk summary and a FINAL total. A chunk that reports a
# non-zero exit, or a file count that does not add up to the whole suite, is a failed gate — read the
# per-chunk log named in the output, exactly as you would read one vitest run.
set -uo pipefail

CHUNKS="${CHUNKS:-3}"
# 1-based, inclusive, and defaulting to the whole run so every existing invocation is byte-identical.
CHUNK_FROM="${CHUNK_FROM:-1}"
CHUNK_TO="${CHUNK_TO:-$CHUNKS}"
OUT="${GATE_OUT:-/tmp/aihr-gate}"
mkdir -p "$OUT"

cd "$(dirname "$0")/.." || exit 1
echo "▸ tree: $(pwd)  branch: $(git branch --show-current)"

# macOS ships bash 3.2, which has no `mapfile` and no associative arrays. Read the list the portable
# way rather than assuming a modern bash — the script otherwise dies with "mapfile: command not found"
# only once someone actually runs it.
# BOTH vitest projects, or this "full suite" is not one: node runs test/**/*.test.ts and dom runs
# test/**/*.dom.test.tsx. Globbing only the first silently dropped five files. The browser project
# (*.browser.test.tsx) is deliberately outside `pnpm vitest run` and stays out here too.
ALL=()
while IFS= read -r f; do ALL+=("$f"); done < <(
  { find test -name '*.test.ts'; find test -name '*.dom.test.tsx'; } | sort
)
TOTAL=${#ALL[@]}
PARTIAL=0
if [ "$CHUNK_FROM" != "1" ] || [ "$CHUNK_TO" != "$CHUNKS" ]; then PARTIAL=1; fi
if [ "$CHUNK_FROM" -lt 1 ] || [ "$CHUNK_TO" -gt "$CHUNKS" ] || [ "$CHUNK_FROM" -gt "$CHUNK_TO" ]; then
  echo "CHUNK_FROM=$CHUNK_FROM CHUNK_TO=$CHUNK_TO is not a slice of 1..$CHUNKS"; exit 2
fi
echo "▸ $TOTAL test files across $CHUNKS chunks"
[ "$PARTIAL" = "1" ] && echo "▸ PARTIAL RUN — chunks $CHUNK_FROM..$CHUNK_TO of $CHUNKS only"

FAILED=0
RAN=0
COUNTED_TOTAL=0
declare -a SUMMARY

for ((c = CHUNK_FROM - 1; c < CHUNK_TO; c++)); do
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
  # (N) at the end of the Test Files line is the number vitest actually counted.
  COUNTED=$(echo "$LINE" | grep -oE '\([0-9]+\)$' | tr -d '()')
  if [ -n "$COUNTED" ] && [ "$COUNTED" != "${#FILES[@]}" ]; then
    echo "  ⚠️  ASKED FOR ${#FILES[@]} FILES, VITEST COUNTED $COUNTED — a file that fails to spawn is"
    echo "      not counted at all, so this is a RED gate however the pass/fail numbers read."
    RC=1
  fi
  TESTS=$(grep -E "^ *Tests " "$LOG" | tail -1)
  DUR=$(grep -E "^ *Duration" "$LOG" | tail -1)
  DISK=$(df -P /opt/homebrew/var/aihr-pg16-ram 2>/dev/null | awk 'NR==2{print $5}')
  echo "  exit=$RC  peak-disk=${DISK:-n/a}"
  echo "  $LINE"
  echo "  $TESTS"
  echo "  $DUR"
  SUMMARY+=("chunk $((c + 1)): exit=$RC ${LINE:-<no summary>}")
  RAN=$((RAN + 1))
  [ -n "$COUNTED" ] && COUNTED_TOTAL=$((COUNTED_TOTAL + COUNTED))
  [ "$RC" != "0" ] && FAILED=1
done

echo
echo "════ FINAL ════"
for s in "${SUMMARY[@]}"; do echo "  $s"; done
echo "  chunks run: $RAN   files counted: $COUNTED_TOTAL of $TOTAL in the suite"
if [ "$FAILED" != "0" ]; then
  echo "  GATE RED — read the chunk logs in $OUT"
elif [ "$PARTIAL" = "1" ]; then
  echo "  SLICE GREEN — chunks $CHUNK_FROM..$CHUNK_TO of $CHUNKS. THIS IS NOT A GATE."
  echo "  The gate is green only when every slice reported exit 0 and the counted files sum to $TOTAL."
else
  echo "  GATE GREEN across all $CHUNKS chunks"
fi
exit "$FAILED"
