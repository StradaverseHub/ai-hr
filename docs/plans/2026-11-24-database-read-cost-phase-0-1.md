# Database read cost: Phase 0, Phase 1 and J1 plan

Decision: ADR 0181. Owner approval: 24 November 2026 (Phase 0 on staging, Phase 1 and J1 to build now; precomputed
access as a pilot). Source facts below were read at main `d9db526a2`; re-read them on the integration base before
building. Every package follows `docs/architecture/FUTURE-BUILD-CONTRACT.md` and `docs/SCALE-AND-RELEASE-RULES.md`,
verifies on GitHub Actions (`alpha-focused-checks.yml` for development), and releases through the shared staging queue.

Each package records its own before and after from the timing logs (`scripts/performance/slow-work-report.mjs`) on
staging. Merged, installed and accepted remain separate states.

## Phase 0: measure

### 0.1 Query statistics on staging

- Files: `deploy/postgres-statistics/50-aihr-query-statistics.conf` and its `README.md`. These are the same settings CI
  uses (`.github/ci/postgres.sh`), with a smaller table, plus sampled `auto_explain` (5% of statements over 500 ms,
  JSON, no bind values).
- Staging has both libraries installed and loads `conf.d`. The operator SSH user has no sudo, so an administrator
  applies it under the staging lease. The restart is the only interruption.
- Done when: `pg_stat_statements` returns rows on staging, and a first top-statement report (aggregates only) is
  attached to the Phase 2 pilot design.

### 0.2 Route baselines

- Record p50 and p95 duration, database share and transactions per request, from the timing logs, for:
  - Home, Transaction View, Payroll list, Organisation and Personnel record;
  - Job descriptions, Approvals and the employee picker search;
  - the Save movement and Set direct superior actions.
- Record the background job queue time and worked time per kind (`bulk_job` timing).
- Done when: the baseline table is in the Phase 1 pull request descriptions, with each figure's source and time window.

## Phase 1: fewer transactions per page (no schema change)

### 1.1 Page renders share one read snapshot by default

- Today the shared snapshot (`db/shared-read.ts`, `lib/request-read-scope.ts`) is opt-in. It is used by the Home and
  Today readers, the shell's pending-task summary (`app/layout.tsx:273-283`), Performance home, pre-salary person items
  and mobile Today. Every other `withTenant` read opens its own transaction.
- Change: at the `withTenant` choke point (`db/client.ts:344-348`), when no shared session is installed but a request
  read scope exists (a server render is in progress), join the scope's carrier for that identity. Route handlers,
  actions, jobs and tests have no scope and are unchanged.
- Unchanged:
  - The refusal rules (`shared-read.ts:212-236`: advisory locks, settings, `FOR UPDATE/SHARE`, read committed, writes,
    savepoints, the reward observation). A refused owner reruns alone, as today.
  - The carrier still commits whenever it is idle, so it never holds a connection between compositions.
  - The identity and deadline match.
  - The opt-outs (`withIndependentTransactions`, agents, no tenant or user).
- Risks to test:
  - An owner that needs read-committed freshness between two of its own statements inside one render.
  - An owner that reads after a write in the same render: the write is refused, so the owner reruns alone.
  - A render-wide snapshot that is older than a concurrent commit. This is bounded by the idle commit.
- Proof:
  - The full page test suite stays green.
  - New tests:
    - an inventory test listing which owners fall back during a frame render;
    - an equivalence test that renders the frame with and without the default, at 70 companies / 1,000 employments,
      and asserts identical output;
    - a transaction-count test.
  - The deadline semantics follow ADR 2026-11-06 database work admission.

### 1.2 App frame reads in one pass

- `app/layout.tsx` awaits these in sequence:
  - `getSession` (153) and `idleTimeoutMinutesFor` (167);
  - `listPrincipals` (183) and `companyContextForPage` (186);
  - `letterNavigation` (202) and `rewardNavigation` (204);
  - `lifecycleModuleInbox` (249).
