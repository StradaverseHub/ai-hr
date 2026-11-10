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

**Manager catalogue authorized set-wise (draft 9911).** The commit re-reads the movement catalogue about eight
times, and its manager list called `app.access_workforce_employment` for every live employment (about 1 ms each:
3.5 s per read at 3,140 employments; the check and confirmation refused employees on the 5 s statement and 15 s
per-employee limits). The catalogue now filters with `app.access_workforce_employment_permitted`, an inlined
expression over the reader's row with the company set from `app.access_workforce_permitted_companies` (the company
check once per distinct company, an InitPlan). The per-row owner and its other callers are unchanged.
`test/workforce-employment-access-set.test.ts` pins the per-row owner and proves the same set for every actor shape
(group, company and descendant scope, other company, super administrator, explicit deny, employee role, stale
grants, archived and date-blocked logins), both capabilities, voided, staged, released and another tenant's rows,
at 340 and 3,100 employments, the same catalogue managers, the existing refusal of a manager outside the actor's
companies, and a plan that stays a scan filter whatever the statistics. A catalogue read at 3,100 employments fell
from about 3.5 s to 15 ms. The catalogue is not cached across reads: the commit's own writes (an exit, a company
change) and the actor's own login state change it between reads, and the fingerprints depend on seeing that.

**Measured after the fix** (3,100 employments, 50-employee file of 129 movement rows, local host at load 8-13, two
samples): the check completes in 33-41 s with every employee valid (before: four employees refused); a chunk holds
the Access lock for 1.8-3.0 s at most (mean 1.4-1.8 s), down from 10.8 s at 340 employments. What remains is the
fixed cost of one employee's commit: about 370 statements (rehearsal and apply), about 0.6 s of database time, and
no statement over 20 ms except lock waits. The synchronous confirmation of the same file ran out of its 45 s request
budget and failed 70 of 129 movements as `movement_import_timeout`; the job saved 120 (9 refused as stale, below).

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
