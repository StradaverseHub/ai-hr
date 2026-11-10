-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5045_attendance_bulk_jobs, idx 4445, when 1793330004745.
-- Draft name on its branch: 9940_attendance_bulk_jobs. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-clocking-20261110 (clocking import and Recompute Attendance as
-- background jobs on the shared bulk-job kernel, 5011): not a reservation, not an installation allocation. The
-- journal position (idx 9940, when 1793330099400) exists only so this branch's schema is executable and
-- reviewable; the integration owner assigns the final tag/idx/when after the freshly verified ledger, per
-- docs/MIGRATION-ALLOCATION.md. Range 9940-9949 is this conversion's draft range.
--
-- Three kinds, no new table (ADR 2026-11-10 employee import, "Shared job kernel"; ADR-0096 amendment):
--  clocking_import               Import Clocking Data: one step per matched employee, finalize writes the run log.
--  attendance_recompute_preview  Recompute Attendance preview: read-only, one step per employee in scope.
--  attendance_recompute          Recompute Attendance apply: one step per employee in scope.
-- None is scoped to an Import History kind (the creator alone reads the job while their grants stay current).
-- A clocking import runs one at a time per tenant, as the synchronous import's one background slot did; a
-- recompute preview or apply runs one at a time per administrator.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive) VALUES
 ('clocking_import',NULL,'tenant'),
 ('attendance_recompute_preview',NULL,'creator'),
 ('attendance_recompute',NULL,'creator');
