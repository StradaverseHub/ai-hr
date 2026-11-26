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
  - **Group size.** Measured on the hosted runner when this was built, one engine pass cost about 2.6 s whatever its
    size (2.1 s of it the Audit loop's whole-run inputs capture and the run's headcount recount; both were removed
    from the pass on 25 November 2026, see "Fixed cost of a pass" below) plus about 53 ms per employee, and the
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
    'reprocess' row and the `payroll-batch.selective-reprocessed` event, are written once per group instead of once
    per employee; together they name exactly the same employees. The per-employee rows (result history, outcome
    events, tax-basis receipts) are unchanged.
  - **Fixed cost of a pass (decided 25 November 2026).** Most of the 2.6 s was two whole-run reads, each paying the
    native payslip read view's per-row history-visibility predicate (about 3 ms a row):
    - *Audit loop inputs capture: once per job, not once per pass.* A selective reprocess job's passes no longer
      capture (`deferAuditCapture`, internal to `core/payroll.ts`). The job takes one capture
      (`captureSelectiveReprocessInputsTx`) in its own finalize unit, with no run key held, before it marks the
      reprocess job completed; a job that stops after committing employees takes it in its settle, under its
      creator's re-checked authority; the request-path loop takes it after its last employee (and on a stop). Each
      job records `captured` on its plan in the same transaction, so a capture is never repeated, and only the worker
      holding the reprocess job's token captures. The capture keeps its shape (`trigger` 'reprocessed', source key
      `inputs:<run>`): `reprocessedEmploymentIds` names every employee the job recalculated or added (outcome status
      `reprocessed`), and the hashes are the whole run's inputs and results after the job's last committed employee.
      What is given up: the intermediate snapshots between groups. Nothing reads them: the daily Audit loop compares
      only the latest `inputs:<run>` capture with `inputs_now`, and a per-pass capture already hashed every employee
      outside its group as they stood at that moment, so an input changed between chunks was never pinned to the
      result that used it. A capture missed because the creator's access is gone is not retried (the daily
      `inputs_now` capture still shows the inputs), exactly as a pass with no login. Every other caller of the subset
      path (statutory adjustments, the public `generatePayslips`) still captures in its own transaction.
    - *Headcount recount through the run's write portal.* The pass recounts `employee_count` through
      `payroll_history_native_payslip_write`, the portal it writes its payslips through and the run's reset and removal
      owners read the whole run through, instead of the read view. Per row it asks the write authority (payroll
      administration of the employment, run still writable), not the effective-history chain. For the administrator who
      may reprocess the two count the same rows; the equivalence test asserts the stored headcount equals both. The
      removal owner's recount (`removeEmployeePayrollTx`) still uses the read view and is a follow-up.
    - *Measured* on `alpha-focused-checks.yml` with the fixture below (before: run 45424377289 at 0e7d6a88d; capture
      only: run 45460679094; both changes: run 45464181979 at dfd65261d). The engine pass's fixed cost F, fitted from
      the job's group chunks (engine wall time against group size), went from about 1.8 s to about 0.29 s, with about
      30 ms per further employee either way. One per-employee pass (request path): 1,843 ms, then 664 ms, then 373 ms.
      The 100-employee job: 29.0 s in 15 chunks, then 14.7 s, then 10.0 s in 14 chunks; its longest chunk, which bounds
      how long a salary or statutory edit for the company waits: 2.77 s, then 1.70 s, then 1.00 s. The job's one
      capture unit takes about 1.25 s and holds no run key. The headcount read for the 100-payslip run: read view
      about 295 ms, write portal about 15 ms. With the smaller F the same `PAYROLL_REPROCESS_CHUNK_FIXED_MULTIPLE`
      keeps chunks near the 1 s `PAYROLL_REPROCESS_CHUNK_TARGET_MS` floor (largest group 18 employees).
  - **Proof.** `test/payroll-reprocess-set-equivalence.test.ts`: two tenants built identically through the product
    owners at 70 companies and 1,000 employments; a 100-employee run with TP3 openings, April and May income-tax
    corrections, salary and Pay Item changes, two additions and two removed salary records; per-employee path against
    the job, equal on every payslip column (money, statutory breakdown, tax metadata, version), run totals, headcount
    and recalculation marks, result history, tax-basis receipts and revisions, job outcomes and counts, and outcome
    events. Both paths write exactly one Audit loop inputs capture per job, naming the reprocessed employees, whose
    hashes equal an independent read of the run's inputs and results after the job; the stored headcount equals the
    read view's and the write portal's count.