- Between those waits it runs four `Promise.all` groups (198, 242, 258, 268).
- `NoticePopupSlot` awaits `viewerEmployment` and then `noticesForEmployment` (`components/notice/notice-surfaces.tsx:35-39`).
- Change: start every independent read as soon as its inputs exist, and inside 1.1's carrier, so the frame costs one
  transaction and about two statement waves. Combine the notice pair into one owner read.
- Proof: the frame transaction-count test from 1.1, and a rendered check of the frame for every native role.

### 1.3 No write on page load; the bell streams

- Today `ShellNotificationCenter` (`app/shell-notification-center.tsx:20`) runs `dispatchNotifications` for admins on
  page load. That is a write transaction with `pg_try_advisory_xact_lock` (`core/notifications.ts:513-553`).
- The minute notification sweep already dispatches (`scripts/notification-email-sweep.ts:61`, `dispatchNotificationsFromSweep`),
  so the page-load call is an opportunistic catch-up.
- Change:
  - Remove the page-load dispatch.
  - Keep the bell and the inbox behind Suspense (the bell already is, at `layout.tsx:494`; `lifecycleModuleInbox`
    is not).
- Effect for users: an admin's new notification appears within the sweep interval (about a minute) rather than on the
  next page load.
- Coordinate with PR 275 (bell recruitment statement), which changes `packs/recruitment/tasks.ts`, not the shell.
- Proof:
  - A test asserting that no write or advisory lock runs during a frame render.
  - The existing sweep tests.

### 1.4 Approvals and leave histories read breakdowns as a set

- `app/approvals/page.tsx:322-331` runs `leaveRequestDateBreakdown` (`core/read.ts:2685-2703`) once per pending
  leave row, one transaction each.
- The same per-row pattern is at:
  - `core/mobile-approvals.ts:243`;
  - `core/mobile-leave-history.ts:120`;
  - `components/leave/own-leave-history.tsx:214`.
- Change: add `leaveRequestDateBreakdowns(ctx, ids)`, one statement with `leave_request_id = any(...)` and the same
  joins and order, grouped in memory. Use it at all four sites.
- Proof:
  - An equivalence test comparing the per-row and set results for every role, at 200 pending rows across 70
    companies.
  - A test that the transaction count is constant from 1 to 200 rows (rule 2).

### 1.5 Route budgets in the gate

- Reuse `test/helpers/statement-observer.ts` (statements and transactions) and the request clock
  (`lib/request-timing.ts:139-156`).
- Add `test/route-read-budget.test.ts`. It records transactions and statements for the frame plus Home, Approvals and
  Personnel at 1 company and at 70 companies, and fails if the 70-company count exceeds the 1-company count, or if
  either exceeds the recorded budget.
- Budgets only go down. Raising one needs an ADR note.

Packages 1.1–1.3 and 1.5 touch the frame and `db/` and belong in one worktree. Package 1.4 touches leave readers only,
and can run in its own worktree.

## J1: background work in lanes (no schema change)

Facts:

- One worker process (`deploy/systemd/aihr-bank-import.service`, `AIHR_DB_POOL_MAX=2`) runs this loop
  (`scripts/bank-import-runner.ts:34-48`): bank tick, individual import tick, one bulk-job unit, then the reward and
  probation ticks.
- The claim (`core/bulk-job-worker.ts:192-198`) takes the least recently touched job of any kind the process
  registers (`kind = any(kinds)`), with `SKIP LOCKED` and a lease.
- `prepare` (359) and some `finalize` units are bounded only by the kind's own code, so one import's validation can
  hold the single lane.
- Two processes are already correct together:
  - Bank and individual ticks take session advisory locks.
  - The reward, contract and probation ticks use `SKIP LOCKED`.
  - Payroll ordering per company uses `BulkJobWaiting`.
- Neither `enqueueBulkJobTx` (`core/bulk-job.ts:49-61`) nor `app.bulk_job_enqueue` checks `bulk_job_worker.kinds`.
  The deploy check (`scripts/check-import-worker.ts`, `deploy/deploy.sh:577`) runs after install.

### J1.1 Lanes by kind

