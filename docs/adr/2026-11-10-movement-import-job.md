# Movement import confirmations run as background jobs on the shared kernel

Status: source implementation on `claude/bulkjob-movement-20261110`; hosted verification and integration pending.
Base: `claude/import-staged-job-20261110` @ `0143d761c` (shared bulk-job kernel, ADR 2026-11-10 employee import).
Draft migrations (unallocated): 9910 `bulk_job_kind` row `movement_import` (scope `movement`, one active job per person),
9911 set-wise manager-list authorization, 9912 `bulk_job_kind` row `movement_check` (scope `movement`, one per person).

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
- **Chunks.** `beginChunkTx` = the session limits plus every lock the employee transaction took (`beginMovementChunkTx`,
  below); each employee then runs `commitMovementEmployee` in a savepoint. A chunk takes another employee only while it
  has done less than 100 ms of work, so it normally holds the lock for one employee. Ending or blacklisting the
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
inside `beginMovementCommitTx`, `beginMovementChunkTx`, `rehearseMovementSequenceTx` and `applyMovementSequenceTx`.
Its employment trigger then takes the
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

**One pass per employee, with the chunk's shared reads.** One employee's commit ran about 550 statements:
a rolled-back rehearsal of every movement, then its replay, and around each movement the catalogue (eight queries and
the 3,100-row manager list) read again up to thirteen times, the subject's state read twice per movement, the
fingerprint computed three times. Now:
- `beginMovementChunkTx` takes every lock the employee transaction took, in the same order (Access, reference
  admission, the shared type catalogue, the workforce writer lock, leave-dependency configuration), once, in the chunk's
  own transaction, so an employee's savepoint rolling back never releases one. Under them nothing but the chunk's own
  writes can change the company admission, the catalogue lists, organisation tags or type resolutions, so
  `MovementChunkReads` reads each once. The only catalogue fact an employee's own movement can change is its own entry in
  the manager list; after every write that entry is read again with the list's own columns and conditions and patched in
  place (a vanished or changed entry keeps its position: its order key, the Employee ID, is unchanged; an entry that
  appears or moves drops the list for a full read). The subject's state after one movement is the state before the next.
  A new day starts the reads again (eligibility and blacklist dates depend on it).
- `applyMovementSequenceTx` (movement.ts) is the rehearsal's own ordered create (at most 20 events, one employee,
  effective-date order, the same writer locks) applied for real. For a movement that applies on save the replay writes
  exactly what the rehearsal wrote (a captured baseline is used only by a scheduled comparison), so one pass leaves the
  same rows, values, order, statutory effects and audit events. The reviewed fingerprint is compared after the writes,
  in the employee's savepoint; a stale employee rolls back with the same `preview_stale_revalidate`. Import History
  items record `organisationWarnings` exactly as the replayed row reported them (the organisation warnings twice).
