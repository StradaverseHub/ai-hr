# Customer deployment readiness — checklist and verdict

Surveyed 2026-09-12 against `main@2ad18fe2` and the live box, read-only, by four parallel surveys
(features · security · statutory · operations). Raw findings, with file:line and SQL for every claim, are
the four files this document summarises; re-derive anything you intend to act on.

**Every claim here is one of: FACT (verified in code or live data) · OBSERVATION · UNKNOWN.** Nothing was
carried over from prose. `docs/HANDOFF-HISTORY.md` was used only as an index of where to look.

---

## THE VERDICT

**The product is further along than its own documentation says, and further from a paying customer than
its feature list suggests.** Those are two different statements and both are true.

**What is genuinely built and proven.** The payroll calculation engines (EPF, SOCSO/SKBBK, EIS, PCB with
replayed accumulators, HRDF, zakat) are golden-tested against the agencies' own worked examples. Tenant
isolation is real and enforced at the database: `ai_hr_app` is `NOBYPASSRLS`, 172 of 173 tables carry RLS,
and a live probe returned zero rows without a tenant context and zero foreign-tenant rows with one.
Migration safety is unusually good — a shadow-migrate gate against the live schema shape, plus an upgrade
rehearsal against a populated baseline. The five nightly sweeps have run 119 times with zero failures.
Employee import is real and has been used six times. Real authentication (WorkOS) is **fully written**:
login, callback, invitation, password reset, an auth audit writer, and a six-step cutover runbook.

**What stands between here and a customer.** Authentication has never been switched on. The documented
deploy path seeds demo data into the target database. There are no backups. Nothing alerts. Nothing has
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
`deploy/deploy.sh:40` hard-requires `DEV_TENANT_ID`, and `:153-156` runs `db/seed.ts` (the demo seeder)
whenever that tenant row is absent from the target database. `deploy/DEPLOY.md:111` instructs the operator
to leave `ALLOW_DEMO_SESSION`, `DEV_TENANT_ID` and `DEV_USER_ID` "as-is".
**Following the documented runbook on a customer box plants Demo Group in their production database on the
first deploy.** Write a customer deploy path that neither requires `DEV_TENANT_ID` nor can invoke the
seeder, and make the seeder refuse to run when `NODE_ENV=production` and the demo flag is unset.

- [ ] Customer deploy path exists and is documented separately from the demo one
- [ ] `db/seed.ts` refuses to run against a production deployment
- [ ] `DEPLOY.md` no longer tells an operator to keep the demo variables

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

### 1.4 Make the password gate fail closed
`middleware.ts:42`: if `SHARE_PASSWORD` is unset the gate returns without checking anything and the whole
app is open, with no error, no log and no startup refusal. Any username is accepted; only the password is
compared. Once 1.3 is done the gate is redundant, but until then an unset variable must be a hard startup
failure rather than a silent no-op.

- [ ] Unset `SHARE_PASSWORD` in a production build refuses to start

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

### 1.6 Alerting, so a failure is not silent
Every cron line redirects stdout and stderr into a file, which means cron's own mail path can never fire.
There is no Sentry, OpenTelemetry, pino or winston in `package.json`, no `/health` route, and no
`logrotate` entry (the provisioning log grows about 1,440 lines a day, unbounded). 77 error lines in the
service journal over seven days went nowhere. A Zabbix agent runs on the host; its rule set is UNKNOWN
from here. The one real thing that exists is `/admin/scheduled-actions`, which shows job history to a
group admin — but it is pull-only, with no run-now and no notification.

- [ ] Non-zero exit on any of the six cron jobs reaches a human
- [ ] Application 5xx reaches a human
- [ ] A health endpoint exists and is monitored
- [ ] Log rotation configured
- [ ] Somebody is nominated as on call

### 1.7 Close the one RLS hole before a second tenant exists
`tenant_suspension_window` is the only table of 173 with row-level security disabled, and `ai_hr_app` holds
full CRUD on it. It is a control-plane table that should belong to `ai_hr_platform`
(`db/migrations/0453_custom_report_app_grant.sql:22-24`). It has **0 rows**, so nothing leaks today — but it
is a cross-tenant read/write hole with no database backstop the moment it is used.

- [ ] RLS enabled with a tenant policy, or the grant revoked from `ai_hr_app`

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

### 2.1 The live tenant's entitlement configuration is currently empty
Measured 2026-09-12: **0 entitlement templates and 0 eligibility rules in force**. Nobody resolves to any
leave entitlement. The restart SQL is written (`scratchpad/restart-config.sql`) and has not been run.
Beyond fixing it, note the shape of the risk: **one admin edit silently zeroed the entitlement engine for
the whole tenant, and nothing anywhere raised an alarm.**

- [ ] Configuration restored and verified in force
- [ ] Consider an alarm for "a leave type resolves for nobody" at tenant scale

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
| **Knowledge base authoring** | `createArticleAction` uses a bare session with no admin gate, and the composer is mounted unconditionally — **any employee can publish to the company knowledge base** at any audience up to `hr_admin`. |
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
- **Tenant isolation** — `ai_hr_app` is `NOBYPASSRLS`; 172 of 173 tables carry RLS; `platform_user` is
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
