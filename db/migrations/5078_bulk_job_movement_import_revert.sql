-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5078_bulk_job_movement_import_revert, idx 4478, when 1793330004778.
-- Draft name on its branch: 9913_bulk_job_movement_import_revert. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-movement-20261110 (movement import Revert as a background job): not a
-- reservation, not an installation allocation. The journal position (idx 9913, when 1793330099913) exists only so this
-- branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the freshly
-- verified ledger, per docs/MIGRATION-ALLOCATION.md. Depends on 5011 (bulk_job_kind) and 5013 (input_shape,
-- finalize_owner).
--
-- The movement import Revert (ADR-0155; core/movement-import-history.ts) rolled every movement back in one request
-- transaction under the Access and leave-dependency locks (10.2 s for 120 movements at 3,500 employments). It now runs
-- as a job (core/movement-import-revert-job.ts): a lock-free review, one rolled-back rehearsal of each employee's
-- compensation that captures what it wrote, then one short verified set-based release, with the synchronous revert as
-- the whole-revert fallback. The creator reads the job while they keep Import History view access to every company it
-- names (scope 'movement'); one active movement revert per person.
--
-- input_shape (core/movement-import-revert-job.ts RevertInput): the attempt, the reviewed hash and the reason; the
-- same shape as employee_import_revert (5062). Unlike that kind, the release and its fallback run as the application
-- role under the creator's authority (no owner routine), so there is no owner finalize.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive,input_shape,finalize_owner)
 VALUES('movement_import_revert','movement','creator','{"attemptId":"string","previewHash":"string","reason":"string"}'::jsonb,false);
