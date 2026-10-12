#!/usr/bin/env bash
# AI HR — build, migrate, (first-time) seed, and restart. Re-run any time to deploy an update.
#
# TWO DEPLOYMENTS, ONE SPINE (r290 / readiness 1.1). install → chain check → build → migrate →
# catalog-seed → restart is identical for the gated consultant demo and for a customer, and keeping it
# in ONE script is the only way it stays identical: a forked customer copy would drift silently and the
# drift would be discovered by the customer. Exactly one thing differs — whether the DEMO SEEDER
# (db/seed.ts, which TRUNCATEs 24 tables and plants a fictional "Demo Group" tenant) may run.
#
#   customer:  ./deploy/deploy-customer.sh   (== ./deploy/deploy.sh --customer)
#              does not require DEV_TENANT_ID, never reaches db/seed.ts, refuses --reseed.
#   demo:      ./deploy/deploy.sh            (unchanged — this box's every-round command)
#              seeds only when .env.production says ALLOW_DEMO_SESSION=true.
#
# Before r290 there was no customer path at all: DEV_TENANT_ID was hard-required at the top and the
# seeder ran whenever that tenant row was ABSENT from the target database — which on a fresh customer
# database is always. Following DEPLOY.md on a customer box planted Demo Group in their production
# database on the first deploy.
#
# Flags: --reseed wipes + reseeds the demo data (destroys tester changes); --migrate-only stops after
# the migrations + catalog seed without seeding demo data or restarting; --customer / --demo select the
# mode explicitly. See deploy/DEPLOY.md.
set -euo pipefail
cd "$(dirname "$0")/.."

# ── r291 / readiness 7.1 — THIS DEPLOY REPORTS ON ITSELF ─────────────────────
#
# Everything below this block is unchanged. What is added is a record, in /var/tmp/aihr-deploy, of
# which deploy is running, how far it got, and how it ended — see deploy/deploy-state.sh for the
# state machine and why it lives outside the rsynced tree.
#
# THE TRAP IS INSTALLED HERE, ABOVE THE ARGUMENT PARSING AND EVERY PREFLIGHT, ON PURPOSE. By the time
# this script runs, `improve:release` has already rsynced new source over /opt/ai-hr. So a refusal at
# the `--reseed` check, at the missing-SHARE_PASSWORD line, or at `MIGRATION_DATABASE_URL` is not a
# no-op: it leaves new source on disk beside a `.next` built from the OLD source, which is exactly the
# mixed state readiness 7.1's third bullet is about. A trap installed after those checks would record
# nothing for any of them.
#
# THE VERDICT COMES FROM A FLAG, NOT FROM `$?`, AND THAT IS NOT A STYLE CHOICE.
#
# Installing an EXIT trap at all changes what this script returns after a `${VAR:?message}` expansion
# error. Measured on bash 3.2.57:
#
#     bash -c 'set -euo pipefail; : "${X:?nope}"'                        → 1
#     bash -c 'set -euo pipefail; trap "true" EXIT; : "${X:?nope}"'      → 0        ← !
#
# Every preflight in this script is that construct: SHARE_PASSWORD (readiness 1.4 — the line that stops
# an open, ungated HRIS from being published), MIGRATION_DATABASE_URL, DEV_TENANT_ID. A naive
# `trap 'rc=$?; …; exit $rc' EXIT` therefore turns all three refusals into a SUCCESSFUL deploy, which is
# a far worse defect than the one r291 set out to fix. Ordinary command failures (the Next build below
# running out of memory) do report correctly — it is only the expansion-error class that lies. Do not
# write the build's command line in a comment here: test/module-catalog-drift.test.ts locates it with
# a plain indexOf over this file to check the chain preflight runs first, and a prose mention above
# that line moves the match and breaks the ordering guard.
#
# So: AIHR_DEPLOY_COMPLETED is set to 1 at the script's two real end points and nowhere else, the trap
# believes the flag rather than `$?`, and a status of 0 with the flag unset is repaired to 1.
# test/r291-detached-deploy.test.ts pins all three refusals, by execution.
#
# `dstate` swallows every error. This is instrumentation on the deploy path and must never be the
# reason a deploy fails — a box with a read-only /var/tmp should still deploy, just unobservably.
AIHR_DEPLOY_REF="${AIHR_DEPLOY_REF:-unknown}"   # the source ref improve:release shipped, when known
AIHR_DEPLOY_LOG="${AIHR_DEPLOY_LOG:-}"          # where the detached launcher redirected this output
AIHR_DEPLOY_COMPLETED=0
dstate() { ./deploy/deploy-state.sh "$@" >/dev/null 2>&1 || true; }
dstate begin "$AIHR_DEPLOY_REF" "$$" "$AIHR_DEPLOY_LOG"
aihr_on_exit() {
  rc=$?
  if [ "$AIHR_DEPLOY_COMPLETED" = "1" ]; then
    dstate finish 0
    exit 0
  fi
  # Reached an end this script does not consider an end: a refusal, a `set -e` abort, an OOM.
  if [ "$rc" = "0" ]; then rc=1; fi
  dstate finish "$rc"
  exit "$rc"
}
trap aihr_on_exit EXIT

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
CUSTOMER=0
DEMO_FORCED=0
for arg in "$@"; do
  case "$arg" in
    --reseed) RESEED=1 ;;
    --migrate-only) MIGRATE_ONLY=1 ;;
    --customer) CUSTOMER=1 ;;
    --demo) DEMO_FORCED=1 ;;
    *) echo "✗ Unknown argument: $arg (expected --reseed, --migrate-only, --customer and/or --demo)"; exit 1 ;;
  esac
