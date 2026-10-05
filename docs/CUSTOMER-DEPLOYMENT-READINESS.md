# Customer deployment readiness — checklist and verdict

Surveyed 2026-09-12 against `main@2ad18fe2` and the live box, read-only, by four parallel surveys
(features · security · statutory · operations). Raw findings, with file:line and SQL for every claim, are
the four files this document summarises; re-derive anything you intend to act on.

Published as a tickable checklist (shared state, survives reloads) at
https://claude.ai/code/artifact/db91c3d8-a733-4844-ac46-843873b245c1

**Every claim here is one of: FACT (verified in code or live data) · OBSERVATION · UNKNOWN.** Nothing was
carried over from prose. `docs/HANDOFF-HISTORY.md` was used only as an index of where to look.

## Verified corrections — 2026-10-05

**Scope.** Code was inspected at `main@2c1c47d6`; this documentation audit did not rerun tests or conduct a
customer rehearsal. The live facts below were supplied by the coordinating deployment audit's read-only
checks on the same date. Sections without a 2026-10-05 verification retain their original survey findings
and require revalidation before action. Older measurements are historical evidence, not current capacity proof.

- **FACT — deployment parity:** local and remote migration journals both contain 417 applied migrations.
  Application source checksums match; the differences are generated TypeScript build metadata and scratch
  PDFs. Source parity does not itself prove that the running build is current or secure.
- **FACT — customer controls still open:** the live deployment has `ALLOW_DEMO_SESSION=true`, no WorkOS
  environment variables or real WorkOS subjects, and no audit-chain flag; 16,551 events exist, zero chained.
  There is no scheduled backup, `BACKUP_DEST` is absent and PostgreSQL has `archive_mode=off`. A successful
  restore of a current production backup was not established by this audit.
- **FACT — partial operations controls:** eight jobs use the installed cron-alert wrapper; provisioning and
  entitlement heartbeat checks and user-level log rotation are scheduled. `AIHR_ALERT_COMMAND` is absent:
  local failure records are not proof that a human receives alerts. All 185 public tables have RLS enabled
  and `ai_hr_app` is `NOBYPASSRLS`; these flags alone do not prove every authorization path.
- **FACT — runtime separation gap:** the environment file is mode 600, but the active `aihr` service's
  `UnsetEnvironment` is empty. The repository's owner-credential exclusion is not installed on the live
  service. Install and verify runtime exclusion of migration/owner credentials before customer data.
- **FACT — capacity baseline:** the current shared host has 2 vCPU and 3,915 MiB RAM. The user confirmed
  4,000 employees at launch, growing gradually. Neither the current host nor proposed replacements have a
  measured 4,000-employee capacity result; clock-in bursts and payroll jobs must be included in the test.
- **FACT — implemented code:** filing acknowledgment, submitted/amended state, filing reversal and filed
  warnings exist (3.2). Each attendance holiday-loader invocation resolves distinct calendar input groups, rather than
  blindly once per employee (7.2). These fixes do not establish an accepted customer filing or a complete
  immutable payroll correction workflow (3.4).

**Release requirements remain:** real authentication and customer provisioning, audit-chain activation
before the first customer write, off-box backups and a timed restore, confirmed human alerts, stable
controlled hosting, runtime credential separation, customer payroll/filing rehearsals and a production-like
4,000-employee load test. The multi-replica requirements in 7.3 must be met before adding app replicas.

---

## THE VERDICT

**The product is further along than its own documentation says, and further from a paying customer than
its feature list suggests.** Those are two different statements and both are true.

**What is implemented, with prior verification recorded below.** The payroll calculation engines (EPF, SOCSO/SKBBK, EIS, PCB with
replayed accumulators, HRDF, zakat) are golden-tested against the agencies' own worked examples. Tenant
isolation has a database backstop: `ai_hr_app` is `NOBYPASSRLS` and 185 of 185 public tables carry RLS
(2026-10-05). The original survey's live probe returned zero rows without a tenant context and zero
foreign-tenant rows with one; that historical probe is not a fresh exhaustive authorization test.
Migration safety is unusually good — a shadow-migrate gate against the live schema shape, plus an upgrade
rehearsal against a populated baseline. The original survey recorded 119 successful sweep runs and six
employee imports; those counts are historical demo evidence. Real authentication (WorkOS) is implemented:
login, callback, invitation, password reset, an auth audit writer, and a six-step cutover runbook.

**What stands between here and a customer.** The live deployment remains in demo mode without WorkOS
configuration. A guarded customer deploy path exists (1.1), but customer cutover is not complete. Backups
are not scheduled, audit chaining is off, and installed local alert/log-rotation machinery has no verified
human delivery (1.2–1.6). Filed state and acknowledgments are implemented (3.2); accepted customer filings,
a customer payroll reconciliation and recovery rehearsal remain unverified. The existing shared host is
not proven for the confirmed 4,000-person launch, and several screens still read or send the full employee
population (7.2). Runtime owner-credential exclusion and multi-replica coordination also remain open.

**Recommendation.** Complete and verify Part 1 before loading real employee data. Use the 4,000-person
workload to validate the proposed hosting resources, then complete customer payroll and filing rehearsals.
This audit provides no release-date estimate and does not certify the current deployment for customer use.

---

## PART 1 — BEFORE ANY REAL EMPLOYEE DATA TOUCHES THE SYSTEM

These are ordered by dependency, not by severity. Two of them cannot be done later.

### 1.1 Fix the deploy path so it cannot seed demo data — DO THIS FIRST
**Historical defect, fixed by r290 below.** At the original survey, `deploy/deploy.sh:40` hard-required
`DEV_TENANT_ID`, and `:174-177` ran `db/seed.ts` (the demo seeder) whenever that tenant row was absent from
the target database. The old runbook instructed the operator to leave demo variables "as-is", allowing
demo data into a customer database. The implemented customer path and seeder guards below close that
documented path; using the separate demo configuration retains the stated residual risk.

- [x] Customer deploy path exists and is documented separately from the demo one — r290:
      `deploy/deploy-customer.sh` (== `deploy.sh --customer`) plus `deploy/.env.customer.example` and
      DEPLOY.md's "Deploying for a customer". It requires no `DEV_TENANT_ID` and cannot reach the seeder.
- [x] `db/seed.ts` refuses to run against a production deployment — r290, `db/seed-guard.ts`: it exits
      non-zero on real WorkOS config, on `NODE_ENV=production` without `ALLOW_DEMO_SESSION=true`, on a
      `DEV_TENANT_ID` that disagrees with the tenant it writes, or on a database already holding a
      tenant it did not create.
- [x] `DEPLOY.md` no longer tells an operator to keep the demo variables — r290.

> **Residual, stated rather than hidden.** `deploy.sh`'s demo branch is gated on
> `ALLOW_DEMO_SESSION=true`, so an operator who copies the DEMO env template onto an EMPTY customer
> database is — in the environment — identical to the demo box, and can still seed. Nothing readable
> distinguishes the two; only the documentation split and the demo template's new header stand in the
> way. It closes properly by deleting the demo deploy path once the consultant demo is retired.

