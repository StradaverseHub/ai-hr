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
#
# ── r417 (ADR-0094): THE FULL GATE NOW RUNS IN TWO PARTS ─────────────────────────────────────────────────
#
#   (a) every test file that does NOT touch the database, in ONE vitest invocation through
#       vitest.nodb.config.ts — no cluster rebuild, no globalSetup, VITEST_MAX_WORKERS_NODB workers
#       (default 6). Which files those are is COMPUTED by scripts/gate-db-classify.ts, never listed by
#       hand, and every doubt sends a file to (b).
#   (b) the DB-touching files, chunked exactly as before: a cluster rebuild + migrate per chunk, CHUNKS and
#       VITEST_MAX_WORKERS handled as before, and the same "asked for N, vitest counted M" assertion.
#
# The two parts must PARTITION the suite (asserted before anything runs), and on a full run the files
# counted across (a) and (b) must equal the suite's file count (asserted at the end). A full green run on a
# clean tree writes .gate-receipt.json {result: PASS, tier: "full", sha: HEAD, …}; a full red run writes
# result FAIL; a slice, a dirty tree or a proof run writes none.
#
# Part (a) ALWAYS runs with every database URL pointed at a closed port (127.0.0.1:1), so a file the
# classifier wrongly called no-DB fails the gate instead of quietly passing against a leftover cluster.
#
#   GATE_NODB_PROOF=1 ./scripts/gate-chunked.sh   run ONLY part (a) — the classifier proof on its own,
#                                                 in a few minutes. Writes no receipt.
#
# A slice (CHUNK_FROM/CHUNK_TO) runs part (a) only in the slice that starts at chunk 1, so the slices of
# one gate still run every file exactly once. The script takes BOTH test-lock slots itself (CLAUDE.md
# §10) unless its caller already holds them, and prints the machine load average first.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=scripts/gate-lib.sh
. scripts/gate-lib.sh
gate_export_locale
gate_hold_both_slots "$SCRIPT" "$@"

CHUNKS="${CHUNKS:-3}"
# 1-based, inclusive, and defaulting to the whole run so every existing invocation is byte-identical.
CHUNK_FROM="${CHUNK_FROM:-1}"
CHUNK_TO="${CHUNK_TO:-$CHUNKS}"
OUT="${GATE_OUT:-/tmp/aihr-gate}"
NODB_WORKERS="${VITEST_MAX_WORKERS_NODB:-6}"
PROOF="${GATE_NODB_PROOF:-0}"
mkdir -p "$OUT"

T_START=$(date +%s)
echo "▸ tree: $(pwd)  branch: $(git branch --show-current)  head: $(git rev-parse --short HEAD)"
gate_print_load
HEAD_AT_START=$(git rev-parse HEAD)
DIRTY_AT_START=$(git status --porcelain | head -1)

