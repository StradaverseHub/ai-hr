# Leave bulk operations run in batches of employees on the shared job kernel

Status: source implementation on `claude/bulkjob-leave-20261110` (base `claude/import-staged-job-20261110` @
0143d761c); hosted verification and integration pending. Production and staging untouched.
Draft migrations (unallocated): 9900 `leave_bulk_jobs` (three `bulk_job_kind` rows), 9901 `leave_ledger_stage`
(staged ledger rows), 9902 `bulk_job_unbounded_kind` (KERNEL: exclusive 'none'), 9903 `leave_follow_up_jobs` (four
`bulk_job_kind` rows), 9905 `leave_stage_digests` (the release's per-employee digests), 9906
`leave_type_pending_year_cycle` (the deferred Leave Year Type change).

The leave cohort writers each ran as ONE transaction over the whole tenant, holding the tenant's Access lock and every
employee's leave-dependency lock until commit (earned accrual measured 3.4 s for 1,207 employees; Generate
Entitlement, carry expiry and year-open the same shape or larger), and a busy employee failed the whole tenant run.

- **Batches, not one transaction.** The unchanged engines (`openLeaveYear`, `accrueEarnedLeave`,
  `expireCarriedLeave`) take an optional `LeaveCohortStepRun`: run inside the caller's transaction for one batch of
  employees (5 by default: about 90 ms per engine call plus 20 ms per employee, measured under host load) and hand over the summary event payload instead of appending it. Each employee's figures
  depend only on that employee's ledger and profile and the tenant's configuration, so a batch computes exactly what
  the whole-cohort run computed for it. The run appends the engine's one summary event for the whole cohort with the
  run's own scope (the batch never leaks into the audit payload). Equivalence is proven on a populated fixture
  (`test/leave-cohort-equivalence.test.ts`): ledger, balances, events, generation log and the screen's result.
- **Background jobs for the admin screens** (`core/leave-cohort-worker.ts`): `leave_generation` (Generate
  Entitlement: year-open batches, then the earned Annual Leave hand-over decided on the WHOLE run's year-open lines,
  then the processing log) and `leave_accrual` (Run Earned Accrual), both per-step, one per tenant (a person's own
  running job is rejoined). Whole-run refusals the synchronous run made before writing (the information-only
  correction guard, an invalid year) are made in `prepare`, so they still refuse before anything is written. A busy
  employee is retried; a batch that keeps failing is recorded and left unchanged (the engines are idempotent, so the
  next run completes it). Authority: admin at enqueue, the kernel's captured-grant fence on every transaction, and
  admin re-checked when the summary events and the log are written.
- **Leave ledger import** (`core/leave-import-worker.ts`, kind `leave_ledger`) is the bulk plan's proof ported onto the
  kernel: one planned row per step through the same row writer, summary event written once. The per-row re-check
  under the row's locks used to read every employment and the whole ledger (its hold grew with the tenant); it now
  reads only the employments the row's reference can match (and any non-ASCII code or e-mail) and their ledger rows,
  deciding exactly as before.
- **Generate Entitlement's log** inserts its lines in statements of at most 1,000: one statement exceeded PostgreSQL's
  65,535 bind parameters at about 7,300 lines and failed the log after the grants committed (found at 3,000
  employees).
- **Timers stay timers.** `scripts/accrue-earned.ts` and `scripts/expire-carry.ts` run with a system context and no
  signed-in creator, which the kernel's admission requires, so they use the same batch steps through
  `runLeaveCohortInline` (short transaction per batch, transient retry, one summary event, failure reported after the
  other batches are written). Their systemd units are unchanged.

## Round 2 (11 Nov 2026)

- **All-or-nothing where the old run was (owner's principle): staged ledger rows** (`core/leave-stage.ts`, draft
  9901). `leave_ledger.stage_id` is stamped by trigger from the transaction-local `app.leave_stage`; a restrictive
  policy hides a staged row from every session except the job's own transactions (`app.leave_stage_visible`) until
  its stage is released. Release is one row in `app.leave_stage_release` (constant time, through a definer that
  checks the caller can act on the job); the worker then clears the markers in bounded batches (settle) and forgets
  the release row; discard deletes unreleased rows in bounded batches on the owner connection. The five definer
  readers of `leave_ledger` were reviewed and need no change (they read TOIL credits by id, debits by request, or
  count rows to refuse a void, where a staged row counting is the conservative answer).
