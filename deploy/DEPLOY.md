# Deploying AI HR to a Linux server (gated consultant demo)

A native (no-Docker) deployment for **demo/testing on a public-IP server**. The app sits behind the
`SHARE_PASSWORD` HTTP-Basic gate; testers use the top-bar "act as" switcher for roles.

> **⚠️ Still demo-only.** There is no real authentication yet — the password gate is the only
> protection, and anyone past it is effectively admin. **Do not load real client/employee PII.** Also:
> with a public IP and **no TLS**, the Basic-auth password travels over plain HTTP — use a throwaway
> password, rotate it after the test, and consider the HTTPS upgrade note at the bottom.

## Co-locating safely on a shared / production host

If this box already runs something important (e.g. another app behind nginx), keep AI HR fully
isolated so it can never disturb the incumbent:

- **Isolated Node** — do NOT replace the system Node. Unpack the official Node 20 tarball into its
  own dir and own it as the app user:
  ```bash
  V=$(curl -fsSL https://nodejs.org/dist/index.tab | awk -F'\t' '$1 ~ /^v20\./{print $1; exit}')
  sudo mkdir -p /opt/node20 && curl -fsSL "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.gz" \
    | sudo tar -xz -C /opt/node20 --strip-components=1
  sudo chown -R "$USER":"$USER" /opt/node20
  /opt/node20/bin/corepack enable --install-directory /opt/node20/bin
  /opt/node20/bin/corepack prepare pnpm@10 --activate
  ```
  Point `aihr.service` at `/opt/node20/bin`; `deploy.sh` already prepends it automatically when present.
- **Separate database** — the local Postgres created here is used only by AI HR. If the incumbent
  has its own (or a remote) Postgres, the two never touch.
- **No firewall / proxy changes** — prefer a `cloudflared` tunnel (see the HTTPS section) and bind
  the app to loopback (`-H 127.0.0.1` in `aihr.service`). The app stays off the LAN entirely; you
  open no ports and leave the incumbent's nginx untouched.
- **Memory cap** — keep the `MemoryHigh`/`MemoryMax` lines in `aihr.service` so that under memory
  pressure the kernel kills AI HR, never the neighbour. Cap the one-time build too:
  `NODE_OPTIONS=--max-old-space-size=2048 nice -n 10 pnpm build`.

## 0. Prerequisites on the server

- **Linux** with `sudo`, a non-root user to run the app (examples use `aihr`).
- **Node 20 LTS** (Next 16 needs ≥20.9) and **pnpm via corepack**:
  ```bash
  # e.g. on Ubuntu/Debian:
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
  sudo corepack enable
  ```
- **PostgreSQL 14+** running locally:
  ```bash
  sudo apt-get install -y postgresql
  sudo systemctl enable --now postgresql
  ```

## 1. Get the code onto the server

There's no git remote configured, so copy the project up (from your Mac), excluding build artifacts:

```bash
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .git --exclude '.env*' \
  ~/Projects/ai-hr/  aihr@YOUR_SERVER_IP:/opt/ai-hr/
```

(Or push the repo to a git host and `git clone` it into `/opt/ai-hr` — either way the app lives in
`/opt/ai-hr`.)

## 2. One-time database bootstrap

Generate two DB passwords and create the database + the two roles (owner + app):

```bash
cd /opt/ai-hr
# hex (not base64) so the passwords are URL-safe inside the postgresql:// connection strings:
OWNER_PW=$(openssl rand -hex 24); APP_PW=$(openssl rand -hex 24)
echo "owner: $OWNER_PW"; echo "app: $APP_PW"   # copy these into .env.production next
sudo -u postgres psql -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" -f deploy/bootstrap-db.sql
```

This creates `ai_hr` owned by `ai_hr_owner`, the non-privileged `ai_hr_app`, and the default
privileges that auto-grant later migrations' tables to the app role (see the comments in the SQL —
do not blanket-grant after migrating).

## 3. Configure the environment

```bash
cp deploy/.env.production.example .env.production
nano .env.production
```

