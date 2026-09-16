# Customer deployment readiness — checklist and verdict

Surveyed 2026-09-12 against `main@2ad18fe2` and the live box, read-only, by four parallel surveys
(features · security · statutory · operations). Raw findings, with file:line and SQL for every claim, are
the four files this document summarises; re-derive anything you intend to act on.

Published as a tickable checklist (shared state, survives reloads) at
https://claude.ai/code/artifact/db91c3d8-a733-4844-ac46-843873b245c1

**Every claim here is one of: FACT (verified in code or live data) · OBSERVATION · UNKNOWN.** Nothing was
carried over from prose. `docs/HANDOFF-HISTORY.md` was used only as an index of where to look.

---

## THE VERDICT

**The product is further along than its own documentation says, and further from a paying customer than
its feature list suggests.** Those are two different statements and both are true.

**What is genuinely built and proven.** The payroll calculation engines (EPF, SOCSO/SKBBK, EIS, PCB with
replayed accumulators, HRDF, zakat) are golden-tested against the agencies' own worked examples. Tenant
isolation is real and enforced at the database: `ai_hr_app` is `NOBYPASSRLS`, 173 of 173 tables carry RLS
(172 at survey time — 0465 closed the last one, see 1.7), and a live probe returned zero rows without a
tenant context and zero foreign-tenant rows with one.
Migration safety is unusually good — a shadow-migrate gate against the live schema shape, plus an upgrade
rehearsal against a populated baseline. The five nightly sweeps have run 119 times with zero failures.
Employee import is real and has been used six times. Real authentication (WorkOS) is **fully written**:
login, callback, invitation, password reset, an auth audit writer, and a six-step cutover runbook.

**What stands between here and a customer.** Authentication has never been switched on. The documented
deploy path seeds demo data into the target database. There are no backups. Nothing alerts (r291 added `GET /health` and wrote the cron-alert and logrotate configs, but nothing is monitoring the endpoint and neither config is installed — see 1.6). Nothing has
ever been filed with any agency, and there is no state in the data model that means "filed". And there is
no customer: production holds two tenants, `System (auth audit)` and `Demo Group`, so every reassuring row
count in this system describes seeded demo data. **No feature in this product has ever been exercised
against real employee data.**

**Recommendation.** Do not put real employee data on this deployment in its current state. The path to a
first customer is a few weeks of unglamorous work, not a rebuild — the hard half (calculation, isolation,
migration safety) is done. Work Part 1 in order; the order matters and is explained below.

---

## PART 1 — BEFORE ANY REAL EMPLOYEE DATA TOUCHES THE SYSTEM

These are ordered by dependency, not by severity. Two of them cannot be done later.

