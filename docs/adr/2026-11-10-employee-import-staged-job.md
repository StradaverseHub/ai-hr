# Employee imports run as background jobs with staged rows and a constant-time release

Status: source implementation on `claude/import-staged-job-20261110`; hosted verification and integration pending.
Base: `7b585515d67885045d79ebb3dce4ef6c5e7b1bd8` (on main `f07f32dcd`). Production and staging untouched.
Draft migrations (unallocated): 9001 staged rows, 9003 shared bulk-job kernel, 9004 release visibility and staged events,
9005/9006 kernel hardening (branch `claude/bulk-job-kernel-hardening-20261111`, section "Hardened kernel").

The single import transaction held tenant-wide locks for its whole length (DESIGN.md: 11 s for 200 rows). This decision
replaces it with a job: validate once, apply in chunk transactions of about 100 ms of work (one or two rows), then release in
one short transaction.

- **Staged state.** `employment`, `person` and (9004) `domain_event` carry `import_pending_attempt_id`, stamped by the
  database for every row written while `app.import_attempt` is set; a guard refuses any other writer of the column.
  A RESTRICTIVE policy hides staged rows from every RLS-subject role unless the session's `app.import_attempt` matches
  or the attempt is released. Child rows are hidden through `app.import_pending_employment_ids()`/`..._person_ids()`.
- **Staged events.** Every event appended inside a chunk is stamped, so person, statutory, family and profile events
  with no subject employment stay invisible until release like the hire's own events. Chain verification (group
  administrators, sequence numbers only) still reads every chained row through `app.audit_chain_verification`.
- **Definer audit.** Definers bypass RLS. The phase-1 audit classified all 622 definers mentioning employment/person; 35
  readers that act on staged rows or return identified data filter them. 9004 rewrites those filters, from their
  installed definitions with an exact predecessor count, to the release-aware `app.import_marker_visible()`.
  Reservation readers (`employee_code_claim`, `card_identifier_*`, `create_login_person`, `people_nric_*`) still see
  staged rows so codes, cards, emails and NRICs stay reserved.
- **Release (activation).** Measured on 3,500 employees: the old activation (one UPDATE per table) held the Access,
  leave-dependency and profile-policy locks for 1.45 s, about 0.6 s in the statement and 0.85 s in COMMIT, where every
  row's deferred constraint triggers ran. It grew with the file. Now visibility is decided by the attempt:
  `app.import_release` inserts one `app.import_attempt_release` row under the initiating user's fresh authority,
  after the duplicate-email recheck under the workforce write lock, in the same transaction as the completion events and
  any evaluation receipt. Every reader sees the whole import at that instant, whatever the file size.
- **Settle.** Afterwards `app.import_settle` clears the markers in bounded owner batches (adaptive, about 200 ms each),
  which fires the ordinary row and deferred triggers (Entra queue, replacement holidays, access revision, epochs)
  exactly as the single UPDATE did, without changing what anyone can see. Release already invalidated the tenant's
  Access revision and company-organisation epoch once.
- **Discard.** Decided rule: a discarded staged hire leaves `employment.hired` followed by a void event (ADR-0157).
  `app.import_discard_batch` voids in bounded owner batches; the void events carry the attempt, and the last batch
  releases the attempt as `discarded`, so hires, events and voids become visible together. A revoked initiator can
  never leave staged rows behind.
- **AI-evaluation-bound imports** use the same job. Admission checks the binding against the exact inputs and replays
  a committed receipt instead of importing twice; the worker claims the binding when the steps become runnable and
  completes it in the release transaction; the screen reads the receipt with the existing reopen action.
- **Worker packaging.** The kernel loop runs inside the protected import worker, `aihr-bank-import.service`
  (`scripts/bank-import-runner.ts`), so the existing closed worker package, first-install helper and staging upgrade
  helper carry it. `deploy.sh` checks the worker heartbeat (`scripts/check-import-worker.ts`); the import screen shows
  a queued import as waiting for the import service while no live worker serves its kind.
