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
- **Unit size.** One pass of the compute path carries about 250 ms of run-wide reads plus about 50 ms per employee
  (quiet host), so steps are two employees and a chunk takes a second step only when the first finished within
  100 ms (`PAYROLL_PROCESS_STEP_EMPLOYEES`, `PAYROLL_PROCESS_CHUNK_BUDGET_MS`). The 3,000-employee rehearsal on a host
  at load 27 to 48 held the run's keys for at most 1.25 to 1.7 s (3 to 8 of about 1,120 chunks over 1 s) with a
  250 ms budget; ten employees per chunk held them for 3.7 s and the old single transaction for 144 s.
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
- **Kernel extension.** `bulk_job_kind.exclusive = 'none'`: the run's own lease is the exclusivity, so an operator can
  start the runs of several companies back to back.

Known limits: the payroll wizard (single resume and multi-company run) still processes synchronously because its result
page reports finished outcomes; the selective reprocess, tax-basis recalculation and payroll history revisions are not
converted here.
