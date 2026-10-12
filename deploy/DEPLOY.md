# Deploying AI HR to a Linux server (gated consultant demo)

New customer/UAT installations must follow [CUSTOMER.md](CUSTOMER.md) and [UAT-HOSTING.md](UAT-HOSTING.md). This legacy guide contains demo-specific Node paths, service accounts and schedules. Do not use them as the customer runtime profile.

A native (no-Docker) deployment for **demo/testing on a public-IP server**. The app sits behind the
`SHARE_PASSWORD` HTTP-Basic gate; testers use the top-bar "act as" switcher for roles.

> **⚠️ Still demo-only.** There is no real authentication yet — the password gate is the only
> protection, and anyone past it is effectively admin. **Do not load real client/employee PII.** Also:
> with a public IP and **no TLS**, the Basic-auth password travels over plain HTTP — use a throwaway
> password, rotate it after the test, and consider the HTTPS upgrade note at the bottom.

## Which deployment is this? — read before step 3 (r290 / readiness 1.1)

This document is the **gated consultant demo** runbook. Use CUSTOMER.md for customer prerequisites, service identity and jobs. Following demo steps 3 and 4 on a customer box can install a fictional Demo Group tenant.

| | gated consultant demo | customer |
|---|---|---|
| env template | `deploy/.env.production.example` | `deploy/.env.customer.example` |
| deploy command | `./deploy/deploy.sh` | `./deploy/deploy-customer.sh` |
| `ALLOW_DEMO_SESSION`, `DEV_TENANT_ID`, `DEV_USER_ID` | set | **absent** |
| `db/seed.ts` (the demo fixture) | seeded on the first deploy | **never runs; not reachable** |
| `--reseed` | wipes and re-seeds the demo | refused |

`db/seed.ts` is not a "sample data" script. It opens with
`TRUNCATE tenant, company, person, employment, … CASCADE` over 24 tables and then writes a fixed
fictional tenant. Before r290 `deploy.sh` ran it whenever the `DEV_TENANT_ID` row was **absent** from
the target database — which on a fresh customer database is always — and hard-required `DEV_TENANT_ID`
before it would start at all. Both are fixed: demo seeding is now an opt-in that requires
`ALLOW_DEMO_SESSION=true` in `.env.production`, `--customer` forces it off, and `db/seed.ts` refuses on
its own account (`db/seed-guard.ts`) if it is ever invoked against a deployment that has not declared
itself a demo, that has WorkOS configured, or whose database already holds a tenant it did not create.

**If you are deploying for a customer, skip steps 3 and 4 and use "Deploying for a customer" below.**

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
  --exclude node_modules --exclude .next --exclude .git --exclude '.env*' --exclude graphify-out \
  ~/Projects/ai-hr/  aihr@YOUR_SERVER_IP:/opt/ai-hr/
