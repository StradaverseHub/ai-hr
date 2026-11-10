-- UNALLOCATED DRAFT on branch claude/bulkjob-leave-20261110 (leave family on the shared bulk-job kernel): not a
-- reservation, not an installation allocation. The journal position (idx 9900, when 1793330099900) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md. Requires 9003 (bulk_job_kind).
--
-- Leave operations that used to run in one web-request transaction holding the tenant's Access and leave-dependency
-- locks now run as background jobs on the kernel (ADR 2026-11-10 employee import, "Shared job kernel"). No new job
-- table: each operation is one bulk_job_kind row.
--  * leave_ledger     Leave ledger import, one row per step; one running import per person (rejoined on resubmit).
--  * leave_generation Generate Entitlement (year-open plus its earned Annual Leave top-up), per employee; one per tenant.
--  * leave_accrual    Run Earned Accrual, per employee; one per tenant.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive) VALUES
 ('leave_ledger',NULL,'creator'),
 ('leave_generation',NULL,'tenant'),
 ('leave_accrual',NULL,'tenant');
