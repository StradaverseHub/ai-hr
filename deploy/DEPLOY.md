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

### The provisioning runner (REQUIRED if you use the operator console)

`scripts/provision-runner.ts` is the out-of-band half of the `/operator` console (ADR-0079). Without it,
clicking **Create customer** queues a request that stays "Queued" forever — the web tier deliberately
cannot provision a tenant itself, and that is the point, not a limitation to work around.

```cron
* * * * * cd /opt/ai-hr && /opt/node20/bin/node --env-file=.env.production --import tsx scripts/provision-runner.ts >> /home/ubuntu/aihr-cron-logs/provision.log 2>&1
```

**Env contract: `MIGRATION_DATABASE_URL` only.** It runs as the table owner, which is exactly why it is a
separate process — the credentials that can create a tenant are kept out of the application. It does not
read `DATABASE_URL`; no app-role service is called. `NEXT_PUBLIC_APP_URL` is read if set, to build an
absolute activation URL (without it the link is stored path-only).

One minute is the intended cadence and one request is handled per tick; a new customer is therefore ready
within about a minute of the click. Overlapping ticks are safe (`FOR UPDATE SKIP LOCKED` plus a status
recheck), and a runner killed mid-flight is reclaimed after 10 minutes rather than leaving a stuck row.

The log is safe to keep: the activation URL is **never** written to it.

Verify:

```bash
tail -f /home/ubuntu/aihr-cron-logs/provision.log   # "· nothing to do" once a minute when idle
```