- **Completion notice.** The kernel appends `bulk-job.finished` under the creator's authority once per job; the
  registry recipe (in-app, no email category) addresses the creator's own current employment only for the job's
  recorded event, stored as message keys rendered by the bell in all six catalogues, linking to Import History.

Known limits: chat-import commits and `commitEmployeeImport`'s remaining callers still use the synchronous path; usage
metering and the entitlement alarm count staged rows as hidden until settled (seconds after release).

## Shared job kernel

One store and worker for every background bulk operation: `bulk_job_kind` (registry), `bulk_job` (admission,
captured grants, lease, progress, counters, metrics, outcome, notice) and `bulk_job_step` (ordered steps with the
applied marker), migration 9003. `core/bulk-job.ts` is the web side; `core/bulk-job-worker.ts` the worker side.

- **Admission** `enqueueBulkJobTx(tx,ctx,{kind,operationKey,companyIds,source,input})` inside the kind's own
  authority check, through the definer `app.bulk_job_enqueue`. Idempotent per operation key; `bulk_job_kind.exclusive`
  gives one active job per tenant or per creator (`BULK_JOB_ALREADY_RUNNING`). The database captures the creator's
  grants; reads are creator-only while they stay current, and for scoped kinds while the Import History company
  access remains.
- **Claim and lease.** `runBulkJobTick(owner,{handlers})` claims the least recently touched claimable job
  (`FOR UPDATE SKIP LOCKED`, 60 s lease, 15 min while preparing), runs one bounded unit, releases the lease. Every
  app-role transaction fences on the lease; a crash leaves the lease to expire and the next worker resumes.
- **Prepare** once with no lock held; steps are inserted in batches; one short transaction makes them runnable with
  the kind's own records (`commitPrepareTx`). A refusal ends the job as failed before any step.
- **Chunks** run `beginChunkTx` (the kind's writer locks), then pending steps in order until `chunkBudgetMs`; each
  step's write and its applied marker commit together. `mode:'atomic'` stops on a refused step and discards;
  `mode:'per-step'` records the refusal on the job (savepoint) and continues. Transient refusals retry with backoff.
- **Finalize** is called repeatedly (`'more'`) until it returns the result, as the app role; it gets the owner
  connection (`unit.ownerTx`) only when the kind declares it. **Discard** likewise, always through `unit.ownerTx`.
  **Cancel** (`requestBulkJobCancel`, definer `app.bulk_job_request_cancel`): atomic kinds discard; per-step kinds
  stop, keeping saved rows.
- **Progress, metrics, notice.** `steps_done`, `counters`, `errors`, `metrics` (largest chunk/transaction times,
  labelled `application_name=aihr-bulk:<kind>:<phase>` for lock attribution) and one completion notice.

To plug in a bulk operation:
1. Migration: `INSERT INTO bulk_job_kind(kind,scope_kind,exclusive,input_shape[,input_max_bytes][,finalize_owner])`;
   no new job table.
2. Admission: check permission, then `enqueueBulkJobTx`; map `bulk_job` rows to the screen's progress shape.
3. Handler (`BulkJobHandler`): `prepare`, optional `commitPrepareTx`, `beginChunkTx`, `applyStepTx`, `mode`, and
   `finalize`/`discard` if the operation is all-or-nothing; add it to `core/bulk-job-handlers.ts`. Writes to the
   job and its steps only through `unit.set`/`unit.step`; owner work only in `unit.ownerTx`.
4. Notice: one `BULK_JOB_NOTICES` entry in `lib/bulk-job.ts` and `bulkJobs.notification.<group>.*` in all six catalogues.
5. Tests: the kind's real-database ticks (see `test/bulk-job-kernel.test.ts` for the per-step shape and
   `test/employee-import-staged-job.test.ts` for the staged shape).

