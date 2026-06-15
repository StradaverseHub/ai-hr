#!/usr/bin/env bash
# Launch AI HR as a password-gated demo for remote testers (see HOSTING.md).
# Builds a production server bound to the network; the SHARE_PASSWORD gate (middleware.ts) protects it.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! grep -Eq '^SHARE_PASSWORD=.+' .env.local 2>/dev/null; then
  cat <<'MSG'
⚠️  SHARE_PASSWORD is not set in .env.local — the demo would be OPEN to anyone with the link.
    Add these two lines to .env.local, then re-run `pnpm host`:

        SHARE_PASSWORD=choose-a-strong-password
        ALLOW_DEMO_SESSION=true

MSG
  exit 1
fi

if ! grep -Eq '^ALLOW_DEMO_SESSION=true' .env.local 2>/dev/null; then
  echo "⚠️  Add  ALLOW_DEMO_SESSION=true  to .env.local (lets the production build run the demo session), then re-run."
  exit 1
fi

echo "▸ Ensuring Postgres is running…"
pnpm db:start >/dev/null 2>&1 || true

echo "▸ Building production server…"
pnpm build

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo localhost)
cat <<EOF

✅ AI HR is starting (password-gated demo):
     http://localhost:3000      (this machine)
     http://${LAN_IP}:3000      (same Wi-Fi)

   To let REMOTE consultants in, open a SECOND terminal and start a tunnel, e.g.:
     cloudflared tunnel --url http://localhost:3000     # instant HTTPS URL, no account needed
   …then share that https URL + your password. Stop with Ctrl-C (here and in the tunnel terminal).

EOF

exec pnpm exec next start -H 0.0.0.0 -p 3000
