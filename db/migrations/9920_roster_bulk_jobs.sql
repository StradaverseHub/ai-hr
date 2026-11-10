-- UNALLOCATED DRAFT on branch claude/bulkjob-roster-20261110 (roster bulk operations on the shared bulk-job kernel):
-- not a reservation, not an installation allocation. The journal position (idx 9920, when 1793330099920) exists only
-- so this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after
-- the freshly verified ledger, per docs/MIGRATION-ALLOCATION.md. Assigned draft range: 9920-9929.
--
-- Roster generation, copy, upload and the grid's bulk brush run as one background kind; Schedule Group bulk
-- assignment as another (ADR 2026-11-10 roster bulk jobs). One active job of each per tenant, so two bulk roster
-- operations never interleave their per-employee writes. No new table: steps live in bulk_job_step (9003).
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive) VALUES('roster_bulk',NULL,'tenant'),('schedule_group_bulk',NULL,'tenant');