Fill in:
- `DATABASE_URL` → `postgresql://ai_hr_app:<APP_PW>@localhost:5432/ai_hr`
- `MIGRATION_DATABASE_URL` → `postgresql://ai_hr_owner:<OWNER_PW>@localhost:5432/ai_hr`
- `AI_CONFIG_SECRET` → `openssl rand -base64 32` (keep it stable — changing it breaks stored AI keys)
- `SHARE_PASSWORD` → a strong throwaway password (you'll give this to the consultant)
- leave `ALLOW_DEMO_SESSION`, `DEV_TENANT_ID`, `DEV_USER_ID`, `PORT` as-is

> Postgres auth: if `ai_hr_app`/`ai_hr_owner` can't log in with a password, set `scram-sha-256` for
> `127.0.0.1/32` in `pg_hba.conf` and `sudo systemctl reload postgresql`.

## 4. Build, migrate, seed

```bash
./deploy/deploy.sh
```

This installs deps, builds, runs migrations (as the owner), and seeds the demo data the first time
(it skips the seed on later runs so tester data survives; `./deploy/deploy.sh --reseed` forces a reset).

## 5. Run it as a service (survives reboots)

```bash
sudo cp deploy/aihr.service /etc/systemd/system/aihr.service
sudoedit /etc/systemd/system/aihr.service     # adjust User / WorkingDirectory if not aihr:/opt/ai-hr
sudo systemctl daemon-reload && sudo systemctl enable --now aihr
sudo systemctl status aihr                    # confirm running   ·   journalctl -u aihr -f  for logs
```

### Passwordless restart (so `deploy.sh` finishes on its own)

`deploy.sh` ends with `sudo -n systemctl restart aihr`. If the deploy user has no passwordless sudo, that step is skipped and the script prints the manual command to run. To let updates restart the service unattended, install the narrow `NOPASSWD` rule (only this one restart, nothing else):

```bash
sudo install -m 440 -o root -g root deploy/aihr-sudoers /etc/sudoers.d/aihr-restart
sudo visudo -cf /etc/sudoers.d/aihr-restart   # must print "parsed OK"
```

Edit `deploy/aihr-sudoers` first if your deploy user isn't `ubuntu` or `systemctl` isn't at `/usr/bin/systemctl`. Without this, just run `sudo systemctl restart aihr` yourself after each `deploy.sh`.

## 5b. Scheduled sweeps (REQUIRED — the app does not run these itself)

Four routine jobs keep leave and reviews correct. **Nothing in the app starts them.** Without this step
they never run, and the failure is silent: leave quietly stops accruing, expired leave is never forfeited,
probation and contract reviews are never opened, and the notifications that depend on the review sweep are
only dispatched when an admin happens to load a page. The demo server ran for months in exactly that state.

| Job | Schedule (server-local) | What it does |
| --- | --- | --- |
| `scripts/accrue-earned.ts` | `0 2 1 * *` | Tops earned-leave policies up to the amount earned |
| `scripts/review-sweep.ts` | `0 3 * * *` | Opens due probation/contract reviews, sends reminders, dispatches notifications |
| `scripts/expire-aged-leave.ts` | `30 3 * * *` | Forfeits earned leave past its configured age |
| `scripts/expire-carry.ts` | `0 3 1 4 *` | Forfeits carried-forward leave, just after the 31 Mar expiry |

All four are idempotent — re-running grants, opens and forfeits nothing extra.

**The host timezone matters.** The scripts resolve "today" via `todayInKualaLumpur()`, and the schedules
above are small-hours local times. Confirm the host agrees before installing:

```bash
timedatectl | grep "Time zone"      # expect Asia/Kuala_Lumpur (+08)
```

Install as the deploy user (no root needed):

```bash
crontab -e
```

```cron
0 2 1 * * cd /opt/ai-hr && /opt/node20/bin/node --env-file=.env.production --import tsx scripts/accrue-earned.ts >> /home/ubuntu/aihr-cron-logs/accrue.log 2>&1
0 3 * * * cd /opt/ai-hr && /opt/node20/bin/node --env-file=.env.production --import tsx scripts/review-sweep.ts >> /home/ubuntu/aihr-cron-logs/review-sweep.log 2>&1
30 3 * * * cd /opt/ai-hr && /opt/node20/bin/node --env-file=.env.production --import tsx scripts/expire-aged-leave.ts >> /home/ubuntu/aihr-cron-logs/expire-aged.log 2>&1
0 3 1 4 * cd /opt/ai-hr && /opt/node20/bin/node --env-file=.env.production --import tsx scripts/expire-carry.ts >> /home/ubuntu/aihr-cron-logs/expire-carry.log 2>&1
```

First `mkdir -p /home/ubuntu/aihr-cron-logs`. Keep the logs **outside** `/opt/ai-hr`: `improve:release`
rsyncs with `--delete` and would wipe anything it doesn't exclude.

Use the absolute node path — cron's `PATH` does not include `/opt/node20/bin`. Do **not** rely on the
`pnpm leave:*` scripts here: they load `.env.local`, which does not exist on a server.

Verify:

```bash
crontab -l                                   # the four lines
systemctl is-active cron                     # active
tail -f /home/ubuntu/aihr-cron-logs/review-sweep.log   # after the next 03:00
```

A reboot spanning a trigger means cron skips that run — it does not catch up. For the monthly and annual
jobs that is worth guarding with systemd timers (`OnCalendar` + `Persistent=true`) instead, which needs
root and additional `aihr-sudoers` entries for `daemon-reload` and `enable`.

## 6. Open the firewall + share

```bash
sudo ufw allow 3000/tcp        # or your PORT
```

Confirm the gate is live (should be `401`):
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://YOUR_SERVER_IP:3000/
```

**Share with the consultant:** `http://YOUR_SERVER_IP:3000` **+** the `SHARE_PASSWORD`. They type any
username + that password at the browser prompt, then use the top-bar **"act as"** switcher to try
HR Admin / Manager / Employee, the 文A button for language, and the **?** tour.

## Updating later

Re-sync the code (step 1) and re-run `./deploy/deploy.sh` — it rebuilds, applies any new migrations,
keeps the data, and restarts the service. Reset the demo with `--reseed`.

## Optional: HTTPS / cleaner URL

No domain is required to run, but to remove the plain-HTTP caveat you can either:
- put **Caddy** or **nginx** in front (needs a domain for a real cert), or
- run **`cloudflared tunnel --url http://localhost:3000`** on the server (free HTTPS URL, no domain,
  no open ports) — the same tunnel model as the laptop, but from the always-on box.
