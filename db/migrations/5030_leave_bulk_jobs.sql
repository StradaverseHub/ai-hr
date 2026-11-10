-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5030_leave_bulk_jobs, idx 4430, when 1793330004730.
-- Draft name on its branch: 9900_leave_bulk_jobs. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-leave-20261110 (leave family on the shared bulk-job kernel): not a
-- reservation, not an installation allocation. The journal position (idx 9900, when 1793330099900) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md. Requires 5011 (bulk_job_kind).
--
-- Leave operations that used to run in one web-request transaction holding the tenant's Access and leave-dependency
-- locks now run as background jobs on the kernel (ADR 2026-11-10 employee import, "Shared job kernel"). No new job
-- table: each operation is one bulk_job_kind row.
--  * leave_ledger     Leave ledger import, one row per step; one running import per person (rejoined on resubmit).
--  * leave_generation Generate Entitlement (year-open plus its earned Annual Leave top-up), per employee; one per tenant.
--  * leave_accrual    Run Earned Accrual, per employee; one per tenant.
--
-- Hardened kernel (5013): each kind declares the top-level keys and JSON types of the input its admission passes
-- (core/leave-import-job.ts, core/leave-cohort-job.ts); app.bulk_job_enqueue refuses anything else. The ledger import
-- carries the file's records, so its input may exceed the 1 MiB default. Generate Entitlement settles its staged
-- ledger rows on the queue-owner connection in finalize (core/leave-cohort-worker.ts, finalizeOwner), so it alone
-- declares finalize_owner.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner) VALUES
 ('leave_ledger',NULL,'creator','{"records":"array","source":"object?","companyId":"string?"}'::jsonb,67108864,false),
 ('leave_generation',NULL,'tenant','{"year":"number","targetMode":"string","leaveTypeIds":"array?","criteria":"object?","employmentIds":"array?"}'::jsonb,1048576,true),
 ('leave_accrual',NULL,'tenant','{"asOf":"string","companyIds":"array","gradeIds":"array","leaveTypeIds":"array"}'::jsonb,1048576,false);