done
if [ "$CUSTOMER" = "1" ] && [ "$DEMO_FORCED" = "1" ]; then
  echo "✗ --customer and --demo are opposites; pass one or neither."
  exit 1
fi

# Use the isolated Node toolchain if present (keeps the host's system Node untouched, and means
# pnpm/node are found even when /opt/node20/bin isn't on the invoking shell's PATH).
# Prefer a supported isolated runtime. Retain the legacy path only for the existing demo.
if [ -d /opt/node24/bin ]; then export PATH="/opt/node24/bin:$PATH"
elif [ -d /opt/node22/bin ]; then export PATH="/opt/node22/bin:$PATH"
elif [ -d /opt/node20/bin ]; then export PATH="/opt/node20/bin:$PATH"
fi

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
: "${MIGRATION_DATABASE_URL:?set in .env.production}"

# DEMO MODE IS AN OPT-IN (r290). `--customer` forces it off; otherwise the deployment has to SAY it is
# the gated demo by setting ALLOW_DEMO_SESSION=true — the same variable lib/session.ts reads to enable
# the "act as" switcher, so a deployment that has it on authenticates nobody and cannot be a real one.
# Absence means customer. That is what makes a plain `./deploy/deploy.sh` safe for an operator who
# copied deploy/.env.customer.example: no ALLOW_DEMO_SESSION, therefore no seed and no DEV_TENANT_ID
# requirement. On the gated box, which sets ALLOW_DEMO_SESSION=true, every branch below resolves
# exactly as it did before r290.
#
# `${ALLOW_DEMO_SESSION:-}`, not `$ALLOW_DEMO_SESSION`: this script runs under `set -u`, where an unset
# variable is a fatal error, and "unset" is the normal customer case.
DEMO=0
if [ "$CUSTOMER" != "1" ] && { [ "$DEMO_FORCED" = "1" ] || [ "${ALLOW_DEMO_SESSION:-}" = "true" ]; }; then
  DEMO=1
fi

if [ "$DEMO" = "0" ]; then
  dstate phase preflight
  node deploy/check-customer-env.mjs
fi

if [ "$DEMO" = "1" ]; then
  # Required by, and read by, the demo seed branch alone. A customer deployment has no such tenant.
  : "${DEV_TENANT_ID:?set in .env.production}"
elif [ "$RESEED" = "1" ]; then
  # Never silently ignore a destructive flag.
  echo "✗ --reseed wipes and re-creates the DEMO data (db/seed.ts TRUNCATEs 24 tables), and this"
  echo "    deploy is not in demo mode — either --customer was passed, or .env.production does not"
  echo "    set ALLOW_DEMO_SESSION=true."
  exit 1
