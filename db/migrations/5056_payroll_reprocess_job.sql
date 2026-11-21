-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5056_payroll_reprocess_job, idx 4456, when 1793330004756.
-- Draft name on its branch: 9956_payroll_reprocess_job. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-payroll-20261110 (payroll's last long holders, 11 Nov 2026): not a
-- reservation, not an installation allocation. The journal position (idx 9956, when 1793330099956) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md.
--
-- Selective per-employee reprocessing runs on the shared bulk-job kernel (core/payroll-reprocess-job.ts) instead of
-- inside the web request. Its exclusivity is the payroll_reprocess_job row's own claim (one worker token per job), so
-- the kind adds no per-creator limit ('none', 9951): an operator may reprocess several runs back to back.
-- Hardened kernel (5013): the kind declares the top-level keys and JSON types of its admission input
-- (core/payroll-reprocess-job.ts): the reprocess job it runs, the run, the selected employments and, when one was
-- given, the reason (a shape has no null, so an absent reason is left out and is optional here). The list of
-- employment ids stays far below the 1 MiB default. Finalize runs as the application role only (finalize_owner
-- false); the stop record of a failed or stopped job is written by the kind's settle in the kernel's owner
-- transaction, and the worker's plan through the kernel's sealed definers, so this kind needs no grant on the job
-- store.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive,input_shape,finalize_owner)
 VALUES('payroll_reprocess',NULL,'none','{"reprocessJobId":"string","batchId":"string","employmentIds":"array","reason":"string?"}'::jsonb,false);