# macOS ships bash 3.2, which has no `mapfile` and no associative arrays. Read the list the portable
# way rather than assuming a modern bash — the script otherwise dies with "mapfile: command not found"
# only once someone actually runs it.
# BOTH vitest projects, or this "full suite" is not one: node runs test/**/*.test.ts and dom runs
# test/**/*.dom.test.tsx. Globbing only the first silently dropped five files. The browser project
# (*.browser.test.tsx) is deliberately outside `pnpm vitest run` and stays out here too.
{ find test -name '*.test.ts'; find test -name '*.dom.test.tsx'; } | sort > "$OUT/all-files.txt"
ALL=()
while IFS= read -r f; do ALL+=("$f"); done < "$OUT/all-files.txt"
TOTAL=${#ALL[@]}

# ── the split ───────────────────────────────────────────────────────────────────────────────────────────
node --import tsx scripts/gate-db-classify.ts explain < "$OUT/all-files.txt" > "$OUT/classify.tsv" || {
  echo "  classifier FAILED — see $OUT/classify.tsv"; exit 1; }
awk -F'\t' '$1=="NODB"{print $2}' "$OUT/classify.tsv" > "$OUT/nodb-files.txt"
awk -F'\t' '$1=="DB"{print $2}' "$OUT/classify.tsv" > "$OUT/db-files.txt"
NODB=(); while IFS= read -r f; do NODB+=("$f"); done < "$OUT/nodb-files.txt"
DBF=();  while IFS= read -r f; do DBF+=("$f");  done < "$OUT/db-files.txt"
# The two lists must PARTITION the suite: same files, none twice, none dropped.
if [ "$(sort "$OUT/nodb-files.txt" "$OUT/db-files.txt" | uniq -d | wc -l | tr -d ' ')" != "0" ] ||
   ! sort "$OUT/nodb-files.txt" "$OUT/db-files.txt" | cmp -s - "$OUT/all-files.txt"; then
  echo "  ✗ the no-DB and DB lists do not partition the $TOTAL suite files — refusing to run"; exit 1
fi
DBTOTAL=${#DBF[@]}
echo "▸ $TOTAL test files: ${#NODB[@]} no-DB (part a, one run, $NODB_WORKERS workers) + $DBTOTAL DB (part b, $CHUNKS chunks)"
echo "  classification: $OUT/classify.tsv"

PARTIAL=0
if [ "$CHUNK_FROM" != "1" ] || [ "$CHUNK_TO" != "$CHUNKS" ] || [ "$PROOF" = "1" ]; then PARTIAL=1; fi
if [ "$CHUNK_FROM" -lt 1 ] || [ "$CHUNK_TO" -gt "$CHUNKS" ] || [ "$CHUNK_FROM" -gt "$CHUNK_TO" ]; then
  echo "CHUNK_FROM=$CHUNK_FROM CHUNK_TO=$CHUNK_TO is not a slice of 1..$CHUNKS"; exit 2
fi
[ "$PARTIAL" = "1" ] && [ "$PROOF" != "1" ] && echo "▸ PARTIAL RUN — chunks $CHUNK_FROM..$CHUNK_TO of $CHUNKS only"

FAILED=0
RAN=0
COUNTED_TOTAL=0
NODB_SECS=0
DB_SECS=0
declare -a SUMMARY

# Read vitest's "Test Files … (N)" line out of a log and compare N with what was asked for.
# Sets LINE, COUNTED and (on a mismatch) RC=1.
check_counted() { # <log> <asked>
  LINE=$(grep -E "^ *Test Files" "$1" | tail -1)
  # (N) at the end of the Test Files line is the number vitest actually counted.
  COUNTED=$(echo "$LINE" | grep -oE '\([0-9]+\)$' | tr -d '()')
  if [ -z "$COUNTED" ] || [ "$COUNTED" != "$2" ]; then
    echo "  ⚠️  ASKED FOR $2 FILES, VITEST COUNTED ${COUNTED:-NOTHING} — a file that fails to spawn is"
    echo "      not counted at all, so this is a RED gate however the pass/fail numbers read."
    RC=1
  fi
}

# ── part (a): the no-DB files, once, no cluster ───────────────────────────────────────────────────────
if [ "$CHUNK_FROM" = "1" ] && [ "${#NODB[@]}" -gt 0 ]; then
  LOG="$OUT/nodb.log"
  echo
  # EVERY database URL points at a CLOSED port, on every run and not only in proof mode: a file the
  # classifier wrongly called no-DB then fails HERE, loudly, instead of passing against whatever cluster
  # happens to be up. So every full gate re-proves the classifier. (test/env.ts loads .env.local with
  # process.loadEnvFile, which never overrides a variable already set, so these win.)
  CLOSED="postgres://nobody:nothing@127.0.0.1:1/no_database_here"
  if [ "$PROOF" = "1" ]; then
    echo "════ part (a) PROOF — ${#NODB[@]} no-DB files with every database URL on a CLOSED port ════"
  else
    echo "════ part (a) — ${#NODB[@]} no-DB files, one run, $NODB_WORKERS workers, no cluster, DB URLs on a closed port ════"
  fi
  t0=$(date +%s)
  env TEST_DATABASE_URL="$CLOSED" TEST_MIGRATION_DATABASE_URL="$CLOSED" \
    DATABASE_URL="$CLOSED" MIGRATION_DATABASE_URL="$CLOSED" VITEST_MAX_WORKERS_NODB="$NODB_WORKERS" \
    pnpm vitest run --config vitest.nodb.config.ts "${NODB[@]}" > "$LOG" 2>&1
  RC=$?
  NODB_SECS=$(( $(date +%s) - t0 ))
  check_counted "$LOG" "${#NODB[@]}"
  echo "  exit=$RC  wall=${NODB_SECS}s"
  echo "  $LINE"
  echo "  $(grep -E "^ *Tests " "$LOG" | tail -1)"
  echo "  $(grep -E "^ *Duration" "$LOG" | tail -1)"
  SUMMARY+=("part a (no-DB): exit=$RC ${LINE:-<no summary>}")
  RAN=$((RAN + 1))
  [ -n "$COUNTED" ] && COUNTED_TOTAL=$((COUNTED_TOTAL + COUNTED))
  [ "$RC" != "0" ] && FAILED=1
fi

# ── part (b): the DB files, chunked, a fresh cluster per chunk ────────────────────────────────────────
if [ "$PROOF" != "1" ]; then
for ((c = CHUNK_FROM - 1; c < CHUNK_TO; c++)); do
  FILES=()
  for ((i = c; i < DBTOTAL; i += CHUNKS)); do FILES+=("${DBF[$i]}"); done
  [ "${#FILES[@]}" -gt 0 ] || continue
  LOG="$OUT/chunk$((c + 1)).log"

  echo
  echo "════ part (b) chunk $((c + 1))/$CHUNKS — ${#FILES[@]} DB files ════"
  t0=$(date +%s)
  # A fresh cluster per chunk: this is what keeps WAL bounded, and it costs well under a minute.
  bash scripts/dev-db-rebuild.sh > "$OUT/rebuild$((c + 1)).log" 2>&1 || {
    echo "  cluster rebuild FAILED — see $OUT/rebuild$((c + 1)).log"; exit 1; }
  pnpm db:migrate > "$OUT/migrate$((c + 1)).log" 2>&1 || {
    echo "  migrate FAILED — see $OUT/migrate$((c + 1)).log"; exit 1; }

  pnpm vitest run "${FILES[@]}" > "$LOG" 2>&1
  RC=$?
  check_counted "$LOG" "${#FILES[@]}"
  TESTS=$(grep -E "^ *Tests " "$LOG" | tail -1)
  DUR=$(grep -E "^ *Duration" "$LOG" | tail -1)
  DISK=$(df -P /opt/homebrew/var/aihr-pg16-ram 2>/dev/null | awk 'NR==2{print $5}')
  SECS=$(( $(date +%s) - t0 ))
  DB_SECS=$((DB_SECS + SECS))
  echo "  exit=$RC  peak-disk=${DISK:-n/a}  wall=${SECS}s (rebuild+migrate+vitest)"
  echo "  $LINE"
  echo "  $TESTS"
  echo "  $DUR"
  SUMMARY+=("chunk $((c + 1)): exit=$RC ${LINE:-<no summary>}")
  RAN=$((RAN + 1))
  [ -n "$COUNTED" ] && COUNTED_TOTAL=$((COUNTED_TOTAL + COUNTED))
  [ "$RC" != "0" ] && FAILED=1
done
fi

WALL=$(( $(date +%s) - T_START ))
echo
echo "════ FINAL ════"
for s in "${SUMMARY[@]}"; do echo "  $s"; done
echo "  runs: $RAN   files counted: $COUNTED_TOTAL of $TOTAL in the suite (${#NODB[@]} no-DB + $DBTOTAL DB)"
echo "  wall: ${WALL}s  (part a ${NODB_SECS}s, part b ${DB_SECS}s)"
if [ "$PARTIAL" != "1" ] && [ "$COUNTED_TOTAL" != "$TOTAL" ]; then
  echo "  ✗ COUNTED $COUNTED_TOTAL OF $TOTAL — the two parts did not run the whole suite"
  FAILED=1
fi
if [ "$FAILED" != "0" ]; then
  echo "  GATE RED — read the logs in $OUT (nodb.log, chunkN.log)"
elif [ "$PROOF" = "1" ]; then
  echo "  PROOF GREEN — all ${#NODB[@]} no-DB files passed with no Postgres reachable. THIS IS NOT A GATE."
elif [ "$PARTIAL" = "1" ]; then
  echo "  SLICE GREEN — chunks $CHUNK_FROM..$CHUNK_TO of $CHUNKS. THIS IS NOT A GATE."
  echo "  The gate is green only when every slice reported exit 0 and the counted files sum to $TOTAL."
else
  echo "  GATE GREEN across part (a) and all $CHUNKS chunks of part (b)"
fi

# ── the receipt (read by scripts/improve/release.ts) ──────────────────────────────────────────────────
if [ "$PARTIAL" = "1" ]; then
  echo "  receipt: none written (a slice or a proof run is not a gate)"
elif [ -n "$DIRTY_AT_START" ] || [ "$(git rev-parse HEAD)" != "$HEAD_AT_START" ]; then
  echo "  receipt: none written — the tree was dirty or HEAD moved, so no commit is what was tested"
else
  RESULT=PASS; [ "$FAILED" != "0" ] && RESULT=FAIL
  node -e '
    const [sha, result, files, total, nodb, db, chunks, wall, a, b, load, branch] = process.argv.slice(1);
    require("node:fs").writeFileSync(".gate-receipt.json", JSON.stringify({
      sha, result, tier: "full", files: Number(files), suiteFiles: Number(total),
      nodbFiles: Number(nodb), dbFiles: Number(db), chunks: Number(chunks),
      wallSeconds: Number(wall), nodbSeconds: Number(a), dbSeconds: Number(b),
      loadAverageAtStart: load, branch, at: new Date().toISOString(),
    }, null, 2) + "\n");
  ' "$HEAD_AT_START" "$RESULT" "$COUNTED_TOTAL" "$TOTAL" "${#NODB[@]}" "$DBTOTAL" "$CHUNKS" "$WALL" \
    "$NODB_SECS" "$DB_SECS" "$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | xargs)" "$(git branch --show-current)"
  echo "  receipt: .gate-receipt.json  result=$RESULT tier=full sha=$(git rev-parse --short HEAD)"
fi
exit "$FAILED"
