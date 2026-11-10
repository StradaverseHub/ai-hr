-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5075_bulk_job_movement_import, idx 4475, when 1793330004775.
-- Draft name on its branch: 9910_bulk_job_movement_import. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-movement-20261110 (movement import on the shared bulk-job kernel): not a
-- reservation, not an installation allocation. The journal position (idx 9910, when 1793330099910) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md. Depends on 5011 (bulk_job_kind) and 5013 (input_shape,
-- finalize_owner).
--
-- Confirming a checked movement import runs as a background job (core/movement-import-worker.ts): one step per
-- employee, each saved all or nothing as before. The creator reads the job while they keep Import History view
-- access to every company in the file (scope 'movement'); one active movement import per person.
--
-- input_shape is the confirmation the admission stores (core/movement-import-job.ts MovementImportJobInput): the
-- attempt, its reviewed preview hash, the chosen employee keys (at most 200 keys of 300 characters, so the default
-- 1 MiB bound holds), the two acknowledgements, the screen's language and the file's name. The confirmation runs as
-- the application role under the creator's authority: no owner finalize.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive,input_shape,finalize_owner)
 VALUES('movement_import','movement','creator','{"attemptId":"string","previewHash":"string","employees":"array","acknowledgeExcluded":"boolean","acknowledgeClosedPayroll":"boolean","locale":"string","sourceName":"string"}'::jsonb,false);