fi

# READINESS 1.4 — THE DEPLOY IS WHERE AN UNSET SHARE_PASSWORD HAS TO DIE.
#
# middleware.ts used to read `if (!password) return next()`, so a .env.production that lost its
# SHARE_PASSWORD line produced a deployment serving the WHOLE HRIS to anyone with the URL: no error, no
# log, HTTP 200 on every route. Nothing about that is visible from the outside — the box looks healthy
# because it IS healthy, it is just open.
#
# middleware.ts now refuses to serve (503) in that state, but middleware runs PER REQUEST: it can only
# turn "silently open" into "loudly broken, after the deploy succeeded and the service restarted". THIS
# line is the one that refuses to START. `${VAR:?}` under `set -u` (line 5) exits non-zero on unset OR
# empty, and `set -e` stops the script — so the box keeps serving the previous, gated build.
#
# ORDER IS THE SAME ARGUMENT THE AUDIT-CHAIN GATE MAKES ~40 LINES BELOW: here, nothing has been
# installed, built, migrated or restarted yet, so a refusal costs nothing and leaves nothing half-done.
# It is a `:` test rather than a script because it needs no database and no node_modules, which is what
# lets it sit this early.
#
# WHEN THE GATE IS RETIRED (readiness 1.3, the WorkOS cutover), delete this line AND the gate in
# middleware.ts together, in a commit someone reviews. Removing the variable is not how you turn it off.
#
# r390 — THE REVIEWED CHANGE THAT COMMENT ASKED FOR. Real WorkOS sign-in (readiness 1.3) is the other
# thing that can guard a deployment, so the preflight now demands ONE of the two, never neither: the demo
# gate (SHARE_PASSWORD), or real sign-in fully configured (ALLOW_DEMO_SESSION not `true` AND all four
# AuthKit settings non-empty — the same rule as lib/real-auth.ts and the middleware). Half a WorkOS
# configuration still refuses, before anything is installed, built, migrated or restarted.
if [ "${AUTH_PROVIDER:-}" = "keycloak" ]; then
  for setting in KEYCLOAK_ISSUER KEYCLOAK_WEB_CLIENT_ID KEYCLOAK_WEB_CLIENT_SECRET KEYCLOAK_MOBILE_CLIENT_ID KEYCLOAK_API_AUDIENCE AUTH_PUBLIC_ORIGIN AUTH_SESSION_KEY; do
    if [ -z "${!setting:-}" ]; then echo "Missing identity setting: $setting" >&2; exit 1; fi
  done
  echo "▸ Deployment-owned Keycloak sign-in selected; demo identity switching is disabled."
elif [ -n "${AUTH_PROVIDER:-}" ] && [ "$AUTH_PROVIDER" != "workos" ]; then
  echo "Unsupported AUTH_PROVIDER" >&2; exit 1
elif [ -z "${SHARE_PASSWORD:-}" ]; then
  if [ "${ALLOW_DEMO_SESSION:-}" = "true" ] || [ -z "${WORKOS_API_KEY:-}" ] || [ -z "${WORKOS_CLIENT_ID:-}" ] \
     || [ -z "${WORKOS_COOKIE_PASSWORD:-}" ] || [ -z "${NEXT_PUBLIC_WORKOS_REDIRECT_URI:-}" ]; then
    echo "✗ SHARE_PASSWORD is missing or empty in .env.production and real WorkOS sign-in is not fully configured — nothing would guard this deployment, so it refuses rather than publish an open app. Set SHARE_PASSWORD (deploy/.env.production.example), or set WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD and NEXT_PUBLIC_WORKOS_REDIRECT_URI with ALLOW_DEMO_SESSION unset, and re-run." >&2
    exit 1
  fi
  echo "▸ No SHARE_PASSWORD: real WorkOS sign-in is configured and guards this deployment."
fi

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
  dstate phase install
  pnpm install --frozen-lockfile --prod=false
  echo "$LOCK_HASH" > "$LOCK_MARKER"
fi