- **Why release re-checks.** Other writers keep working on the same employees while their rows are staged and
  cannot see them (the monthly accrual would grant the same top-up twice). Every participating writer takes the
  employee's leave-dependency lock, so one that touched an employee after its batch was staged has committed before
  the release can take that lock. The release takes the tenant's Access lock and every subject's lock (one
  statement), compares per-employee digests of everything the engines read (ledger rows other than the job's own,
  the employment and assignment rows, a frozen encashment balance) and a digest of the leave configuration with what
  each batch saw, and recomputes a changed batch (its staged rows dropped, the engine re-run) before trying again
  (40 attempts, then the job fails and keeps nothing). The released rows are what the old single transaction would
  have written at the moment of release. A busy subject at release is a transient refusal, retried. The digests are
  computed by one administrator-only definer (draft 9905) that reads the visible set once and applies the same stage
  visibility: through row security they cost 0.5-0.7 s for 3,000 employees inside the release, now 28-46 ms.
- **Generate Entitlement** (`leave_generation`) is now `atomic`: the year-open batches write under one stage, the
  earned Annual Leave batches under another, both visible to the job. A refused year-open batch discards both (the
  old run threw before writing: no ledger row, no event, no log). A refused earned batch fails the earned part as a
  whole: later earned batches are skipped and at release its stage is dropped while the year-open is released, so
  the entitlement stays and the result reports the earned part's error, exactly as the old run did. The two summary
  events are written in the release transaction with the rows; the processing log follows (unchanged, with the
  1,000-line statements). Cancel discards. Proven in `test/leave-cohort-equivalence.test.ts` (an earned failure
  injected in the last batch, a year-open failure, and a ledger change made by another writer between staging and
  release, each against the synchronous run).
- **Run Earned Accrual job: once-per-run reads.** The engine takes an optional preload (scoped active types, tables
  in force, the template resolver for every employee the run may reach, and the whole-scope protected-period check
  `prepare` already made, which is when the synchronous run made it), read once per worker in its own READ ONLY
  snapshot before a chunk takes any lock (at 3,000 employees about a second). Before each batch, under the engine's first
  locks (the Access lock every workforce writer also takes, and the leave configuration shared), one statement
  re-checks the configuration and the batch's employment and assignment rows; anything changed and the batch reads
  for itself. Subject leave-dependency locks (configuration plus every employee) are one statement for every caller;
  a chunk runs one batch. Unloaded at 3,000 employees a batch went from 19 to 14 statements and 45 to 33 ms.
  Run Earned Accrual itself stays per-step (see open questions).
- **Entitlement recalculation** after a leave-type earning-rule, table or eligibility-rule save (`leave_recalc`,
  `core/leave-follow-up-worker.ts`): admitted where the save ran the loop, with the as-at date fixed then; one
  employee per step (the step's savepoint is that employee's transaction), refusals recorded and the rest continue,
  as the best-effort loop did. Same result object. A caller with no signed-in user still runs the loop inline.
- **KERNEL EXTENSION (draft 9902; integration note).** `bulk_job_kind.exclusive` gains `'none'`: the admission
  trigger keys such a job by its own id, so one person may hold several active jobs of the kind. `'tenant'` and
  `'creator'` are unchanged and still derived by the database. Used by `leave_recalc` and `leave_a2c`, where a second
  save while the first job runs must queue a second job, not refuse the save; each re-reads the committed
  configuration and is idempotent, so they converge (tested).
- **A2C re-projection** (`leave_a2c`): the web Leave Year Type save (`a2cInBackground`) admits the job inside its own
  transaction instead of correcting inline; other callers of `updateLeaveType` keep the inline correction. `prepare`
  makes the whole-tenant protected-period check the save made; batches of first-year employees stage their ledger
  rows and hand each corrected employee's history row and `leave.entitlement.recalculated` event to the job (a
  `sink` on the unchanged engine); release as above, then the history rows and events in bounded steps. A refused
  batch discards everything.
