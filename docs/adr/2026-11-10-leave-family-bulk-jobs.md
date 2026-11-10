# Leave bulk operations run in batches of employees on the shared job kernel

Status: source implementation on `claude/bulkjob-leave-20261110` (base `claude/import-staged-job-20261110` @
0143d761c); hosted verification and integration pending. Production and staging untouched.
Draft migrations (unallocated): 9900 `leave_bulk_jobs` (three `bulk_job_kind` rows), 9901 `leave_ledger_stage`
(staged ledger rows), 9902 `bulk_job_unbounded_kind` (KERNEL: exclusive 'none'), 9903 `leave_follow_up_jobs` (four
`bulk_job_kind` rows).

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
  have written at the moment of release. A busy subject at release is a transient refusal, retried.
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
  `prepare` already made, which is when the synchronous run made it). Before each batch, under the engine's first
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
  batch discards everything. Residual: the override itself commits with the save, so for the minutes the job runs
  first-year employees on the type read the new model against the old ledger rows, until every correction appears at
  once; the old save committed both together. The save's `leave-type.updated` event now precedes the corrections.
- **Previews** (Generate Entitlement, Run Earned Accrual) no longer take the tenant's exclusive Access lock and the
  leave configuration lock for their whole length: each dry run runs in its own READ ONLY REPEATABLE READ
  transaction, one consistent snapshot, where the database refuses any write. Their figures are unchanged (the
  existing preview tests pass). The leave import preview already took no tenant lock.
- **Chat-confirmed leave import** now starts the owner's background import (kind `leave_ledger`, once per card by
  its operation key); a running import of the same person refuses without claiming the card. The card says it
  started and links to the leave import page, which shows progress and counts.
- **TOIL expiry and year-end close**: see the section below (converted in a separate checkout and merged here).

Open questions for the owner: Run Earned Accrual and the carry-expiry and monthly accrual timers were single
transactions too but stay per-step (each employee independent and idempotent; a rerun completes a refused batch);
the same staging would make them all-or-nothing. The A2C window above.
