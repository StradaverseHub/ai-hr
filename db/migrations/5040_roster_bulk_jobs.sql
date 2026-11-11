-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5040_roster_bulk_jobs, idx 4440, when 1793330004740.
-- Draft name on its branch: 9920_roster_bulk_jobs. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-roster-20261110 (roster bulk operations on the shared bulk-job kernel):
-- not a reservation, not an installation allocation. The journal position (idx 9920, when 1793330099920) exists only
-- so this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after
-- the freshly verified ledger, per docs/MIGRATION-ALLOCATION.md. Assigned draft range: 9920-9929.
--
-- Roster generation, copy, upload and the grid's bulk brush run as one background kind; Schedule Group bulk
-- assignment as another (ADR 2026-11-10 roster bulk jobs). One active job of each per tenant, so two bulk roster
-- operations never interleave their per-employee writes. No new table: steps live in bulk_job_step (5011).
--
-- Hardened kernel (5013): each kind declares the top-level keys and JSON types of its admission input
-- (core/roster-bulk-job.ts). A shape has no null, so a key that would be null is left out and is optional here.
--  roster_bulk: op names the operation and one of generate, copy, assign and import carries its request; companyId
--   is absent for a grid brush with no company chosen. The upload's file is the job's source, not its input.
--  schedule_group_bulk: attendanceRuleId is absent when the batch takes the employees out of every Schedule Group.
-- input_max_bytes: one operation may name up to 100,000 employments (lib/roster-selection.ts, 4,000,002 bytes of
-- JSON), above the 1 MiB default; 8 MiB covers that list as stored text. Neither finalize needs the owner connection.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner) VALUES
 ('roster_bulk',NULL,'tenant','{"op":"string","companyId":"string?","generate":"object?","copy":"object?","assign":"object?","import":"object?"}'::jsonb,8388608,false),
 ('schedule_group_bulk',NULL,'tenant','{"employmentIds":"array","attendanceRuleId":"string?","returnQuery":"string"}'::jsonb,8388608,false);
