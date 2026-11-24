# ADR 0181 Database read cost: precomputed access, one read transaction per request, lanes for background work

Date: 24 November 2026

Status: Owner approved the direction on 24 November 2026. Phase 0, Phase 1 and J1 are authorised to build. Phase 2
(precomputed access) is authorised as a pilot on company-level access and Job descriptions only; widening it to other
table families needs the pilot's equivalence and shadow evidence. Nothing here is built, merged, installed or accepted.

This ADR builds on, and does not replace, the database decisions of 6–10 November 2026 (`docs/adr/2026-11-06-*` to
`docs/adr/2026-11-10-*`), ADR 0135 (reader/writer Access lock), `docs/architecture/FUTURE-BUILD-CONTRACT.md` and
`docs/SCALE-AND-RELEASE-RULES.md`. The screen-level findings in `docs/ARCHITECTURE-PERFORMANCE-REMEDIATION.md`
(AP-001 onwards) keep their IDs and ledger: work under this ADR that fixes one of them closes it there with its own
evidence, rather than opening a parallel item. Installation-specific measurements are kept in a private review and are not
reproduced here.

## Context

Request timing (`lib/request-timing.ts`, `docs/PERFORMANCE-TIMING.md`) shows that slow screens, searches, saves and
background jobs spend 92–99% of their time inside database statements. Application code is 0–4%, and waiting for a
database connection was negligible on every slow route. A faster application language or more hardware would not
change this. Four shared causes explain it:

1. **Authority is re-derived for every row.** The schema has about 2,200 row-security policies and about 2,900
   `SECURITY DEFINER` functions in `app`. The tenant predicate is an inlinable `STABLE` function and is cheap. The cost
   is in non-inlinable definer and plpgsql chains evaluated per row: for example `can_see_employment` (admin scope, a
   recursive reporting-line walk and the department tree), `can_see_person` (which calls it per employment) and
   `access_workforce_company` (principal snapshot, login block, role, scope and allowance checks). Statistics on a
   small installation show tables of under 1,500 rows read end to end billions of rows' worth by full scans. Forcing
   JIT off in tenant transactions (rule 6) was an earlier symptom of the same cause.
2. **Every read opens its own transaction, and the app frame repeats about 30 of them.** Each tenant read is BEGIN,
   settings, query, COMMIT. The app frame (`app/layout.tsx`) runs about 25–30 of these in several sequential waves on
   every page load, and admins also run the notification dispatch write on page load. The shared request snapshot
   (ADR 2026-11-10 Home request read scope) already proved the remedy on Home and is used in only a few files.
3. **Saving redraws everything.** There is no data cache, no cache tag and no `use cache`. About 900
   `revalidatePath` calls (13 of them layout-wide), about 830 action redirects and about 225 `router.refresh()` calls
   re-render the whole tree, app frame included, after a save.
4. **Lists and background work do per-row work.** Lists page with `OFFSET` and exact `count(*)`, and search with
   unindexed `ilike '%term%'` that row security cannot push ahead of the policies (not LEAKPROOF). Background jobs run
   in one serial worker lane, one chunk at a time, mostly one employee at a time, under the same per-row authority
   cost.

## Decisions

### 1. Precomputed access replaces per-row authority chains (change A), piloted first

Authority answers are stored in indexed tables and maintained when access changes, following the Zanzibar/Leopard
pattern. The permission rules do not change; only where their answers are stored does.

- `access_effective_company (tenant_id, user_id, capability, company_id, access_version)`: which companies a user
  may act on for each capability, after roles, grants, scopes, denials and login blocks.
- `access_visible_employment (tenant_id, viewer_user_id, employment_id, valid daterange, reason, access_version)`:
  which employments a user may see, flattening admin scope, the reporting-line tree, the department head tree and
  delegations with effective dates. This table is designed in the pilot but is not used by any policy until the pilot
  is accepted.

Maintenance rules:

- Rows are maintained **in the same transaction** as the change that affects them (grants, role assignments,
  assignments, reporting lines, departments, delegations, employment status) by set-based statements. A change too
  large for a request (for example a company-wide restructure) runs on the bulk-job kernel in bounded chunks, and
  readers see the previous consistent answer until each chunk commits.
- Each tenant has an access version, incremented by every maintaining write. It keys the cached viewer profile
  (Phase 3) and lets tests and the rebuild check prove freshness.