The leave ledger proof (`claude/bulk-jobs-admission-20261110`, draft 9002) maps to: kind `leave_ledger`,
`exclusive:'creator'`, no scope kind, `mode:'per-step'`, steps from `planLeaveImport`, `applyStepTx` =
`applyLeaveImportRowTx` (its `written` result as `imported`/`skipped` counters), `finalize` =
`appendLeaveImportCompletedTx` with the batch id kept in `plan`, and no discard (cancel keeps saved rows).

## Hardened kernel (drafts 9005, 9006)

A security review found that the application role could write what the worker later trusts: 9003 revoked only from
PUBLIC, so the public-schema default privileges (`deploy/bootstrap-db.sql`) still gave `ai_hr_app`
SELECT/INSERT/UPDATE/DELETE on `bulk_job`, `bulk_job_step`, `bulk_job_worker` and `bulk_job_kind` (kinds have no row
security), on top of 9003's column UPDATE grants (22 job columns; step state/result/error) and step INSERT/DELETE.
Every kind's finalize also received a raw owner connection, and nothing tied owner-path writes to their job.

- **Grants.** `ai_hr_app` keeps SELECT on `bulk_job`, `bulk_job_step` (creator-only row security, now a SELECT-only
  policy) and `bulk_job_kind`, and nothing else on the store; no privilege on `bulk_job_worker` or the seal tables.
  The web side writes only through `app.bulk_job_enqueue` (session tenant and user, current principal, known kind,
  companies of the tenant, input matching `bulk_job_kind.input_shape` and `input_max_bytes`, file hashed by the
  database; there is no admission plan) and `app.bulk_job_request_cancel`. Without UPDATE the app role cannot
  `SELECT ... FOR UPDATE` either; `unit.fenceTx` takes the row lock.
- **Lease capability.** Each claim generates a 256-bit secret, binds its sha256 to that lease in `app.bulk_job_seal`
  (`app.bulk_job_lease_capability`, owner) and clears it when the unit ends. `unit.fenceTx` passes it to
  `app.bulk_job_fence`, which binds the transaction (`app.bulk_job_capability`, transaction-local) and tells a lost
  lease from lost authority. The worker's writes from its app-role transactions go through definers that refuse
  without it: `app.bulk_job_steps_put`, `app.bulk_job_pending_steps`, `app.bulk_job_step_update`,
  `app.bulk_job_worker_update` (forward state transitions only; terminal and discard transitions stay on the owner
  connection). `lease_token` stays readable; it is not the capability.
- **Seal.** `app.bulk_job_seal` holds sha256 digests of the input (sealed at admission) and the plan;
  `app.bulk_job_step_seal` one digest per step over (kind, row_num, payload, state, result, error). Only the worker
  writes them. Every capability-gated write first checks the value it changes still matches its seal; the chunk
  reader verifies each pending step before it is applied; `app.bulk_job_seal_verify` (owner only) checks the input
  before prepare, input and plan before every finalize unit, and every step before the first finalize unit after the
  last step write (for the employee import, the release) or whenever a kind calls `unit.verifySeal()`. A mismatch
  (SQLSTATE XX001 or `BulkJobIntegrityError`) fails the job through the kind's normal failure path. Discard does not
  verify: undoing staged work is the safe direction, and the release/discard definers check the attempt themselves.
- **Owner connection.** `unit.ownerTx(fn)` is one transaction on the queue-owner connection that refuses unless the
  lease is still held. Discard always gets it; finalize only when `handler.finalizeOwner` and
  `bulk_job_kind.finalize_owner` agree (a handler alone fails the job with `BulkJobConfigurationError`). Kinds no
  longer receive a raw owner handle; `describeFailure` gets the owner connection inside a READ ONLY transaction and
  returns `planMerge` instead of writing.
