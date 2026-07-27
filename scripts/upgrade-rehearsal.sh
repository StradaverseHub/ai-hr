#!/usr/bin/env bash
# Upgrade rehearsal — apply a release to a database that already has a customer's data in it.
#
# WHY THIS EXISTS
# ---------------
# Every other gate in this repo tests the INSTALL, never the UPGRADE. The vitest template is built
# schema-only ("no seed data" — test/global-setup.ts) and every one of the ~4,800 tests starts from
# empty tables; cleanroom-verify.sh likewise migrates an EMPTY database 0000 -> latest and then runs
# the suite. So the entire migration chain has only ever been exercised against emptiness.
#
# That is the wrong shape for a multi-tenant product with live customers. The failures that matter on
# deploy day are the ones emptiness cannot produce: a NOT NULL column added to a table that already
# has rows, a unique index that collides with data already present, a backfill that claims to grant
# every tenant an entitlement and silently misses the ones created since the last release. Those are
# exactly the changes the recent releases have been making — 0313 adds entitlement tables AND
# backfills them for existing tenants.
#
# This script rehearses that: build a database at the LAST RELEASED code, populate it the way a
# customer's database is populated, then apply the new release's migrations and backfills on top and
# check the customer's data survived.
#
# HOW THE BASELINE IS BUILT, AND WHY IT USES A SECOND WORKTREE
# ------------------------------------------------------------
# Populating an OLD schema with NEW code does not work — today's seed writes columns that did not
# exist at the baseline. So the baseline database is built by the BASELINE's own code, from the
# worktree that already exists for that release, and only then does HEAD's migrator touch it. That
# keeps the rehearsal honest: nothing from the new release participates until the upgrade step.
#
# WHAT IT DELIBERATELY DOES NOT DO
# --------------------------------
# It does not copy production data. A dump would be the most faithful rehearsal, but this is an HR
# product: a production dump is real people's salaries, bank accounts and identity numbers, and
# pulling that onto a developer laptop is a PDPA problem, not a testing convenience. The synthetic
# tenant below is shaped like a customer without being one. If you ever do want to rehearse against
# real data, do it on the server, against a sanitised copy, deliberately — not as a side effect of
# running a script.
#
# USAGE
#   scripts/upgrade-rehearsal.sh [baseline-ref] [scratch-db-name]
#     baseline-ref  git ref of the last RELEASED code (default: build/r70)
#     scratch-db    database to build and destroy (default: ai_hr_upgrade_rehearsal)
#
# Exit code 0 = the upgrade applied and every invariant held. Non-zero = do not deploy.
set -uo pipefail

BASELINE_REF="${1:-build/r70}"
SCRATCH="${2:-ai_hr_upgrade_rehearsal}"
PGHOST=127.0.0.1; PGPORT=5433; SUPER=postgres
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0

say() { printf '\n== %s\n' "$1"; }
fail() { printf '   FAIL: %s\n' "$1"; FAILED=1; }
ok()   { printf '   ok: %s\n' "$1"; }

psql_scratch() { psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d "$SCRATCH" -tAc "$1" 2>/dev/null; }

# The baseline worktree: the release we are upgrading FROM. Must already exist — this script does not
# create worktrees, because guessing which checkout is safe to reuse is how you clobber someone's work.
BASELINE_WT=""
while read -r path _ branch; do
  [ "$branch" = "[${BASELINE_REF}]" ] && BASELINE_WT="$path"
done < <(git -C "$ROOT" worktree list)
if [ -z "$BASELINE_WT" ]; then
  echo "No worktree checked out at $BASELINE_REF."
  echo "Create one first:  git worktree add .claude/worktrees/<name> $BASELINE_REF"
  exit 2
fi

say "rehearsing upgrade: $BASELINE_REF  ->  $(git -C "$ROOT" rev-parse --short HEAD)"
echo "   baseline worktree: $BASELINE_WT"
echo "   scratch database:  $SCRATCH"

# ── 1. A database at the BASELINE release ────────────────────────────────────────────────────────
say "1/6  building the baseline database"
psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d postgres -q \
  -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" -c "CREATE DATABASE \"$SCRATCH\"" || exit 1

# Grants the app role needs, mirroring deploy/bootstrap-db.sql, so the seed and the app can connect.
psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d "$SCRATCH" -q \
  -c "GRANT CONNECT ON DATABASE \"$SCRATCH\" TO ai_hr_app" 2>/dev/null

ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT
{
  grep -vE '^(DATABASE_URL|MIGRATION_DATABASE_URL)=' "$ROOT/.env.local" 2>/dev/null
  echo "DATABASE_URL=postgres://$SUPER@$PGHOST:$PGPORT/$SCRATCH"
  echo "MIGRATION_DATABASE_URL=postgres://$SUPER@$PGHOST:$PGPORT/$SCRATCH"
} > "$ENVFILE"

# Migrate + seed with the BASELINE's own code. Nothing from the new release runs yet.
( cd "$BASELINE_WT" && cp "$ENVFILE" .env.rehearsal \
  && DATABASE_URL="postgres://$SUPER@$PGHOST:$PGPORT/$SCRATCH" \
     MIGRATION_DATABASE_URL="postgres://$SUPER@$PGHOST:$PGPORT/$SCRATCH" \
     pnpm exec drizzle-kit migrate >/dev/null 2>&1 ) \
  && ok "baseline migrations applied" || { fail "baseline migrations"; exit 1; }