- New tables carry tenant row security and explicit grants, apply as the restricted `ai_hr_owner` (rule 8), and are
  written only by named definer maintenance functions; the application role cannot write them directly.
- The HR date a visibility check uses comes from the repository's existing HR date owner, set once per transaction
  like the tenant. This ADR adds no new SQL clock.

Policies then become one indexed semi-join evaluated once per statement:

```sql
company_id = any ((select app.effective_companies('workforce.view')))
```

**Pilot scope.** Company-level access (`access_effective_company`) and the Job descriptions read path
(`job_document` and its revisions). It has no reporting-line tree, has a clear slow screen to measure, and a small
blast radius. Employment, person, reporting line and leave follow only after the pilot's evidence is accepted.

**Proof of equivalence (rule 3).** A table family switches only after all three hold:

1. **Equivalence tests:** the old and new policy return identical rows, order and counts for every role, under
   "All companies" and one company, on a fixture of at least 70 companies and 1,000 employments, including denied,
   blocked, expired and future-dated access.
2. **Shadow comparison on staging:** for an agreed period both answers are computed, the old one is served, and every
   difference is logged as a count by capability and reason, with no person or tenant values. The switch needs zero
   unexplained differences.
3. **Rebuild check:** a scheduled job recomputes the tables from scratch and reports any difference from the
   incrementally maintained rows. A difference fails closed for that tenant (falls back to the old functions) and
   alerts.

### 2. One read transaction per page render by default (change B)

The shared request snapshot (`db/shared-read.ts`, `lib/request-read-scope.ts`) becomes the default for page renders
and GET route handlers rather than an opt-in. One identity gets one `REPEATABLE READ READ ONLY` carrier per render.
Every existing refusal still applies: a barrier, setting, write, savepoint or read-committed requirement runs that
owner in its own transaction exactly as today. Writes and server actions are unchanged. The payroll history barrier
keeps its current rules; this ADR does not relax it.

### 3. The app frame reads once, writes never, and streams what is slow

The frame's facts (menu and module access, inbox counts, assistant access, notices) are read in one batched pass
inside the render's carrier. The admin notification dispatch moves off page load onto the worker's existing sweep.
The bell and inbox stream behind Suspense so they never block the page. A per-user cached viewer profile keyed by
access version is Phase 3, after precomputed access exists to invalidate it.

### 4. Saves update only what changed (change D, Phase 3)

Server actions return their result and the next address, and the client navigates in-app, generalising the Export to
Excel form pattern. `revalidatePath` is replaced by data tags (`updateTag` for read-your-own-writes), starting with the
layout-wide calls.

### 5. Lists show capped counts and page by key (change E, Phase 4)

- A list shows its exact total when it is under 1,000 rows and "1,000+" above, with an explicit "count exactly"
  action where a user needs the number. Exports, payroll, statutory and report totals are always exact; the cap
  applies only to on-screen list totals.
- Lists page with keyset pagination, not `OFFSET`.
- Searched names and numbers get tenant-led trigram indexes once precomputed access lets Postgres narrow to the
  visible set first.
- Per-row loops in a request become set-based reads (rule 2).

### 6. Read models for the heaviest screens (change F, Phase 5)

Transaction View, Home cards and dashboard figures may read ordinary row-secured tables fed from the `domain_event`
outbox by the worker. Each row records the source version it reflects. Money is never calculated from a projection;
payroll truth stays in its source tables.

### 7. Background work runs in lanes, and never waits for a worker that cannot run it (change H)

- **J1 (now):** more than one worker process may run, each serving a declared lane (for example payroll runs, tax
  recalculation, imports, exports, sweeps). Per-tenant fairness applies inside each lane. Singleton duties (bank ticks
  and other once-only sweeps) stay exactly once, guarded by their existing locks. When workers are live but none
  advertises a job kind (the web is already on a newer version, as "web first, worker next" allows), the web refuses
  to queue it with a plain "being installed" message. When no worker is live at all (a restart), it queues as today
  and shows that the job is waiting for the background service. The release check verifies that every kind has a live
  worker in its lane.
