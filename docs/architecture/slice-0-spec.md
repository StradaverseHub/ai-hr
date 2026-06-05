# Slice 0 Specification — "the spine"

The walking skeleton: the narrowest end-to-end slice that exercises the unretrofittable
architectural bets. This document is the functional + test + deployment deliverable for v1.

## Personas

| Persona | Goal | Cares about |
|---|---|---|
| **Employee** | Request leave; see own profile & balance | Speed, clarity, privacy of own data |
| **Line Manager** | Approve reports' leave; see team | Seeing *only* their reports, not peers |
| **HR Admin** | Onboard / transfer / offboard; manage org | Correct history, no data loss, audit |
| **Super Admin** | Tenant-wide configuration | Isolation, control, oversight |
| *(Platform / me)* | Operate the tenant | Tenant isolation, observability |

## Core use cases

- **UC1 — Hire.** HR Admin creates a Person (or reuses an existing one) and opens an
  Employment in a Company with an initial Assignment (position, department, type, status,
  `valid_from`). Emits `employment.hired`.
- **UC2 — Transfer.** HR Admin changes an employee's position/department effective a date.
  System closes the current Assignment (`valid_to`) and inserts a new one; **history is
  preserved**. Emits `assignment.transferred`.
- **UC3 — Terminate.** HR Admin ends an Employment effective a date; open Assignment is
  closed; status → Terminated. Emits `employment.terminated`.
- **UC4 — Reporting lines.** HR Admin sets one or more managers (typed lines), including a
  **cross-company** manager. System **rejects an administrative cycle**.
- **UC5 — Request leave.** Employee requests Annual leave for a date range; system computes
  days and checks **projected balance ≥ 0**; creates a `pending` request. Emits
  `leave-request.submitted`.
- **UC6 — Approve / reject.** The employee's administrative manager approves; system writes
  a ledger debit and flips status atomically. Emits `leave-request.approved`. Reject emits
  `leave-request.rejected` with no debit.
- **UC7 — As-of org read.** Any authorized user reconstructs the org / an employee's
  manager & department **as of a past date**.
- **UC8 — Tenant isolation.** A user authenticated into Tenant A can never read Tenant B's
  rows (DB-enforced).
- **UC9 — ABAC.** A manager sees their reports' leave but not peers'; an employee sees only
  their own records.

## Acceptance criteria (samples)

- **AC-UC2.1** After a transfer effective `D`, querying the employee's assignment *as-of
  `D-1`* returns the old department and *as-of `D`* returns the new one; both rows exist.
- **AC-UC4.1** Inserting an administrative reporting edge that would close a cycle returns a
  domain error and writes **no** row and **no** event.
- **AC-UC6.1** Approving a leave request that would drive the balance negative is rejected;
  no ledger debit is written.
- **AC-UC6.2** Approval writes exactly one ledger debit and exactly one
  `leave-request.approved` event, in one transaction (all-or-nothing).
- **AC-UC8.1** With `app.tenant_id` set to Tenant A, a query for a known Tenant B row
  returns zero rows (not an error that leaks existence).
- **AC-UC9.1** A manager querying a non-report's leave request returns zero rows.
- **AC-substrate** Every state-changing service method has a corresponding event append
  (verified by the write-vs-`events.append` grep in review).

## Non-functional requirements (v1 targets)

- **Security:** default-deny RLS; app connects as non-`BYPASSRLS` role; secrets via env;
  TLS everywhere; no PII in logs.
- **Auditability:** 100% of state changes produce a domain event with a real actor.
- **Data integrity:** temporal invariants enforced by constraints, not just app code.
- **Performance:** org/as-of and team reads < 200 ms p95 at seed scale (hundreds of
  employees). Real load testing deferred until past Slice 0.
- **Observability:** structured request logs with `tenant_id` + `request_id`; basic error
  tracking.

## Test strategy (per the engineering principles)

| Layer | Tool | Covers |
|---|---|---|
| Unit | Vitest | leave-days calc, balance projection, **cycle detection**, accrual rules |
| Integration | Vitest + ephemeral Postgres | **RLS allow/deny**, as-of queries, temporal close+insert, atomic approve |
| E2E | Playwright | hire → assign → request → approve happy path; manager-only visibility |
| Security | Integration | cross-tenant denial (UC8), ABAC denial (UC9), default-deny on a new table |

> Authorization tests assert **both** the allow path and the deny path. A policy that only
> ever proves "allowed" is considered untested.

## Deployment & operations (v1)

- **Environments:** local (Docker Postgres) → preview → production. Drizzle migrations are
  the single source of schema truth; **no manual DDL** in any shared environment.
- **CI:** typecheck + lint + unit + integration (spins up Postgres) on every PR; block on
  red. E2E on main.
- **Rollback:** every migration has a tested down path; deploys are reversible. Because the
  org core is append-only/effective-dated, *data* rollback is rare — we correct forward
  with a new effective-dated version.
- **Secrets:** WorkOS + database creds via environment, never committed.
- **Monitoring:** error tracking + uptime check from day one; dashboards grow with scope.

## Definition of done for Slice 0

All nine use cases pass their acceptance criteria; the security suite (UC8/UC9 + default-
deny) is green; every write path emits an event; migrations apply cleanly forward and
backward on a fresh database; the happy-path E2E is green in CI.