say "2/6  populating it like a customer's database"
( cd "$BASELINE_WT" && node --env-file=.env.rehearsal --import tsx db/seed.ts >/dev/null 2>&1 ) \
  && ok "baseline seed applied" || fail "baseline seed (continuing — some assertions will be weaker)"

# ── 3. Snapshot what the customer has, BEFORE the upgrade ────────────────────────────────────────
say "3/6  recording the customer's data before the upgrade"
BEFORE_TENANTS=$(psql_scratch "SELECT count(*) FROM tenant")
BEFORE_EMPLOYMENTS=$(psql_scratch "SELECT count(*) FROM employment")
BEFORE_PAYSLIPS=$(psql_scratch "SELECT count(*) FROM payslip")
BEFORE_LEDGER=$(psql_scratch "SELECT coalesce(sum(days),0) FROM leave_ledger")
BEFORE_EVENTS=$(psql_scratch "SELECT count(*) FROM domain_event")
echo "   tenants=$BEFORE_TENANTS employments=$BEFORE_EMPLOYMENTS payslips=$BEFORE_PAYSLIPS leaveDays=$BEFORE_LEDGER events=$BEFORE_EVENTS"
[ "${BEFORE_TENANTS:-0}" -gt 0 ] || fail "baseline database is empty — the rehearsal would prove nothing"

# ── 4. THE UPGRADE — the new release's migrations over populated data ────────────────────────────
say "4/6  applying the new release's migrations"
MIG_OUT=$( cd "$ROOT" && DATABASE_URL="postgres://$SUPER@$PGHOST:$PGPORT/$SCRATCH" \
  MIGRATION_DATABASE_URL="postgres://$SUPER@$PGHOST:$PGPORT/$SCRATCH" \
  pnpm exec drizzle-kit migrate 2>&1 )
if [ $? -eq 0 ]; then ok "migrations applied over populated data"; else fail "MIGRATION FAILED on populated data"; echo "$MIG_OUT" | tail -20; fi

say "5/6  running the release's backfills"
BF_OUT=$( cd "$ROOT" && node --env-file="$ENVFILE" --import tsx scripts/seed-catalogs.ts 2>&1 )
if [ $? -eq 0 ]; then ok "seed-catalogs"; else fail "seed-catalogs"; echo "$BF_OUT" | tail -10; fi

# ── 6. Did the customer's data survive, and did the backfill actually cover them? ────────────────
say "6/6  checking the customer's data survived"
for pair in "tenant:$BEFORE_TENANTS" "employment:$BEFORE_EMPLOYMENTS" "payslip:$BEFORE_PAYSLIPS" "domain_event:$BEFORE_EVENTS"; do
  tbl="${pair%%:*}"; before="${pair##*:}"
  after=$(psql_scratch "SELECT count(*) FROM $tbl")
  # Rows may be ADDED by a backfill; they must never be LOST. An upgrade that deletes a customer's
  # payslips is the failure this whole script exists to catch, so the comparison is one-directional.
  if [ "${after:-0}" -ge "${before:-0}" ]; then ok "$tbl kept its rows ($before -> $after)"
  else fail "$tbl LOST ROWS ($before -> $after)"; fi
done

AFTER_LEDGER=$(psql_scratch "SELECT coalesce(sum(days),0) FROM leave_ledger")
if [ "$BEFORE_LEDGER" = "$AFTER_LEDGER" ]; then ok "leave balances unchanged ($BEFORE_LEDGER)"
else fail "leave balances CHANGED by the upgrade ($BEFORE_LEDGER -> $AFTER_LEDGER)"; fi

# The backfill assertion that matters: ADR-0077 C5 says a backfill guarding an invariant stays in
# deploy.sh permanently as a per-deploy check. This is that check, run before the deploy rather than
# during it — every pre-existing tenant must come out the far side entitled, or the release silently
# switches paid modules off for customers who had them.
if psql_scratch "SELECT to_regclass('public.tenant_module')" | grep -q tenant_module; then
  ORPHANS=$(psql_scratch "SELECT count(*) FROM tenant t WHERE NOT EXISTS (SELECT 1 FROM tenant_module m WHERE m.tenant_id = t.id)")
  if [ "${ORPHANS:-1}" -eq 0 ]; then ok "every pre-existing tenant has entitlement rows"
  else fail "$ORPHANS tenant(s) came out of the upgrade with NO entitlement rows"; fi

  CATALOG=$(psql_scratch "SELECT count(*) FROM module")
  [ "${CATALOG:-0}" -gt 0 ] && ok "module catalog seeded ($CATALOG rows)" || fail "module catalog is EMPTY after upgrade"
fi

say "result"
if [ "$FAILED" -eq 0 ]; then
  echo "   UPGRADE_REHEARSAL=PASS — this release applies to a populated customer database."
  psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d postgres -q -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)"
  rm -f "$BASELINE_WT/.env.rehearsal"
else
  echo "   UPGRADE_REHEARSAL=FAIL — do not deploy."
  echo "   Scratch database \"$SCRATCH\" KEPT for inspection; drop it when done."
fi
exit "$FAILED"