- **J2, payroll processing (built, 25 November 2026; not yet on staging).** The `payroll_process` job keeps its steps
  of `PAYROLL_PROCESS_STEP_EMPLOYEES` (4), but one `employees` step now computes a group: itself and the chunk's following
  employees steps, up to an adaptive number of employees, through one pass of the same compute path
  (`runPayrollProcessingUnitTx`), so the run-wide reads and checks (about 45 statements) are paid once per group instead
  of once per four employees. The step marks the steps it covered applied in the same transaction (new kernel step
  outcome `consumed`: the kernel loads and verifies those steps, and the chunk budget can never split a group); the
  group's whole chunk result sits on its first step, and finalize skips the covered steps' empty results. A group pass
  that refuses is rolled back to its savepoint and its steps then run one per pass exactly as before, so a refusal and
  its message are the per-step path's; grouping resumes after them. Group size: the shared estimator
  (`core/bulk-job-group-size.ts`, also used by the reprocess) aims a pass at max(`PAYROLL_PROCESS_CHUNK_TARGET_MS`,
  default 500 ms, `PAYROLL_PROCESS_CHUNK_FIXED_MULTIPLE` x the measured fixed cost, default 2), at most
  `PAYROLL_PROCESS_GROUP_MAX` employees (default 200; `1` restores one step per pass), doubling from 16. The target is
  lower than the reprocess's because a processing pass has no whole-run inputs capture, so its fixed cost is small, and
  a chunk holds the company's payroll inputs key exclusively.
  - **Per-employee statements removed from the engine pass** (both full generation and the reprocess use them): the
    income-tax scheme resolution (`resolveTaxSelectionsMY`, pack seam `resolveTaxSchemes`) reads identities, statutory
    rows (FOR SHARE, in person order) and selections for the whole pass and takes the declaration advisory locks in the
    per-employee order in one statement: four statements per pass instead of four per employee. Each employee's result
    or refusal comes from the single call's rules and is raised where the single call stood (first in employment order
    for a generation, inside the payslip loop for a reprocess). The holiday sets of working-day proration, daily rates
    and working-days leave divisors come from the calendar module's one-statement window read
    (core/calendar-window-inputs.ts), 50 employees per statement, instead of each employee's own statements once per use.
    New payslips are written by multi-row inserts of up to 500 after the loop (the only insert trigger on payslip is
    deferred, so row and trigger outcomes are the per-row insert's). `PAYROLL_PASS_SET_READS=off` restores all three
    per-employee forms. Still per employee, and only for the configurations that need them: the formula-builder runtime
    and attendance overtime windows.
  - **Timing.** Each pass logs an `[aihr-timing]` `bulk-chunk` line (`kind` payroll_process, `mode` group or single,
    employees, steps, wall, calculation, database) and adds to `bulk_job.metrics`: `processCalcMs` (process CPU) and
    `processDbMs` (the rest of the wall time), `processGroups`, `processGroupEmployees`, `processSingles`,
    `processSingleEmployees`, `processRefusedGroups` (group passes that refused and fell back) and per-pass maxima. A
    one-step pass is otherwise the run's last step left alone, or a group estimated below two steps.
  - **Proof.** `test/payroll-process-set-equivalence.test.ts`: two tenants built identically through the product owners
    at 70 companies and 1,000 employments; a 120-employee run with TP3 money and Section C2 openings, a taxable and a
    non-taxable Pay Item, May salary changes, daily-rated employees, people with no income tax and a May joiner, processed
    for April and May on the per-employee path as it was (one step per pass, `PAYROLL_PASS_SET_READS=off`) and on the
    set path; equal on every payslip column, run totals, headcount and status, inputs, Pay Items,
    audit events, status history and job results; a June run that loses a salary record after planning refuses and
    discards identically. The group tax resolver is compared employee by employee with the single resolver, refusals
    included. `test/payroll-processing-job.test.ts` runs its synchronous-oracle comparison (golden digest and audit
    events) both ways.
- **J2, imports: employee import (built, 25 November 2026; not yet on staging).** Profiled at the 70-company shape on
  the hosted runner, a staged hire cost about 105–115 statements and 190–270 ms a row, spread over many small
  statements (locks and checks repeated per row, about 17 statements per row rebuilding the visible-employment array,
  five single-row event inserts, deferred work at commit); the calculation was about 20% of it. The first employee
  step of a chunk of the common shape (a new person hired into one company with the statutory profile, the tax
  selection, the IC-derived date of birth, the first salary and the opening leave grants; no family, register,
  allocation or other optional block) now writes the following pending rows of that shape as one group
  (`applyEmployeeHireGroupTx`, `core/employee-import-set.ts`): the tenant-level locks and checks of each owner once per
  group, every per-subject lock key and authority check in one statement each, multi-row writes, and the group's events
  in ONE statement in the per-row order (each row's `employment.hired`, `employee.tax-scheme.selected`,
  `statutory.my.created`, `person.updated`, `compensation.set`), so the audit chain carries the same events in the same
  order. The rules stay with their owners: the hire's employment values, event payload and opening grant
  (`core/org.ts`), the salary terms and event (`core/comp.ts`), the date-of-birth write (`core/profile.ts`) and the
  country's statutory and tax-selection values (reached through the pack registry, `statutory.hireGroup`) are shared
  functions both paths call. The set path never decides a refusal: anything the per-row path would refuse or do
  differently (a failed check, an existing row where a new one is expected, a subject lock another transaction holds,
  any database refusal) rolls the group's savepoint back, and every row of that group takes the per-row path
  (`applyEmployeeImportRowTx`), which records exactly its own outcome, error-log row and refusal. The staged-attempt
  markers, writer locks, release, settle and discard are unchanged; chunk transactions also set the point-read marker
  (0691). Other rows (family, registers, superiors, every optional block, non-administrator initiators) take the
  per-row path as before. `COPY` is not used: the steps are staged through the sealed kernel definer
  (`app.bulk_job_steps_put`, 400 per statement), which measured 44 ms for the whole 60-row file, so loading is not
  where the time goes; a `COPY` route would need a new definer reading a session table for no measurable gain.
  - **Group size.** A chunk holds the tenant's exclusive Access lock, so groups aim for a short chunk:
    `EMPLOYEE_IMPORT_CHUNK_TARGET_MS` (default 300 ms of group work) or `EMPLOYEE_IMPORT_CHUNK_FIXED_MULTIPLE` (default 2) x the
    measured fixed cost, never above `EMPLOYEE_IMPORT_CHUNK_CEILING_MS` (default 500 ms), estimated from two groups of
    different sizes as for the reprocess job, starting at 8 rows; `EMPLOYEE_IMPORT_GROUP_MAX` (default 64; `1`
    restores the per-row path for every row). Per-row steps keep the 100 ms chunk budget. Each chunk logs an
    `[aihr-timing]` `bulk-chunk` line (mode `group`, `single` or `declined` with a closed reason) and adds
    `importCalcMs` (process CPU) and `importDbMs` (the rest of the wall time) to `bulk_job.metrics`, with group and
    single counts and per-chunk maxima.
  - **Proof.** `test/employee-import-set-equivalence.test.ts`: two tenants built identically at 70 companies and 1,000
    employments import the same files through the job, per row and set-based: a 120-row file (common rows, family
    rows, direct superiors, a bad email, a duplicate Employee ID, an Employee ID already in use, a blank name) and an
    80-row file refused while saving (one row's Employee ID taken after preparation, so its group is declined
    mid-file). Equal on every saved row, every event in chain order with its payload, the job, the progress view,
    Import History (attempt, items, events, runs and error rows) and the chain verification.
  - **Measured** (hosted runner, the equivalence file of 120 rows): 157 ms and 117 statements a row per row against
    81 ms and 28 statements set-based (run 45478436767; calculation 5.0 s and database 13.9 s against 1.7 s and 8.0 s),
    and 284 against 126 ms a row on a slower runner (run 45482824672). One group costs about 140 ms fixed plus about
    20 ms a row; about 15 ms a row more is deferred work at commit, and validation (unchanged) about 20 ms a row. Groups
    of about 16 rows would save a further 15–20 ms a row at the price of exclusive holds near 1 s, so the target stays
    at 300 ms. The longest chunk lock hold rose from about 350 ms to about 700 ms (commit included), under the 1 s
    bound, over about a third as many chunks.
  - **Maintenance.** A change to a covered owner (the hire, the first salary, the IC-derived date of birth, the MY
    statutory or tax-selection initialisation) must keep the set path in step; the equivalence test fails otherwise.
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
  set-based release) are unchanged. Hosted runner (`test/section-import-set-equivalence.test.ts`, run 45494683209):
  Profile 72.7 → 47.0 ms and 30.3 → 25.3 statements a row; Family 57.4 → 31.3 ms and 27.7 → 19.4. The writers'
  own statements remain, so the gain is smaller than for the leave import, and the longest chunk hold rises from
  about 210 to 505 ms (groups of at most 16 rows); `SECTION_IMPORT_CHUNK_CEILING_MS` lowers it.

