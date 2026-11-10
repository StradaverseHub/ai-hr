# Leave bulk operations run in batches of employees on the shared job kernel

Status: source implementation on `claude/bulkjob-leave-20261110` (base `claude/import-staged-job-20261110` @
0143d761c); hosted verification and integration pending. Production and staging untouched.
Draft migration (unallocated): 9900 `leave_bulk_jobs` (three `bulk_job_kind` rows).

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

Not converted here: dry-run previews (read-only, still one transaction), entitlement recalculation on rule/template
saves (`reprojectEntitlementForLeaveTypeCohort`), A2C re-projection (`reprojectA2cEntitlement`), TOIL expiry and
year-end close (`core/toil.ts`), and the chat-import leave commit, which still uses the synchronous import.

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