- The lean pass hands an employee back to the unchanged reference body (`commitEmployeeTx`, which the synchronous
  confirmation still uses) in the same employee savepoint whenever it is outside that proof: any Update or Delete row,
  any movement dated after today or recorded as scheduled (`MovementSequenceDeferred`), or the actor's own employment
  (its movements can change the actor's own authority). The chunk's reads start again after a reference employee. Job
  counters `leanEmployees` / `referenceEmployees` record which path decided each employee.
- One lean employee runs about 220 statements (110 for an exit, 175 for a company change), about a third of the
  writer's own and the leave reprojection's. `assembleCatalog` also evaluates today once per catalogue instead of twice
  per manager row, which the synchronous paths share.

**The check runs on the job (draft 9912, kind `movement_check`).** It writes inside rolled-back rehearsals, so it cannot
be a lock-free snapshot. The request now only stores the file on the job (`startMovementCheckJob`); the worker reads and
plans it once with no tenant lock (`planMovementCheck`, the synchronous check's own reading), checks one employee per
step in a savepoint of its chunk that always rolls back (`checkMovementEmployeeTx`: the synchronous check's per-employee
body, `checkEmployeeTx`, with the chunk's reads; an employee with Update or Delete rows or the actor's own employment is
checked with none), retries lock and serialization refusals instead of reporting them as refused rows, and records the
attempt with the sealed plan in one short transaction fenced on the lease (`recordMovementPreview`, shared with the
synchronous check). The finished job carries what the synchronous check returned (attempt, reviewed preview hash,
preview); the screen follows it with the same progress panel (`people.import.movementCheckJob.*`), shows the preview
when it finishes, and rejoins a running check after navigation. The completion notice (`bulkJobs.notification.
movementCheck.*`, six catalogues) opens Import History, where the checked attempt is listed.

**The revert review reads one snapshot without the writer locks.** A movement import whose items only created movements
is reviewed by `planImportRevert` (the same function and shape as the employee import's on
`claude/bulkjob-register-20261110`) on a read-only snapshot: its review only reads, so it no longer holds the Access
and leave-dependency locks for 2.2-2.6 s. An import with Update or Delete items keeps the locked review (it rehearses
their compensation). The reviewed hash is the one the locked revert re-checks.

**Measured** (the same 50-employee, 129-row file; 3,400-3,500 employments; local host at load 7-10; probes running;
two samples, the larger value shown):
| | check (job) | confirm (job) | revert |
|---|---|---|---|
| request | 10-12 ms (enqueue) | enqueue only | review 2.3 s (no writer lock), then revert |
| wall | 30-32 s | 32-33 s | 9.8-10.3 s |
| max tenant-lock hold | 0.71 s (0 over 1 s) | 0.91 s (0 over 1 s) | 10.2 s (one transaction) |
| outcome | 50 of 50 valid | 120 saved, 9 stale (as before), 50 lean | 120 restored |
| probe max: login / Access writer / clock-in | 486 / 567 / 406 ms | 776 / 777 / 731 ms | 8.0 / 10.4 / 10.4 s |
| probe max: My Profile / Home / Personnel | 18 / 293 / 3,553 ms | 21 / 321 / 3,859 ms | 20 / 273 / 3,548 ms |
| errors, Busy | 0, 0 | 0, 0 | 0, 0 |
The review no longer holds a writer lock (second sample; the first still did). In the second sample the clock-in probe
reused days earlier runs had punched and was refused as a fixture conflict ("Each clocking must be later than the
previous one"); its clock-in figures are the first sample's. Personnel is already 3.0-3.3 s at baseline on this tenant (the list read itself, not a lock wait). With the host at
load 11-17 (other workers) one of 50 confirm chunks held 1.27 s and the check 0.99 s; the revert took 22.8 s. The
synchronous confirmation of the same file ran its 45 s request budget and failed 22-25 of 129 movements as
`movement_import_timeout`, holding up to 1.37 s; under the load spike the synchronous check itself ran out of its
45 s budget.

Known limits:
- An exit or company change alters the tenant's manager list, which every later employee's reviewed fingerprint
  covers, so later employees of the same file are refused as stale (`preview_stale_revalidate`), as before.
- **The whole-import revert still holds the writer locks for one transaction (9.6 s for 120 movements).** It is the
  movement owner's rollback, movement by movement (`reverseMovementForImportTx`, `editMovementEventTx`,
  `createMovementEventTx`); about a fifth of its statements write (12 movements: 368 statements, of which 31 event
  inserts, 10 assignment, 8 compensation, 6 employment and 3 reporting-line updates and 12 organisation-tag records).
  The employee import's set-based release (an owner-only SQL routine that voids the hires in one statement) does not
  carry over: a set-based movement release means either expressing the rollback itself in SQL (a second implementation
  of the movement rollback, to be reviewed as a calculation change) or a release that replays write images captured
  from rolled-back per-employee rehearsals, verified against the rehearsal's own after-state and write counts with a
  fall-back to today's transaction (new audit-chain, sequence and trigger rules to review). Either needs a decision
  before it is built; a per-employee revert with an explicit partial outcome needs an owner decision.
- A check that finished while its creator was away is not shown again on the import screen; its attempt is in Import
  History and the file is uploaded again to confirm it (the synchronous check behaved the same after navigation).
- `movementImportDownloadData` has no product caller; the template download uses the lock-free presentation snapshot.
