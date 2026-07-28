#!/usr/bin/env bash
# AI HR — build, migrate, (first-time) seed, and restart the gated demo. Re-run any time to deploy an
# update. Pass --reseed to wipe + reseed the demo data (destroys tester changes), or --migrate-only to
# stop after the migrations + catalog seed without seeding demo data or restarting. See deploy/DEPLOY.md.
set -euo pipefail
cd "$(dirname "$0")/.."

# ARGUMENTS, parsed rather than positional. `--migrate-only` exists because DEPLOY.md has always told
# the operator to run the ADR-0077 slice-3 parity reconciliation "after migrate, before restarting the
# service, in the same window" — and until this flag there was no way to do that (review r3). This is a
# single `set -e` script that runs install → chain check → build → migrate → seed → restart with no stop
# point, so the achievable sequence was migrate-AND-restart, then reconcile: a window in which every
# tenant created after 0313 is live on slice-3 code with typed_pay_components / multi_cycle_payroll /
# notifications resolving OFF. A payroll run in that window produces different numbers with no error,
# which is the exact harm the reconciliation exists to prevent.
RESEED=0
MIGRATE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --reseed) RESEED=1 ;;
    --migrate-only) MIGRATE_ONLY=1 ;;
    *) echo "✗ Unknown argument: $arg (expected --reseed and/or --migrate-only)"; exit 1 ;;
  esac
done

# Use the isolated Node toolchain if present (keeps the host's system Node untouched, and means
# pnpm/node are found even when /opt/node20/bin isn't on the invoking shell's PATH).
[ -d /opt/node20/bin ] && export PATH="/opt/node20/bin:$PATH"

# deploy/.env.production.example, NOT .env.example. The pointer was changed to .env.example during the
# ADR-0077 slice-3 remediation and that was a regression: .env.example is the DEVELOPER template — it
# carries a superuser MIGRATION_DATABASE_URL against ai_hr_dev, TEST_* URLs, no SHARE_PASSWORD, and it
# ships MULTI_CYCLE_PAYROLL_ENABLED / TYPED_PAY_COMPONENTS_ENABLED / PAYROLL_RESET_ENABLED /
# PAYROLL_UNLOCK_ENABLED all active and true. A .env.production built from it, run through the parity
# reconciliation DEPLOY.md prescribes, would hand every customer two payroll risk switches that
# 0313's tenant_setting_write policy then makes ai_hr_app unable to close.
[ -f .env.production ] || { echo "✗ Missing .env.production — copy deploy/.env.production.example, fill it in, and re-run."; exit 1; }
# Load the production env so db:migrate (MIGRATION_DATABASE_URL) and the seed pick it up.
set -a; . ./.env.production; set +a
: "${MIGRATION_DATABASE_URL:?set in .env.production}"; : "${DEV_TENANT_ID:?set in .env.production}"

# Skip the install when the lockfile hasn't moved since the last successful install. node_modules is
# rsync-excluded (it persists across deploys), so on a code-only update — the common case — reinstalling
# is pure overhead. We hash pnpm-lock.yaml and stash it INSIDE node_modules (also rsync-excluded, so the
# marker survives), then reinstall only when the hash differs or node_modules is gone. --prod=false: the
# build, drizzle-kit (migrate) and tsx (seed) are devDependencies a NODE_ENV=production install would skip.
LOCK_HASH="$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)"
LOCK_MARKER="node_modules/.deploy-lockfile-sha"
if [ -d node_modules ] && [ "$(cat "$LOCK_MARKER" 2>/dev/null)" = "$LOCK_HASH" ]; then
  echo "▸ Dependencies unchanged (lockfile hash matches) — skipping install."
else
  echo "▸ Installing dependencies…"
  pnpm install --frozen-lockfile --prod=false
  echo "$LOCK_HASH" > "$LOCK_MARKER"
fi

# ADR-0030 / ADR-0077 slice 3 — BLOCKING, and deliberately BEFORE the build. Slice 3 changed
# AUDIT_HASH_CHAIN_ENABLED from a truthiness test to `=== 'true'`, which is correct and which DISARMS
# the chain on every box that copied .env.example's active `=false` line (the string 'false' is truthy).
# Disarming is not something verifyTenantChain() can report — it only inspects rows that carry chain
# columns — so the log would go on rendering "intact" over an unverifiable window. This compares the env
# against what the database actually holds and exits non-zero if they disagree. `set -e` stops the deploy.
#
# ORDER MATTERS. It used to sit after build + migrate + catalog-seed, so a refusal left the box serving
# the OLD code against a MIGRATED schema — a half-applied state nothing rolls back, recoverable only by
# editing .env.production over SSH. The check needs an env file and a database connection and nothing
# else, so running it here makes a refusal free: nothing has been touched yet. It sits after the install
# only because `node --import tsx` needs node_modules.
echo "▸ Checking the audit hash-chain gate against the database…"
node --env-file=.env.production --import tsx scripts/check-audit-chain-gate.ts

echo "▸ Building production server…"
# Heap headroom for `next build`'s TypeScript pass. Node's default old-space cap (~2 GB on this box) was
# hit on 2026-07-21 deploying R52: compilation succeeded, then the build died with "Ineffective
# mark-compacts near heap limit" partway through "Running TypeScript" at ~1.95 GB. Nothing was wrong with
# the code — tsc --noEmit passes locally and in the clean-room gate; the project simply outgrew the
# default. deploy.sh runs in an SSH session, NOT under aihr.service's cgroup, so that unit's MemoryMax
# does not apply here; the box has ~3 GB free plus swap. If this OOMs again, raise the number rather than
# setting typescript.ignoreBuildErrors — the build's type pass catches RSC client/server boundary errors
# that tsc alone does not.
NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=3072" pnpm build