### 8. Guardrails

- A per-route budget of transactions and statements for page renders and actions runs in the gate, measured by the
  existing request timing.
- Every list gets a "same cost for 1 company and 70 companies" test.
- `pg_stat_statements` and sampled `auto_explain` run on staging now. Production gets them only in one planned
  window, together with memory sizing, under a separate explicit production permission.
- Targets, read from the timing logs: page p95 under 1 s, save p95 under 300 ms, search and filter p95 under 300 ms.
- Standard for new work (owner, 25 November 2026, "Read models + standard"): the rules in
  `docs/architecture/FUTURE-BUILD-CONTRACT.md` ("Database read cost"). They are enforced by shrink-only ratchets,
  `test/read-cost-ratchets.test.ts` and `test/read-cost-policy-authority.test.ts`, with allowlists in
  `test/read-cost-ratchets/`. A raised route budget is recorded here or in the area's ADR, in the same PR.
- Raised budget, board 124a979e (26 November 2026): `removeFixedTransactionDialogAction` 21 -> 22 statements
  (test/payroll-board-20261125-action-read-budget.test.ts, alpha-focused-checks run 45770342651). The extra statement
  is the one bounded `INSERT ... SELECT` every recalculation mark now makes to record a pending mark for an employee
  whose company the saver cannot administer payroll for (migration 7560, approved plan item 9); for a payroll
  administrator it inserts nothing. Same number of transactions; no other measured action moved.
- Raised budgets, board build integration of 038c304b / bc6b5490 with 124a979e (26 November 2026): the CP38 writers
  mark through the same helper, so each gains the same one statement (test/cp38-read-budget-038c304b.test.ts,
  alpha-focused-checks run 45778899374: Add 13 -> 14, Edit 15 -> 16). Budgets `saveCp38DialogAction` 15 -> 16,
  `deleteCp38DialogAction` 14 -> 15, `deleteCp38Action` 12 -> 13. Same number of transactions; the CP38 page reads
  did not move.

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