- **The Leave Year Type change waits for its corrections (draft 9906; return round 1).** A save that moves a type TO
  a2c leaves `year_cycle_override` as it was and names the job in `leave_type.pending_year_cycle_job_id`; the
  engine computes as if the type had the new value (`yearCycleOverrideAs`). The release is the configuration write
  the save used to make: under the configuration lock exclusively it sets the override, clears the pending job,
  appends the override's own `leave-type.updated` event and releases the staged rows, all in ONE transaction. So
  every reader sees the old type with the old figures until then and the new type with every correction after,
  never a mix (`test/leave-follow-up-jobs.test.ts` observes the type and the corrections in one snapshot after every
  unit of the job). The save's own event carries the rest of the save; the override's change is recorded by the
  release that makes it. A later Leave Year Type save clears or replaces the pending job, and a superseded job
  releases nothing; a refused or stopped job withdraws its pending change. A move away from a2c is still made by the
  save itself (the engine has nothing to correct then). While a conversion waits, the Leave Year Type form shows the
  old value and the progress panel says the type is being applied.
- **Previews** (Generate Entitlement, Run Earned Accrual) no longer take the tenant's exclusive Access lock and the
  leave configuration lock for their whole length: each dry run runs in its own READ ONLY REPEATABLE READ
  transaction, one consistent snapshot, where the database refuses any write. Their figures are unchanged (the
  existing preview tests pass). The leave import preview already took no tenant lock.
- **Chat-confirmed leave import** now starts the owner's background import (kind `leave_ledger`, once per card by
  its operation key); a running import of the same person refuses without claiming the card. The card says it
  started and links to the leave import page, which shows progress and counts.
- **TOIL expiry and year-end close**: see the section below (converted in a separate checkout and merged here).

Owner decision (return round 1): per-step is accepted for Run Earned Accrual, the carry-expiry and monthly accrual
timers and the TOIL sweeps (each employee independent, reruns idempotent). A refusal part-way followed by the same run
again ends exactly where an uninterrupted run ends: proven for the accrual job and both timers in
`test/leave-cohort-equivalence.test.ts` ("per-step leave runs") and for the sweeps in `test/toil-sweep-job.test.ts`.

## TOIL expiry and the replacement-leave year-end close (kinds `toil_expiry`, `toil_year_close`, draft 9903)

Source: `claude/bulkjob-toil-20261111`. Each sweep (`runToilExpiry`, `closeReplacementLeaveYear` in `core/toil.ts`) was
ONE request transaction holding the tenant's Access lock, the leave-dependency configuration lock exclusively and every
subject employee's locks for the whole tenant.

- **Off the request path.** `runToilExpiryAction` / `closeReplacementLeaveYearAction` check the same authority
  (`ToilSweepForbiddenError`) and enqueue (`core/toil-sweep-job.ts`); the Leave Credit page follows the job and, when it
  finishes, opens the address the action used to redirect to, so the existing banners report the result. A person's
  own running sweep is rejoined; another administrator's is refused. Notice group `toilSweep`.
- **Batches, unchanged calculation** (`core/toil-sweep-worker.ts`, per-step). One step is 5 employees
  (`LEAVE_COHORT_BATCH_EMPLOYEES`) and at most 40 credits (`TOIL_SWEEP_BATCH_CREDITS`, an employee is never split), one
  step per chunk. A batch runs the selection, subject locks and NOWAIT re-read the synchronous sweep ran, narrowed to its
  employees (`lockedDueToilAccrualsTx`, `lockedActiveToilAccrualsTx`, now shared by both forms), and the unchanged
  executor `expireAccrualsTx` with the same per-company boundary and carry-forward rules (`sweepReplacementYearTx`).
  Each credit's settlement depends only on that credit, its employee's wages and hire date and its company's leave
  cycle and country, so a batch writes what the whole-tenant sweep wrote for those employees; events keep the sweep's
  order (employment, then credit). The synchronous functions remain for other callers.
- **Lock modes.** A batch takes the Access lock, the configuration lock SHARED and its employees' locks. Exclusive is
  needed only to create the tenant's REPLACEMENT leave type (`ensureReplacementLeaveType` inserts on a miss): the
  transaction that makes the steps runnable creates it once, under the exclusive lock, when the plan settles anything
  and the type is missing (exactly when the old sweep reached it). A batch resolves the type with
  `findReplacementLeaveTypeIdTx` under the shared lock; every writer that archives, reclassifies or deletes a leave type
  takes the lock exclusively, so the executor finds the same type later in that transaction. Only if the type vanished
  after preparation does a batch take the lock exclusively (non-waiting) and let the executor create it.