if [ "${AUTH_PROVIDER:-}" = "keycloak" ]; then
  node --import tsx --input-type=module -e 'import { keycloakConfig } from "./lib/identity/config.ts"; keycloakConfig();'
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
dstate phase audit-chain
node --env-file=.env.production --import tsx scripts/check-audit-chain-gate.ts

echo "▸ Building production server…"
dstate phase build
# Heap headroom for `next build`'s TypeScript pass. Node's default old-space cap (~2 GB on this box) was
# hit on 2026-07-21 deploying R52: compilation succeeded, then the build died with "Ineffective
# mark-compacts near heap limit" partway through "Running TypeScript" at ~1.95 GB. Nothing was wrong with
# the code — tsc --noEmit passes locally and in the clean-room gate; the project simply outgrew the
# default. deploy.sh runs in an SSH session, NOT under aihr.service's cgroup, so that unit's MemoryMax
# does not apply here; the box has ~3 GB free plus swap. If this OOMs again, raise the number rather than
# setting typescript.ignoreBuildErrors — the build's type pass catches RSC client/server boundary errors
# that tsc alone does not.
#
# RAISED 3072 -> 4096 on 2026-07-30 deploying r83, which hit the identical wall at ~3013 MB: "Ineffective
# mark-compacts near heap limit", again partway through "Running TypeScript", again with tsc --noEmit and
# the full suite green locally. Same story as R52 — the tree simply grew. The box has 3.9 GB RAM (~3.4 GB
# available) and 3.9 GB of swap, so 4096 overcommits physical memory by design and leans on swap for the
# tail of the type pass; that is slower but it completes. If it OOMs a third time, check `free -m` first:
# past ~4096 this stops being a headroom problem and becomes a "needs a bigger box" one.
#
# ⚠️ LOWERED 4096 -> 2560 on 2026-09-24 deploying r336, AND THE DIRECTION IS THE POINT. The advice above
# ("raise the number") holds only while the cap still sits under what the box can actually give. It no
# longer does, and raising it again would make things worse, not better:
#
#   R52 and r83 both died as "Ineffective mark-compacts near heap limit" — V8 hitting ITS OWN limit and
#   saying so. r336 died twice as a bare "Killed", exit 137: the kernel OOM killer, with no V8 message at
#   all. Those are different failures. A cap ABOVE available physical memory means V8 never approaches its
#   limit, so it never GCs hard — it just grows until the OS shoots it. The cap has to sit BELOW what is
#   free for V8 to compact instead of balloon, which is the only mechanism that gets a big type pass
#   through a small box.
#
#   Measured on 2026-09-24: `free -m` showed 2573 MB available at the start of the second attempt (the
#   first had been starved by an orphaned worker from the first failure — a killed `pnpm build` can leave a
#   ~2.5 GB next child reparented to init, in D state, for ~10 minutes; check `ps --sort=-rss` before
#   blaming capacity). It still died at "Running TypeScript" with 4096. r336 added +13,900/-1,325 lines
#   across 126 files, which is what tipped it.
#
# 2560 -> 3584, SAME DAY, and the correction matters more than the number.
#
#   2560 did exactly what it was lowered to do: the bare "Killed"/137 became V8's OWN
#   FatalProcessOutOfMemory with a native stack trace — i.e. V8 reached its limit and said so, instead of
#   being shot by the kernel before it ever collected. That confirms the mechanism above. What it also
#   showed is that 2560 is simply BELOW what this type pass needs.
#
#   The rule stated above was half right. The cap must sit under what the box can ACTUALLY back, and that
#   is RAM **plus free swap**, not RAM alone — swap is exactly what the 4096 era was leaning on, and it
#   worked until swap ran short. Measured across the three r336 attempts:
#     attempt 1  cap 4096  ~14 MB RAM / 1.6 GB swap free   -> kernel kill (an orphaned worker had eaten it)
#     attempt 2  cap 4096  2.5 GB RAM / 1.6 GB swap free   -> kernel kill (4096 + overhead > 4.1 GB backing)
#     attempt 3  cap 2560  2.5 GB RAM / 2.9 GB swap free   -> V8 self-OOM (cap too low, backing was fine)
#   So the confounder in 1-2 was the orphan consuming swap, not the cap being "above physical RAM".
#
#   3584 sits above the 2560 V8 exhausted and ~1.8 GB under the 5.4 GB of RAM+swap now free, so V8 has
#   room to compact without the kernel getting involved. ⚠️ BEFORE BLAMING THIS NUMBER, RUN `free -m` AND
#   `ps --sort=-rss`: a killed `pnpm build` leaves a ~2.5 GB next worker reparented to init (D state, up to
#   ~10 min) that starves the retry and makes a capacity problem out of a cleanup one.
#
# 3584 -> 4096 on 2026-09-24 deploying r337, ONE ROUND LATER, as a V8 self-OOM again. r337 added ~1,270
# lines to the payroll kernel and that was enough. Back to r83's number, and it fits now for a reason the
# r336 attempts did not have: RAM+swap free was 2727+2895 = 5.6 GB, against the 4.1 GB those attempts had
# while an orphaned worker sat on the swap. 4096 + node overhead is ~4.5 GB, which that backing covers.
#
# ⚠️ READ THE TREND, NOT JUST THE NUMBER. 2048 (R52) -> 3072 (r83) -> 4096 (r83) -> 3584 (r336, after the
# orphan confound) -> 4096 (r337). The type pass has needed a bump in consecutive rounds, so the number
# below is not a settled fact — it is the current reading of a moving one.
#
# ✅ THE CEILING MOVED ON 2026-09-25, AND THIS NOTE USED TO SAY THE OPPOSITE. It read "THE NEXT BUMP DOES
# NOT FIT", which was true while the box had 5.6 GB of RAM+swap: 4096 plus ~0.5 GB of overhead was ~80% of
# everything it had. A second swapfile was added that day — /swap2.img, 8 GB, priority -3, persisted in
# /etc/fstab beside the original /swap.img — taking swap from 3.8 GB to 12.1 GB and total backing from
# 7.7 GB to 15.7 GB. 4096 now sits at roughly a quarter of what the box can back, not four fifths.
#
# WHAT THAT DOES AND DOES NOT BUY. It removes the FAILURE: the r336-r339 deploys died four times, and the
# rule those failures established still holds — the cap must fit RAM + FREE SWAP, not RAM alone, because a
# cap above what the box can back converts a clean V8 self-OOM into a kernel kill. It does NOT make the
# build fast: swap is disk-backed, so a type pass that spills still crawls. The durable fix is RAM on the
# VM (a VMware guest, 2 cores, 3.9 GB) — at 8 GB the pass would run in memory and the build would drop
# from ~15-20 minutes to ~5. Until then, expect slow-but-completing.
#
# ⚠️ AND CHECK `free -m` AND `ps --sort=-rss` BEFORE BLAMING THIS NUMBER AGAIN. A killed `pnpm build`
# leaves a ~2.5 GB next worker reparented to init, in D state, for up to ~10 minutes. It starves the retry
# and looks exactly like capacity. That confounded the first two r336 attempts and cost a wrong diagnosis.
#
# Still never typescript.ignoreBuildErrors: the build's type pass catches RSC client/server boundary
# errors that tsc alone does not, which is the whole reason it runs here.
# 4096 -> 6144 on 2026-10-07 deploying r394, which died as a V8 self-OOM at ~4030 MB, 18 minutes into
# "Running TypeScript" — the same wall, one round later. The note above made growing swap the precondition for
# the next bump, and it has been met: /swap2.img (8 GB) now sits beside /swap.img (3.8 GB), so RAM+swap is
# ~15.7 GB against the 5.6 GB that note measured. 6144 + ~0.5 GB overhead is ~42% of that, well clear of the
# kernel-kill regime. It does not make the build fast (the tail spills to disk-backed swap); RAM on the VM is
# still the durable fix. r394's 232 one-line loading.tsx files did NOT grow the type pass: the generated route
# validator was byte-identical in size with and without them (3157 lines), so this is the tree's growth.
# ⚠️ And a failed build leaves `.next` without a BUILD_ID: restarting the service then has NOTHING to start
# (r394 took the app down that way, 12:05 MYT). After a failed build, redeploy; never restart.
NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=6144" pnpm build
# The build id this source produced, recorded the instant the build succeeded and nowhere else.
# `deploy-state.sh status` compares it against the .next/BUILD_ID physically on disk, which is how a
# later deploy that died before finishing its own build is distinguishable from a clean one.
dstate built

