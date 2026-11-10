# Payroll runs are processed by a background job with a processing status and a run-level lease

Status: source implementation on `claude/bulkjob-payroll-20261110`; hosted verification and integration pending.
Base: `claude/import-staged-job-20261110` @ `0143d761c` (shared bulk-job kernel) merged with
`claude/access-wave4-payroll-20261110` @ `9e5c13d38` (reader/writer Access lock, payroll inputs key). Production and
staging untouched. Draft migrations (unallocated): 9950 status value, 9951 lease, kind and guard, 9952 run group,
9953 kernel settle, 9954 payroll-partner point read, 9955 staged payroll history, 9956 selective reprocess kind.

Owner decision 2026-11-10 (bulk-job plan, item 2): a `processing` run status, visible to payroll operators and hidden
from employees, with a run-level durable lease. Until now one transaction computed and wrote every payslip of a run
while holding the run's company/month key and its company's payroll inputs key (exclusively), so salary, statutory,
fixed-item and policy edits for that company waited for the whole run and were refused as busy after 5 s.

- **Admission.** The run screen's Process action (`requestPayrollProcessing`) checks the run is a draft and that the
  operator can administer its company's payroll, admits a `payroll_process` job and moves the run `draft ->
  processing`, recording the job in `payroll_batch.processing_job_id` (CHECK: set exactly while processing). One short
  transaction under the same keys as before; it clears the run's recalculation mark (a full generation's own clear,
  moved here so a mark written during processing survives).
- **Lease, not key.** Every lifecycle owner already refuses a run that is not in the status it needs (inputs, scope,
  delete, close, reset, reprocess, one-off ledger writes), so nothing needs the keys held across the run. Each job unit
  takes exactly the keys a synchronous generation takes, for that unit only, and fences on the lease.
- **Same computation.** The job runs `generatePayslipsTx` itself in phases: `plan` (read-only, no key: the whole-run
  readiness gate, the run's employments in the whole-run read's order, and the overtime-prefill decision over the whole
  run), `begin` (opening gates, whole-run attach-on-generate), `employees` chunks (the same path narrowed to the
  chunk, sorted back to the planned order; each chunk re-asserts the readiness gate for its employments) and finalize.
  Finalize prefills the company's remaining overtime candidates and runs the extracted, shared tail
  (`recordSegmentCoverageTx`, `completeFullGenerationTx`): status, totals, ledgers, claims and events. The audit loop's
  input capture, which reads every owner row of the run and grows with it, follows in its own unit with no run key
  held (its event still follows the processed event). Totals are each payslip's exact addends, summed in the planned
  order, so they equal the single loop's to the bit.
- **Unit size.** Profiled on the 3,000-employee rehearsal database (statement log per unit, then CPU profile), a
  step's fixed cost was database round trips, not computation: every employment statement rebuilt the whole
  visible-employment array under row security (about 9 ms each, about 60 ms a step), the TP1 routing read scanned the
  company's whole active set (20 ms) and each employee's policy took up to three reads. Now (`b7b8b4a34`): a chunk
  and the finalize set the transaction-local point-read marker of migration 0691 (a company administrator's
  employment reads skip the rebuild; the administrator arm is already in the original predicate, so the rows are the
  same, and a payroll partner who is not a company administrator keeps the original predicate); TP1 routing reads
  only the people whose routing can name one of the chunk's employments, each still decided from all of that person's
  employments in the whole active set; policies resolve set-wise (`resolveAssignedPoliciesTx`). A step costs about
  65 ms plus 10 ms per employee at load 10 to 13 (was about 90 ms plus 17 ms), so steps are four employees and a chunk
  applies steps for `PAYROLL_PROCESS_CHUNK_BUDGET_MS` (100 ms). What remains per step is statement planning (each
  RLS-expanded statement is planned afresh, about 0.7 ms) for about 45 run-level statements.
- **Rehearsal (3,000 employees, budget 100 ms, step 4, load 10 to 13; scripts/performance/payroll-processing-
  rehearsal.ts).**

  | | A: job + salary edits | B: job | C: synchronous |
  |---|---|---|---|
  | wall | 81 s | 75 s | 42 s |
  | longest hold, run keys (period / inputs exclusive) | 261 ms | 214 ms | 41,512 ms |
  | longest chunk transaction | 297 ms | 228 ms | — |
  | longest tenant-wide hold (shared Access) | 323 ms | 319 ms | 41,512 ms |
  | finalize / audit capture (no run key) | 48 / 709 ms | 67 / 813 ms | — |
  | probe max: login, Access writer, clock-in, My Profile, Home, Personnel | 18, 36, 351, 52, 224, 4,376 ms | 40, 24, 366, 32, 243, 3,724 ms | 583, 79, 401, 27, 220, 3,597 ms |
  | salary edit max | 208 ms (32 marked) | — | — |
  | errors / Busy | 0 / 0 | 0 / 0 | 0 / 0 |

  Baseline with nothing running: Personnel 4,184 ms max (the 3,000-row workforce list on this host, unchanged by
  payroll), clock-in 488 ms. Figures digest B = C (`90b7e809…`); `verifyTenantChain` valid. The previous rehearsal
  (load 27 to 48, steps of two) held the run keys for 1.25 to 1.7 s and took 544 to 565 s.
- **Edits while processing.** `markBatchNeedsRecalc` and `markRunsAffectedByEmploymentChangeTx` treat a processing run
  like a processed one for the employees it has already paid; fixed-item and policy-assignment writers mark such a run
  (`markProcessingRunsForEmploymentsTx`). A writer holds the employee's payroll inputs key (shared) and a chunk holds
  it exclusively, so a change is either read by the employee's chunk or marks the run; none waits for the run. Run
  inputs (`setPayrollInput`) keep the existing draft-only refusal.
- **One run per company at a time.** A later month reads the earlier month's payslips, so a job waits (transiently) for
  an earlier-started processing run of the same company.
- **Failure.** A refusal in the plan returns the run to draft. A failed or cancelled job discards on the queue-owner
  connection: payslips deleted in bounded batches, the chunks' overtime-prefill rewrites restored from snapshots, the
  begin unit's attached one-off rows detached, the run back in draft with any mark cleared, and one
  `payroll-batch.processing-discarded` event. Formula evaluation rows stay, as after a reset.
- **Visibility.** Employees read closed, released runs only, so a processing run is never theirs to see. The run screen
  shows no register, totals or exports until the run is processed, and a progress panel (the employee import pattern)
  with the creator's job progress; the creator gets the `bulk-job.finished` notice.
- **Wizard runs.** The Payroll Process wizard's resumed run and its multi-company run admit each company's
  processing job (`startResumedPayrollRun`, `startMultiCompanyPayroll`) instead of generating inside the request. A
  later company's job waits for the earlier companies' runs (job input `after`), as the synchronous loop processed
  them in order. The result screen follows a durable, creator-only run group (draft migration 9952,
  core/payroll-run-group-store.ts) with the run screen's processing panel per company; when the last job finishes,
  its `afterTerminal` settles the group once to the same `CompanyOutcome`s (the job records the reason
  `reasonForPayrollError` gives its refusal), the same `summarize` header and, for a multi-company run, the same
  `payroll-run-group.completed` event (its `endedAt` is when the last run finished). Saved drafts keep the one-shot
  `?r=` result. Known difference: every company's draft is now created before the first run processes (before, each
  after the previous company's run); no draft-creation reader depends on another company's processed run.
- **Income-tax recalculation** (core/payroll-tax-basis.ts). The preview computes in one read-only snapshot with no
  tenant-wide lock and saves the preview record in a short transaction that rechecks authority. Confirming used to
  recompute the whole selection (up to 1,000 employees, up to 25 s) under the history and Access write locks before
  opening the batch. It now recomputes in a read-only snapshot with no lock, refused exactly as before when the
  figures no longer match; the batch opens in one short transaction under the write locks after a set-wise digest
  proves nothing the recomputation read changed since that snapshot (Pay Item settings, subjects, company, the
  year's verified rules, and every payslip and run of the company in the year by row version, with their income-tax
  corrections and imported history snapshots and revisions); a changed digest recomputes again (twice at most, then
  the same refusal). Each employee is still recomputed and compared under the write locks before its own correction
  commits, which already bounded every other hold to one employee. All-or-nothing is not required: every employee
  commits on its own with a durable per-employee outcome, so no staging is needed. The 50-employee continuation still
  runs on the request (short holds each); moving it onto the kernel is the remaining step.
- **Selective reprocess** (core/payroll-reprocess-job.ts, 9956). The screen used to recalculate every selected
  employee inside the request. The per-employee transaction is extracted unchanged (`reprocessEmployeeTx`, checked
  token for token against the old loop body) and `reprocessSelectedEmployees` composes the same phases. The screen now
  calls `requestSelectiveReprocess` (same checks and idempotent payroll_reprocess_job enqueue) and a
  `payroll_reprocess` job (exclusive `none`: the reprocess job's claim is the exclusivity) claims the reprocess job
  with its own worker token, runs one employee per chunk, completes under that token, and on a run-level refusal
  leaves the request path's stop record (failed, stop code, employee stopped at; committed employees stay). The
  screen shows the job's progress (the existing reprocess-job route) and then its results.
- **Point reads for a payroll partner** (9954). The 0691 marker skipped rebuilding the visible-employment array only
  for a company administrator. `app.can_admin_payroll_for(company_id)` is already an arm of the original predicate
  under the same voided/tenant guards, so 9954 adds it to the short-circuit: identical rows for every grant, no
  authority added (test/payroll-partner-point-read.test.ts proves the rows and that the array is never built).
- **Run-group settlement** is now the kernel's retried `settle` (9953, `bulk_job.settled_at`): the job stays
  unnotified with its inputs and a later tick retries a failed settlement with backoff; it runs on the queue-owner
  connection under each group's row lock, idempotently (a settled group is skipped), with the same result and
  `payroll-run-group.completed` payload and the creator as actor. The web-side settle reads the jobs FOR SHARE, so a
  job whose terminal state commits meanwhile finds the group. test/payroll-run-group-failed-company.test.ts refuses
  the first attempt and proves one event, and restores 7076f8af test 2b end to end: a company job that fails inside
  the run (after paying an employee) or when it prepares renders on the result page as its reason row
  (PRE_PROCESS_BLOCKED, as the synchronous catch mapped it) beside the company that succeeded.
- **Kernel extension.** `bulk_job_kind.exclusive = 'none'` (9951): the run's own lease is the exclusivity, so an
  operator can start the runs of several companies back to back (the multi-company wizard admits them in one
  request). **Merge rule for other kernel users:** 9951 replaces `bulk_job_kind_exclusive_check` (now `tenant`,
  `creator`, `none`) and `app.bulk_job_admit()` (adds `ELSE NEW.id::text` for `none`). Any other branch that recreates
  either from 9003's text must carry both changes forward, and the integration must leave exactly one final
  `bulk_job_admit` that is the union of every branch's edits, in the highest-numbered migration that touches it. If
  the `none` arm were lost, a payroll kind would fall back to per-creator exclusivity and the second company of a
  wizard run would be refused as already running; test/payroll-multi-company-process.test.ts ("follows the run …")
  admits two jobs for one creator and fails in that case. The handler also uses the kernel's optional
  `describeFailure` (writes the reason onto its own job's plan through the owner connection) and `settle`.
- **Kernel extensions, later** (core/bulk-job-worker.ts): `settle` (above, 9953) and `BulkJobWaiting`, a unit that
  cannot start until other work finishes is retried after 2 s without using the transient retry budget, so waiting
  never fails a job (the payroll history kind waits for its tenant's open stage this way).

## Payroll history upload confirm and revert (core/payroll-history-revisions.ts, core/payroll-history-job.ts, 9955)

Both ran as one transaction holding the tenant's history barrier and Access lock exclusively for the whole file
(105.6 s and 28.2 s at 2,994 employees, measured on the previous base). Both stay all-or-nothing (a partially applied
file cannot be represented: one `confirmed` event lists every change and revert undoes by that list).

- **Set-wise planning.** Every per-record fact the plan reads (names, records, latest and first revisions,
  snapshots, payroll on file, open and processed runs, statutory reports, payment exports) is read in a fixed number
  of bulk reads under the same row security, and the plan's rules run over them in memory. On the 3,000-employee
  rehearsal tenant the plan hash equals the per-record planner's for creates, overwrites of a closed processed run
  (with their warnings) and refused months; validation 31.2 s -> 1.1 s (6,000 records: 68.2 s -> 2.2 s). Revert
  eligibility likewise, judged change by change so the first refusal is unchanged (test suites unchanged).
- **The job.** The Import Payroll History screen and the log's Revert make the same checks (a refusal records the
  failure, as before) and admit a `payroll_history` job. Prepare re-plans in a read-only snapshot with no lock and
  refuses exactly when the single transaction did, recording the digest of every fact the plan read. Chunks write the
  single transaction's rows through the same code (`writeRecordPayslipTx`, `writeSnapshotRevisionTx`) under the
  shared Access lock only. The release takes the history and Access write locks, repeats the attempt's checks,
  re-reads the facts and compares the digest (a changed digest re-plans without locks and refuses only if the plan
  changed, at most five times), resolves or creates each group's pay period, allocates its run sequence, closes the
  batch with the same totals, writes the same `confirmed`/`committed` (or `reverted`) events and releases the stage.
  A revert's release compares a digest of what can still change (see below) instead. A failure deletes the staged rows on the owner
  connection (newest revisions first) and records the attempt's failure once (kernel `settle`).
- **One history writer per tenant, never refused.** The tenant's one open stage (unique partial index) is what the
  exclusive barrier gave. A second job waits for it (`BulkJobWaiting`); the single-transaction paths that remain
  (the trusted record-based import and the chat import card) refuse while a stage is open.
- **Staged visibility.** A pending-row registry (`app.payroll_history_staged_row`, stamped by an AFTER INSERT trigger
  while the job's transaction-local setting names the open stage) with RESTRICTIVE policies on payroll_batch, payslip
  and the history record, snapshot and revision tables, instead of a pending column per table: payslip and batch rows
  are published whole by existing owners (the information payslip document, assistant review witnesses, attendance
  digests) and the history tables are immutable, so a column would change every existing document and could never
  be cleared. Every row stays byte-identical to the single transaction's; the release is one row (the stage's state)
  and the registry is cleared afterwards in bounded batches. A staged batch carries no pay period until the release
  (a deferred constraint trigger requires one on every other batch), so a run an operator creates meanwhile in the
  same month never collides with a run sequence nobody can see.
- **Definer and owner-connection audit.** The effective-snapshot owner (`payroll_history_effective`, applied by the
  payslip policy and every payslip definer) ignores staged revisions and treats a staged imported payslip as not
  effective, while an ordinary payslip a staged import adopts stays effective; `payroll_history_batch_adopted` and
  `payroll_history_self_issued` ignore staged snapshots. Of the 68 definers reading these tables, 16 reads enumerate
  rows independently of a stored reference (run existence for periods, the leave and attendance coverage row locks,
  information preservation and readiness, the assistant family context, the learning leaver check, child-relief
  resync, the attendance review's history fingerprint, the income-tax binders) and get `payroll_history_row_visible`
  after an exact count of their reads; the rest reach rows by a stored or caller-supplied id, through the effective
  owner, by pay_period_id (a staged batch has none), or by a status a staged draft never has; triggers act on their
  own transaction's rows as before. The adopted-payslip freeze now sees a staged adoption (an unlock or reset of that
  payslip is refused as it would be a moment later, instead of failing on the snapshot's foreign key). Owner
  connection: usage capture counts payslips by creation day and now excludes unreleased staged ones explicitly (as it
  excludes staged employee imports); the anomaly sweep reads processed runs only (a staged batch is a draft). Operator
  report and repair scripts read by stored id or are one-off reports.
- **Snapshot binding.** The 0660 snapshot binding checked the planned rows in one statement joining every attempt;
  its cached generic plan expanded every attempt's planned rows per snapshot (about 250 ms each once a tenant holds a
  few large attempts). 9955 finds the snapshot's attempt first and scans only its rows (same conjunction, about 5 ms).

Rehearsal (scripts/performance/payroll-history-rehearsal.ts, 2,994 fictional employees, one month, five lines per
employee, worker process as installed, load 4.6 to 7.6; the single transaction now plans set-wise, so it is far
shorter than the 105.6 s measured before):

| | job confirm | job revert | single-transaction confirm | single-transaction revert |
|---|---|---|---|---|
| wall | 64.4 s | 34.1 s | 35.7 s | 6.3 s |
| history barrier, longest exclusive hold | 266 ms (release) | 28 ms (release) | 35,552 ms | 6,118 ms |
| Access, longest hold by the operation | 190 ms exclusive (release); chunks 134 ms shared | chunks 249 ms shared; release 58 ms | 35,422 ms exclusive | 5,989 ms exclusive |
| longest chunk / release transaction | 145 / 293 ms | 282 / 58 ms | — | — |
| probe max: login, Access writer, clock-in, My Profile, Home, Personnel, payroll reader | 5, 256, 149, 16, 210, 2,695, 89 ms | 54, 75, 1,067, 54, 1,241, 6,502, 25 ms | 20, 4,290, 4,559, 19, 34,935, 3,597, 35,523 ms | 4, 848, 5,142, 10, 5,460, 2,965, 6,055 ms |
| errors / Busy | 0 / 0 | 0 / 0 | 11 / 11 (lock timeouts) | 1 / 1 |

During the job revert the host load rose to 7.6: no exclusive tenant hold exceeded 28 ms and the Access-writer and
payroll-reader probes stayed at 75 and 25 ms, so the clock-in, Home and Personnel maxima there are CPU, not lock
waits (the longest Access hold, 1,005 ms shared, was a probe's own Personnel read). Revert's release checks only what
can still change (runs processed and statutory reports for the dependent months, statutory artefacts of the current
snapshots' batches) and re-derives the whole eligibility without locks when that changed; re-deriving it under the
locks took about 1.3 s at this size.

Baseline with nothing running: Personnel 2,603 ms max (the 3,000-row workforce list on this host), Home 261 ms,
clock-in 250 ms. Figures digest of the imported batches, job = single transaction (`e3b8f978…`); `verifyTenantChain`
valid. Equivalence on identical tenants (test/payroll-history-staged-job.test.ts): pay periods, batches, payslips,
records, snapshots, revisions, history and audit events equal after confirm and after revert; a refused revert
refuses identically and records the same failure; a revert whose dependent month is processed while it is staged
re-derives its eligibility and refuses exactly as the single transaction would.

Known limits: the trusted record-based import (`commitPayrollHistoryImport`) and the chat import card still confirm
through the single transaction (now about 30 s at 3,000 records instead of 105 s); moving them onto the job changes
their synchronous result shape and the chat card's wording, which needs a product decision. The income-tax
recalculation's per-employee continuation still runs on the request.
