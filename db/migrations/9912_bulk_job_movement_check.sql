-- UNALLOCATED DRAFT on branch claude/bulkjob-movement-20261110 (movement import check on the shared bulk-job kernel):
-- not a reservation, not an installation allocation. The journal position (idx 9912, when 1793330099912) exists only
-- so this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md. Depends on 5011 (bulk_job_kind) and 5013 (input_shape,
-- finalize_owner).
--
-- Checking an uploaded movement file runs as a background job (core/movement-import-check-worker.ts): one step per
-- employee, each rehearsed in a savepoint that always rolls back; the import attempt is recorded at the end. The
-- creator reads the job while they keep Import History view access to every company it names (scope 'movement');
-- one active movement check per person.
--
-- input_shape (core/movement-import-job.ts MovementCheckJobInput): the file's own name, the screen's language and the
-- browser's operation key when it sent one. The file itself is the job's source content, not input. The attempt is
-- recorded as the application role under the creator's authority: no owner finalize.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive,input_shape,finalize_owner)
 VALUES('movement_check','movement','creator','{"name":"string","locale":"string","operationKey":"string?"}'::jsonb,false);
