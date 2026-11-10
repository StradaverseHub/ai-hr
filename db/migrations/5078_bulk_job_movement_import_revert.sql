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
--> statement-breakpoint
-- The synchronous fallback's completion, committed in the fallback's own transaction (core/movement-import-revert-job.ts).
-- The fallback can outlast the job's lease; a worker that then picks the job up finds this row (under the attempt's
-- row lock, so a fallback still committing is waited for) and finishes the job with the recorded outcome instead of
-- reverting again and failing as already reverted. One row per job; the reverted Import History event it names is the
-- proof, so a row can be written only by the job's creator, while the job is finalizing, for the job's own attempt and
-- that attempt's reverted event. Never updated or deleted by the application.
CREATE TABLE app.movement_revert_job_outcome(
 job_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 attempt_id uuid NOT NULL,
 event_id uuid NOT NULL UNIQUE REFERENCES public.import_attempt_event(id),
 restored integer NOT NULL CHECK(restored>=0),
 fallback text,
 recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE app.movement_revert_job_outcome ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON app.movement_revert_job_outcome FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT,INSERT ON app.movement_revert_job_outcome TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY movement_revert_job_outcome_read ON app.movement_revert_job_outcome FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id()
  AND EXISTS(SELECT 1 FROM public.bulk_job j WHERE j.id=movement_revert_job_outcome.job_id AND j.kind='movement_import_revert'));
--> statement-breakpoint
CREATE POLICY movement_revert_job_outcome_record ON app.movement_revert_job_outcome FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id()
  AND EXISTS(SELECT 1 FROM public.bulk_job j WHERE j.id=movement_revert_job_outcome.job_id AND j.tenant_id=movement_revert_job_outcome.tenant_id
   AND j.kind='movement_import_revert' AND j.state='finalizing' AND j.created_by=app.current_user_id()
   AND j.input->>'attemptId'=movement_revert_job_outcome.attempt_id::text)
  AND EXISTS(SELECT 1 FROM public.import_attempt_event e WHERE e.id=movement_revert_job_outcome.event_id
   AND e.tenant_id=movement_revert_job_outcome.tenant_id AND e.attempt_id=movement_revert_job_outcome.attempt_id AND e.kind='reverted'));