- **Attribution.** Every owner transaction sets `app.bulk_job` (the job id) with the capability, transaction-locally.
  `app.bulk_job_attribution()` returns `{id,kind,tenantId}` for audit triggers and refuses a job the session does not
  hold; trigger `a_bulk_job_event_attribution` adds `payload.bulkJob={id,kind}` to every domain event of that
  transaction before the audit chain seals it (discard void events, owner settle side effects). The app-role chunk
  transactions remain attributed to the creator as actor, labelled by `application_name`.
- **Kernel clean-up.** At terminal the kernel clears input, file, steps and their seals (`app.bulk_job_clear_inputs`);
  `afterTerminal` returns `{clearPlan:true}` to clear the plan too.

Tests: `test/bulk-job-kernel.test.ts` (privilege inventory, every tamper path refused as 42501, capability guessing,
forged attribution, admission shape checks, seal failures for payload, result and plan, owner-finalize declaration,
owner-path event attribution) and `test/employee-import-staged-job.test.ts` (discard voids carry the job).

### Rebasing a conversion branch onto the hardened kernel

Every branch (roster, payroll, leave, register, movement, clocking, labels, operator):
1. Rebase onto the hardened kernel commit; keep its kernel migrations numbered after 9006. Do not `CREATE OR REPLACE`
   any 9005/9006 function; `app.bulk_job_admit`, the `exclusive` check and `bulk_job_one_active` are untouched by
   9005, so exclusivity extensions keep working (the enqueue definer's `ON CONFLICT DO NOTHING` covers any unique
   index).
2. Every `INSERT INTO bulk_job_kind` declares `input_shape` (the top-level keys and JSON types its admission input
   carries, optional ones with `?`) and `input_max_bytes` when the input may exceed 1 MiB. A kind without a shape can
   admit only a NULL input (22023 otherwise). Set `finalize_owner=true` only together with `finalizeOwner:true`.
3. `enqueueBulkJobTx` has no `plan`: put admission data in `input` (and its shape) or derive it in `prepare`.
   `bulkJobTx(..,{lock:true})` is gone.
4. No kind code writes `bulk_job` or `bulk_job_step`, under either role. In a transaction that has called
   `unit.fenceTx(tx)` (or inside `unit.ownerTx`, passing `owner`): `plan=coalesce(plan,'{}')||X` →
   `unit.set(tx,{planMerge:X})`; `plan=X` → `{plan:X}`; `counters=counters||X` → `{countersMerge:X}`;
   `errors=errors||X` → `{errorsAppend:X}`; `result=X` → `{result:X}`; a step's `result=X` →
   `unit.step(tx,seq,{result:X})`; `result=result||X` → `{resultMerge:X}`; reopening steps →
   `unit.step(tx,seqs,{state:'pending',result:null,error:null})` with
   `unit.set(tx,{state:'running',expectState:['finalizing'],stepsDoneAdd:-n})`. A write in a plain
   `withTenant(ctx,…)` must fence first. `select … from bulk_job … for update` → `await unit.fenceTx(tx)` (it locks the
   row), then a plain select. Reads of steps and of the job stay as they are.
5. `unit.owner` is gone. Discard: `unit.ownerTx(async owner=>…)`, one bounded transaction per unit, no manual
   `begin`/`commit`, no app-role transaction inside. Finalize needs `finalizeOwner:true` plus `finalize_owner=true` for
   `unit.ownerTx!`; otherwise read through a fenced app-role transaction. Call `await unit.verifySeal()` immediately
   before an owner definer that decides a release from steps or plan, unless it is the first finalize unit after the
   last step write.
6. `describeFailure` must not write; return `planMerge`. `afterTerminal` must not clear plan or inputs; return
   `{clearPlan:true}` if the plan must go.
7. A new web-side write to the job store is a SECURITY DEFINER granted to `ai_hr_app`, never a table or column grant;
   the kernel test's privilege inventory fails on any grant beyond SELECT.
8. Run the branch's kind tests together with `test/bulk-job-kernel.test.ts`.

