# Payroll runs are processed by a background job with a processing status and a run-level lease

Status: source implementation on `claude/bulkjob-payroll-20261110`; hosted verification and integration pending.
Base: `claude/import-staged-job-20261110` @ `0143d761c` (shared bulk-job kernel) merged with
`claude/access-wave4-payroll-20261110` @ `9e5c13d38` (reader/writer Access lock, payroll inputs key). Production and
staging untouched. Draft migrations (unallocated): 9950 status value, 9951 lease, kind and guard.

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
- **Income-tax recalculation preview** (core/payroll-tax-basis.ts) computes in one read-only snapshot with no
  tenant-wide lock and saves the preview record in a short transaction that rechecks authority. Confirming still
  recomputes the whole selection under the history and Access write locks (up to 25 s); not converted here.
- **Kernel extension.** `bulk_job_kind.exclusive = 'none'` (9951): the run's own lease is the exclusivity, so an
  operator can start the runs of several companies back to back (the multi-company wizard admits them in one
  request). **Merge rule for other kernel users:** 9951 replaces `bulk_job_kind_exclusive_check` (now `tenant`,
  `creator`, `none`) and `app.bulk_job_admit()` (adds `ELSE NEW.id::text` for `none`). Any other branch that recreates
  either from 9003's text must carry both changes forward, and the integration must leave exactly one final
  `bulk_job_admit` that is the union of every branch's edits, in the highest-numbered migration that touches it. If
  the `none` arm were lost, a payroll kind would fall back to per-creator exclusivity and the second company of a
  wizard run would be refused as already running; test/payroll-multi-company-process.test.ts ("follows the run …")
  admits two jobs for one creator and fails in that case. The handler also uses the kernel's optional
  `describeFailure` (writes the reason onto its own job's plan through the owner connection) and `afterTerminal`.

Known limits: the selective reprocess and the income-tax recalculation's confirmation are not converted. Payroll
history upload confirm and revert (core/payroll-history-revisions.ts) still run as one exclusive transaction; see
"Payroll history upload" below.

## Payroll history upload (core/payroll-history-revisions.ts)

Measured on the rehearsal database (fictional, one month, five lines per employee, load 7 to 12):

| | 300 employees | 2,994 employees | locks held throughout |
|---|---|---|---|
| validate upload (preview) | 3.0 s | 42.5 s | history barrier (shared) — now none |
| confirm | 4.1 s | 105.6 s | history (exclusive) + Access (exclusive) |
| review revert (preview) | 6.4 s | 23.8 s | history (shared) + Access (exclusive) — now none |
| revert | 6.6 s | 28.2 s | history (exclusive) + Access (exclusive) |

- **Converted here:** the upload's validation and the revert review are read-only (the review "never held a row";
  the validation writes only the attempt and its event). Both now plan in one REPEATABLE READ, READ ONLY snapshot with
  no tenant-wide lock (every history writer commits whole, so the snapshot sees it all or nothing) and the upload saves
  its attempt in a short transaction. Confirm and revert still re-plan under the write locks and refuse a changed
  plan, so nothing a snapshot missed is ever applied.
- **All-or-nothing is needed today.** A confirm commits every selected record of the file or none: its failure record
  says no payroll change was committed, one `confirmed` event lists every change, and revert undoes an attempt by
  that list. A partially applied file cannot be represented, so per-step mode is not available without an owner
  decision.
- **Not converted: confirm and revert.** Both re-plan the whole file under the exclusive history and Access locks
  (planning is most of the time: per record, about eight reads for dependencies and warnings), then write about five
  rows per record. The conversion needs (1) a `payroll_history_import` bulk-job kind with `exclusive='tenant'` (one
  history writer per tenant, which the exclusive barrier gave), (2) staged visibility: a pending attempt column on
  `payroll_batch`, `payroll_history_import_record`, `_snapshot` and `_revision` with restrictive policies (as
  9001/9004 do for employment and person), released by one flip per table, (3) an audit of every SECURITY DEFINER
  reader of those tables (at least `payroll_history_batch_totals`, `payroll_history_batch_adopted`,
  `payroll_tax_basis_subjects`, the effective-batch view and the statutory/EA readers) so none sees a pending row,
  (4) a release unit under the history write lock that rechecks the plan's volatile inputs set-wise (target revision
  pointers, later processed runs, statutory reports, payment exports, master-data rows and authority) instead of the
  whole re-plan, and (5) planning made set-wise so the job's prepare (no lock) stays bounded. Revert is the same
  shape (one revision per record). Until then both remain long exclusive holders at this size.
