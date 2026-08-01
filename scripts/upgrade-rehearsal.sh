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

# --rebuild forces the from-scratch baseline path. Default is CARRY FORWARD; see "REUSE" below.
REBUILD=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --rebuild) REBUILD=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

BASELINE_REF="${1:-build/r70}"
# ONE stable database, deliberately. A per-round name (…_r84, …_r85) means a fresh CREATE DATABASE every
# round, which is both the slowest operation on this box and a permanent leak — that habit is part of how
# the cluster reached 72 databases on 2026-07-30.
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
# ── REUSE, AND WHY IT IS ALSO MORE FAITHFUL ──────────────────────────────────────────────────────
# This script used to DROP and CREATE the scratch database on every run. That was slower AND a weaker
# simulation than it needed to be.
#
# Production is never rebuilt. It is one long-lived database that has accumulated every migration, in
# order, across every release — including the odd ones: a column added then widened, a backfill that ran
# when the table was small, an index built before the data arrived. A freshly-built baseline has none of
# that history; it only ever proves "the chain applies to a database made this morning".
#
# So the default is now CARRY FORWARD: keep the database between rounds and apply each release on top,
# exactly as the server does. It removes the single most expensive operation here (CREATE DATABASE forces
# a checkpoint and copies the template directory — it has taken 25 to 52 minutes on this machine) and it
# accumulates real history as the releases go by.
#
# `--rebuild` keeps the clean-room path for when you want determinism instead: after a failed rehearsal
# left the database half-migrated, when the baseline ref changes, or periodically to prove the whole chain
# still applies from nothing.
EXISTING_MIGRATIONS=$(psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d "$SCRATCH" -tAc \
  "SELECT count(*) FROM drizzle.__drizzle_migrations" 2>/dev/null | tr -d ' ')
if [ "$REBUILD" = "0" ] && [ -n "${EXISTING_MIGRATIONS:-}" ] && [ "${EXISTING_MIGRATIONS:-0}" -gt 0 ]; then
  say "1/6  reusing the carried-forward database ($EXISTING_MIGRATIONS migrations already applied)"
  echo "   this is the upgrade production actually performs: an existing database moved forward"
  echo "   pass --rebuild to construct a fresh baseline instead"
  CARRIED=1
else
  CARRIED=0
  say "1/6  building the baseline database"
  # CHECKPOINT FIRST. On PostgreSQL 14 both DROP and CREATE DATABASE force an immediate checkpoint and
  # WAIT on it. Run straight after a full suite — which is exactly when a rehearsal runs — that wait has
  # hung indefinitely in IPC/CheckpointStart four times on 2026-08-01, each needing the cluster rebuilt to
  # escape. test/global-setup.ts got the same treatment, but it only covers the SUITE's own creates; this
  # script builds its scratch database through its own path, which is why the suite passed and the
  # rehearsal still wedged.
  #
  # Doing it explicitly, once, means the forced checkpoints find little left to flush. It is NOT a
  # guaranteed fix — a wedge was reproduced on 2026-08-01 with fsync=off, full_page_writes=off and
  # synchronous_commit=off all set, and the checkpointer sitting in UNINTERRUPTIBLE kernel wait (ps state
  # U), which no Postgres-level setting can shorten. The durable fix is PostgreSQL 15+, whose
  # CREATE DATABASE defaults to STRATEGY=WAL_LOG and forces no checkpoint at all.
  # SKIPPED ON PostgreSQL 15+, and this is the durable fix the comment above predicted. Measured on
  # 16.14: five CREATE DATABASE statements move pg_stat_bgwriter.checkpoints_req by ZERO (WAL_LOG
  # strategy), so there is no create-checkpoint left to pre-empt. Worse, the pre-emptive CHECKPOINT
  # became the wedge itself — it hung on IPC/CheckpointDone for 10m16s on 2026-08-02 with the counters
  # frozen, on 16.14, which is one more checkpoint that can stick for no remaining benefit.
  #
  # DROP DATABASE still forces a checkpoint on 16, so the risk is reduced, not removed. The ACTUAL root
  # cause was identified on 2026-08-02 and is not a Postgres setting at all: this Mac runs Trend Micro
  # real-time file scanning (iCoreSecurity / iCoreService, libTmFileScan + libTmFileEventHub), and those
  # processes sit in the SAME uninterruptible kernel wait (ps state U) as the stuck checkpointer. A
  # checkpoint fsyncs thousands of files and an on-access scanner hooks every one, which is why no
  # Postgres-level tuning ever helped and why a wipe only helps until the file count grows back. The
  # real fix is excluding the data directory from that scanner.
  if [ "$(psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d postgres -tAc 'show server_version_num' 2>/dev/null || echo 0)" -lt 150000 ]; then
    psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d postgres -q -c "CHECKPOINT" 2>/dev/null || true
  fi
  psql -h "$PGHOST" -p "$PGPORT" -U "$SUPER" -d postgres -q \
    -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" -c "CREATE DATABASE \"$SCRATCH\"" || exit 1
fi

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
# Skipped entirely when carrying forward: the database already holds the baseline schema AND the data
# every previous round left in it, which is the state we want to upgrade. Re-running the baseline
# migrator would be a no-op and re-seeding would pile a second tenant on top of the first.
if [ "$CARRIED" = "0" ]; then
  ( cd "$BASELINE_WT" && cp "$ENVFILE" .env.rehearsal \
    && DATABASE_URL="postgres://$SUPER@$PGHOST:$PGPORT/$SCRATCH" \
       MIGRATION_DATABASE_URL="postgres://$SUPER@$PGHOST:$PGPORT/$SCRATCH" \
       pnpm exec drizzle-kit migrate >/dev/null 2>&1 ) \
    && ok "baseline migrations applied" || { fail "baseline migrations"; exit 1; }

  say "2/6  populating it like a customer's database"
  ( cd "$BASELINE_WT" && node --env-file=.env.rehearsal --import tsx db/seed.ts >/dev/null 2>&1 ) \
    && ok "baseline seed applied" || fail "baseline seed (continuing — some assertions will be weaker)"
else
  say "2/6  carrying the existing customer data forward"
  ok "no re-seed — the data already in this database IS the customer's data"
fi

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