Roster (`claude/bulkjob-roster-20261110`, 9920/9921, `tenant_queue`):
- 9921 keeps the `exclusive` check with `'tenant_queue'`, its `bulk_job_admit`, `watched_at` and
  `app.bulk_job_waiting`. Replace `GRANT UPDATE(watched_at) ON bulk_job TO ai_hr_app` with a definer
  `app.bulk_job_mark_watched(p_job uuid)` (SECURITY DEFINER: `UPDATE bulk_job SET watched_at=now() WHERE id IN (SELECT id
  FROM bulk_job WHERE id=p_job AND app.bulk_job_access(id) FOR UPDATE SKIP LOCKED)`), EXECUTE to `ai_hr_app`;
  `markBulkJobWatchedTx` calls it.
- 9920: `roster_bulk` and `schedule_group_bulk` declare `input_shape` (their job inputs); `finalize_owner` stays false.
- `core/bulk-job-worker.ts`: re-apply the `tenant_queue` predicate to the first claim query and `quietNotice` to
  `notifyFinished(connection,c,job)` (pass the handler; the quiet path keeps its owner `notified_at` update).
- `core/roster-bulk-worker.ts`: `markSummarizedTx` → `unit.set(tx,{planMerge:{summarized:true}})` inside its fenced
  finalize transaction.

Payroll (`claude/bulkjob-payroll-20261110`, 9950–9952, `exclusive='none'`):
- 9951 keeps the `'none'` check value and its `bulk_job_admit`; `payroll_process` declares
  `input_shape='{"batchId":"string","after":"array?"}'`, `finalize_owner` false.
- `core/payroll-processing-job.ts`: finalize's `plan=plan||{finalized}` and `{"captured":true}` → `unit.set(tx,{planMerge:…})`;
  discard's `unit.owner` + manual `begin`/`commit` → `unit.ownerTx(async owner=>…)` (its void/reset events then carry
  the job); `describeFailure` returns `planMerge:{failureReason}` instead of updating the plan.

Leave (`claude/bulkjob-leave-20261110`, 9900–9905, `'none'` and several active jobs per creator):
- 9902 and payroll's 9951 both replace `bulk_job_admit` and the `exclusive` check: integration keeps one replacement
  covering `('tenant','creator','none','tenant_queue')` with one key rule for `'none'` (`'job:'||id` or `id::text`;
  either is unique). 9005 does not depend on it.
- 9900/9903 kind rows declare `input_shape`; the cohort/generation and follow-up kinds that settle staged leave rows in
  finalize declare `finalize_owner=true` with `finalizeOwner:true` and use `unit.ownerTx!(owner=>settleLeaveStages(owner,…))`
  plus `unit.set(owner,{planMerge:{settled:true}})`; leave import reads its counters/errors/plan as the app role.
- Worker writes: plan merges → `{planMerge}`; step accumulator rewrites → `unit.step(tx,seq,{result})`;
  `result||'{"written":true}'` → `{resultMerge:{written:true}}`; `counters||` → `{countersMerge}`; finalize's
  `result=…,plan=plan||{"finalized":true}` → `unit.set(tx,{result,planMerge:{finalized:true}})`; the cohort-marker and
  TOIL-sweep `select … from bulk_job … for update` → `unit.fenceTx(tx)` then a plain select; discards →
  `unit.ownerTx(owner=>discardLeaveStageRows(owner,…))`.

Register, movement, clocking, labels: the same checklist; register also moves its admission `plan` into `input`,
declares owner finalize for `app.register_import_release`/`app.employee_import_revert_release` and calls
`unit.verifySeal()` before them, and reopens stale steps with `unit.step`/`unit.set`; movement's confirmation hook and
section import's plan write become `unit.set` in fenced transactions; clocking's `errors||`/`plan||` become
`errorsAppend`/`planMerge`; labels' discard uses `unit.ownerTx`.
