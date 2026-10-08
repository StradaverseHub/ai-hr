#!/usr/bin/env bash
# r417 (ADR-0094) — THE AFFECTED TIER: gate a presentational-only diff in minutes instead of ~25.
#
#   bash scripts/gate-affected.sh [BASE] > /tmp/aihr-gate-affected.log 2>&1
#
# BASE defaults to the commit PRODUCTION RUNS: built_ref from the box's own deploy-state.sh (read-only),
# falling back to `main` when the box cannot be asked or the ref is not in this repo. The diff judged is
# `git diff BASE...HEAD`. A tree with uncommitted or untracked changes is refused — the receipt names a
# commit, so what is tested must BE that commit.
#
# 1. CLASSIFY (no lock, seconds). scripts/gate-tier.ts decides, file by file, whether the diff is
#    presentational or docs. If any file is not: it prints FULL GATE REQUIRED with every reason and exits
#    3. Run the full gate (scripts/gate-chunked.sh) instead — there is no override.
# 2. PLAN (under both test-lock slots). scripts/gate-affected-plan.ts builds the set:
#      (i) `vitest related` over the changed source files, (ii) every test whose source text names a
#      changed file, (iii) the repo-sweeping guards (-guard / -drift / pack-drift and a fixed list),
#      plus the changed tests themselves — then splits it no-DB / DB with scripts/gate-db-classify.ts.
# 3. RUN. The no-DB files through vitest.nodb.config.ts with every database URL on a closed port; the DB
#    files after ONE cluster rebuild + migrate; and (iv) `pnpm test:browser` when a .tsx or .css changed.
#    Each run asserts vitest COUNTED what it was asked for.
# 4. RECEIPT. Green → .gate-receipt.json {result: PASS, tier: "affected", sha, base, changed, run, counts}.
#    Red → nothing is written (and any older receipt is left alone: it names a different sha, or the
#    same sha's full-gate result, and release.ts checks the sha).
#
# What this tier cannot catch is in ADR-0094. The short version: it is only allowed when nothing outside
# components/, screen markup, CSS, messages, docs, tests and public assets changed — lib/, core/, packs/,
# db/, actions, routes, scripts and config all force FULL, so behaviour reached through them is never
# "affected-gated".
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=scripts/gate-lib.sh
. scripts/gate-lib.sh
gate_export_locale
OUT="${GATE_OUT:-/tmp/aihr-gate-affected}"
mkdir -p "$OUT"
HOST="${IMPROVE_SSH_HOST:-203.142.6.241}"
PORT="${IMPROVE_SSH_PORT:-8288}"

if [ -z "${AIHR_AFFECTED_STAGE:-}" ]; then
  # ── stage 1: classify, unlocked ──────────────────────────────────────────────────────────────────────
  echo "▸ tree: $(pwd)  branch: $(git branch --show-current)  head: $(git rev-parse --short HEAD)"
  gate_print_load
  if [ -n "$(git status --porcelain)" ]; then
    echo "✗ REFUSED — uncommitted or untracked changes. Commit them (a WIP commit is fine) and re-run:"
    git status --porcelain | head -20 | sed 's/^/    /'
    exit 2
  fi

  BASE="${1:-}"
  BASE_SOURCE=argument
  if [ -z "$BASE" ]; then
    STATUS=$(ssh -p "$PORT" -o BatchMode=yes -o ConnectTimeout=12 "ubuntu@$HOST" \
      'cd /opt/ai-hr && deploy/deploy-state.sh status' 2>/dev/null)
    DEPLOYED=$(printf '%s\n' "$STATUS" | sed -n 's/^built_ref=//p' | head -1)
    if [ -n "$DEPLOYED" ] && [ "$DEPLOYED" != "-" ] && git cat-file -e "${DEPLOYED}^{commit}" 2>/dev/null; then
      BASE="$DEPLOYED"; BASE_SOURCE="deployed (built_ref on $HOST)"
    else
      BASE=main; BASE_SOURCE="main (could not read a usable built_ref from $HOST: '${DEPLOYED:-no answer}')"
    fi
  fi
  echo "▸ base: $BASE  — $BASE_SOURCE"

  node --import tsx scripts/gate-tier-git.ts "$BASE" --json "$OUT/changed.json"
  RC=$?
  if [ "$RC" = "3" ]; then
    echo; echo "FULL GATE REQUIRED — run scripts/gate-chunked.sh (CLAUDE.md §4). Nothing was tested."; exit 3
  elif [ "$RC" != "0" ]; then
    echo; echo "FULL GATE REQUIRED — the diff could not be classified (exit $RC). Nothing was tested."; exit 3
  fi

  export AIHR_AFFECTED_STAGE=locked AIHR_AFFECTED_BASE="$BASE" AIHR_AFFECTED_BASE_SOURCE="$BASE_SOURCE"
  export AIHR_AFFECTED_HEAD="$(git rev-parse HEAD)" AIHR_AFFECTED_T0="$(date +%s)"
  gate_hold_both_slots "$SCRIPT"   # re-execs this script under the nested lock unless already held