- **Whole-run decisions once.** Expiry's `skippedOutOfScope` is counted in preparation, in one snapshot (due and
  visible, minus settleable). The close's decisions (the boundary's markers, the legacy tenant-wide marker, "already
  closed") are made in preparation from the same marker read. The per-company `replacement-leave-year.closed` markers
  are written once after the last batch, with the subtotals and carried-forward counts the synchronous close computed,
  only for companies that had in-scope credits and none of whose employees sits in a failed batch (a marker on a partly
  swept company would strand the rest); the boundary's markers are read again under the Access lock and the shared
  configuration lock so a company is never closed twice.
- **Partial result.** A busy employee (credit lock or row held, or the due set moving: `LeaveDependencyUnavailable`) is
  retried; a batch that keeps failing (60 retries) or is refused is recorded and left unchanged, the job's result is
  what the synchronous sweep returns for what was written, `failedEmployees` says how many employees were not
  processed, and running the sweep again completes them (only `active` credits are ever touched).
- **Authority.** Admin at enqueue, the kernel's captured-grant fence on every transaction, admin re-checked in every
  batch and in the transaction that writes the markers and the result: a creator who loses admin gets no marker.
- **Evidence.** `test/toil-sweep-equivalence.test.ts` (populated fixture: four companies including an anniversary
  cycle; lapse, statutory and ORP convert-to-pay, carry forward, partly taken, self-declared, not yet due; type present
  and absent; a dual-scoped administrator's `skippedOutOfScope`), `test/toil-sweep-job.test.ts` (refused batch and
  re-run, authority, busy employee), `test/toil-sweep-job-panel.dom.test.tsx`, `test/toil-sweep-notice.dom.test.tsx`.

**Open question for the owner: the sweeps are no longer all-or-nothing.** The old transaction settled every due credit
or none. The ledger-row staging the rest of the family uses (`core/leave-stage.ts`) hides staged `leave_ledger` rows
only; a sweep also flips `toil_accrual.status`, links `settled_ledger_entry_id` and appends one `toil.converted` /
`toil.lapsed` event per credit (convert-to-pay records the owed cash on that event; no payroll input is written), and
none of those has an invisible staged state. So a batch that cannot be written leaves its employees' credits active
while the rest are settled, and the screen says so. Two consequences to accept or reject: (1) after a re-run, the
marker of a company that was partly swept states only what the re-run settled for it (the first run's part is in its
credits' events), where an uninterrupted run's marker states the whole; (2) the REPLACEMENT leave type, when created,
is created before the batches and stays even if every batch fails. Keeping all-or-nothing would need staged states for
the credit status, the settlement link and the per-credit events (a schema change of the 9001/9004 kind); no schema
change is made here.

## Rehearsal, round 2 (3,000 fictional employees, disposable local cluster, shared loaded host)

`scripts/performance/leave-bulk-rehearsal.ts` against the real protected worker process, probes running throughout,
every tenant-wide lock sampled (Access, leave configuration, audit chain). Runs 6, 8 and 9 (evidence in the worker's
scratch directory); Personnel is slow on this host with no job running (idle baseline 2.8-7.3 s), so it is not
attributed to the jobs. No run had an error from a job, a Busy refusal or a broken audit chain (`verifyTenantChain`
valid).

| Operation | Longest chunk / release transaction | Longest sampled tenant-lock hold by the job | Clock-in max | Access writer max |
|---|---|---|---|---|
| Generate Entitlement preview (snapshot) | none (no tenant lock) | 0 ms | 277 ms | 261 ms |
| Generate Entitlement (staged, 3,000 + earned) | 372 ms / release 128 ms | 262 ms | 557 ms | 542 ms |
| Run Earned Accrual (run 8 / run 9) | 435 ms / 1,679 ms (a host stall that held the probes' own transactions 1.4-1.8 s) | 371 / 441 ms | 284 / 1,815 ms | 459 / 1,683 ms |
| Entitlement recalculation (3,000) | 669 ms | 475 ms | 1,002 ms | 941 ms |
| A2C re-projection (756 first-year) | 322 ms / release 42 ms | 262 ms | | |
| Leave ledger import (3,000 rows) | 331 ms | 148 ms | 288 ms | 230 ms |
| TOIL expiry (3,000 credits, half converted to pay) | 366 ms | 250 ms | 342 ms | 321 ms |
| Replacement-leave year close (1,500 settled, 1,500 carried) | 282 ms | 118 ms | 276 ms | 208 ms |