### 1.2 Arm the audit hash chain — THIS ONE IS NOT RETROACTIVE
As of 2026-10-05, production holds 16,551 `domain_event` rows and **zero** are chained. `AUDIT_HASH_CHAIN_ENABLED` is absent
from `.env.production`. There is no backfill: every event written before it is armed is permanently
unprotected (ADR-0030, and `deploy/DEPLOY.md`'s own "there is no way back afterwards").
**Arm it before the first real record is written, not after.** If tamper-evidence is part of what is being
sold, this is the moment it has to happen.

**DECISION RECORDED 2026-09-17 (r295), which is this section's own third checkbox.** The chain stays
**OFF on the gated demo box**, deliberately, and the reasoning is: arming it here protects nothing that
already exists — all 11,195 `domain_event` rows predate it and can never be chained retroactively — while
the box holds only `Demo Group` and `System (auth audit)`, i.e. no real employee data to protect. Arming a
demo box would also burn the one-way door on the wrong deployment: `deploy/DEPLOY.md` states there is no
way back afterwards.

**It MUST be armed on the customer deployment before their first data load, and that is the owner's
action.** `deploy/.env.customer.example` already carries `AUDIT_HASH_CHAIN_ENABLED=true` so the customer
path starts armed rather than needing someone to remember. This decision is reversible for the demo box at
any time; the customer-box requirement is not, which is why it is written down rather than assumed.

- [x] Customer environment template sets `AUDIT_HASH_CHAIN_ENABLED=true`
- [ ] `AUDIT_HASH_CHAIN_ENABLED=true` verified on the customer deployment before first data load
- [ ] Verified: new events carry `chain_seq`, `prev_hash` and `hash`
- [x] Decision recorded for leaving it off on the gated demo — r295; this does not waive the customer requirement

### 1.3 Run the WorkOS cutover
The 2026-10-05 live check found no WorkOS environment variables or real WorkOS subjects and
`ALLOW_DEMO_SESSION=true`. The application remains in demo session mode; a shared password is not
individual employee authentication. Invitation and auth-event counts below belong to the original survey
unless separately dated.

Two live consequences, both measured on the box:
- `/login` sits outside the password gate by design (`lib/auth-routes.ts:14` — `AUTH_ROUTE_PREFIXES`, not
  :15) and returns 200 to anyone. **RE-CHECKED 2026-09-17 (r295): the "publishes every principal's name
  and role" half does NOT reproduce in the served markup** — `curl` of `/login` on the live box returns
  717 KB with **zero** employee codes, zero role strings and zero person-like names. Either it was fixed
  since the survey, or the switcher's identity list is fetched client-side and so is invisible to `curl`.
  **UNRESOLVED, and it needs a browser to settle** — do not treat the original claim as fact, and do not
  treat this re-check as an all-clear either. The route being unauthenticated is not in doubt; what it
  discloses is.
- A single POST to `/login/as` sets the `dev_user` cookie and makes the caller the group admin.

All six steps of `docs/WORKOS-CUTOVER.md` are outstanding. Run the bootstrap invite **before** unsetting
`ALLOW_DEMO_SESSION`, or you lock yourself out.

- [ ] WorkOS provisioned; four env vars set
- [ ] `scripts/auth/bootstrap-invite.ts` run while the demo flag is still on
- [ ] `ALLOW_DEMO_SESSION` and the `DEV_*` variables removed
- [ ] `select workos_user_id from app_user` shows real `user_…` subjects
- [ ] One full invite → activate → sign in → reset cycle exercised
- [ ] `auth.login` events appear in `domain_event`

### 1.4 Make the password gate fail closed — DONE (r290)
`middleware.ts:42`: if `SHARE_PASSWORD` is unset the gate returned without checking anything and the whole
app was open, with no error, no log and no startup refusal. Any username is accepted; only the password is
compared. Once 1.3 is done the gate is redundant, but until then an unset variable must be a hard startup
failure rather than a silent no-op.

**What was built, and where it falls short of the survey's wording.** "Refuses to start" is not something
middleware can do — it is invoked per REQUEST, in the edge runtime, after the server is already listening.
So the refusal is in two places and only the first is a real start-time refusal:

1. `deploy/deploy.sh:61` — `: "${SHARE_PASSWORD:?…}"` beside the `MIGRATION_DATABASE_URL` guard, before the
   install, the build and the migrations. A box whose `.env.production` is missing the variable (or holds
   it empty) is never rebuilt, never migrated and never restarted; it keeps serving the previous, gated
   build. THIS is the arm that refuses.
2. `middleware.ts` — 503 on every route, auth routes included, plus one `✗ SHARE GATE:` line to the
   journal. It cannot refuse to start, so it refuses to serve. This is the backstop for every way the app
   can be started that did not come through `deploy.sh`.

The predicate is `NODE_ENV !== 'development'`, not `=== 'production'`: the open path is the one that has to
be named, so test, and an environment that never set `NODE_ENV` at all, both refuse. `next dev` without a
`SHARE_PASSWORD` is unchanged and is pinned from both sides in `test/share-gate.test.ts`.

- [x] Unset `SHARE_PASSWORD` in a production build refuses to start — deploy refusal + per-request 503;
      verified with a real `next build` + `next start` (503 on `/`, `/login` and with Basic credentials)

### 1.5 Backups, and a restore that has actually been tested
**Current live facts, 2026-10-05:** no backup cron job, no `BACKUP_DEST`, and `archive_mode=off`. Scheduled
off-box recovery and point-in-time recovery are not established. Backup/restore scripts and documentation
now exist, but a successful timed restore of a current production dump was not verified. The original
survey's ad-hoc dumps and failed rehearsal do not establish a recovery-point or recovery-time guarantee.

**What r291 built, and exactly where it stops.** Two scripts, **not scheduled on the live box** —
`scripts/backup-db.sh` and `scripts/restore-rehearsal.sh`, shared plumbing in `scripts/backup-lib.sh`,
documented in `deploy/DEPLOY.md` under "Backups, restore and rollback", and exercised end to end
against a real cluster by `test/r291-backup-and-restore-rehearsal.test.ts`. The survey's findings above
were all re-verified against the live box on 2026-09-16 before anything was written; every one held.

The backup script refuses to run without an off-box `BACKUP_DEST` (a local path needs an explicit
opt-in), takes the dump and MEASURES the database in one exported snapshot so the two describe the same
instant, writes a manifest beside the dump, reads the shipped size back to prove arrival, prunes at the
destination by the timestamp in the filename and never below a floor, and exits non-zero with a
stage-specific code on every failure. It chooses a `pg_dump` at least as new as the server rather than
inheriting whatever is on `PATH`.

**A current production restore remains unverified; the rehearsal is designed to detect failures.**
"Usable" is defined as: the archive is the one the manifest describes; the target exists
and is reachable *before* `pg_restore` runs; `pg_restore --exit-on-error` completes; the schema, exact
row counts, RLS flags, policy counts and drizzle watermark all match the manifest by diff; and **the
application role** — `ai_hr_app`, `NOBYPASSRLS` — reads exactly what it read at backup time with a
tenant context and nothing at all without one. That last clause is the difference between *present* and
*usable*, and it is not decorative: a dump taken with `--no-privileges` restores with no errors, every
table and every row correct, and the product cannot read one row of it. The test suite builds exactly
that dump, plus a truncated one, a byte-corrupted one, one missing rows and one that lost row-level
security, and requires the rehearsal to reject all five.

**What it deliberately does not do.** It does not choose a destination or hold a credential; it does not
schedule anything; and it is **not wired into `deploy.sh`** — a pre-deploy dump whose destination was
unreachable would either block every deploy or fail quietly, and which of those the owner wants is not
this repo's call. `deploy/DEPLOY.md` states the manual sequence instead.

- [x] A backup script that cannot silently write beside the database, verifies arrival, and prunes
      correctly (floor included) — r291, `scripts/backup-db.sh`
- [x] A restore rehearsal that defines and checks "usable", times itself, writes the outcome down, and
      is proven to FAIL on five kinds of damaged backup — r291, `scripts/restore-rehearsal.sh`
- [x] Backup, restore and rollback documented — r291, `deploy/DEPLOY.md` mentioned none of the three
- [ ] Scheduled `pg_dump` with retention, to an **off-box** destination — DECISION REQUIRED: the
      destination (another host over ssh, or object storage through `BACKUP_SHIP_CMD`) and the
      schedule. Until both are chosen, nothing runs and this item is not closed.
- [ ] WAL archiving with base backups, or managed point-in-time recovery, if required by the customer's
      recovery objective — `archive_mode=off` on 2026-10-05. A replica alone is not a historical backup.
- [ ] The rehearsal RUN against a real production dump, and the restore time written down. It has been
      run only against a fixture: production is SELECT-only from here and `pg_dump` against it is
      blocked, so the first real timing has to be taken on the box.
- [ ] Rollback: automatic pre-deploy dump. Documented and deliberately not wired — see above.
- [ ] Somebody nominated to hear about a failed backup (1.6 owns this; without it the status file and
      the non-zero exit go nowhere)

### 1.6 Alerting, so a failure is not silent — PARTLY DONE (r291)
**The state this item found, all of it re-verified on the box on 2026-09-16.** Every one of the six cron
lines redirects stdout and stderr into a file, so cron's own mail path can never fire. There is no Sentry,
OpenTelemetry, pino or winston in `package.json` — the grep is zero — and there was no `/health` route
(`app/admin/leave-config/balance-health` is an unrelated admin screen) and no `logrotate` entry for
ai-hr. A Zabbix agent runs on the host; it reports to `103.13.121.90`, a server this project does not
control, so its rule set is still UNKNOWN from here. The one real thing that already existed is
`/admin/scheduled-actions`, which shows job history to a group admin — pull-only, no run-now, no
notification.

**Two corrections to the survey's own numbers, both found by re-running the commands.**

1. **"77 error lines in the service journal over seven days" is not reproducible, and the truth is
   worse.** `journalctl -u aihr -p err --since '7 days ago'` returns **zero entries**. The breakdown over
   2,076 journal lines is p4 warning 28, p6 info 2,020, p0–p3 **nil**. The string `error` appears on 253
   lines, most of them stack-trace continuations of one `ChunkLoadError` storm. The reason priority 3 is
   empty is the finding: **Next writes its errors to stdout, and systemd files plain stdout at priority
   info**, so no priority-based alert — including a Zabbix `systemd` item — can ever see an application
   error. Real failures went past in that window: eight `Failed query: select "id" from "employment" …`,
   four `Failed to load static file for page: /500 ENOENT`, four `InvariantError: client reference
   manifest … does not exist`, thirteen `AuthRequiredError`.
2. **The provisioning log is unbounded AND undateable.** 81,847 lines / 1,395,146 bytes on 2026-09-16,
   about 17 bytes each, and every one of them is the string `· nothing to do` with **no timestamp**. The
   survey's "about 1,440 lines a day" is the right order (one line per minute), but the sharper problem is
   that after any rotation there is nothing in the file to date a line by.

**What was built (r291), and the one decision inside it.** `/health` is reachable **without** the
`SHARE_PASSWORD` gate and is the only unauthenticated path in the application — a health check behind a
password is not a health check, and most monitors cannot distinguish a 401 from an outage. The opposite
risk, a health check that leaks internals to the internet, is answered by making the endpoint worth
nothing to read rather than by putting it back behind the gate: it returns exactly `{"status":"ok"}` or
`{"status":"unhealthy"}` and nothing else — no version, no host, no counts, no driver error text. The
reason a probe failed goes to the journal, which is already behind ssh.

It does a real `select 1` on the application pool, so **process alive** and **can serve requests** are
different answers: no reply at all means the process is down, `503` means it is up and cannot serve, `200`
means both. There is deliberately no liveness-only URL beside it, because a permanently-200 endpoint is
what someone eventually points the monitor at. The 1.4 fail-closed refusal sits **above** the bypass on
purpose: with `SHARE_PASSWORD` unset, `/health` returns 503 too, because a deployment that refuses to
serve is not healthy. Polling is bounded — 2 s timeout, single-flighted, 1 s cache — so the one
unauthenticated endpoint cannot be used to exhaust the connection pool.

Verified by running, not by reasoning: a real `next build` + `next start` with the gate on answers 200 on
`/health`, 401 on `/people` and 401 on `/health/db`, anonymously; a dev server pointed at a dead database
port answers `503 {"status":"unhealthy"}` and logs `✗ HEALTH: … Reason: connect ECONNREFUSED
127.0.0.1:5999`, with the host and port in the journal and absent from the body.

**At the end of r291**, `deploy/cron-alert.sh` and `deploy/logrotate-aihr` were **written but not installed** — both change the
crontab or `/etc`, which is the owner's to do. Install steps are in `deploy/DEPLOY.md` §5c. The wrapper
moves the redirect inside the job (restoring cron's mail path), alerts through `logger -p user.err`,
stdout and an optional `AIHR_ALERT_COMMAND`, preserves the exit status through all three, timestamps each
run, and touches a heartbeat on success — because a job that **stops running** has no exit code to alert
on, and `scripts/review-sweep.ts` records that it was missing from this crontab for six weeks.

**No observability dependency was added, and that is a recommendation, not an omission.** Sentry or
OpenTelemetry is a vendor, a cost and a data-residency decision about a payroll system; it belongs to the
owner. The dependency-free alternative for application 5xx is `instrumentation.ts`'s `onRequestError` with
a `<3>` syslog prefix (`SyslogLevelPrefix` defaults to true, verified in `man systemd.exec` on the box),
which would put real application errors at priority 3 next to the cron alerts. It was **designed and not
built**: `onRequestError` also fires for `AuthRequiredError`, which is what a normal logged-out visit
produces — thirteen of them in that seven-day window — so shipping it without an error taxonomy would
build an alarm that cries wolf at every anonymous visitor, and a muted channel is worse than none.

**PARTLY DONE 2026-09-17 (r295), on the live box.** All six sweeps now run through
`deploy/cron-alert.sh`: the redirect moved INSIDE the job, so a non-zero exit reaches cron's mail path AND
writes a priority-3 journal line (`journalctl -t aihr-cron -p err`) — a stream that is otherwise empty
here, so it is either silent or an incident. Both arms were proven on the box before being relied on: a
failure exits 7 and logs; a success writes 0 bytes and touches `heartbeat/<job>`. Verified on real traffic
— the minutely provision runner completed through the wrapper with zero spurious alerts.

A heartbeat staleness check runs hourly, because **a job that stops running has no exit code** and no
wrapper can see it: `review-sweep` was absent from this crontab for six weeks while every log looked fine.
Previous crontab backed up at `/home/ubuntu/crontab.pre-r295.20260917-011036.bak`.

**Log rotation IS now bounding the files, by a user-level route — r295.** The ROOT install
(`/etc/logrotate.d/aihr` from `deploy/logrotate-aihr`) is still the right answer and still needs a sudo
password this operator does not hold: `sudo -l` shows `ubuntu` holds `(ALL : ALL) ALL` **with a password**
and NOPASSWD for exactly one command, `systemctl restart aihr`.

But rotation never needed root here. The directory is `drwxrwxr-x ubuntu ubuntu` and every log is
`ubuntu:ubuntu`, so `logrotate` run AS ubuntu has every privilege it needs.
`/home/ubuntu/logrotate-aihr-user` + a user state file now runs daily from the crontab at 04:10.
**Forced once on install: `provision.log` went from 1,404,005 bytes to 0**, archived as
`provision.log-2026-09-17`. Nothing bounded these files before.

The one difference from the root config, and the reason it is a separate file: **`su ubuntu ubuntu` is
deliberately absent.** That directive exists so a ROOT-run logrotate drops privileges; run as ubuntu there
is nothing to drop and logrotate refuses it outright. Adding it back breaks rotation silently.

**IF THE ROOT INSTALL IS EVER DONE, delete the crontab line that drives this** — two rotations racing over
one set of files is worse than either alone. Noted in both the config header and the crontab comment.

- [x] Log rotation configured — user-level r295; scheduled installation reverified 2026-10-05
- [x] Eight cron jobs use the failure-reporting wrapper — installed, reverified 2026-10-05
- [ ] A non-zero job exit and a stale heartbeat reach a nominated human — `AIHR_ALERT_COMMAND` is absent
      on 2026-10-05; local logs/cron output do not prove human delivery. Exercise an end-to-end alert.
- [ ] Application 5xx reaches a human — **still open**; the design is above, the decision is the owner's
- [x] A health endpoint exists — `GET /health`, ungated, database-backed, 503 when it cannot serve.
      **"and is monitored" is still the owner's step**: nothing here points a monitor at it
- [ ] Health endpoint watched by an external monitor with verified human delivery
- [ ] Somebody is nominated as on call

### 1.7 Close the one RLS hole before a second tenant exists — DONE (r290, migration 0465)
`tenant_suspension_window` was the only table of 173 with row-level security disabled, and `ai_hr_app` held
full CRUD on it. It is a control-plane table that should belong to `ai_hr_platform`
(`db/migrations/0453_custom_report_app_grant.sql:19-22`, not `:22-24` — the file is 23 lines). It has
**0 rows**, so nothing had leaked — but it was a cross-tenant read/write hole with no database backstop the
moment it was used.

**Both, not either.** `0465_tenant_suspension_window_control_plane.sql` revokes every privilege from
`ai_hr_app` AND enables RLS with no policy — the `platform_user` shape (0313 + 0351), which is what a
control-plane table with no app-side reader looks like here. A tenant policy was rejected: nothing in
`app/`, `core/`, `lib/` or `packs/` touches this table, so a policy would have to invent a reader that does
not exist. The two real writers, `scripts/apply-dunning.ts` and `scripts/reactivate-tenant.ts`, both require
`MIGRATION_DATABASE_URL` and run as `ai_hr_owner`.

RLS is **ENABLED, not FORCED**, and that is deliberate: `platform_user` is forced because its reader is
`ai_hr_platform` (BYPASSRLS), whereas here the legitimate writers *are* the owner. Forcing would deny them.
None of the six cron jobs mentions this table (`crontab -l`, 2026-09-16) and all six connect as the owner.

The revoke alone would not have been enough: the grant exists only because `deploy/bootstrap-db.sql:72-75`
runs `ALTER DEFAULT PRIVILEGES`, so a re-bootstrap puts it back silently. RLS with no policy is the layer
that survives that, and `test/tenant-suspension-window-rls.test.ts` proves it by handing the grant back
inside a test and watching the app role still read zero rows.

Verified on a scratch database built with the same bootstrap grant: **173 of 173 tables now carry RLS**,
`relrowsecurity=t relforcerowsecurity=f`, no policy, and `has_table_privilege('ai_hr_app', …)` false for
SELECT/INSERT/UPDATE/DELETE. `pnpm gate:shadow` → `SHADOW_RESULT=PASS (381/381 applied against live-shaped
schema)`.

- [x] RLS enabled with a tenant policy, or the grant revoked from `ai_hr_app` — both: grant revoked and
      RLS enabled with no policy (migration 0465)

### 1.8 Stable, controlled exposure
The app listens on `127.0.0.1:3000`. Public access is a Cloudflare **quick** tunnel started by hand on
18 June, not under systemd (`systemctl is-active cloudflared` → inactive), on a random
`*.trycloudflare.com` hostname with no SLA and no access control. If that process dies the customer's URL
changes and nothing restarts it. nginx on the box serves only an unrelated co-tenant application.
The hosting description above is the original survey, not a newly verified public-endpoint inventory.
**Code checked 2026-10-05:** `middleware.ts:106-152` contains no throttle for the shared-password path and
no application-wide limiter was found. Edge protection remains unverified; WorkOS-owned auth protection
must be assessed separately once real authentication is configured.

- [ ] Named tunnel under systemd, or nginx with a real certificate, on a stable hostname
- [ ] Rate limiting at the edge and on the authentication path
- [ ] Decision recorded about sharing a box with an unrelated production system

---

## PART 2 — BEFORE THE FIRST REAL PAYROLL RUN

### 2.1 An admin edit silently zeroed the entitlement engine — RESOLVED BY THE CUSTOMER
**Corrected 2026-09-13.** On 2026-09-12 this tenant had **0 entitlement templates and 0 eligibility rules
in force** and nobody resolved to any leave entitlement. **The reporter restored it themselves that
evening**; measured 2026-09-13, 1 template and 1 rule are in force. The restart SQL that was written for
this is **superseded and must NOT be run** — it clears `valid_to` on rule `e1aa6e06`, which the reporter
deliberately retired at 17:30 that evening, and its own pre-flight guard cannot catch that because the
guard's end-state condition is already true.

The outage is closed. **The finding that survives is the shape of the risk:** one admin edit silently
zeroed the entitlement engine for a whole tenant, it stayed down for a day, and nothing anywhere raised
an alarm. Nobody would have noticed until an employee was refused leave.

**BOTH ALARMS BUILT (r296), AND THE CRONTAB LINE IS THE OWNER'S STEP.** `scripts/entitlement-alarm.ts`
+ `core/entitlement-alarm.ts` check every tenant in good standing, nightly, through
`deploy/cron-alert.sh` — exit 3 on an alarm, exit 2 when the check could not answer for a tenant, and
both reach the priority-3 journal r295 opened. It is a DETECTOR: every transaction it opens is
`SET TRANSACTION READ ONLY`, so the server refuses a write from it, and the test proves the refusal from
inside the module's own transaction rather than asserting it in a comment.

The predicates, and what each deliberately stays silent on:

- **Templates in force dropped to zero** = `templatesInForce == 0 AND templatesStarted > 0 AND
  activeEmployments > 0`, where `templatesStarted` counts versions whose `valid_from <= today` — versions
  that HAVE already been in force. That term is what separates "was configured and is now zero" from
  "never configured": a brand-new tenant has no rows, a tenant mid-setup has only future-dated ones, and
  neither alarms. Retiring one table or rule while anything else is in force leaves the count above zero,
  so the retirement the reporter made on purpose that evening stays silent.
- **A leave type resolves for nobody** = a leave type with at least one table IN FORCE today that not one
  active employee is reached by, asked of `buildTemplateEntitlementResolver.winnerFor` — the engine's own
  answer, including the sole-table (r193) and default-table (76ffdcf2) branches — so it cannot disagree
  with what the engine actually grants. A type with NO table is deliberately excluded: that is the
  position `core/entitlement-scheme-view.ts` already ships to the screen, and on this tenant (1 table
  across nine active leave types) the opposite position would have raised eight findings on night one.
- **Eligibility rules are counted and reported, never alarmed on.** One table in force with no rule
  resolves for EVERYBODY (r193 fault 3), so "rules dropped to zero" would fire on a correct configuration.

Residual, stated rather than glossed: a tenant whose templates were HARD DELETED rather than retired reads
as never-configured and stays silent. `deleteEntitlementTemplate` already refuses a lineage that granted
days, but that guard is an approximation — the ledger records no template reference at all — so closing
this needs the deciding lineage recorded on the grant, which is a schema change and a separate item.

- [x] An alarm for "a leave type resolves for nobody" at tenant scale — built r296
- [x] An alarm for "a tenant's entitlement templates in force dropped to zero" — built r296
- [x] Entitlement alarm and its heartbeat staleness check scheduled — reverified 2026-10-05;
      human alert delivery remains open in 1.6

### 2.2 Master data must be complete before month one
Of 73 rows in `employee_statutory_my`: **30 have no tax number, 31 no EPF number, 47 no SOCSO number,
33 no bank account.** This is correct refusal behaviour — the CP39 builder throws on a missing TIN, and
Borang A/8A block the download — but it means the migration must land every identifier before the first
run. Separately, **31 of 93 payslips carry no EPF basis stamp** and can never be filed from this system.

- [ ] TIN, EPF, SOCSO and bank account present for every employee before month one
- [ ] Import rehearsed on a copy of the customer's real file

### 2.3 Two payroll steps only happen if a human presses a button
Overtime and attendance allowances reach payroll through `prefillOvertimeFromAttendance`, whose only caller
is a button. Nothing recomputes attendance after a shift or rule change except a human visiting
`/attendance/recompute`, a page with no navigation row. Both are acknowledged debt in
`packs/attendance/index.ts:33-37`.

- [ ] Both steps written into the monthly payroll runbook as mandatory, or automated

### 2.4 Payroll configuration that silently defaults
`company_payroll_config` has **0 rows**, so every cut-off window resolves to the plain calendar month and
pay day to month-end, behind a warning on a page you only reach with `?readiness=full`.
`payroll_anomaly_config` is also empty **and there is no admin screen to write it**, so all 2,359 anomaly
findings were classified by thresholds that `core/payroll-anomaly.ts` itself describes as numbers
"nobody should mistake for empirical".

**r292 took the DISCLOSURE arm, deliberately, and did not build a settings screen.** The thresholds are
already editable — company row → tenant row → code default, resolved without a deploy; what is missing is a
form, not a mechanism. A form would not make the numbers empirical (ADR-0076 §6: only real client history or
a shadow run produces a defensible threshold), and it would destroy a signal the product already depends on:
`core/control-tower.ts` derives `thresholdsTuned` from `count(payroll_anomaly_config) > 0` and **refuses to
print a staffing headcount (`impliedOperators`) while it is false**. Ship a form and the first admin who saves
anything at all flips that flag, and the tower starts printing a headcount projection backed by a number with
no more evidence than the placeholder — the exact harm that file's own header names. So the numbers in force
are now stated on `/payroll/<batch>/anomalies`, in the measurement strip above the queue, each tagged
"shipped default" or "set for this company", with a plain statement that a shipped default has no empirical
basis. It is DERIVED from the same resolver the evaluator uses, so it can never name a threshold the engine
did not apply, and the placeholder warning disappears by itself the moment a row supplies that number.

- [ ] Cut-off and pay day configured explicitly per company
- [x] Anomaly thresholds either made editable or disclosed as arbitrary — **disclosed (r292)**, argued above;
      still worth tuning them from this customer's own pay history before relying on the auto-clear rate

### 2.5 A parallel run
Nothing here substitutes for running one real month alongside the customer's existing process and
reconciling to the cent, before anyone relies on it.

- [ ] One month processed in parallel and reconciled

---

## PART 3 — BEFORE THE FIRST STATUTORY FILING

### 3.1 Two PERKESO file builders disagreed, and both were reachable — **consolidated (r296)**
`localization/my/socso-eis-file.ts` zero-padded numerics and wrote a SKBBK box at offset 238;
`lib/perkeso-socso-file.ts` space-padded and had a 20-character filler there instead. Both emitted 278
characters and both downloaded, from two different screens. **The one golden-tested byte-for-byte against a
genuinely accepted PERKESO file is the one with no SKBBK box** — the field that becomes mandatory on
1 October 2026.

**Confirmed and worse than reported.** Generated from both screens against one real July-2026 payroll, the
two files differed in **six character ranges per record** (201-208, 215, 221-222, 227-228, 233-234,
239-244) and again at the end of the file — one wrote a trailing CRLF, the other did not. They also
differed in **which fact filled the salary box**: Reports wrote `payslip.gross_pay`, the Borang 8A screen
wrote `statutory.bases.socsoEis`. And they arrived under two unrelated filenames
(`PERKESO_<digits>_MMYYYY.txt` vs `perkeso-socso-<code>-YYYYMM.txt`). An operator had no way to tell which
of the two they were holding. These are **not two different PERKESO products**: `my.socso-eis` and
`my.borang-8a` are genuinely two different *paper* documents, but ASSIST has **one** combined SOCSO+EIS
upload file, and both screens claimed to produce it.

**What r296 did.** One writer (`lib/perkeso-socso-file.ts`) behind both screens;
`localization/my/socso-eis-file.ts` keeps its query and writes nothing. The difference between the two
layouts is now a **date**, `PERKESO_SKBBK_MANDATORY_FROM = 10/2026`, applied in one function
(`perkesoLayoutForPeriod`): a contribution month before 10/2026 is written to the **accepted** v1.0 layout,
10/2026 onward to v2.0 with the SKBBK box at 239-244. The golden test against the customer's own accepted
file passes **unmodified**. Both screens now produce identical bytes and one filename
(`test/perkeso-one-writer.test.ts`, against a real database).

- [x] One builder behind both screens, golden-tested, carrying SKBBK — **done (r296)**
- [ ] **Establish which layout PERKESO ASSIST accepts.** Still UNKNOWN and still not answerable from this
      repository: v1.0 is a file PERKESO accepted in January 2026; **v2.0 has never been uploaded from this
      system**. On 1 Oct 2026 this system starts writing a layout nobody here has seen accepted — watch the
      first v2.0 upload.
- [ ] **Decide what the 1 Oct 2026 date is measured against.** We compare it to the contribution month and
      say so in code; the specification does not say whether a late or amended return for an earlier month
      filed after the cutover must use v2.0.
- [ ] **Settle Jun–Sep 2026 SKBBK.** SKBBK has been deducted since 1 Jun 2026 and the accepted layout has
      no box for it, so an upload for those months does not pay it. The amount is named in the file's
      validation report and recorded on the artefact as `skbbkNotCarriedCents`; how PERKESO wants it
      settled during the transition is UNKNOWN. (Nothing has been filed yet — see 3.2 — so this is a
      backfiling question, not an outstanding liability created by this system.)
- [ ] **Surface the SKBBK gap on the screen, not only in the validation report.** The report is behind a
      button on the Borang 8A review screen; the Reports download shows nothing. Needs a message key in all
      six locales; not done in r296.

### 3.2 Filed state and acknowledgments — IMPLEMENTED; customer filing unverified
**Code verified 2026-10-05:** `core/reporting.ts:506` implements `markReportFiled`, checking
`payroll.statutory_file` permission, requiring an acknowledgment reference and recording the filing date,
timestamp and actor. It sets `submitted`, or `amended` when a previously filed report for the same company,
type and period exists, and appends an audit event. `reverseReportFiling` (`:633`) requires a reason,
returns the report to draft and preserves the removed filing evidence in its audit event. The actions are
wired in `app/payroll/reports/actions.ts:58-85`.

`core/payroll.ts:1031-1068` now derives `statutoryFiled` from submitted/amended statuses, excluding mere
draft generation. These are application records of a filing; they do not themselves submit to an agency
or prove an agency accepted the artifact. Original survey draft counts are historical.

- [x] Mark-as-filed action records who, when and the acknowledgment reference — verified in code
- [x] `statutoryFiled` distinguishes filed reports from drafts — verified in code
- [ ] Customer filing rehearsal completed, accepted artifact and acknowledgment independently checked

### 3.3 No bank payment file, no e-filing
`localization/my/bank-files/` contains one file, a **2014-vintage** BNM routing table flagged RE-VERIFY
that still lists RBS Malaysia. Three bank formats are named; none has a builder. The CSV that exists says
in its own header that it is not a giro file. There are **zero outbound calls** to any LHDN, KWSP, PERKESO
or MyInvois host. Every payment and every return is a manual key-in today.

- [ ] Customer's bank named, its real bulk-payment spec sourced, one file built and golden-tested
- [ ] BNM routing codes re-verified against PayNet
- [ ] Manual portal key-in accepted and documented, or an integration scoped

### 3.4 A complete filed-month correction procedure remains open
**Code verified 2026-10-05:** additional payroll runs exist, but the filed-period guard
(`core/payroll.ts:1904-1913`, `:1967`, `:3536-3542`; `core/statutory-filed.ts:187`) prevents treating another
run as a general solution once statutory filing/payment evidence exists. EA overrides with reasons and
audit evidence also exist (`core/ea-override.ts:203`), but affect EA fields only, not payroll totals,
CP8D/Form E or an agency amendment workflow.

The gated unlock/reset path still exists. Unlock requires a reason (`core/payroll.ts:8553`); reset deletes
payslip rows before regenerating (`:8306`, `:8374`). A filing reversal or an `amended` report label does
not create immutable contra payroll entries or obtain agency acceptance. A customer correction/refiling
procedure and the customer's unlock/reset policy remain required. The original survey's enabled flags
were not reverified for a customer deployment in this audit.

- [ ] Correction story defined: contra payslip and amended return, or a documented refile procedure
- [ ] Decide whether unlock and reset stay enabled on a customer deployment

### 3.5 The repo's own sign-off gates are still open
`docs/architecture/STATUTORY-SOURCES.md` carries unticked go-live gates: the EPF Part A accountant
sign-off, seven PCB relief figures that are **rate-only from a secondary source** because the LHDN
specification URL now 404s, a TP1 catalogue transcribed from a board attachment rather than retrieved from
hasil.gov.my, and 2026 lunar public holidays still flagged provisional.

- [ ] Each gate signed off against the current official publication, with a name and a date
- [ ] `MY_STATUTORY_VERSION` bumped

### 3.6 One full rehearsal
Twenty-nine payroll runs exist; **two** have ever been closed, both retroactively. Zero off-cycle and zero
adjustment runs have ever been created despite both being valid statuses.

- [ ] One end-to-end rehearsal: process → close → generate every form → submit to each portal → record the
      acknowledgement

---

## PART 4 — LOOKS BUILT, IS INERT

Each of these presents as a working feature. Fix it or disclose it, but do not sell it as-is.

| Feature | Reality |
|---|---|
| **Email notification** | **Still inert; the FALSE CLAIMS about it are fixed, r292.** There is **no email transport anywhere in the repo** — no nodemailer, SMTP, SendGrid, Postmark, Mailgun, SES or Resend, and none in `package.json`. Notifications are in-app only (dispatch inserts a `notification` row; the topbar bell is the only reader), and only **9 of 83** employments have a login at all, so an in-app notice reaches nobody for the other 74. The one real mail is WorkOS's invitation. The survey found one false comment; there were **five** claims in total, all now corrected: `core/notifications.ts:33` ("this path SENDS EMAIL"), the same sentence copied into `test/user-lifecycle.test.ts`, the `notice.published` registry entry crediting a "preference/channel machinery" that does not exist (`notification_pref` and `notification_delivery` have **zero** code references outside `db/schema.ts`), the same entry misquoting the publisher's checkbox as "Send Email Notification" (it reads "Notify recipients when it is published"), `scripts/review-sweep.ts` warning that a green run "does NOT prove mail was sent", and — the only one a customer could see — the on-screen help under that checkbox, which told an HR admin the notice was "Sent through the existing notification settings, so each person's preferences still apply." No transport was added: that is a vendor and cost decision for the owner. `test/r292-notification-channel-truth.test.ts` is a source-shape guard pinning the absence of a transport and the absence of the claim **together**, so whoever adds one is handed the list of comments and copy to revisit in the same commit. |
| **Every AI surface** | No provider is configured: `grep -c API_KEY .env.production` → 0, `ai_provider_config` → 0 rows. All eleven callers resolve null. All three agents default off with no override, and `agent_proposal` is empty across all eight writer sites. The anomaly engine that does work (2,359 findings) is deterministic rules, not a model. |
| **Attendance geofencing** | `geofencing_enabled` is false for **all 83** employments; both its tables are empty. The logic is correct and well tested; it has simply never been switched on, and the enable switch is on the personnel card, not where the navigation points. |
| **Field-level PII encryption** | `pii_key` is empty and `sealForSubject`/`unsealForSubject` have **zero callers**. No field in the product is sealed. Do not represent the product as encrypting personal data at rest beyond what the database itself provides. |
| **Performance goal-setting** | `proposeGoalsAction`, `approveGoalAction` and `lockGoalSettingAction` are imported by no component. The stage does not exist in the interface. |
| **Commercial module gating** | **FIXED r292.** Was: navigation-deep, not service-deep — `assertModuleEnabled()` had **4** call sites in `core/` (assistant-grant, replacement-request ×2, schema-explorer) and `requireModule()` **7** `page.tsx` files of 198; per pack, pages in its route trees vs pages checked were attendance 23/3, payroll 57/1, claims 6/1, performance 4/1, so a customer who declined Payroll could reach 56 of its 57 screens by URL and post to every action behind them. The fix is a MECHANISM, not 86 more page calls: `core/module-gate.ts` binds a module code to `withTenant`, and the five pack service files (`core/claims.ts`, `core/performance.ts`, `core/attendance.ts`, `core/payroll.ts`, `core/payroll-view.ts`) take `withTenant` from it — one import line each gates 165 exported entry points, reads and writes alike, and every function added to those files later. A second gate covers the report axis (`runReportSpec` on the dataset's category), which does not pass through the pack screens at all. `requireModule()`'s deliberate **fail-open** is unchanged and still correct: it is a REDIRECT decision, and bouncing a paying customer to a dashboard during a resolver outage would tell them their module had been removed. 25 new `layout.tsx` segment guards give that clean redirect for whole route trees, and `/?moduleUnavailable=<code>` now actually says which module (it carried the code since slice 4 and the dashboard read it nowhere). What this deliberately does NOT gate: `core/read.ts` (shared kernel — `dashboardStats` reads `payroll_batch` and attendance in one function and the dashboard is core), the `tx`-taking helpers the kernel calls (`markBatchNeedsRecalc`, `currentAdminManager`, `resolveBatchScopeFilter`), `/attendance/travel` (travel_request is declared by no pack, so it is spine at an attendance URL), and BOOTSTRAP contexts carrying `entitlementsExempt` (the seeder and provisioner create the tenant before any entitlement can exist). Verified live: with all four packs deleted from `tenant_module`, 11 pack routes redirect to `/?moduleUnavailable=…` while `/`, `/leave`, `/approvals`, `/admin/personnel`, `/reports`, `/me` and `/attendance/travel` all still render 200. |
| **Knowledge base authoring** | **FIXED r290.** Was: `createArticleAction` on a bare session, composer mounted unconditionally — any employee could publish at any audience up to `hr_admin`. The survey missed a **second** door, `uploadFileAction`, identically exposed. Both are now admin-only via `assertKbAuthor` in `core/knowledge-base.ts`, the composer is absent from the tree for a non-author, and all three writes clamp the audience to the author's own clearance. Note for anyone tempted to remove the guard: `0039_kb_rls.sql`'s INSERT policy is `WITH CHECK (tenant_id = …)` and nothing more — ADR-0017 §3 chose open contribution, so **there is no RLS backstop for a create** and the application guard is the only one. A test pins that a raw INSERT is still accepted by Postgres, so a green refusal test can never be mistaken for RLS doing the work. |
| **The vendor's build queue** | `/feedback` sits in the ungated home group for every authenticated user, showing 815 feedback items with statuses like `building` and `deployed`. Decide whether a customer's staff should see this. |

---

## PART 5 — PER-CUSTOMER ONBOARDING RUNBOOK

The onboarding path exists in code and **has never provisioned anyone**: `tenant_provision_request` is
empty, no `operator` role grant exists, and `/operator` redirects away while demo mode is on. The
provisioning runner has correct concurrency handling (`FOR UPDATE SKIP LOCKED`, claim-before-work, terminal
status in one transaction) and ticks every 60 seconds writing 1.3 MB of "nothing to do".

1. [ ] Part 1 complete on the target box
2. [ ] Operator role granted as `ai_hr_owner`
3. [ ] **Provision a throwaway tenant end to end through the console**, including revealing and redeeming
       the activation link — the first real use must not be the first use ever
4. [ ] Decide the customer's module set; confirm `tenant_module` rows (note the second, undocumented gating
       axis: nine `*_ENABLED` environment flags, and `TOIL_ENABLED=true` today while the module is off)
5. [ ] Import employees (dry-run analyse, then commit — this path is proven, used six times)
6. [ ] Import opening leave balances and payroll history (these two paths have **never run in production**)
7. [ ] Configure company payroll cut-off and pay day, leave types, entitlement tables and schemes,
       approval chains, holiday calendars, shifts
8. [ ] Parallel payroll run, reconciled
9. [ ] First filing rehearsal
10. [ ] Support path agreed — note `/feedback` is a development loop, not a customer support channel

---

## PART 6 — WHAT IS SOLID, AND SHOULD NOT BE RE-LITIGATED

- **Statutory calculation engines** — EPF, SOCSO with SKBBK, EIS, PCB with replayed accumulators, HRDF,
  zakat, all golden-tested against the agencies' own worked examples.
- **Tenant isolation** — `ai_hr_app` is `NOBYPASSRLS`; all 185 public tables carry RLS (2026-10-05;
  0465 closed the historical `tenant_suspension_window` gap); `platform_user` is
  default-deny with no grant; `withTenant` uses transaction-scoped `SET LOCAL`. Verified live.
- **Migration safety** — shadow-migrate against the live schema shape catches drizzle's silent-skip mode;
  the upgrade rehearsal runs against a populated baseline; the audit-chain gate runs before the build.
- **Scheduled work** — eight jobs use the alert wrapper (2026-10-05). The original 119 successful runs
  are historical evidence, not an assertion of no subsequent failures or missed work.
- **Employee import** — analyse-then-commit, six real runs, ~45 optional columns, XLSX supported.
- **Leave engine** — the deepest module in the product, and the most heavily tested.

Note one accepted consequence: no table is `FORCE ROW LEVEL SECURITY`, so `ai_hr_owner` bypasses RLS
entirely. Privileged maintenance jobs must remain separate from web processes. The repository service
excludes the migration credential, but that exclusion is not active on the live service (2026-10-05);
verify runtime separation, not only the application's chosen connection string. Jobs using owner access
depend on application-layer scoping with no RLS backstop for that role.

---

## PART 7 — CAPACITY

### 7.1 The server has no build headroom — measured 2026-09-13
The box has **3.8 GiB of memory in total**. During its own deploy typecheck it ran down to about
**105 MiB available**, with a single Next.js worker holding 2.7 GB. The build survived, but there is no
margin: the next dependency that grows the build tips a deploy into an out-of-memory failure. That is
survivable today only because `deploy.sh` builds before it migrates, so a failed build leaves the database
untouched and the old service running.

Two related facts from the same deploy — **both closed in r291**, and recorded here as they stood.
`pnpm improve:release` did **not** detach the remote `deploy.sh` (`scripts/improve/release.ts:83`), so
anything that killed the local release process killed the server build with it, and the board was left
saying the work did not ship when it did. On 2026-09-16 a dropped SSH connection did the inverse twice in
one session: the local release hung on a dead socket long after the box had built, restarted and gone
healthy, and the board had to be transitioned by hand. And a build interrupted either way left new source
on disk beside a stale `.next` build id, which nothing on the server detected or reported.

What r291 changed:

- The remote deploy is launched `setsid nohup ./deploy/deploy.sh > <log> 2>&1 < /dev/null &` and followed
  by **polling** — one independent SSH round trip every few seconds asking for the log bytes not yet seen
  plus a state block. A killed local process, a Ctrl-C or a dropped connection now stops the *watching*,
  not the deploy; the follower reconnects rather than giving up, and gives up loudly (non-zero) rather
  than reporting a success it did not observe.
- **The box reports on itself.** `deploy/deploy-state.sh` records each deploy in `/var/tmp/aihr-deploy`
  (outside the rsynced tree), and `deploy/deploy-state.sh status` distinguishes: `running` · `ok` ·
  `failed` (deploy.sh's EXIT trap caught a non-zero exit, with the code and the phase) · `died` (no
  result and the recorded pid is gone — SIGKILL, the OOM killer, a reboot) · `incomplete` (a release was
  announced and deploy.sh never began: an interrupted rsync) · `unknown` (no record, never read as ok).
  `stale_build=1` is the mixed-tree signal on its own: the source ref on disk differs from the ref
  `.next` was built from, or the `.next/BUILD_ID` on disk is not the one the last clean deploy recorded.
- A remote failure makes the local `improve:release` exit **non-zero** and marks nothing deployed.

The memory headroom itself is unchanged — an OOM during `next build` is now *reported* rather than
silent, but the box still has no margin.

- [ ] Raise the server's memory, or build elsewhere and ship the artifact
- [x] Detach the remote deploy so a local failure cannot kill it — r291
- [x] A deploy that fails partway is detected and reported, rather than left mixed — r291

### 7.2 Pagination and payloads — historical measurements, current 4,000-person launch risks

**2026-10-05 scope:** the measurements below are the 2026-09-17 r297 workstation results. They predate the
attendance holiday fix and are not a benchmark of the current production build, proposed infrastructure
or 4,000-person workload. Historical threshold estimates below must not be used as launch capacity limits.

`lib/pagination.ts:124` (`paginateRows`) slices an already-loaded array, across **31 call sites** — not the
61 recorded here before, which counted import lines and the definition as well as calls. Production holds 84
employments, 93 payslips and 29 payroll runs, with **at most 19 payslips in any single run**, so the table
this item names has never drawn more than 19 rows.

**The UNKNOWN is answered, and the premise was too narrow.** `rows.slice()` is never the cost, and there is
no single row count: three different costs sit around the slice, their thresholds an order of magnitude
apart, and the worst screen fails for a reason that is not pagination at all.

**Budget, fixed before measuring.** Server render **≤ 1,000 ms** (Nielsen's 1 s limit on uninterrupted flow
of thought; equally, 1,000 ms of a 2,500 ms "good" LCP leaves 1,500 ms for transfer and paint), AMBER to
3,000 ms, RED beyond. Row-dependent document growth **≤ 1.0 MB**, judged on the bytes that scale with row
count, above the dev server's fixed ~0.8–0.95 MB framework floor.

**Method, repeatable.** Scratch database `ai_hr_r297page` cloned from `ai_hr_dev` and seeded **additively**
(nothing truncated) with tenants of 100 / 1,000 / 10,000 employments and payroll runs of 25 / 100 / 1,000 /
10,000 payslips, each payslip carrying a `statutory` jsonb sized to production's measured 1,027-byte average.
Driven against `next dev` on port 3297, tenant switched with the `dev_user` cookie, each route warmed twice
then the median of three `curl` timings; the read timed separately by calling `core/payroll.batchDetail`
through the real drizzle path as the app role with RLS on. Database dropped afterwards. **These numbers are
optimistic:** local Postgres runs on a RAM disk with `fsync=off` on an 11-core workstation, while production
is 2 vCPU with 3.9 GB (7.1). Expect the box to be slower, not faster.

**The read scales exactly linearly** — ~0.139 ms and ~1,195 bytes of JSON per payslip row:

| payslips in the run | read | full array as JSON | rendered page as JSON |
|---|---|---|---|
| 25 | 7 ms | 29 KB | 29 KB |
| 100 | 19 ms | 119 KB | 29 KB |
| 1,000 | 141 ms | 1.19 MB | 29 KB |
| 10,000 | 1,395 ms | 11.96 MB | 29 KB |

**End to end** (median of three, warmed; document bytes include the dev framework floor):

| screen | 100 | 1,000 | 10,000 |
|---|---|---|---|
| `/payroll/<batchId>` | 0.21 s / 905 KB | 0.27 s / 906 KB | 1.57 s / 906 KB |
| `/admin/loans` | 0.25 s / 824 KB | 0.17 s / 1.13 MB | 0.97 s / 4.16 MB |
| `/admin/personnel` | 0.22 s / 973 KB | 0.32 s / 1.15 MB | 1.78 s / 2.87 MB |
| `/attendance/daily` | 0.70 s / 960 KB | ~10 s / 1.17 MB | **did not finish in 14 min** |

**1. A server-side slice is cheap, and the over-fetch never reaches the browser.** On `/payroll/<batchId>`
the document is FLAT at ~906 KB from 25 rows to 10,000 — only the 25 visible rows are rendered. The whole
cost is the read, so the page crosses 1,000 ms at **≈ 5,800 payslips in one run** (fit: 190 ms + 0.139 ms × n)
and 3,000 ms at ≈ 20,000. Production's largest run is 19. This is the least urgent of the three.

**2. A client-side slice ships every row to the browser, and `ALL_ROW_CEILING` does not stop it.** Twelve of
the 31 call sites sit inside `'use client'` components, so the full array is serialised into the RSC payload
before `paginateRows` ever runs. `/admin/loans` grows **+337 bytes per employee** and `/admin/personnel`
**+192**, reaching 1 MB of row payload at roughly 3,000 and 5,200 employees. Note that `/admin/personnel`
**already server-pages its list** (`listEmployeesPage`) and still ships every employee, because
`listEmployees` separately feeds the client-side `EmployeeSwitcher`: server-paging a list does not by itself
stop a screen shipping the whole population. The user-reachable worst case is one click — `?size=all` on a
10,000-payslip run renders the 2,000-row ceiling as a **9.59 MB document in 7.3 s**. The ceiling behaved
correctly (it said "showing the first 2,000 of 10,000"); it is simply set for a smaller world.

**3. The historical attendance holiday N+1 is fixed in current code.** The old daily-attendance path
performed a sequential holiday query for each employee missing attendance; that was the defect behind the
historical 14-minute result above. As of `main@2c1c47d6`, daily attendance calls
`holidayDatesByEmployment` once (`core/attendance.ts:2368`), and the range loader does likewise (`:2522`).
The helper bulk-loads employment inputs and memoizes by company, work state and holiday group
(`core/holidays.ts:542-582`). Monthly absence resolution also memoizes that same calendar key
(`core/absence-days.ts:425-478`; called by `core/attendance.ts:2781-2785`).

Resolver work therefore scales with distinct calendar input groups, not blindly with employee count.
This is not a constant-query guarantee when every employee has a different calendar input. The old
per-employee warning at `core/attendance.ts:4246` is a stale comment. The fix is code evidence only:
repeat first-morning, no-clock-in, historical-date and diverse-calendar cases at 4,000 employees before
claiming an acceptable response time. The historical estimate of a 120-employee limit no longer applies.

**4. Historical cancellation behavior needs retesting.** When the old 10,000 measurement was cancelled client-side,
Node stayed at 100% CPU for minutes and queued later requests behind it — two subsequent requests timed out
at 300 s and the server had to be restarted. On a 2-vCPU box (7.1), one impatient reload of a slow screen
degrades the app for every other user.

**Which of the 31 call sites can actually grow.** Separating these is most of the value: eighteen of them can
never reach a problematic row count.

*Class A — grows with headcount, or headcount × time (13 sites; **client** = every row crosses the wire).*
`app/payroll/[batchId]/page.tsx:101` payslips in one run · `app/payroll/adjustments-panel.tsx:71` draft inputs ·
`app/attendance/daily/page.tsx:71` one row per employee per day · `app/attendance/page.tsx:73,74` corrections and
per-employee summary · `app/attendance/request-status/page.tsx:90` · **client:** `components/roster-grid.tsx:233`
employees × every date of the month · `components/loan-list.tsx:100` every loan in scope ·
`components/applied-in-payroll-list.tsx:116` · `app/payroll/transaction-view/individual-table.tsx:90` ·
`app/payroll/transactions/zakat/elections-list.tsx:110` · `components/tp1-declarations-list.tsx:120` ·
`app/feedback/bulk-table.tsx:76`.

*Class B — grows with time only, or already bounded (6 sites).* `app/payroll/page.tsx:185` payroll runs (~12–24
per company per year; 29 today) · `app/performance/page.tsx:47` review cycles ·
`app/attendance/individual/page.tsx:69` one employee over a chosen range (≤ 366 rows by construction) ·
`components/salary-history-table.tsx:115` one employment's salary history · `app/claims/page.tsx:82` the signed-in
person's OWN claims · `app/payroll/transaction-view/history-table.tsx:107`, already bounded at the QUERY by
`HISTORY_ROW_CAP = 200` (862ed0ad) — the precedent for the right fix, and its own comment names this item as the
carried debt.

`app/attendance/my-records/page.tsx:134` stood in Class B until item 2aef3cd8 (r362) emptied that screen at the
reporter's instruction: it reads no attendance at all now, so the site is gone rather than fixed. If an attendance
view returns to `/attendance/my-records`, its read returns to this class with it.

*Class C — bounded by configuration, fine forever (11 sites).* `app/admin/organization/page.tsx:133` companies (12) ·
`app/admin/settings/employee-id/page.tsx:44` · `app/admin/settings/hiring-defaults/page.tsx:117` ·
`app/admin/settings/dashboard/page.tsx:75` a fixed catalogue of cards · `app/admin/settings/movement/page.tsx:175` ·
`app/admin/pay-components/page.tsx:64` · `app/admin/holidays/page.tsx:73` (~20 a year per calendar) ·
`app/admin/holidays/groups/page.tsx:50` · `components/grade-labels-grid.tsx:363` ·
`components/profile-options-grid.tsx:290` · `components/system-labels-grid.tsx:584` org structure. None of these can
plausibly pass the 2,000-row ceiling, let alone a budget.

**What the historical r297 measurement round deliberately did NOT do.** No call site was rewritten and nothing was converted to
server-side paging: the measurement was the deliverable, and the numbers say a blanket rewrite would be aimed
at the cheapest of the three costs. 100,000 rows was not seeded — the answer was unambiguous at 10,000, and
the local cluster lives on a RAM disk. No timing assertion was added anywhere: a timing test is a flaky test,
so the numbers are recorded here instead. Attendance was fixed subsequently, as verified above.

**Current unbounded reads confirmed 2026-10-05.** The user has confirmed 4,000 employees at launch. These
paths still warrant query/payload limits and production-like measurements; the old small demo population
is not a reason to defer them. Scope-fenced reads must remain scope-fenced when introducing server search.

| Surface | Current source evidence | Required capacity work |
|---|---|---|
| Personnel employee switcher | `app/admin/personnel/page.tsx:203,488` loads all employees separately from the paged table; `employee-switcher.tsx:53` searches the full client prop | Server-backed, scoped search with bounded results; preserve access to every eligible employee |
| Loans and employee panel | `app/admin/loans/page.tsx:67,78,154,167` reads all employees and all company loans before filtering; `components/loan-list.tsx:100` pages in the browser | Filter/page loans at the query and bound employee lookup; measure historical loan/repayment growth |
| Monthly roster | `core/roster.ts:2553,2574,2586` loads employees, filters in memory and reads all matching assignments; `app/roster/page.tsx:470` sends cells to the client before `components/roster-grid.tsx:283` slices employees | Page employee rows and their corresponding assignments before serialization; test a 31-day window (up to 124,000 employee-date positions at 4,000 employees) |
| Payroll run detail | `core/payroll.ts:10361-10390` reads all payslips including statutory JSON; `app/payroll/[batchId]/page.tsx:111` then slices on the server | Bound list queries independently from aggregate totals; measure full-run processing, viewing and export at 4,000 employees |

An assumed 100–200 concurrently active users is a **planning assumption**, not a measured requirement or
capacity guarantee. Validate actual clock-in burst concentration, payroll job overlap, company/calendar
distribution, document sizes and retention. Capture response-time percentiles, error rate, queueing,
database connection/lock pressure, CPU/RAM, transferred bytes and recovery after cancelled requests using
synthetic data on production-equivalent resources.

- [x] Batch/memoize per-employee holiday resolution — verified in current daily, range and monthly paths
- [ ] Re-measure current attendance and the unbounded surfaces above at the 4,000-person launch workload
- [ ] Bound growing client payloads and query reads, preserving full employee selection through scoped search
- [ ] Decide whether `ALL_ROW_CEILING = 2000` is still right now that 2,000 rows is a 9.6 MB document. It
      truncates honestly, which is the important half; the number is the open question.
- [ ] `/payroll/<batchId>` query pagination and launch-scale payroll rehearsal; the historical ~5,000
      estimate does not establish safety at 4,000 on the proposed servers

### 7.3 Multiple app replicas require explicit coordination

**Verified code facts, 2026-10-05:** attachments are PostgreSQL `bytea`, including employee documents
(`db/schema.ts:5450-5461`; `core/employee-documents.ts:150-164`), so app replicas do not currently need a
shared upload directory. Database storage, WAL, backup duration and restore sizing must include those
blobs. Private object storage would require an application migration; it is not an existing capability.

Jobs run as separate host-cron CLI processes, not timers started by the web app
(`scripts/provision-runner.ts:4-14`). Provisioning already claims work using `FOR UPDATE SKIP LOCKED`
(`:82-97`); do not assume every sweep has equivalent exclusion. `deploy/cron-alert.sh:92-94` executes its
command without a distributed lock, and `core/job-run.ts:126` records results rather than acquiring a lease.

The repository has no explicit shared Next.js cache handler, deployment ID or Server Actions encryption-key
configuration in `next.config.ts`. React `cache()` in the session/viewer helpers is request memoization,
not evidence of shared cross-replica caching. Follow the current
[Next.js self-hosting requirements](https://nextjs.org/docs/app/guides/self-hosting): replicas must serve the
same build artifact, share the appropriate Server Actions key and handle deployment version skew; persistent
cache use and invalidation need an explicit multi-instance design. A Redis service alone does not satisfy
these requirements.

- [ ] Deploy one immutable build across replicas; configure and verify shared Server Actions key handling
      and rolling-deployment version behavior without exposing secrets
- [ ] Audit persistent cache/invalidation usage and exercise cross-replica action requests after a rollout
- [ ] Run one scheduler, or implement per-job distributed leases plus retry/idempotency checks before
      enabling duplicate runners; preserve the provisioning queue's existing claim semantics
- [ ] Add/verify edge rate limits and appropriate application request limits, including clock-in burst tests
- [ ] Separate web, worker and migration credentials; constrain database connection pools across all replicas
- [ ] Validate private database access, encrypted backups and a timed restore with representative attachment
      volume before accepting hosting resources as sufficient

---

## WHAT WE COULD NOT VERIFY

- Whether the host's Zabbix agent alerts on anything relevant — its rule set is not visible from the box.
- Which PERKESO ASSIST file layout is actually accepted today (3.1) — this needs a submission or the
  current specification. r296 removed the second builder and made the choice a date, so there is now ONE
  answer to be wrong about instead of two silently different ones; it did not and could not establish
  which answer is right. v2.0 has never been uploaded from this system, and the system starts writing it
  on 1 October 2026.
- The seven PCB relief figures, against a primary source: the LHDN specification URL 404s.
- Current performance at the confirmed 4,000-person launch workload, including clock-in bursts and payroll
  overlap, on the proposed production resources. The historical workstation results do not establish this.
- Whether a current production backup can be restored within the agreed recovery objective.
- Customer payroll reconciliation, accepted filing and operational rehearsal evidence; this audit did not
  inspect real employee records or conduct those exercises.
</content>