- **J2 (later):** set-based chunks load inputs for a few hundred employees in a few statements, run the existing
  deterministic calculation per employee in memory, and write with multi-row statements, proven by equivalence tests
  for every pay item, tax and statutory output. Imports load with `COPY` into their staging tables. Chunk timing
  splits calculation from database time; only a calculation shown to be CPU-bound could justify a compiled engine.
- **J2, selective reprocess (built, 24 November 2026; not yet on staging).** The `payroll_reprocess` job keeps one
  step per employee, but the first step of a chunk recalculates a group: the longest run of following employees who
  are ordinary recalculations (already on the run and still in the month) goes through one pass of the existing
  payroll engine (`reprocessEmployeeGroupTx` in `core/payroll.ts`): the run-wide reads once, each employee's
  calculation unchanged, one job checkpoint and one multi-row outcome-event insert. The group's other steps only
  record themselves; the last one ends the chunk (kernel step outcome `endChunk`). Additions, exclusions, unreadable
  employees and the employees a refused pass names take the per-employee transaction (`reprocessEmployeeTx`) in a chunk
  of their own, so each outcome and stop record is the per-employee path's; a refused pass is narrowed to the employee
  its refusal names (or halved when it names no one) and grouping resumes after them. The run-level checks (job claim
  and token, batch status, permission, closed period) are the per-employee transaction's own, taken once per group
  under the same keys and row locks; the payroll history barrier rules are those of the same engine pass. Chunk
  transactions set the point-read marker the processing job uses (0691/9954).
  - **Group size.** Measured on the hosted runner, one engine pass costs about 2.6 s whatever its size (2.1 s of it is
    the Audit loop's whole-run inputs capture and the run's headcount recount) plus about 53 ms per employee, and the
    calculation itself is 2–5% of the time; the rest is database. A one-employee pass therefore cannot meet a 100 ms or
    1 s chunk. The group size is estimated from two passes of different sizes (a straight line: fixed cost F, cost per
    employee m) so a chunk lasts `PAYROLL_REPROCESS_CHUNK_FIXED_MULTIPLE` x F (default 2) and at least
    `PAYROLL_REPROCESS_CHUNK_TARGET_MS` (default 1,000 ms), at most `PAYROLL_REPROCESS_GROUP_MAX` employees (default 200;
    `1` restores one employee per chunk), doubling from 16 until the estimate exists. A salary or statutory change for
    the company may then wait up to about 2F behind one chunk instead of F, while the run needs about one chunk per 50
    employees instead of one per employee. Each chunk logs an `[aihr-timing]` `bulk-chunk` line (closed labels and
    numbers only) and adds to `bulk_job.metrics`: `reprocessCalcMs` (process CPU: calculation and driver) and
    `reprocessDbMs` (the rest of the wall time), with group counts and per-chunk maxima.
  - **Known difference, intended.** The run-level audit rows of one engine pass, the `payroll_status_history`
    'reprocess' row, the `payroll-batch.selective-reprocessed` event and the Audit loop's inputs capture, are written
    once per group instead of once per employee; together they name exactly the same employees. The per-employee
    rows (result history, outcome events, tax-basis receipts) are unchanged. This also removes a quadratic cost: the
    inputs capture re-read the whole run for every employee.
  - **Proof.** `test/payroll-reprocess-set-equivalence.test.ts`: two tenants built identically through the product
    owners at 70 companies and 1,000 employments; a 100-employee run with TP3 openings, April and May income-tax
    corrections, salary and Pay Item changes, two additions and two removed salary records; per-employee path against
    the job, equal on every payslip column (money, statutory breakdown, tax metadata, version), run totals, headcount
    and recalculation marks, result history, tax-basis receipts and revisions, job outcomes and counts, and outcome
    events.
- **J2, imports: leave ledger import (built 25 November 2026; not yet on staging).** The `leave_ledger` job keeps one
  step per planned row; the first step of a chunk writes a group of following rows (`applyLeaveImportGroupTx`,
  `core/leave-import.ts`): the Access lock once, the configuration and every employee in one lock statement, the leave
  types and the narrowed employment and ledger reads once for the union of the rows' references, the unchanged
  validation and plan comparison per row in file order (each row sees the rows the group wrote before it), and one
  multi-row insert. Any decline (a changed row, a busy employee, a non-ASCII reference, a database refusal) rolls the
  group back and its rows take `applyLeaveImportRowTx`, which records every outcome. The adaptive group size, the
  `bulk-chunk` timing line and the `importCalcMs` / `importDbMs` metrics are shared for the per-step import kinds in
  `core/import-set-group.ts`; `LEAVE_IMPORT_GROUP_MAX=1` restores the per-row path. Hosted runner, 160-row file at
  70 companies / 1,000 employments (`test/leave-import-set-equivalence.test.ts`, which also proves equality of the
  ledger, events, job and progress view): 29.7 → 10.5 ms and 8.9 → 3.3 statements a planned row for the whole job,
  a group about 3.3 ms a row; `COPY` not used (the file is never the cost).
