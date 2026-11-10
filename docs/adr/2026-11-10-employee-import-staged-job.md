# Employee imports run as background jobs with staged rows and a constant-time release

Status: source implementation on `claude/import-staged-job-20261110`; hosted verification and integration pending.
Base: `7b585515d67885045d79ebb3dce4ef6c5e7b1bd8` (on main `f07f32dcd`). Production and staging untouched.
Draft migrations (unallocated): 9001 staged rows, 9003 shared bulk-job kernel, 9004 release visibility and staged events.

The single import transaction held tenant-wide locks for its whole length (DESIGN.md: 11 s for 200 rows). This decision
replaces it with a job: validate once, apply in chunk transactions of about 200 ms, then release in one short transaction.

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
  authority check. Idempotent per operation key; `bulk_job_kind.exclusive` gives one active job per tenant or per
  creator (`BULK_JOB_ALREADY_RUNNING`). The database captures the creator's grants; reads are creator-only while
  they stay current, and for scoped kinds while the Import History company access remains.
- **Claim and lease.** `runBulkJobTick(owner,{handlers})` claims the least recently touched claimable job
  (`FOR UPDATE SKIP LOCKED`, 60 s lease, 15 min while preparing), runs one bounded unit, releases the lease. Every
  app-role transaction fences on the lease; a crash leaves the lease to expire and the next worker resumes.
- **Prepare** once with no lock held; steps are inserted in batches; one short transaction makes them runnable with
  the kind's own records (`commitPrepareTx`). A refusal ends the job as failed before any step.
- **Chunks** run `beginChunkTx` (the kind's writer locks), then pending steps in order until `chunkBudgetMs`; each
  step's write and its applied marker commit together. `mode:'atomic'` stops on a refused step and discards;
  `mode:'per-step'` records the refusal on the job (savepoint) and continues. Transient refusals retry with backoff.
- **Finalize** is called repeatedly (`'more'`) until it returns the result; **discard** likewise, on the owner
  connection. **Cancel** (`requestBulkJobCancel`): atomic kinds discard; per-step kinds stop, keeping saved rows.
- **Progress, metrics, notice.** `steps_done`, `counters`, `errors`, `metrics` (largest chunk/transaction times,
  labelled `application_name=aihr-bulk:<kind>:<phase>` for lock attribution) and one completion notice.

To plug in a bulk operation:
1. Migration: `INSERT INTO bulk_job_kind(kind,scope_kind,exclusive)`; no new job table.
2. Admission: check permission, then `enqueueBulkJobTx`; map `bulk_job` rows to the screen's progress shape.
3. Handler (`BulkJobHandler`): `prepare`, optional `commitPrepareTx`, `beginChunkTx`, `applyStepTx`, `mode`, and
   `finalize`/`discard` if the operation is all-or-nothing; add it to `core/bulk-job-handlers.ts`.
4. Notice: one `BULK_JOB_NOTICES` entry in `lib/bulk-job.ts` and `bulkJobs.notification.<group>.*` in all six catalogues.
5. Tests: the kind's real-database ticks (see `test/bulk-job-kernel.test.ts` for the per-step shape and
   `test/employee-import-staged-job.test.ts` for the staged shape).

The leave ledger proof (`claude/bulk-jobs-admission-20261110`, draft 9002) maps to: kind `leave_ledger`,
`exclusive:'creator'`, no scope kind, `mode:'per-step'`, steps from `planLeaveImport`, `applyStepTx` =
`applyLeaveImportRowTx` (its `written` result as `imported`/`skipped` counters), `finalize` =
`appendLeaveImportCompletedTx` with the batch id kept in `plan`, and no discard (cancel keeps saved rows).