### 1.1 Fix the deploy path so it cannot seed demo data — DO THIS FIRST
`deploy/deploy.sh:40` hard-requires `DEV_TENANT_ID`, and `:174-177` runs `db/seed.ts` (the demo seeder)
whenever that tenant row is absent from the target database. `deploy/DEPLOY.md:111` instructs the operator
to leave `ALLOW_DEMO_SESSION`, `DEV_TENANT_ID` and `DEV_USER_ID` "as-is".
**Following the documented runbook on a customer box plants Demo Group in their production database on the
first deploy.** Write a customer deploy path that neither requires `DEV_TENANT_ID` nor can invoke the
seeder, and make the seeder refuse to run when `NODE_ENV=production` and the demo flag is unset.

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
Production holds 11,195 `domain_event` rows and **zero** are chained. `AUDIT_HASH_CHAIN_ENABLED` is absent
from `.env.production`. There is no backfill: every event written before it is armed is permanently
unprotected (ADR-0030, and `deploy/DEPLOY.md`'s own "there is no way back afterwards").
**Arm it before the first real record is written, not after.** If tamper-evidence is part of what is being
sold, this is the moment it has to happen.

- [ ] `AUDIT_HASH_CHAIN_ENABLED=true` set on the customer deployment before first data load
- [ ] Verified: new events carry `chain_seq`, `prev_hash` and `hash`
- [ ] Decision recorded if it is deliberately left off

### 1.3 Run the WorkOS cutover
`.env.production` contains no `WORKOS_*` key and sets `ALLOW_DEMO_SESSION=true`, so `lib/session.ts:231-248`
takes the dev-switcher branch and **the deployed system authenticates nobody**. All nine `app_user` rows
carry placeholder subjects; `app_invitation` is empty; no `auth%` domain event has ever been written.

Two live consequences, both measured on the box:
- `/login` sits outside the password gate by design (`lib/auth-routes.ts:15`) and returns 200 with every
  principal's real name and role. With real employees loaded that publishes the staff directory.
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
`crontab -l`, `cron.d`, `cron.daily` and `systemctl list-timers` contain **no dump job**. `archive_mode=off`
and `wal_level=replica`, so there is no point-in-time recovery. Every dump on the box is an ad-hoc
pre-migration artefact, all on the same disk as the database. `deploy/DEPLOY.md` (28 KB) mentions backup,
restore and rollback exactly zero times. The only restore rehearsal on the box **failed**
(`/home/ubuntu/rehearsal-restore.log` ends `database "ai_hr_rehearsal" does not exist`).
Today the recovery-point objective is "whenever someone last dumped by hand" and the recovery-time
objective is unknown. **An untested backup is not a backup.**

- [ ] Scheduled `pg_dump` with retention, to an **off-box** destination
- [ ] WAL archiving or a replica, if the customer's tolerance requires point-in-time recovery
- [ ] A restore rehearsed into a scratch database, timed, and the result written down
- [ ] Rollback defined: previous release tagged, previous build kept, automatic pre-deploy dump

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

`deploy/cron-alert.sh` and `deploy/logrotate-aihr` are **written but NOT installed** — both change the
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

- [ ] Non-zero exit on any of the six cron jobs reaches a human — **wrapper written and tested, awaiting
      the owner's crontab edit** (`deploy/cron-alert.sh`, `DEPLOY.md` §5c)
- [ ] Application 5xx reaches a human — **still open**; the design is above, the decision is the owner's
- [x] A health endpoint exists — `GET /health`, ungated, database-backed, 503 when it cannot serve.
      **"and is monitored" is still the owner's step**: nothing here points a monitor at it
- [ ] Log rotation configured — **config written and tested, awaiting `cp` to `/etc/logrotate.d/aihr`**
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
There is **no rate limiting anywhere** — the shared password can be brute-forced without limit or alarm.

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

- [ ] An alarm for "a leave type resolves for nobody" at tenant scale
- [ ] An alarm for "a tenant's entitlement templates in force dropped to zero"

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
findings were classified by thresholds that `core/payroll-anomaly.ts:54-65` itself describes as numbers
"nobody should mistake for empirical".

- [ ] Cut-off and pay day configured explicitly per company
- [ ] Anomaly thresholds either made editable or disclosed as arbitrary

### 2.5 A parallel run
Nothing here substitutes for running one real month alongside the customer's existing process and
reconciling to the cent, before anyone relies on it.

- [ ] One month processed in parallel and reconciled

---

## PART 3 — BEFORE THE FIRST STATUTORY FILING

### 3.1 Two PERKESO file builders disagree, and both are reachable
`localization/my/socso-eis-file.ts` zero-pads numerics and writes a SKBBK box at offset 238;
`lib/perkeso-socso-file.ts` space-pads and has a 20-character filler there instead. Both emit 278
characters and both download, from two different screens. **The one golden-tested byte-for-byte against a
genuinely accepted PERKESO file is the one with no SKBBK box** — the field that becomes mandatory on
1 October 2026.

- [ ] Establish which layout PERKESO ASSIST accepts; delete or gate the other
- [ ] One builder behind both screens, golden-tested, carrying SKBBK

### 3.2 There is no "filed" state to reach
All 20 `statutory_report` rows on production are `draft`. Both insert sites hardcode `status: 'draft'` and
no code anywhere updates that column, so `final`, `submitted` and `amended` are unreachable. The unlock
warning that claims `statutoryFiled` actually means "somebody generated a draft", so it misleads in both
directions.

- [ ] A mark-as-filed action recording who, when and the acknowledgement reference
- [ ] `statutoryFiled` means filed

### 3.3 No bank payment file, no e-filing
`localization/my/bank-files/` contains one file, a **2014-vintage** BNM routing table flagged RE-VERIFY
that still lists RBS Malaysia. Three bank formats are named; none has a builder. The CSV that exists says
in its own header that it is not a giro file. There are **zero outbound calls** to any LHDN, KWSP, PERKESO
or MyInvois host. Every payment and every return is a manual key-in today.

- [ ] Customer's bank named, its real bulk-payment spec sourced, one file built and golden-tested
- [ ] BNM routing codes re-verified against PayNet
- [ ] Manual portal key-in accepted and documented, or an integration scoped

### 3.4 A filed month cannot be corrected without rewriting history
The payroll status enum is `draft | processed | closed` — there is no `paid`, `reversed` or `void`, and no
contra. Closed payslips are immutable at the database trigger. The only correction path is unlock → reset
(which **deletes** the payslips) → regenerate → re-close. Both `PAYROLL_UNLOCK_ENABLED` and
`PAYROLL_RESET_ENABLED` are **on in production**.

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
| **Email notification** | There is **no email transport anywhere in the repo** — no nodemailer, SMTP, SendGrid, Postmark, Mailgun, SES or Resend, and none in `package.json`. The comment at `core/notifications.ts:33` claiming the path sends email is false. Notifications are in-app only, and only **9 of 83** employments have a login at all. The one real mail is WorkOS's invitation. |
| **Every AI surface** | No provider is configured: `grep -c API_KEY .env.production` → 0, `ai_provider_config` → 0 rows. All eleven callers resolve null. All three agents default off with no override, and `agent_proposal` is empty across all eight writer sites. The anomaly engine that does work (2,359 findings) is deterministic rules, not a model. |
| **Attendance geofencing** | `geofencing_enabled` is false for **all 83** employments; both its tables are empty. The logic is correct and well tested; it has simply never been switched on, and the enable switch is on the personnel card, not where the navigation points. |
| **Field-level PII encryption** | `pii_key` is empty and `sealForSubject`/`unsealForSubject` have **zero callers**. No field in the product is sealed. Do not represent the product as encrypting personal data at rest beyond what the database itself provides. |
| **Performance goal-setting** | `proposeGoalsAction`, `approveGoalAction` and `lockGoalSettingAction` are imported by no component. The stage does not exist in the interface. |
| **Commercial module gating** | Gating is navigation-deep, not service-deep: `assertModuleEnabled()` has 4 call sites, `requireModule()` 6 routes and it **fails open** by design. Around 35 attendance, payroll, claims and performance routes have no module check, so a customer who declines Attendance can still reach `/roster` by URL. |
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
- **Tenant isolation** — `ai_hr_app` is `NOBYPASSRLS`; 173 of 173 tables carry RLS (172 at survey time;
  0465 closed `tenant_suspension_window`); `platform_user` is
  default-deny with no grant; `withTenant` uses transaction-scoped `SET LOCAL`. Verified live.
- **Migration safety** — shadow-migrate against the live schema shape catches drizzle's silent-skip mode;
  the upgrade rehearsal runs against a populated baseline; the audit-chain gate runs before the build.
- **Scheduled work** — six cron jobs, 119 recorded runs, **zero failures**, no missed days.
- **Employee import** — analyse-then-commit, six real runs, ~45 optional columns, XLSX supported.
- **Leave engine** — the deepest module in the product, and the most heavily tested.

Note one accepted consequence: no table is `FORCE ROW LEVEL SECURITY`, so `ai_hr_owner` bypasses RLS
entirely. The web tier never uses it, but **all six cron jobs do**, so for those paths correctness rests on
application-layer scoping with no database backstop.

---

## PART 7 — CAPACITY

### 7.1 The server has no build headroom — measured 2026-09-13
The box has **3.8 GiB of memory in total**. During its own deploy typecheck it ran down to about
**105 MiB available**, with a single Next.js worker holding 2.7 GB. The build survived, but there is no
margin: the next dependency that grows the build tips a deploy into an out-of-memory failure. That is
survivable today only because `deploy.sh` builds before it migrates, so a failed build leaves the database
untouched and the old service running.

Two related facts from the same deploy. `pnpm improve:release` does **not** detach the remote
`deploy.sh` (`scripts/improve/release.ts:83`), so anything that kills the local release process kills the
server build with it, and the board is left saying the work did not ship when it did. And a build
interrupted that way leaves new source on disk beside a stale `.next` build id, which nothing on the
server detects or reports.

- [ ] Raise the server's memory, or build elsewhere and ship the artifact
- [ ] Detach the remote deploy so a local failure cannot kill it
- [ ] A deploy that fails partway is detected and reported, rather than left mixed

### 7.2 Pagination fetches every row

`lib/pagination.ts:124` fetches every row then slices, across 61 call sites. It has never bitten because
production holds 83 employments and 93 payslips. **UNKNOWN:** the row count at which it becomes a problem;
nobody has load-tested it. A customer an order of magnitude larger should be assumed to expose it.

---

## WHAT WE COULD NOT VERIFY

- Whether the host's Zabbix agent alerts on anything relevant — its rule set is not visible from the box.
- Which PERKESO ASSIST file layout is actually accepted today (3.1) — this needs a submission or the
  current specification.
- The seven PCB relief figures, against a primary source: the LHDN specification URL 404s.
- Load behaviour at customer scale (Part 7).
- Whether a restore of the current dumps actually succeeds — the one rehearsal on the box failed for an
  unrelated permission reason and was never retried.
- Anything at all about real customer data, because there has never been any.
</content>