- **J2, imports: Profile and Family section imports (built 25 November 2026; not yet on staging).** The profile showed
  a per-row Profile step at about 83 ms and 31 statements, 35 ms of it the locked re-analysis reading every employee
  the file names again for every row. In a Profile or Family file that changes no identifier another row reads (IC,
  old IC, work e-mail), the first step of a chunk writes a group of following rows for distinct persons
  (`applySectionGroupTx`, `core/import-sections.ts`): the writer locks and the whole-file analysis once, with every
  group row's own database checks, then each row's unchanged tail of `applySectionRowTx` (plan comparison, authority,
  record locks, every owner writer, in file order). The writes stay per row (they are the owners' writers: person,
  compliance, statutory setters, dependents); only the reads are set-based. Any refusal rolls the group back to
  `applySectionRowTx`. `SECTION_IMPORT_GROUP_MAX=1` restores the per-row path. Bank and Statutory files (Import
  History) and the register imports (Qualification, Emergency Contact: about 40 ms an employee, already one
  set-based release) are unchanged.

### 8. Guardrails

- A per-route budget of transactions and statements for page renders and actions runs in the gate, measured by the
  existing request timing.
- Every list gets a "same cost for 1 company and 70 companies" test.
- `pg_stat_statements` and sampled `auto_explain` run on staging now. Production gets them only in one planned
  window, together with memory sizing, under a separate explicit production permission.
- Targets, read from the timing logs: page p95 under 1 s, save p95 under 300 ms, search and filter p95 under 300 ms.

## Order of work

| Phase | What | Schema change |
|---|---|---|
| 0 | Query statistics on staging; per-route baselines from timing logs | No (staging setting) |
| 1 | Default shared read transaction; frame batched with no write on load; Suspense for bell and inbox; Approvals set-based breakdown; gate route budgets | No |
| J1 | Worker lanes; refuse unserved job kinds; release check on advertised kinds | No |
| 2 | Precomputed access pilot: company access and Job descriptions, with equivalence, shadow and rebuild checks | Yes |
| 3 | Cached viewer profile; tag-based saves | Small |
| 4 | Capped counts, keyset paging, trigram search, set-based list reads | Indexes |
| 5 | Read models; widened gate budgets | Yes |
| J2 | Set-based payroll, reprocessing and import chunks; `COPY` imports | Staging tables only |
| 6 | Database memory sizing (planned production window); replicas only if still needed | No |

Each phase ships through the normal gate and the shared staging queue and is measured before and after from the timing
logs. The concrete Phase 0/1/J1 plan is `docs/plans/2026-11-24-database-read-cost-phase-0-1.md`.

## Consequences

- Access maintenance becomes a writer obligation: every change to grants, roles, assignments, reporting lines,
  departments, delegations or employment status must maintain the access tables in the same transaction. A missed
  writer is caught by the rebuild check and fails closed.
- Two authority paths coexist during the pilot and shadow period. The old definer functions remain the fallback until
  each family's switch is accepted, and the import/drift allowlists only shrink.
- On-screen list totals above 1,000 are approximate by design; any figure used for pay, statutory filing, export or
  audit stays exact.
- More worker processes increase concurrent database work; lane sizes and connection budgets follow
  `db/capacity.ts`.

## Alternatives rejected

- **Rewrite hot paths in a compiled language.** The time is inside database statements; it would not move.
- **Hardware or memory first.** It helps a little and does not remove the per-row cost; it is Phase 6.
- **Materialised views for access.** They cannot carry row security and refresh whole relations.
- **Client-side replicas of HR or pay data.** Audit and authorisation forbid it.
- **Screen-by-screen tuning only.** It has been done (6–10 November) and does not remove the shared causes.