echo "▸ Applying database migrations (as ai_hr_owner)…"
dstate phase migrate
pnpm db:migrate

# ADR-0077 C11 — UNCONDITIONAL, and deliberately above the demo-seed `if` below: that branch is skipped
# on every normal update, so seeding the catalogs inside it would leave an updated deployment with an
# empty module catalog and every entitlement lookup failing closed. Idempotent (ON CONFLICT DO UPDATE).
echo "▸ Seeding module + setting catalogs…"
dstate phase catalogs
node --env-file=.env.production --import tsx scripts/seed-catalogs.ts

# 0318 — seed feedback_plan_revision from what survived. Idempotent (ON CONFLICT DO NOTHING), so it
# stays here permanently rather than being a one-shot: a deploy that adds the table to a database it has
# not run against yet must still populate it. It PRINTS how many earlier plan versions it could not
# recover, so the gap is reported on every deploy instead of being discovered by a confused reporter.
echo "▸ Seeding feedback plan history…"
node --env-file=.env.production --import tsx scripts/backfill-plan-history.ts

# ADR-0077 slice 6 — grant each tenant the country modules its companies already operate in. Idempotent
# and permanent, not one-shot: a company created between deploys is picked up on the next one. It runs
# AFTER seed-catalogs because tenant_module.module_code has an FK to module(code), and it is a script
# rather than a migration because "where a pack is registered" is a question only TypeScript can answer.
echo "▸ Granting country modules…"
node --env-file=.env.production --import tsx scripts/backfill-country-modules.ts

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
  dstate phase migrate-only
  echo ""
  echo "⏸  --migrate-only: stopped after migrate + catalog seed. The service is NOT restarted and is"
  echo "    still serving the previous build."
  echo "    Run the ADR-0077 slice-3 entitlement-parity reconciliation now — deploy/DEPLOY.md,"
  echo "    'ONE-SHOT: entitlement parity' — then finish with:  ./deploy/deploy.sh"
  # One of the two places this script legitimately ends. See the trap at the top.
  AIHR_DEPLOY_COMPLETED=1
  exit 0