- A lane is a named subset of `BULK_JOB_HANDLERS` (`core/bulk-job-handlers.ts`), declared in code next to the
  handlers:
  - `payroll`: payroll processing, settle and history;
  - `tax`: reprocess, readiness and basis;
  - `import`: employee, register, leave, movement, attendance and fixed transactions;
  - `export`: transaction exports;
  - `default`: everything not listed.
  Every kind belongs to exactly one lane, and a test enforces it.
- The runner reads `AIHR_WORKER_LANE`. It registers only that lane's handlers, so the existing claim and heartbeat
  advertise exactly that subset, with no SQL change.
- The bank, individual, reward and probation ticks run only in the `default` lane. They stay single-runner through
  their existing locks.
- With no `AIHR_WORKER_LANE` set, the process runs every lane, which is today's behaviour. That is the rollback.
- Per-tenant fairness is unchanged inside each lane.

### J1.2 Units and capacity

- Use one templated unit, `aihr-worker@.service`, with an instance per lane (`aihr-worker@payroll`, …). Keep
  `aihr-bank-import.service` as the default lane, so installed tooling and monitoring keep their name.
- Extend `bank_import_worker_installer_v2.py` and its validator and upgrade tests
  (`test/fixtures/bank-import-worker-upgrade-tests.py`).
  - Today they require exactly one unit and `AIHR_DB_POOL_MAX=2`.
  - The installer change must keep rejecting any other pool override.
- Each process uses up to 4 connections (owner 1, probation 1, app pool 2). Five lanes fit within
  `AIHR_DB_BACKGROUND_CONNECTIONS` (16, `db/capacity.ts:41`). Prove it in `test/capacity*.test.ts`.
- `scripts/check-import-worker.ts` checks that every kind has a live worker in its lane.

### J1.3 Never queue a job no worker can run

- In `enqueueBulkJobTx`, before calling `app.bulk_job_enqueue`, read the live workers' kinds through the existing
  `app.bulk_job_worker_ready`.
  - **Workers are live but none advertises the kind:** the web and the worker are on different versions, which is
    expected under "web first, worker next". Refuse with a plain message that the feature is being installed and to
    try again in a few minutes. Queue nothing.
  - **No worker is live at all,** for example during a restart: queue as today and show "waiting for the background
    service", which already exists.
- Proof:
  - Tests for both cases and for the normal path.
  - A deploy check test proving that a new kind is refused until the worker advertises it.

### J1 proof and rollout

- **Equivalence and safety:** an equivalence test on the kernel. Run two processes in different lanes, plus one
  all-lane process, over a mixed queue. It asserts the same job outcomes, no double claim, per-company payroll order
  kept, and bank ticks run once.
- **Staging measurement:** start an employee import and a payroll run together, and show that payroll's queue time no
  longer includes the import's units.
- **Production:** production gets the units only through a normal production release, with its own permission.

## Sequencing and ownership

| Package | Worktree | Files (main) | Depends on |
|---|---|---|---|
| 0.1 | none (administrator on staging) | `deploy/postgres-statistics/` | staging lease |
| 0.2 | any | evidence only | 0.1 for statement data; timing logs now |
| 1.1, 1.2, 1.3, 1.5 | pages | `db/client.ts`, `db/shared-read.ts`, `lib/request-read-scope.ts`, `app/layout.tsx`, `app/shell-notification-center.tsx`, `components/notice/`, new tests | none |
| 1.4 | leave | `core/read.ts` (breakdown), `app/approvals/page.tsx`, `core/mobile-approvals.ts`, `core/mobile-leave-history.ts`, `components/leave/own-leave-history.tsx`, new tests | none |
| J1 | workers | `scripts/bank-import-runner.ts`, `core/bulk-job-handlers.ts`, `core/bulk-job.ts`, `deploy/systemd/`, installer and tests, `scripts/check-import-worker.ts` | none |
| 2 pilot | access | new migration (allocate by `docs/MIGRATION-ALLOCATION.md`), `app.access_workforce_company` callers on `job_document` | 0.1 report helps but does not block design |

The pages, leave and workers packages touch disjoint files and can build in parallel. PR 273 (`core/payroll-view.ts`,
migration 7200) and PR 275 (`packs/recruitment/tasks.ts`) are owned elsewhere; none of these packages edits their
files.