echo "▸ Applying database migrations (as ai_hr_owner)…"
pnpm db:migrate

# ADR-0077 C11 — UNCONDITIONAL, and deliberately above the demo-seed `if` below: that branch is skipped
# on every normal update, so seeding the catalogs inside it would leave an updated deployment with an
# empty module catalog and every entitlement lookup failing closed. Idempotent (ON CONFLICT DO UPDATE).
echo "▸ Seeding module + setting catalogs…"
node --env-file=.env.production --import tsx scripts/seed-catalogs.ts

# 0318 — seed feedback_plan_revision from what survived. Idempotent (ON CONFLICT DO NOTHING), so it
# stays here permanently rather than being a one-shot: a deploy that adds the table to a database it has
# not run against yet must still populate it. It PRINTS how many earlier plan versions it could not
# recover, so the gap is reported on every deploy instead of being discovered by a confused reporter.
echo "▸ Seeding feedback plan history…"
node --env-file=.env.production --import tsx scripts/backfill-plan-history.ts

# ADR-0077 slice 3 — ENTITLEMENT PARITY IS NOT CHECKED HERE, DELIBERATELY. A blocking
# `reconcile-entitlement-parity.ts --preflight` sat at this line and had to come out (review r2): it
# could never reach a clean state, and both of its escapes were worse than the thing it guarded.
#
# `packs/catalog.ts` gives every catalogued setting `defaultOnInstall: false` alongside
# `defaultValue: false`, and `settingsOnInstallFor` emits a row only when those two DIFFER — so
# `db/provision.ts` writes ZERO `tenant_setting` rows for a new tenant, on purpose and after a long
# argument recorded at that call site. Meanwhile `deploy/enable-demo-flags.sh` sets PAYROLL_RESET_ENABLED,
# PAYROLL_UNLOCK_ENABLED and INDIVIDUAL_TXN_PAY_ENABLED true on this box, so the preflight counted every
# tenant created after 0313 as three setting rows short — permanently, and by design rather than by
# accident. The FIRST customer provisioned after this deploy would therefore have blocked every deploy
# after it, and the two ways out were to run `--apply` (which writes `payroll.reset_enabled=true` and
# `payroll.unlock_enabled=true` for a brand-new tenant — `scope='platform'` rows that 0313's
# `tenant_setting_write` policy makes `ai_hr_app` unable to close again, i.e. exactly the over-grant
# provision.ts refuses) or to set ENTITLEMENT_PARITY_ACKNOWLEDGED=true and disable the check forever.
#
# The deeper reason is that the script is not a gate-shaped thing at all. Its own header says it cannot
# tell "this tenant predates the row" from "the operator deliberately left this module unticked", and its
# plan asks a human to read the list against the customer records before applying. A check whose only
# correct resolution is human sign-off cannot be an automated `set -e` gate. It is a one-shot for the
# slice-3 maintenance window, run by hand, and deploy/DEPLOY.md documents it there — which is also what
# DEPLOY.md said while this line contradicted it. `--preflight` still exists for an operator who wants a
# scripted "did I finish?" after `--apply`.

# THE STOP POINT the reconciliation needs. Everything the script writes has a foreign key into the
# catalogs seeded immediately above, and nothing below this line has run — so the database is migrated,
# the catalogs are present, and the service is still serving the OLD code. That is precisely the state
# DEPLOY.md's "after migrate, before restarting the service" describes. The command to run here is in
# deploy/DEPLOY.md rather than echoed: it takes a --created-before date only the operator knows, and
# reproducing it here would make this script look like it runs the reconciliation, which it must not.
if [ "$MIGRATE_ONLY" = "1" ]; then
  echo ""
  echo "⏸  --migrate-only: stopped after migrate + catalog seed. The service is NOT restarted and is"
  echo "    still serving the previous build."
  echo "    Run the ADR-0077 slice-3 entitlement-parity reconciliation now — deploy/DEPLOY.md,"
  echo "    'ONE-SHOT: entitlement parity' — then finish with:  ./deploy/deploy.sh"
  exit 0
fi

# Seed only if the demo tenant is absent, so updates preserve whatever the consultant has been testing.
if [ "$RESEED" = "1" ] || ! psql "$MIGRATION_DATABASE_URL" -tAc "SELECT 1 FROM tenant WHERE id='$DEV_TENANT_ID'" 2>/dev/null | grep -q 1; then
  echo "▸ Seeding demo data…"
  node --env-file=.env.production --import tsx db/seed.ts
else
  echo "▸ Demo data already present — skipping seed (use './deploy/deploy.sh --reseed' to reset)."
fi

echo "▸ Restarting service…"
# Detect the unit directly. The old `list-unit-files | grep -q` form was fragile (under set -o
# pipefail a SIGPIPE from the producer can flip the result); `systemctl cat` is a clean exit-code check.
if systemctl cat aihr.service >/dev/null 2>&1; then
  # `sudo -n` (non-interactive) so an automated deploy never blocks on a password prompt: it succeeds
  # when the NOPASSWD rule (deploy/aihr-sudoers) is installed, else it falls through to a manual hint.
  if sudo -n systemctl restart aihr 2>/dev/null; then
    echo "✅ Deployed + restarted. Logs: journalctl -u aihr -f"
  else
    echo "⚠️  Build + migrations are done, but restarting the service needs privileges this shell lacks."
    echo "    Finish with:  sudo systemctl restart aihr"
    echo "    (or install deploy/aihr-sudoers once for passwordless restarts — see DEPLOY.md)"
  fi
else
  echo "ℹ️  No 'aihr' systemd service yet — install deploy/aihr.service (see DEPLOY.md), or run manually:"
  echo "     pnpm exec next start -H 0.0.0.0 -p \${PORT:-3000}"
fi