fi

# THE DEMO SEEDER — the one branch that differs between the two deployments, and the only place in this
# script that can reach db/seed.ts. In customer mode `$DEMO` is 0, so neither the psql probe nor the
# seeder is ever evaluated; `$DEV_TENANT_ID` is not even expanded, which is why customer mode does not
# need it under `set -u`. db/seed-guard.ts refuses independently if this is ever reached wrongly.
dstate phase seed
if [ "$DEMO" = "1" ]; then
  # Seed only if the demo tenant is absent, so updates preserve whatever the consultant has been testing.
  if [ "$RESEED" = "1" ] || ! psql "$MIGRATION_DATABASE_URL" -tAc "SELECT 1 FROM tenant WHERE id='$DEV_TENANT_ID'" 2>/dev/null | grep -q 1; then
    echo "▸ Seeding demo data…"
    node --env-file=.env.production --import tsx db/seed.ts
  else
    echo "▸ Demo data already present — skipping seed (use './deploy/deploy.sh --reseed' to reset)."
  fi
else
  echo "▸ Customer deployment — the demo seeder was not run and is not reachable from this mode."
fi

# Refresh bundled documentation on EVERY release, including existing customer tenants.
# This only upserts system articles; it never runs the destructive demo seed.
echo "▸ Refreshing system knowledge-base guides…"
node --env-file=.env.production --import tsx db/seed-guides.ts --all

echo "▸ Restarting service…"
dstate phase restart
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

# The other place this script legitimately ends, and the LAST line on purpose. See the trap at the top:
# this, not `$?`, is what decides whether the deploy is recorded as ok.
AIHR_DEPLOY_COMPLETED=1
