-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5033_leave_follow_up_jobs, idx 4433, when 1793330004733.
-- Draft name on its branch: 9903_leave_follow_up_jobs. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-leave-20261110: not a reservation, not an installation allocation. The
-- journal position (idx 9903, when 1793330099903) exists only so this branch's schema is executable and reviewable;
-- the integration owner assigns the final tag/idx/when, per docs/MIGRATION-ALLOCATION.md. Requires 5011 and 5032.
--
-- The rest of the leave family on the shared bulk-job kernel (one bulk_job_kind row each, no new job table):
--  * leave_recalc     Entitlement recalculation after a leave-type earning-rule, table or eligibility-rule save
--                     (one employee per step, as the per-employee transactions were). 'none': a second save while
--                     one runs queues another job; each re-reads the committed configuration and is idempotent.
--  * leave_a2c        The Anniversary-to-Calendar re-projection a Leave Year Type save triggers (staged, released at
--                     once, as the save's single transaction was). 'none' for the same reason.
--  * toil_expiry      Run TOIL Expiry (batches of employees). One per tenant.
--  * toil_year_close  Close the replacement-leave year (batches of employees, then the per-company markers). One per tenant.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive) VALUES
 ('leave_recalc',NULL,'none'),
 ('leave_a2c',NULL,'none'),
 ('toil_expiry',NULL,'tenant'),
 ('toil_year_close',NULL,'tenant');