Grant the operator role by hand, as the DB owner — there is deliberately no UI or invitation path for it
(a customer's group admin cannot mint one; migration 0295 forbids it):

```sql
INSERT INTO role_assignment (tenant_id, app_user_id, company_id, role)
VALUES ('<tenant-uuid>', '<app-user-uuid>', NULL, 'operator');
```

Note: **suspending or deleting a customer is not implemented** (ADR-0079, deferred).

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
keeps the data, and restarts the service. Reset the demo with `--reseed`. `--migrate-only` stops after
the migrations and the catalog seed, without seeding demo data or restarting, for a deploy that needs a
manual step in between (see the entitlement-parity one-shot below); run it again with no arguments to
finish.

### ONE-SHOT: entitlement parity, at the ADR-0077 slice-3 deploy only

Slice 3 turns eight `*_ENABLED` env flags into per-tenant entitlement rows. Migration 0313 already
backfilled those rows for every tenant that existed **when it ran** — but a migration runs once, and
any tenant provisioned through the operator console **after** that has been running
`notifications`, `multi_cycle_payroll`, `typed_pay_components` and the three payroll settings on the
strength of `.env.production` alone, with no row to inherit. Those six would switch off silently at the
flip; `typed_pay_components` changes payroll numbers when it does.

Run this **after `migrate`, before restarting the service**, in the same window. `./deploy/deploy.sh
--migrate-only` stops at exactly that point — migrations applied, catalogs seeded, service still on the
previous build — so the documented ordering is reachable rather than aspirational. Finish with a plain
`./deploy/deploy.sh` afterwards.

The reconcile is a **dry run by default** — it prints a per-tenant plan and writes nothing until you
pass `--apply`. `--created-before` is the **flip date**, and `--apply` refuses without it:

```bash
cd /opt/ai-hr
./deploy/deploy.sh --migrate-only
/opt/node20/bin/node --env-file=.env.production --import tsx \
  scripts/reconcile-entitlement-parity.ts --created-before=YYYY-MM-DD
# read the plan against your customer list, then:
/opt/node20/bin/node --env-file=.env.production --import tsx \
  scripts/reconcile-entitlement-parity.ts --created-before=YYYY-MM-DD --apply
./deploy/deploy.sh          # build the rest of the way and restart
```

Use **today's date** when you run this inside the deploy window; use the date the slice-3 deploy went
out if you are reconciling later. The boundary is what separates the two populations: a tenant created
**before** the flip was running on `.env.production` and needs its rows; a tenant created **after** it
already got correct install defaults from `db/provision.ts`, and granting the env set on top of that
would write `payroll.reset_enabled=true` and `payroll.unlock_enabled=true` for a brand-new customer —
`scope='platform'` rows `ai_hr_app` can never close again.

Read the plan properly rather than skimming it. The script grants only what `.env.production` actually
has on and never revokes, but a grant is **permanent** and it cannot tell "this tenant predates the
row" from "the operator deliberately left this module unticked" — before slice 3 an untick had no
effect, because nothing read the row, so both look identical in the data. The plan lists every tenant
with its creation date; anything you do not want granted, record that decision first — see "If you
decide a tenant should stay without something the plan proposes" below, which gives the statement for
each axis (a `disabled` row is a **module** remedy; `tenant_setting` has no status column). The script
skips any tenant that already has a row at any grain, including a company-scoped one. Safe to re-run.
It is **not** a cron entry — delete the script once slice 7 ships the plan-management plane.

To confirm afterwards, `--preflight` re-plans and exits non-zero if anything is still outstanding. Pass
the same `--created-before` — without it the verdict can never be green (see below):

```bash
/opt/node20/bin/node --env-file=.env.production --import tsx \
  scripts/reconcile-entitlement-parity.ts --created-before=YYYY-MM-DD --preflight
```

`deploy.sh` deliberately does **not** run that check. `db/provision.ts` writes no **platform-scoped**
`tenant_setting` row for a new tenant — `payroll.reset_enabled` and `payroll.unlock_enabled` keep
`defaultOnInstall: false` because a purchased module must never arrive with a risk switch already open —
while this box has both flags set to true. So every tenant created from now on is "missing" those two
rows forever, by design. Unbounded, that made the preflight permanently red: as a blocking gate the
first customer provisioned after this deploy would block every deploy after it, and the only ways out
were to grant two platform-scoped switches `ai_hr_app` can never close again, or to switch the gate off
permanently. `--created-before` removes those tenants from the question; the reconciliation still needs
you to read a plan against your customer list, which is what keeps it a step in this runbook rather than
something a script can decide.

The **third** payroll key, `payroll.individual_txn_pay_enabled`, is not in that group. It is
`scope: 'tenant'`, it decides ordinary payslip arithmetic rather than opening a control hatch, and it
carries `defaultOnInstall: true` — so every tenant that buys payroll gets it, before and after the flip
alike, and it needs nothing from you.

If you decide a tenant should stay **without** something the plan proposes, record that decision before
you `--apply`:

- a **module**: insert a `disabled` `tenant_module` row for that tenant and code.
- a **setting**: `tenant_setting` has no status column, so the equivalent is an explicit OFF row,
  written on the **owner** connection (`ai_hr_app` cannot write a platform-scoped key at all):

```bash
psql "$MIGRATION_DATABASE_URL" -c \
  "INSERT INTO tenant_setting (tenant_id, key, value, source)
   VALUES ('<TENANT-UUID>', 'payroll.reset_enabled', 'false'::jsonb, 'platform')
   ON CONFLICT DO NOTHING;"
```

**The audit hash chain is checked automatically and blocks the deploy.** `AUDIT_HASH_CHAIN_ENABLED`
used to be read with a truthiness test, so the literal `AUDIT_HASH_CHAIN_ENABLED=false` that
`.env.example` shipped **armed** the ADR-0030 hash chain. It is now `=== 'true'`, which stops the chain
on any box that copied the template — and stopping it is **not** something the verifier can report:
`verifyTenantChain()` only inspects rows that carry chain columns, so events written while the gate is
off are absent from the chain rather than a break in it, and re-arming later links contiguously across
the hole. A green "chain intact" over an unverifiable window is the failure mode.

So `deploy.sh` runs `scripts/check-audit-chain-gate.ts` **before the build**, not just before the
restart: it needs only the env file and a database connection, so refusing there costs nothing and
leaves the box exactly as it was, rather than serving the old code against an already-migrated
schema. Run it by hand with `MIGRATION_DATABASE_URL` (the **owner** role) — `domain_event` is
RLS-bound for `ai_hr_app`, and a filtered zero would read as "this database has no chain". It
compares the env value against what the database already holds and **exits non-zero** — halting the
deploy — when the database has a chain this env would not keep. To resolve it, either:

- set `AUDIT_HASH_CHAIN_ENABLED=true` in `.env.production` (keeps doing what the box does today), or
- leave the gate off and add `AUDIT_CHAIN_STOP_ACKNOWLEDGED=true`, which records the stop as a
  decision. The admin **Data Privacy & Audit Integrity** page then reports, alongside the verdict, how
  many events were recorded **after** the chain started without being chained — a genuine hole, as
  distinct from ordinary history predating the chain, which is permanently unchained by design
  (0074 defers that backfill to ADR-0030 §3). So the window is visible rather than silent, and the
  banner means something an admin can act on.

There is no way back afterwards: ADR-0030 §3's historical backfill, the only thing that could chain the
window retroactively, is not built.

The parity reconciliation above is the other half of this window, and unlike the chain check it is
**yours to run**, for the reason given there: only you can tell a tenant that predates the row from one
whose module was deliberately left unticked.

### ONE-SHOT: convert the approval rules the Assignment Template screen cannot own (241817ef)

Run this **before** the Approval Workflows and Company base approval chain sections are removed from the
Approval tab, not after. Those two sections are the only editor for rules whose `leave_type_id` is null
("applies to every leave type", which the assign form cannot express) and for rules that carry their own
chain instead of a template (the assignments table filters `template_id is not null`). Removing them
first does not break routing — resolution falls through to the tenant-default template and then the
built-in `direct_manager → hr_admin` chain — it re-routes requests to a different approver with nothing
on screen saying so.

```bash
cd /opt/ai-hr
/opt/node20/bin/node --env-file=.env.production --import tsx \
  scripts/convert-approval-rules.ts            # dry run — writes nothing
```

The dry run is a **measurement, not a forecast**: it performs the identical writes and the identical
proof inside a transaction and then rolls back on purpose. Read the printed list — it names every
company and leave type that changes, and the approved plan promises the reporter that list before
anything is removed. Then:

```bash
/opt/node20/bin/node --env-file=.env.production --import tsx \
  scripts/convert-approval-rules.ts --apply
```

Every routing subject × leave type × day-range probe is resolved before and after the rewrite in the
same transaction; the first difference aborts and rolls back with the affected employment, leave type
and both chains printed. A tenant that fails that way has rules needing a human decision — a rewrite
that would move an approver is exactly what this step exists to refuse. Safe to re-run: a converted row
is no longer a candidate.

One consequence the proof cannot cover, printed as a `NOTE` line per company: "applies to every leave
type" also meant every leave type created **later**. After the conversion those companies have explicit
per-type assignments, so a leave type added afterwards needs an assignment of its own instead of
inheriting the company's base chain. That is inherent in the Assignment Template model — its assign form
requires at least one leave type — and it is the price of having one place to configure approvals. Tell
the customer before you run `--apply`, not after.

### Switching a platform-scoped setting on (until slice 7)

Four keys in `packs/catalog.ts` are `scope: 'platform'`, which migration 0313 enforces in Postgres: the
`tenant_setting_write` policy requires `scope='tenant'`, so **`ai_hr_app` can never write them** and no
screen in the product can either. That is deliberate — `payroll.reset_enabled` and
`payroll.unlock_enabled` reopen or wipe a finalised payroll run, `audit.hash_chain_enabled` is the
tamper evidence itself, and `feedback.ai_planning_enabled` is operator tooling rather than a customer
feature. The plane that will manage these properly is ADR-0077 slice 7.

Until then the only writer is the **owner** connection, by hand. `feedback.ai_planning_enabled` in
particular has no other path at all: it is absent from 0313's backfill, absent from
`LEGACY_ENABLED_SETTINGS` (so the reconcile script never emits it), and excluded from the install
defaults, so `scripts/feedback-plan.ts` and the admin "generate plan" button stay off for every tenant
on every deployment until someone runs this:

```bash
psql "$MIGRATION_DATABASE_URL" -c \
  "INSERT INTO tenant_setting (tenant_id, key, value, source)
   VALUES ('<TENANT-UUID>', 'feedback.ai_planning_enabled', 'true'::jsonb, 'platform')
   ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value"
```

Substitute the key to switch a different platform setting on, and `'false'::jsonb` to switch one off.
Do **not** use this for `audit.hash_chain_enabled`: that gate is still read from the environment until
slice 8 (see `DEFERRED_ENV_GATES`), so a row for it changes nothing today, and ADR-0030 §3 requires a
historical backfill that is not built before the chain can legitimately be turned on for an existing
database.

## Optional: HTTPS / cleaner URL

No domain is required to run, but to remove the plain-HTTP caveat you can either:
- put **Caddy** or **nginx** in front (needs a domain for a real cert), or
- run **`cloudflared tunnel --url http://localhost:3000`** on the server (free HTTPS URL, no domain,
  no open ports) — the same tunnel model as the laptop, but from the always-on box.