```

(Or push the repo to a git host and `git clone` it into `/opt/ai-hr` — either way the app lives in
`/opt/ai-hr`.)

## 2. One-time database bootstrap

Create/store three distinct passwords through the approved secret manager, then run the secure wrapper with PostgreSQL 16+ clients:

```bash
cd /opt/ai-hr
sudo -u postgres deploy/bootstrap-db.sh
```

The wrapper reads owner, application and platform passwords through hidden prompts. For automated secret-manager input use --stdin with exactly three newline-terminated records. Never pass passwords via psql -v arguments, print them or enable shell tracing. Missing/empty input refuses before roles are created. Existing roles are not rotated or certified safe by this bootstrap.

This creates ai_hr owned by ai_hr_owner, the restricted ai_hr_app, the BYPASSRLS ai_hr_platform control-plane role and migration default grants. Do not blanket-grant tables after migrations.

## 3. Configure the environment (gated demo)

```bash
cp deploy/.env.production.example .env.production
nano .env.production
```

Fill in:
- `DATABASE_URL` → `postgresql://ai_hr_app:<APP_PW>@localhost:5432/ai_hr`
- `MIGRATION_DATABASE_URL` → `postgresql://ai_hr_owner:<OWNER_PW>@localhost:5432/ai_hr`
- `AI_CONFIG_SECRET` → `openssl rand -base64 32` (keep it stable — changing it breaks stored AI keys)
- `SHARE_PASSWORD` → a strong throwaway password (you'll give this to the consultant)
- `PORT` → leave as-is
- `ALLOW_DEMO_SESSION`, `DEV_TENANT_ID`, `DEV_USER_ID` → leave as-is **on the gated demo box only.**
  These three are what let `deploy.sh` run the demo seeder. **A customer deployment must not have
  them** — see "Deploying for a customer" below and use `deploy/.env.customer.example`, which does not
  contain them. (This bullet used to read "leave … as-is" with no such qualification, and following it
  on a customer box planted `Demo Group` in their production database on the first deploy.)

> Postgres auth: if `ai_hr_app`/`ai_hr_owner` can't log in with a password, set `scram-sha-256` for
> `127.0.0.1/32` in `pg_hba.conf` and `sudo systemctl reload postgresql`.

## 4. Build, migrate, seed (gated demo)

```bash
./deploy/deploy.sh
```

This installs deps, builds, runs migrations (as the owner), and seeds the demo data the first time
(it skips the seed on later runs so tester data survives; `./deploy/deploy.sh --reseed` forces a reset).

## Deploying for a customer (replaces steps 3 and 4)

Follow [CUSTOMER.md](CUSTOMER.md) in order. Use deploy/.env.customer.example with explicit Keycloak authentication, audit chaining, private verified-TLS database connections and the dedicated customer service. The first customer is created with scripts/bootstrap-customer.ts after migrations; identity enrollment and activation are separate acceptance steps.

Use ./deploy/deploy-customer.sh --migrate-only during initial commissioning. This still installs/builds/migrates/catalog-seeds and stops before restart; it never runs the demo seeder. --reseed is refused. Configure supported Node paths, isolated runtime credentials and customer job definitions from that guide; do not continue into the demo service/cron setup below.

### If you get a refusal from the seeder

`db/seed.ts` exits non-zero with `✗ REFUSING TO SEED` rather than truncating. It fires on any of:
real authentication configured (a non-empty `WORKOS_*`); `NODE_ENV=production` without
`ALLOW_DEMO_SESSION=true`; a `DEV_TENANT_ID` that disagrees with the id the seeder writes; or a
`tenant` table that already holds a row the seeder did not create. On a customer deployment the right
response is never to satisfy the condition — it is that the seeder was invoked at all. Deploy with
`./deploy/deploy-customer.sh`.

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
| `scripts/expire-carry.ts` | `0 3 1 4 *` | Forfeits carried-forward leave, just after the 31 Mar expiry |

All three are idempotent — re-running grants, opens and forfeits nothing extra.

> **REMOVED 2026-08 (c459bff9).** `scripts/expire-aged-leave.ts` (`30 3 * * *`, "Forfeits earned leave past
> its configured age") is GONE, together with the `leave_type.expiry_value` / `expiry_unit` columns it read.
> If you are upgrading a host that already has the crontab installed, **remove that line from the crontab
> BEFORE deploying**, or cron fires nightly at a file that no longer exists. `crontab -e`, delete the
> `expire-aged-leave` line, save.

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
0 3 1 4 * cd /opt/ai-hr && /opt/node20/bin/node --env-file=.env.production --import tsx scripts/expire-carry.ts >> /home/ubuntu/aihr-cron-logs/expire-carry.log 2>&1
0 1 * * * cd /opt/ai-hr && /opt/node20/bin/node --env-file=.env.production --import tsx scripts/capture-usage.ts >> /home/ubuntu/aihr-cron-logs/capture-usage.log 2>&1
30 2 * * * cd /opt/ai-hr && /opt/node20/bin/node --env-file=.env.production --import tsx scripts/anomaly-sweep.ts >> /home/ubuntu/aihr-cron-logs/anomaly-sweep.log 2>&1
```

`capture-usage` runs FIRST, at 01:00, because it meters the day before the other sweeps mutate anything.
`anomaly-sweep` (ADR-0076) runs at 02:30, after metering and before the 03:00 review sweep; it evaluates
every PROCESSED payroll run for anomalies so the exceptions queue is already filled when an operator
opens it. It is **read-only with respect to money** and idempotent — a re-run supersedes its previous
verdicts rather than duplicating them — so a missed night costs nothing and needs no backfill. Add
`--dry-run` to see what it would evaluate without writing.

**The block above is the ORIGINAL plain form and is NOT what the box runs.** Every live job was routed
through `deploy/cron-alert.sh` in r295 so a non-zero exit reaches cron's mail path instead of being
swallowed by a redirect. `crontab -l` is the truth (CLAUDE.md §7); this file has already drifted from it
once. The child-relief job below is written in the wrapper form because that is what was installed.

```cron
15 1 * * * cd /opt/ai-hr && deploy/cron-alert.sh child-relief /home/ubuntu/aihr-cron-logs/child-relief.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/resync-child-relief-grid.ts
```

`resync-child-relief-grid` (b25e421e, r352) runs at 01:15, between metering and the anomaly sweep, and it
is the reason a child's birthday reaches the payslip at all. `employee_statutory_my.num_children` and
`.child_relief_table` are a cached projection of the Family register that the payroll kernel reads, and
`syncChildReliefFromFamily` only ever fired on a dependent add / edit / archive — so the figure aged only
when a human happened to touch the record. This job re-derives it nightly for every employee on `auto`.

It does **not** write the column itself: it calls that same `syncChildReliefFromFamily`, so a resynced row
is byte-identical to what the next family edit would have produced, including the rail that skips anyone on
`manual`, the rail that reports `unchanged` when nothing moved, and the alert raised when a figure moves
while a payroll batch for the current period is still open. That alert is why the job is scheduled BEFORE
the working day rather than during it. It is safe to run more than once — a second run the same night
reports `unchanged` for everyone — and it does not recompute issued payslips; it changes what FUTURE runs
compute. Add `--dry-run` to print whose relief would move without writing, and **read that output before
the first real run**: on a register that has never been resynced, relief moves in both directions.

Installed and verified on 2026-09-28 (r352). The first production run moved nothing — 4 employees on
`auto` across 2 tenants, all four `unchanged`, 0 payroll alerts — so the stored figures already agreed
with the register that day. ⚠️ **`--dry-run` lists who would be examined; it does NOT compute the delta**
(it counts every row as `unchanged` and writes nothing). To see what a run would actually move, read
`num_children` and `child_relief_table` before and after.

First `mkdir -p /home/ubuntu/aihr-cron-logs`. Keep the logs **outside** `/opt/ai-hr`: `improve:release`
rsyncs with `--delete` and would wipe anything it doesn't exclude.

Use the absolute node path — cron's `PATH` does not include `/opt/node20/bin`. Do **not** rely on the
`pnpm leave:*` scripts here: they load `.env.local`, which does not exist on a server.

Verify:

```bash
crontab -l                                   # the five lines
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

## 5c. Alerting and log rotation (readiness 1.6 — NOT installed by deploy.sh)

Three pieces, and only the first is already live after a deploy. The other two are text files in this
repo that **you install by hand**, because both change the crontab or `/etc`, which no automated release
here is allowed to touch.

### `GET /health` — the endpoint to monitor (live after any deploy)

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/health     # 200
```

It is reachable **without** `SHARE_PASSWORD` — an uptime monitor holding the shared demo password would
be a second place that password lives, and most monitors cannot tell a 401 from an outage. It is the
**only** unauthenticated path in the application, and it is an exact match: `/health/anything` is still
gated. Point whatever you monitor with at it, over the same URL the customer uses, and alert on anything
that is not 200.

| It answers | Meaning |
| --- | --- |
| `200 {"status":"ok"}` | Alive, and a real `select 1` on the application pool came back |
| `503 {"status":"unhealthy"}` | Alive and **cannot serve requests** — the database round trip failed |
| `503` + a `SHARE_PASSWORD` text body | The deployment is unconfigured (readiness 1.4). Also an alarm |
| No answer at all | The process is down, or nothing routes to it |

It discloses **nothing else** — no version, no host, no counts, no database error text. The reason a
probe failed goes to the journal instead, where it is already behind ssh:

```bash
journalctl -u aihr | grep 'HEALTH:'
# ✗ HEALTH: the database probe FAILED, ... Reason: connect ECONNREFUSED 127.0.0.1:5999
# ✓ HEALTH: the database probe recovered; /health is answering 200 again.
```

One line per **transition**, not per request, so the line that says when an outage began is not buried.
The probe is bounded to 2 s, single-flighted and cached for 1 s, so polling it hard cannot exhaust the
connection pool.

### `deploy/cron-alert.sh` — make a failing sweep reach a human

Today every crontab line ends `>> …log 2>&1`, which takes stdout and stderr away from cron and therefore
disables cron's only built-in alerting. A sweep that dies at 03:00 writes a stack trace to a file and
nothing else happens. The wrapper moves the redirect inside the job and alerts on a non-zero exit through
three channels: `logger -p user.err` (a priority-3 journal line — a stream that is otherwise **empty** on
this box, so it is either silent or an incident), stdout (so cron mails it if `MAILTO` and an MTA exist),
and `AIHR_ALERT_COMMAND` (optional, your own webhook / `mail` / push — it gets the summary on stdin).

The file ships executable. Rewrite each crontab line so the wrapper owns the log — **there is no `>>` and
no `2>&1` any more, that is the point**:

```cron
MAILTO=ops@example.com
AIHR_ALERT_COMMAND=curl -sS -X POST -d @- https://your-webhook.example/aihr
0 1 * * * cd /opt/ai-hr && deploy/cron-alert.sh capture-usage /home/ubuntu/aihr-cron-logs/usage-capture.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/capture-usage.ts
30 2 * * * cd /opt/ai-hr && deploy/cron-alert.sh anomaly-sweep /home/ubuntu/aihr-cron-logs/anomaly-sweep.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/anomaly-sweep.ts
0 3 * * * cd /opt/ai-hr && deploy/cron-alert.sh review-sweep /home/ubuntu/aihr-cron-logs/review-sweep.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/review-sweep.ts
0 2 1 * * cd /opt/ai-hr && deploy/cron-alert.sh accrue-earned /home/ubuntu/aihr-cron-logs/accrue.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/accrue-earned.ts
0 3 1 4 * cd /opt/ai-hr && deploy/cron-alert.sh expire-carry /home/ubuntu/aihr-cron-logs/expire-carry.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/expire-carry.ts
* * * * * cd /opt/ai-hr && deploy/cron-alert.sh provision /home/ubuntu/aihr-cron-logs/provision.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/provision-runner.ts
30 3 * * * cd /opt/ai-hr && deploy/cron-alert.sh entitlement-alarm /home/ubuntu/aihr-cron-logs/entitlement-alarm.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/entitlement-alarm.ts
```

The last line is **readiness 2.1 (r296) and it is a DETECTOR, not a sweep** — it changes nothing, and
every transaction it opens is `SET TRANSACTION READ ONLY`, so the server refuses a write from it. It is
the only job here whose non-zero exit is a statement about the CUSTOMER'S DATA rather than about the job,
so it carries three codes and the wrapper prints the number in its own summary:

| exit | means | what to do |
| --- | --- | --- |
| `0` | every tenant checked, entitlement tables in force everywhere | nothing |
| `3` | at least one tenant resolves nobody to any leave entitlement | read the alarm lines, restore the tables |
| `2` | the check could not answer for at least one tenant | the answer is INCOMPLETE — fix the check first |

It exists because one admin edit zeroed a live tenant's entitlement engine on 2026-09-12, it stayed down
for a day, and nothing raised an alarm; nobody would have noticed until an employee was refused leave.
A brand-new tenant, a tenant mid-setup and a deliberately retired rule all stay SILENT by design — see
`core/entitlement-alarm.ts` for each predicate and what it deliberately does not cover.

**Its alarm is STANDING**, which is why it is its own job and not folded into `review-sweep`: the
condition is still true tomorrow night, so it pins its own exit code non-zero until a human fixes the
configuration — and therefore its own heartbeat stale. On any other job that would break the staleness
signal below; here it is the same incident reported twice, and the alarm itself is the louder half.
Read `heartbeat/entitlement-alarm` as "last CHECKED AND CLEAN", not as "last ran".

Read it back with `crontab -l` — never trust the install command; a sweep has gone missing from this
crontab before. Then prove the alarm works by failing a job **on purpose**, which is the only way to know:

```bash
cd /opt/ai-hr && deploy/cron-alert.sh selftest /home/ubuntu/aihr-cron-logs/selftest.log sh -c 'exit 7'
echo "exit=$?"                                        # 7 — the status survives
journalctl -t aihr-cron -p err -n 5 --no-pager        # the alert line
```

**A job that stops running has no exit code**, so no wrapper can see it — and `scripts/review-sweep.ts`
records that it was absent from this crontab for six weeks while every log looked fine. Each successful
run therefore touches `/home/ubuntu/aihr-cron-logs/heartbeat/<job>`, and staleness is the signal for that
class. Schedule the check separately, against whatever interval each job should meet:

```cron
7 * * * * find /home/ubuntu/aihr-cron-logs/heartbeat -name provision -mmin +10 -exec sh -c 'echo "AI HR: provision runner has not succeeded in 10 minutes" | logger -t aihr-cron -p user.err' \;
17 6 * * * find /home/ubuntu/aihr-cron-logs/heartbeat -name entitlement-alarm -mmin +2880 -exec sh -c 'echo "AI HR: the entitlement alarm has not completed cleanly in 48 hours" | logger -t aihr-cron -p user.err' \;
```

The entitlement-alarm window is **48 hours, not 25**, precisely because its heartbeat means "checked and
clean": a single night's standing alarm must not also page somebody about staleness. Two consecutive
nights without a clean run is either a real outage nobody has fixed or a job that has stopped running,
and both deserve the line. `/admin/scheduled-actions` carries a card for it either way, so a job that was
never installed reads "Never run" inside the application instead of only as a missing file on the box.

### `deploy/logrotate-aihr` — bound the log files

Nothing rotates them today; `/etc/logrotate.d` on the box has entries for nginx, postgresql, rsyslog, ufw
and zabbix-agent and **none for ai-hr**. `provision.log` had reached 81,847 lines on its own.

```bash
sudo cp /opt/ai-hr/deploy/logrotate-aihr /etc/logrotate.d/aihr
sudo chown root:root /etc/logrotate.d/aihr && sudo chmod 0644 /etc/logrotate.d/aihr
sudo logrotate --debug /etc/logrotate.d/aihr     # dry run — prints what it would do, changes nothing
sudo logrotate --force /etc/logrotate.d/aihr     # once, now; then read the directory back
ls -la /home/ubuntu/aihr-cron-logs/
```

Two traps, both silent. The installed filename **must not contain a dot** (logrotate's `tabooext` skips
such files without a word), and the `su ubuntu ubuntu` line inside must stay — without it logrotate
refuses a group-writable directory it does not own and simply does nothing. The config keeps the journal
itself out of scope: that is journald's own `SystemMaxUse`, not this file's.

### What is still NOT covered

**Application 5xx does not reach anybody.** Next writes its errors to stdout, which systemd files at
priority **info**, so `journalctl -u aihr -p err` is empty even during an incident — over seven days it
returned zero entries while the log held a `ChunkLoadError` storm, eight `Failed query` lines and four
`ENOENT .next/server/pages/500.html`. Nothing in this repo changes that yet; see readiness 1.6.

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

## Backups, restore and rollback

**Read this before the first real employee record exists.** This document ran to 28 KB without the
words backup, restore or rollback appearing once, and the box matched: as of 2026-09-16 `crontab -l`,
`/etc/cron.d`, `/etc/cron.daily` and `systemctl list-timers` contain **no dump job**; `archive_mode` is
`off` and `wal_level` is `replica`, so there is **no point-in-time recovery**; and the eight dumps in
`/home/ubuntu` are ad-hoc pre-migration artefacts sitting on the same disk as the database — the one
failure a backup exists for is the one that takes them with it. The only restore anyone has rehearsed
failed (`/home/ubuntu/rehearsal-restore.log`: `database "ai_hr_rehearsal" does not exist`).

Two scripts exist for this. **Neither is installed.** Installing them is the two decisions below.

### What the owner has to decide first

1. **Where the backups live.** `BACKUP_DEST` has no default and `scripts/backup-db.sh` refuses to run
   without it — a local path is refused too, unless you pass `BACKUP_ALLOW_LOCAL_DEST=1` to say the
   path is somewhere other than this disk. Cheapest workable answer: another machine you can ssh to,
   `BACKUP_DEST=user@host:/srv/ai-hr-backups`, which needs no software beyond rsync and a key. Object
   storage is supported through `BACKUP_SHIP_CMD` (your uploader, your credentials); nothing in this
   repo picks a provider or holds a key.
2. **When it runs and who hears about a failure.** Nothing here schedules anything, and readiness 1.6
   owns the alerting. Until somebody is nominated, a failed backup is a line in a log nobody reads.

Two more, if the customer's tolerance requires them: **point-in-time recovery** (`archive_mode=on` plus
somewhere to put the WAL, or a streaming replica — a dump-only arrangement loses everything written
since the last dump), and **how long backups are kept**, which is a retention default here and may be a
contractual number for them.

### Taking a backup

```bash
cd /opt/ai-hr && set -a && . ./.env.production && set +a &&   BACKUP_DATABASE_URL="$MIGRATION_DATABASE_URL"   BACKUP_APP_DATABASE_URL="$DATABASE_URL"   BACKUP_DEST=user@host:/srv/ai-hr-backups   scripts/backup-db.sh
```

It picks a `pg_dump` at least as new as the server (the box has 16.15; a dump taken with an older
client is a restore failure deferred to the worst possible day), takes the dump and MEASURES the
database in the same snapshot, writes a `.manifest` beside the `.dump`, ships both, reads the size back
to prove they arrived, and prunes old backups **at the destination** — never below
`BACKUP_RETAIN_MIN` (default 7) however old they are. It exits non-zero on every failure with a
stage-specific code, writes a status file, and ends every run on one
`BACKUP_RESULT=PASS|FAIL stage=… exit=…` line. For cron, alert on the exit code AND on the status
file's `at` field going stale — a non-zero exit cannot tell you the job never ran.

Run it away from a deploy window: `pg_dump` holds `ACCESS SHARE`, so a migration's `ALTER TABLE` will
wait behind it. Safe to run twice (it takes a lock and refuses rather than overwriting).

### Rehearsing the restore — the half that matters

**An untested backup is not a backup.** `scripts/restore-rehearsal.sh` restores a backup into a scratch
database and then decides whether the result is USABLE, which is not the same as present:

```bash
REHEARSAL_DATABASE_URL="$MIGRATION_DATABASE_URL" REHEARSAL_APP_DATABASE_URL="$DATABASE_URL"   scripts/restore-rehearsal.sh --dump /path/to/ai_hr-ai_hr-20260916T010000Z.dump
```

It checks the archive against the manifest's checksum, refuses a `pg_restore` too old for it, CREATES
the scratch database and proves it can connect to it *before* invoking `pg_restore` (the 2026-09-11
failure), restores with `--exit-on-error`, then diffs the restored database against the manifest —
tables, exact row counts, RLS flags, policy counts, the drizzle watermark — and finally connects **as
the application role** to check that it can read what it could read before, and that with no tenant
context it reads nothing. That last check is the one a superuser's inspection can never make: a restore
that loses the `GRANT`s is a database `psql` reads perfectly and the product cannot read at all.

It times the restore and appends one line per run to `$REHEARSAL_LOG`. That line is the recovery-time
objective; the manifest's `taken_at` is the recovery point. Both are numbers you can quote to a
customer only after this has actually run.

Rehearse on the server or on a machine you would call production. A production dump is real salaries
and identity numbers; restoring one onto a laptop is a PDPA problem, not a testing convenience.

### Rollback

- **Code.** `improve:release` rsyncs; the previous release is the previous commit on `main`. Roll back
  by re-syncing that commit and re-running `./deploy/deploy.sh` (or `deploy-customer.sh`).
- **Schema.** There are no down-migrations in this repo, by design. A schema rollback IS a restore:
  take a backup with the script above BEFORE a risky migration, and if it goes wrong restore that
  backup into a new database and repoint `DATABASE_URL` / `MIGRATION_DATABASE_URL` at it.
- **Before a risky deploy**, run the backup manually and rehearse it. `deploy.sh` does **not** take one
  automatically and deliberately: a pre-deploy dump whose destination was unreachable would either
  block every deploy or fail quietly, and neither is a decision this repo should make for you.

## Updating later

On a customer deployment, re-sync the code (step 1) and re-run `./deploy/deploy-customer.sh`. The rest
of this section is the gated demo's.

Re-sync the code (step 1) and re-run `./deploy/deploy.sh` — it rebuilds, applies any new migrations,
keeps the data, and restarts the service. Reset the demo with `--reseed`. `--migrate-only` stops after
the migrations and the catalog seed, without seeding demo data or restarting, for a deploy that needs a
manual step in between (see the entitlement-parity one-shot below); run it again with no arguments to
finish.

### Asking the box what happened to its last deploy (r291 / readiness 7.1)

A deploy takes minutes, and from outside the box a deploy that is RUNNING, one that FINISHED, and one
that DIED PARTWAY all look the same: no output, a URL that still answers, a service that is still up.
`deploy.sh` now records itself, and the box will tell you which it was:

    ssh -p 8288 ubuntu@<host> 'cd /opt/ai-hr && deploy/deploy-state.sh status'

    state=ok | running | failed | died | incomplete | unknown
    phase=preflight|install|audit-chain|build|migrate|catalogs|seed|restart|migrate-only
    ref=<the source ref improve:release shipped>     built_ref=<what .next was built from>
    build_id=<.next/BUILD_ID on disk>                built_build_id=<what the last clean deploy built>
    stale_build=0|1                                  log=<the full output of that deploy>

- `failed` — deploy.sh exited non-zero; `exit_code` and `phase` say where (an OOM in `next build` is
  `phase=build`). `died` — nothing finalized the record and the recorded pid is gone: SIGKILL, the OOM
  killer, or a reboot. `incomplete` — a release announced itself and deploy.sh never started, so the
  rsync was interrupted. `unknown` is never read as success.
- **`stale_build=1` means the source on disk is not what `.next` was built from.** The service keeps
  serving the OLD build until it is restarted, so this is recoverable: fix the cause and re-run the
  deploy. Do **not** `systemctl restart aihr` first.
- State lives in `/var/tmp/aihr-deploy` (`AIHR_DEPLOY_STATE_DIR` to move it), outside `/opt/ai-hr`
  because `improve:release` rsyncs that tree with `--delete`.

`pnpm improve:release` launches the deploy detached (`setsid nohup … &`) and follows it by polling, so
a Ctrl-C or a dropped connection stops the watching, not the deploy — and a remote failure still makes
the local command exit non-zero. Running `deploy.sh` by hand over SSH, do the same and keep the state
readable:

    cd /opt/ai-hr && LOG=/var/tmp/aihr-deploy/deploy-$(date -u +%Y%m%dT%H%M%SZ).log && mkdir -p /var/tmp/aihr-deploy \
      && AIHR_DEPLOY_LOG="$LOG" setsid nohup ./deploy/deploy.sh > "$LOG" 2>&1 < /dev/null & \
      echo "$LOG"
    # then: tail -f "$LOG"   and   deploy/deploy-state.sh status

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

### Provisioning the platform plane on an EXISTING install (ADR-0077 slice 7)

If `ai_hr_platform` is missing — which is the case on any database bootstrapped before the role was
added to `bootstrap-db.sql`, and on any install that followed the old two-password instructions above:

```bash
sudo -u postgres psql -d ai_hr -At -c "select rolname from pg_roles where rolname like 'ai_hr%'"
```

Two rows instead of three means the plane was never provisioned. Fix it with:

```bash
bash deploy/provision-platform-role.sh          # run on the server, as the deploy user
```

**Re-running `bootstrap-db.sql` is NOT sufficient, and this is the whole reason the script exists.**
Migration `0351_platform_plane.sql` wraps every one of its `GRANT`s in
`IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_hr_platform') THEN RAISE NOTICE; RETURN`.
On a database where the role was absent when `0351` ran, that guard fired and **every grant was
skipped** — and drizzle has recorded `0351` as applied, so it will never run again. Creating the role
on its own therefore yields a role that can log in and read nothing. The script creates the role *and*
replays `0351`'s grant list, then verifies the boundary (it asserts SQLSTATE `42501` specifically, so a
probe that fails for an unrelated reason cannot masquerade as a boundary).

It is idempotent, refuses to run twice, backs up `.env.production`, generates the password on the host
so it never reaches a transcript, and derives `PLATFORM_DATABASE_URL` from `DATABASE_URL` so the host,
port and database name cannot drift. No service restart is needed — `db/platform.ts` is imported only
by `scripts/platform-usage-report.ts`.

To undo:

```bash
sudo -u postgres psql -d ai_hr -c 'DROP OWNED BY ai_hr_platform; DROP ROLE ai_hr_platform;'
# then remove the PLATFORM_DATABASE_URL line from .env.production
```

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
