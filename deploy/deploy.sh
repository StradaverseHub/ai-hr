#!/usr/bin/env bash
# AI HR — build, migrate, (first-time) seed, and restart the gated demo. Re-run any time to deploy an
# update. Pass --reseed to wipe + reseed the demo data (destroys tester changes). See deploy/DEPLOY.md.
set -euo pipefail
cd "$(dirname "$0")/.."

# Use the isolated Node toolchain if present (keeps the host's system Node untouched, and means
# pnpm/node are found even when /opt/node20/bin isn't on the invoking shell's PATH).
[ -d /opt/node20/bin ] && export PATH="/opt/node20/bin:$PATH"

[ -f .env.production ] || { echo "✗ Missing .env.production — copy deploy/.env.production.example, fill it in, and re-run."; exit 1; }
# Load the production env so db:migrate (MIGRATION_DATABASE_URL) and the seed pick it up.
set -a; . ./.env.production; set +a
: "${MIGRATION_DATABASE_URL:?set in .env.production}"; : "${DEV_TENANT_ID:?set in .env.production}"

echo "▸ Installing dependencies…"
# --prod=false: the build, drizzle-kit (migrate) and tsx (seed) are devDependencies, which a
# NODE_ENV=production install would otherwise skip.
pnpm install --frozen-lockfile --prod=false

echo "▸ Building production server…"
pnpm build

echo "▸ Applying database migrations (as ai_hr_owner)…"
pnpm db:migrate

# Seed only if the demo tenant is absent, so updates preserve whatever the consultant has been testing.
if [ "${1:-}" = "--reseed" ] || ! psql "$MIGRATION_DATABASE_URL" -tAc "SELECT 1 FROM tenant WHERE id='$DEV_TENANT_ID'" 2>/dev/null | grep -q 1; then
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
