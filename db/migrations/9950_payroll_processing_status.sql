-- UNALLOCATED DRAFT on branch claude/bulkjob-payroll-20261110 (payroll processing as a background bulk job): not a
-- reservation, not an installation allocation. The journal position (idx 9950, when 1793330099950) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md.
--
-- Owner decision 2026-11-10 (bulk-job plan, item 2): a payroll run being processed by the background job has its
-- own status, visible to payroll operators and hidden from employees. An ADD VALUE must commit before the value is
-- referenced, and the migrator wraps each file in one transaction, so 9951 uses it.
ALTER TYPE payroll_status ADD VALUE IF NOT EXISTS 'processing' AFTER 'draft';