fi

# ── stage 2: plan and run, under both test-lock slots ──────────────────────────────────────────────────
BASE="$AIHR_AFFECTED_BASE"
if [ "$(git rev-parse HEAD)" != "$AIHR_AFFECTED_HEAD" ] || [ -n "$(git status --porcelain)" ]; then
  echo "✗ REFUSED — HEAD moved or the tree changed while waiting for the lock. Re-run."; exit 2
fi

node --import tsx scripts/gate-affected-plan.ts "$OUT/changed.json" "$OUT/plan.json" || {
  echo "✗ could not build the affected set — GATE RED"; exit 1; }
list() { node -e 'const p=require(process.argv[1]); for (const f of p[process.argv[2]]) console.log(f)' "$OUT/plan.json" "$1"; }
NODB=(); while IFS= read -r f; do [ -n "$f" ] && NODB+=("$f"); done < <(list nodb)
DBF=();  while IFS= read -r f; do [ -n "$f" ] && DBF+=("$f");  done < <(list db)
BROWSER=$(node -e 'console.log(require(process.argv[1]).browser ? 1 : 0)' "$OUT/plan.json")

FAILED=0
COUNTED_TOTAL=0
declare -a SUMMARY
check_counted() { # <log> <asked>  → LINE, COUNTED, RC=1 on mismatch
  LINE=$(grep -E "^ *Test Files" "$1" | tail -1)
  COUNTED=$(echo "$LINE" | grep -oE '\([0-9]+\)$' | tr -d '()')
  if [ -z "$COUNTED" ] || [ "$COUNTED" != "$2" ]; then
    echo "  ⚠️  ASKED FOR $2 FILES, VITEST COUNTED ${COUNTED:-NOTHING} — RED however the numbers read."
    RC=1
  fi
}

if [ "${#NODB[@]}" -gt 0 ]; then
  echo; echo "════ no-DB: ${#NODB[@]} files, DB URLs on a closed port ════"
  CLOSED="postgres://nobody:nothing@127.0.0.1:1/no_database_here"
  env TEST_DATABASE_URL="$CLOSED" TEST_MIGRATION_DATABASE_URL="$CLOSED" \
    DATABASE_URL="$CLOSED" MIGRATION_DATABASE_URL="$CLOSED" \
    VITEST_MAX_WORKERS_NODB="${VITEST_MAX_WORKERS_NODB:-6}" \
    pnpm vitest run --config vitest.nodb.config.ts "${NODB[@]}" > "$OUT/nodb.log" 2>&1
  RC=$?
  check_counted "$OUT/nodb.log" "${#NODB[@]}"
  echo "  exit=$RC  $LINE"; echo "  $(grep -E '^ *Tests ' "$OUT/nodb.log" | tail -1)"
  SUMMARY+=("no-DB: exit=$RC ${LINE:-<no summary>}")
  [ -n "$COUNTED" ] && COUNTED_TOTAL=$((COUNTED_TOTAL + COUNTED))
  [ "$RC" != "0" ] && FAILED=1
