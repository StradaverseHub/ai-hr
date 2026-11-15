#!/usr/bin/env bash
# ADR-0181 — the database sequence of a ZERO-DOWNTIME release, run from the CANDIDATE release
# directory while the previous release keeps serving. It ships inside the release so the step list is
# versioned with the code that needs it; release-web.sh calls it and never hard-codes the steps.
#
# Order is the production sequence of prod-2026-11-14.1 (blocks E.2 + E.3), which is deploy.sh's
# order: audit-chain gate, migrate, post-migrate-online, catalogs, plan history, country modules,
# audit-chain gate again, guides. test/zero-downtime-release-web.test.ts pins it against deploy.sh.
#
# What is different from the stopped-service window, and why:
#   - The migration connection carries lock_timeout (default 3 s). Under live traffic an ALTER that
#     waits behind a long reader would queue EVERY later query on that table behind itself; a
#     bounded wait fails the whole migration transaction instead (drizzle applies all pending entries
#     in one transaction), nothing is applied, and the attempt is retried with backoff. The previous
#     release keeps serving throughout.
#   - It refuses unless the release-mode classifier says `online` for exactly this base/candidate
#     pair (release-web.sh passes --base). A maintenance release uses the stopped-service runbook.
#
# Environment: /etc/aihr/runtime.env then /etc/aihr/deploy.env, sourced into a clean environment
# (the 14 Nov run_in pattern), so nothing from the operator's shell leaks in.
set -euo pipefail
umask 077

die() { echo "STOP: $*" >&2; exit 1; }
BASE="" ACCEPT="" LOG_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE=$2; shift 2 ;;
    --accept) ACCEPT=$2; shift 2 ;;
    --log-dir) LOG_DIR=$2; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
REL=$(cd "$(dirname "$0")/../.." && pwd)
[ -n "$BASE" ] && [ -d "$BASE/db/migrations" ] || die "--base <running release dir> is required"
[ -n "$LOG_DIR" ] || LOG_DIR=$(mktemp -d)
mkdir -p "$LOG_DIR"
NODE_BIN=${AIHR_NODE_BIN:-/opt/node24/bin}
ENV_FILES=${AIHR_RELEASE_ENV_FILES:-"/etc/aihr/runtime.env /etc/aihr/deploy.env"}
LOCK_TIMEOUT=${AIHR_MIGRATION_LOCK_TIMEOUT:-3s}
ATTEMPTS=${AIHR_MIGRATION_ATTEMPTS:-6}

run_in() {
  env -i PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin" HOME="${HOME:-/root}" LANG=C.UTF-8 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_ENABLE_NETWORK=0 NEXT_TELEMETRY_DISABLED=1 \
    AIHR_BOUND_LOCKS="${AIHR_BOUND_LOCKS:-}" \
    bash -c 'set -a; for f in $1; do . "$f"; done; set +a
      if [ -n "$AIHR_BOUND_LOCKS" ]; then
        MIGRATION_DATABASE_URL=$(node -e "const u=new URL(process.env.MIGRATION_DATABASE_URL);u.searchParams.set(\"lock_timeout\",process.argv[1]);process.stdout.write(u.toString())" "$AIHR_BOUND_LOCKS")
        export MIGRATION_DATABASE_URL
      fi
      unset AIHR_BOUND_LOCKS; cd "$0" && shift 2 && exec "$@"' \
    "$REL" "$ENV_FILES" _ "$@" </dev/null
}

step() {
  local name=$1; shift
  local t0; t0=$(date +%s)
  echo "▸ $name"
  if run_in "$@" >"$LOG_DIR/$name.log" 2>&1; then echo "  ok ($(( $(date +%s) - t0 )) s)"; return 0; fi
  echo "  FAILED — tail of $LOG_DIR/$name.log:"; tail -25 "$LOG_DIR/$name.log" | sed 's/^/    /'
  return 1
}

echo "release=$(cat "$REL/.next/BUILD_ID") base=$(cat "$BASE/.next/BUILD_ID" 2>/dev/null || echo '?')"
MODE_ARGS=(--base "$BASE" --candidate "$REL")
[ -z "$ACCEPT" ] || MODE_ARGS+=(--accept "$ACCEPT")
"$NODE_BIN/node" "$REL/scripts/releases/migration-release-mode.mjs" "${MODE_ARGS[@]}" | tee "$LOG_DIR/release-mode.txt" \
  || die "release mode is not online (see $LOG_DIR/release-mode.txt): use the stopped-service maintenance runbook"

step audit-chain-gate node --import tsx scripts/check-audit-chain-gate.ts || die "audit chain gate refused before any change; the previous release is still serving"

# The lock-bounded migration. lock_timeout rides on the connection URL: postgres.js sends unknown URL
# query parameters as startup parameters (node_modules/postgres/src/index.js, `connection`), and
# drizzle-kit connects with that URL. The rehearsal workflow proves the bound against a held lock.
attempt=1
while :; do
  if AIHR_BOUND_LOCKS=$LOCK_TIMEOUT step "migrate-attempt-$attempt" pnpm db:migrate; then break; fi
  if ! grep -qE '55P03|lock timeout|canceling statement due to lock timeout' "$LOG_DIR/migrate-attempt-$attempt.log"; then
    die "migration failed for a reason other than a lock wait; nothing further ran. The previous release is still serving."
  fi
  [ "$attempt" -lt "$ATTEMPTS" ] || die "migration could not take its locks in $ATTEMPTS attempts (lock_timeout=$LOCK_TIMEOUT); retry later or in a window"
  sleep $(( attempt * 5 ))
  attempt=$(( attempt + 1 ))
done

# From here the schema is migrated. It is compatible with the running release by construction, which
# keeps serving; a failed step is repaired forward and the sequence rerun (every step is idempotent).
after() { step "$@" || die "post-migration step $1 failed; the schema is migrated and the previous release is still serving. Repair forward, then rerun migrate (idempotent)"; }
after post-migrate-online node --import tsx scripts/post-migrate-online.ts
after seed-catalogs node --import tsx scripts/seed-catalogs.ts
after backfill-plan-history node --import tsx scripts/backfill-plan-history.ts
after backfill-country-modules node --import tsx scripts/backfill-country-modules.ts
after audit-chain-gate-after node --import tsx scripts/check-audit-chain-gate.ts
after seed-guides node --import tsx db/seed-guides.ts --all
echo "MIGRATE_ONLINE_RESULT=pass logs=$LOG_DIR"
