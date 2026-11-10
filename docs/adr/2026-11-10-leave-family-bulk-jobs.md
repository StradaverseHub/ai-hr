# Leave bulk operations run in batches of employees on the shared job kernel

Status: source implementation on `claude/bulkjob-leave-20261110` (base `claude/import-staged-job-20261110` @
0143d761c); hosted verification and integration pending. Production and staging untouched.
Draft migration (unallocated): 9900 `leave_bulk_jobs` (three `bulk_job_kind` rows).

The leave cohort writers each ran as ONE transaction over the whole tenant, holding the tenant's Access lock and every
employee's leave-dependency lock until commit (earned accrual measured 3.4 s for 1,207 employees; Generate
Entitlement, carry expiry and year-open the same shape or larger), and a busy employee failed the whole tenant run.

- **Batches, not one transaction.** The unchanged engines (`openLeaveYear`, `accrueEarnedLeave`,
  `expireCarriedLeave`) take an optional `LeaveCohortStepRun`: run inside the caller's transaction for one batch of
  employees (20 by default) and hand over the summary event payload instead of appending it. Each employee's figures
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
  kernel: one planned row per step through the same row writer, summary event written once.
- **Timers stay timers.** `scripts/accrue-earned.ts` and `scripts/expire-carry.ts` run with a system context and no
  signed-in creator, which the kernel's admission requires, so they use the same batch steps through
  `runLeaveCohortInline` (short transaction per batch, transient retry, one summary event, failure reported after the
  other batches are written). Their systemd units are unchanged.

Not converted here: dry-run previews (read-only, still one transaction), entitlement recalculation on rule/template
saves (`reprojectEntitlementForLeaveTypeCohort`), A2C re-projection (`reprojectA2cEntitlement`), TOIL expiry and
year-end close (`core/toil.ts`), and the chat-import leave commit, which still uses the synchronous import.