fi

if [ "${#DBF[@]}" -gt 0 ]; then
  echo; echo "════ DB: ${#DBF[@]} files, after ONE cluster rebuild ════"
  bash scripts/dev-db-rebuild.sh > "$OUT/rebuild.log" 2>&1 || { echo "  cluster rebuild FAILED — see $OUT/rebuild.log"; exit 1; }
  pnpm db:migrate > "$OUT/migrate.log" 2>&1 || { echo "  migrate FAILED — see $OUT/migrate.log"; exit 1; }
  VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-4}" pnpm vitest run "${DBF[@]}" > "$OUT/db.log" 2>&1
  RC=$?
  check_counted "$OUT/db.log" "${#DBF[@]}"
  echo "  exit=$RC  $LINE"; echo "  $(grep -E '^ *Tests ' "$OUT/db.log" | tail -1)"
  SUMMARY+=("DB: exit=$RC ${LINE:-<no summary>}")
  [ -n "$COUNTED" ] && COUNTED_TOTAL=$((COUNTED_TOTAL + COUNTED))
  [ "$RC" != "0" ] && FAILED=1
fi

BROWSER_COUNTED=0
if [ "$BROWSER" = "1" ]; then
  NB=$(find test -type f -name '*.browser.test.tsx' | wc -l | tr -d ' ')
  echo; echo "════ browser: pnpm test:browser ($NB files) — a .tsx or .css file changed ════"
  pnpm test:browser > "$OUT/browser.log" 2>&1
  RC=$?
  check_counted "$OUT/browser.log" "$NB"
  echo "  exit=$RC  $LINE"
  SUMMARY+=("browser: exit=$RC ${LINE:-<no summary>}")
  BROWSER_COUNTED="${COUNTED:-0}"
  [ "$RC" != "0" ] && FAILED=1
fi

ASKED=$(( ${#NODB[@]} + ${#DBF[@]} ))
WALL=$(( $(date +%s) - AIHR_AFFECTED_T0 ))
echo; echo "════ FINAL (affected tier, base ${BASE:0:12}) ════"
for s in "${SUMMARY[@]}"; do echo "  $s"; done
echo "  files counted: $COUNTED_TOTAL of $ASKED in the affected set  (+ $BROWSER_COUNTED browser)   wall: ${WALL}s"
[ "$COUNTED_TOTAL" != "$ASKED" ] && FAILED=1
if [ "$FAILED" != "0" ]; then
  echo "  GATE RED (affected tier) — read the logs in $OUT. No receipt written."
  exit 1
fi
echo "  GATE GREEN (affected tier)"

node -e '
  const fs = require("node:fs");
  const [planFile, changedFile, sha, base, baseSource, counted, browser, wall] = process.argv.slice(1);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const changed = JSON.parse(fs.readFileSync(changedFile, "utf8"));
  fs.writeFileSync(".gate-receipt.json", JSON.stringify({
    sha, result: "PASS", tier: "affected", base, baseSource,
    changed: changed.files.map((f) => f.path),
    run: plan.run, browserProject: plan.browser,
    counts: { files: Number(counted), nodb: plan.nodb.length, db: plan.db.length, related: plan.related.length,
              sourceMentions: plan.grepped.length, guards: plan.guards.length, browserFiles: Number(browser) },
    wallSeconds: Number(wall), at: new Date().toISOString(),
  }, null, 2) + "\n");
' "$OUT/plan.json" "$OUT/changed.json" "$AIHR_AFFECTED_HEAD" "$BASE" "$AIHR_AFFECTED_BASE_SOURCE" \
  "$COUNTED_TOTAL" "$BROWSER_COUNTED" "$WALL"
echo "  receipt: .gate-receipt.json  result=PASS tier=affected sha=${AIHR_AFFECTED_HEAD:0:7} base=${BASE:0:12}"
exit 0
