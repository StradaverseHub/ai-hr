# Movement import confirmations run as background jobs on the shared kernel

Status: source implementation on `claude/bulkjob-movement-20261110`; hosted verification and integration pending.
Base: `claude/import-staged-job-20261110` @ `0143d761c` (shared bulk-job kernel, ADR 2026-11-10 employee import).
Draft migration (unallocated): 9910 `bulk_job_kind` row `movement_import` (scope `movement`, one active job per person).

Confirming a checked movement import saved every chosen employee in the web request, one transaction per
employee, each holding the exclusive tenant Access lock for that employee's whole commit (checks, rehearsal,
movements, Import History items). The request could run for the whole 45 s request budget and late employees
failed with `movement_import_timeout`; a lock wait over 1 s failed the employee as `change_refused`.

- **Admission.** `startMovementImportJob` runs the confirmation's attempt checks under the attempt row lock (not
  reverted; a confirmed attempt answers with its recorded counts; not already being saved; the reviewed preview;
  maintain access to every company in the file; a valid employee choice) and records the same refusals on the
  attempt. It then only enqueues; the request writes no HR data. The browser's operation key rejoins its job.
- **Kind.** `per-step`, one step per employee: today's semantics were already "each employee all or nothing; other
  employees still go through", so nothing is staged and an employee's movements become visible when its chunk
  commits, as before. The worker re-reads the attempt's original file (screen language captured at admission for
  the localized headers and Import History texts) and plans through the same `planMovementCommit`.
- **Chunks.** `beginChunkTx` = the session limits plus the exclusive Access lock the employee transaction took
  (`beginMovementCommitTx`); each employee then runs `commitMovementEmployee` (the synchronous commit's own body) in a
  savepoint. The chunk budget is 100 ms, so a chunk holds the lock for one employee. Ending or blacklisting the
  employment of a person with a login, and reporting-line or company changes, keep today's exclusive serialisation
  (last-administrator constraint, reporting-line cycle and root checks). Lock and serialization refusals retry the
  chunk with backoff instead of failing the employee; after 30 consecutive retries the step is recorded as that
  employee's refused change.
- **Finalize.** One short transaction, fenced on the lease, records the failed items and the confirmed event
  (`recordMovementConfirmation`, shared with the synchronous path) and marks the job confirmed in the same
  transaction. The result is the synchronous `MovementUploadResult`; the screen shows it in the existing result
  panel. A job that stops before its confirmation records the failure on the attempt (best effort, as before).
- **Screen and notice.** The movement screen follows the job with the employee import's progress panel and rejoins
  a running job after navigation; the creator gets `bulk-job.finished` (`bulkJobs.notification.movementImport.*`,
  six catalogues) linking to Import History filtered to movements.
- **Equivalence.** `test/movement-import-job.test.ts` runs the same fixture and files through the synchronous
  confirmation and through the job and compares every tenant row keyed by employment, person, attempt or aggregate
  (movements, assignments, compensation, reporting lines, statutory, Import History items and events, audit
  events), plus the returned result and a valid audit chain.

Integration with the reader/writer Access lock (`claude/access-reader-writer-20261110`): that branch keeps these
sites exclusive (`lockAccessConfigurationWriteTx`, `app.access_configuration_write_lock()`); apply the same rename
inside `beginMovementCommitTx` and in `rehearseMovementSequenceTx`. Its employment trigger then takes the
administrator guard and the 4701 statement trigger the `org-reporting` lock on their own.

Known limits, unchanged from the synchronous path and left for follow-up decisions:
- An exit or company change alters the tenant's manager list, which every later employee's reviewed fingerprint
  covers, so later employees of the same file are refused as stale (`preview_stale_revalidate`).
- The check (`previewMovementUpload`, movement-import.ts:405) still runs in the request: one rollback-only
  transaction per employee under the exclusive Access lock.
- The whole-import revert (`movementRevertHandler`, movement-import-history.ts:103) is all or nothing in one
  transaction. It corrects existing rows, so the staged-row release (9001/9004) does not apply; it needs its own
  design (for example per-employee revert with an explicit partial outcome) and an owner decision.
- `movementImportDownloadData` (movement-import.ts:542) has no product caller; the template download uses the
  lock-free presentation snapshot.
