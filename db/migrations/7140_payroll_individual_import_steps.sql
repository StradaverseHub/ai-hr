-- Board 0ec0ee00, stage 2 — large Individual Transaction uploads (up to 10,000 rows), written and reverted in steps.
-- Allocation: 7140, journal idx 10540, when 1795280007140 (docs/MIGRATION-ALLOCATION.md). Writers reviewed:
-- core/individual-txn-import.ts (validate, step confirm, step revert), core/individual-import-job.ts (admission,
-- confirmation, revert request) and core/individual-import-worker.ts (queue progress). The Fixed Transaction import
-- does not use these tables. Every existing row satisfies the wider limits; no row is rewritten.
--
-- Rollback (manual, only before any attempt holds more than 2,000 rows or uses the new states/outcome table):
--   restore the 0688/2460 CHECKs, trigger body and queue index; DROP the two functions, the outcome table and the
--   added columns.

-- 1. Limits. One Individual upload holds up to 10,000 rows (was 2,000). The looser records CHECK is added NOT VALID
--    and validated separately, so existing attempts are read under SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE.
ALTER TABLE public.payroll_txn_import_attempt DROP CONSTRAINT payroll_txn_import_attempt_records_check;
--> statement-breakpoint
ALTER TABLE public.payroll_txn_import_attempt ADD CONSTRAINT payroll_txn_import_attempt_records_check
 CHECK (jsonb_typeof(records)='array' AND jsonb_array_length(records)<=10000) NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_txn_import_attempt VALIDATE CONSTRAINT payroll_txn_import_attempt_records_check;
--> statement-breakpoint
ALTER TABLE public.payroll_txn_import_attempt DROP CONSTRAINT payroll_txn_import_attempt_written_check;
--> statement-breakpoint
ALTER TABLE public.payroll_txn_import_attempt ADD CONSTRAINT payroll_txn_import_attempt_written_check CHECK (written BETWEEN 0 AND 10000);
--> statement-breakpoint
-- importing: written in steps; stopped: a step kept failing, rows written so far remain and can be reverted;
-- reverting: a revert is removing the written rows in steps.
ALTER TABLE public.payroll_txn_import_attempt DROP CONSTRAINT payroll_txn_import_attempt_state_check;
--> statement-breakpoint
ALTER TABLE public.payroll_txn_import_attempt ADD CONSTRAINT payroll_txn_import_attempt_state_check
 CHECK (state IN ('validated','importing','completed','stopped','reverting','reverted'));
--> statement-breakpoint
-- Summary columns, so the Import Log never reads a 10,000-row preview to count it. Older attempts keep NULL totals
-- (readers fall back to their preview) and zero progress (their outcomes stay in the inline array).
ALTER TABLE public.payroll_txn_import_attempt
 ADD COLUMN total_rows integer CHECK (total_rows BETWEEN 0 AND 10000),
 ADD COLUMN invalid_rows integer CHECK (invalid_rows BETWEEN 0 AND 10000),
 ADD COLUMN processed integer NOT NULL DEFAULT 0 CHECK (processed BETWEEN 0 AND 10000),
 ADD COLUMN reverted_count integer NOT NULL DEFAULT 0 CHECK (reverted_count BETWEEN 0 AND 10000),
 ADD COLUMN revert_cursor integer NOT NULL DEFAULT 0 CHECK (revert_cursor BETWEEN 0 AND 10001),
 ADD COLUMN revert_requested_by uuid REFERENCES public.app_user(id),
 ADD COLUMN revert_confirm_processed boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- 2. Row outcomes of a step-written import, appended once per row by the step that wrote (or refused) it. Keyed by
--    attempt and Excel row number; never updated or deleted, so a replayed step cannot record a row twice.
CREATE TABLE public.payroll_txn_import_outcome (
 attempt_id uuid NOT NULL REFERENCES public.payroll_txn_import_attempt(id),
 row_num integer NOT NULL CHECK (row_num BETWEEN 2 AND 10001),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 state text NOT NULL CHECK (state IN ('invalid','imported','failed')),
 transaction_id uuid,
 outcome jsonb NOT NULL CHECK (jsonb_typeof(outcome)='object'),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (attempt_id,row_num),
 CHECK ((state='imported')=(transaction_id IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX payroll_txn_import_outcome_imported ON public.payroll_txn_import_outcome (attempt_id,row_num) WHERE state='imported';
--> statement-breakpoint
ALTER TABLE public.payroll_txn_import_outcome ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_txn_import_outcome FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Visible exactly when its attempt is (0688 payroll_txn_import_scope applies inside the subquery).
CREATE POLICY payroll_txn_import_outcome_read ON public.payroll_txn_import_outcome FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.payroll_txn_import_attempt a
  WHERE a.id=payroll_txn_import_outcome.attempt_id AND a.tenant_id=payroll_txn_import_outcome.tenant_id));
--> statement-breakpoint
-- Appended only while its attempt is still being written.
CREATE POLICY payroll_txn_import_outcome_append ON public.payroll_txn_import_outcome FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.payroll_txn_import_attempt a
  WHERE a.id=payroll_txn_import_outcome.attempt_id AND a.tenant_id=payroll_txn_import_outcome.tenant_id
   AND a.state IN ('validated','importing')));
--> statement-breakpoint
GRANT SELECT,INSERT ON public.payroll_txn_import_outcome TO ai_hr_app;
--> statement-breakpoint
-- Append-only: the owner's default privileges (deploy/bootstrap-db.sql) also grant UPDATE and DELETE; take them back.
REVOKE UPDATE,DELETE,TRUNCATE ON public.payroll_txn_import_outcome FROM ai_hr_app;
--> statement-breakpoint
-- 3. Transitions. Source and outcomes stay immutable; progress only grows; a step-written import completes only when
--    every row has its outcome, and a revert finishes only when every written row is gone.
CREATE OR REPLACE FUNCTION app.payroll_txn_import_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total integer;counted integer;imported integer;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Import actor mismatch' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.tenant_id,NEW.operation_id,NEW.created_by,NEW.company_ids,NEW.source_name,NEW.source_hash,NEW.method,NEW.records,NEW.bindings,NEW.created_at,NEW.total_rows,NEW.invalid_rows)
  IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.operation_id,OLD.created_by,OLD.company_ids,OLD.source_name,OLD.source_hash,OLD.method,OLD.records,OLD.bindings,OLD.created_at,OLD.total_rows,OLD.invalid_rows)
 THEN RAISE EXCEPTION 'Import source is immutable' USING ERRCODE='23514'; END IF;
 total:=coalesce(NEW.total_rows,jsonb_array_length(NEW.preview->'rows'));
 IF OLD.state='validated' AND NEW.state='completed' AND jsonb_array_length(NEW.outcomes)>0 THEN
  -- One transaction over the whole file, outcomes inline (attempts confirmed before stage 2).
  IF jsonb_array_length(NEW.outcomes)<>jsonb_array_length(NEW.preview->'rows') OR NEW.written<>(SELECT count(*) FROM jsonb_array_elements(NEW.outcomes) o WHERE o->>'state'='imported')
   OR NEW.processed<>0 OR NEW.reverted_count<>0 OR NEW.revert_cursor<>0 OR NEW.revert_requested_by IS NOT NULL
  THEN RAISE EXCEPTION 'Import outcomes do not reconcile' USING ERRCODE='23514'; END IF;
 ELSIF OLD.state IN ('validated','importing') AND NEW.state IN ('importing','completed','stopped') THEN
  -- Step-written: outcomes live in payroll_txn_import_outcome; the validated preview is the approved one.
  IF NEW.outcomes<>'[]'::jsonb OR NEW.preview IS DISTINCT FROM OLD.preview OR NEW.processed<OLD.processed OR NEW.written<OLD.written
   OR NOT (NEW.recalc_batch_ids@>OLD.recalc_batch_ids) OR NEW.processed>total
   OR NEW.reverted_count<>0 OR NEW.revert_cursor<>0 OR NEW.revert_requested_by IS NOT NULL
   OR (NEW.state='completed')<>(NEW.processed=total)
  THEN RAISE EXCEPTION 'Import outcomes do not reconcile' USING ERRCODE='23514'; END IF;
  IF NEW.state IN ('completed','stopped') THEN
   SELECT count(*),count(*) FILTER (WHERE o.state='imported') INTO counted,imported FROM public.payroll_txn_import_outcome o WHERE o.attempt_id=NEW.id;
   IF counted<>NEW.processed OR imported<>NEW.written THEN RAISE EXCEPTION 'Import outcomes do not reconcile' USING ERRCODE='23514'; END IF;
  END IF;
 ELSIF OLD.state IN ('completed','stopped','reverting') THEN
  -- Reverting never rewrites what the import recorded.
  IF (NEW.preview,NEW.outcomes,NEW.written,NEW.recalc_batch_ids,NEW.processed) IS DISTINCT FROM (OLD.preview,OLD.outcomes,OLD.written,OLD.recalc_batch_ids,OLD.processed)
  THEN RAISE EXCEPTION 'Import outcomes are immutable' USING ERRCODE='23514'; END IF;
  IF OLD.state='completed' AND NEW.state='reverted' THEN
   -- The single-transaction revert of attempts reverted before stage 2.
   IF NEW.reverted_by IS DISTINCT FROM app.current_user_id()
    OR (NEW.reverted_count,NEW.revert_cursor,NEW.revert_requested_by,NEW.revert_confirm_processed) IS DISTINCT FROM (OLD.reverted_count,OLD.revert_cursor,OLD.revert_requested_by,OLD.revert_confirm_processed)
   THEN RAISE EXCEPTION 'Import outcomes are immutable' USING ERRCODE='23514'; END IF;
  ELSIF OLD.state IN ('completed','stopped') AND NEW.state='reverting' THEN
   -- Requested by the caller; a revert resumed after a refusal keeps the rows already removed.
   IF NEW.revert_requested_by IS DISTINCT FROM app.current_user_id() OR (NEW.reverted_count,NEW.revert_cursor) IS DISTINCT FROM (OLD.reverted_count,OLD.revert_cursor)
    OR NEW.written-NEW.reverted_count<=0
   THEN RAISE EXCEPTION 'Invalid import transition' USING ERRCODE='23514'; END IF;
  ELSIF OLD.state='reverting' AND NEW.state='reverting' THEN
   IF (NEW.revert_requested_by,NEW.revert_confirm_processed) IS DISTINCT FROM (OLD.revert_requested_by,OLD.revert_confirm_processed)
    OR NEW.reverted_count<OLD.reverted_count OR NEW.revert_cursor<OLD.revert_cursor OR NEW.reverted_count>NEW.written
   THEN RAISE EXCEPTION 'Invalid import transition' USING ERRCODE='23514'; END IF;
  ELSIF OLD.state='reverting' AND NEW.state='reverted' THEN
   IF NEW.reverted_by IS DISTINCT FROM app.current_user_id() OR NEW.reverted_count<>NEW.written OR NEW.revert_cursor<OLD.revert_cursor
    OR (NEW.revert_requested_by,NEW.revert_confirm_processed) IS DISTINCT FROM (OLD.revert_requested_by,OLD.revert_confirm_processed)
   THEN RAISE EXCEPTION 'Import outcomes are immutable' USING ERRCODE='23514'; END IF;
  ELSIF OLD.state='reverting' AND NEW.state IN ('completed','stopped') THEN
   -- A refused or failed revert hands the batch back: completed only when nothing was removed from a finished import.
   IF (NEW.reverted_count,NEW.revert_cursor,NEW.revert_requested_by,NEW.revert_confirm_processed) IS DISTINCT FROM (OLD.reverted_count,OLD.revert_cursor,OLD.revert_requested_by,OLD.revert_confirm_processed)
    OR (NEW.state='completed')<>(NEW.reverted_count=0 AND (jsonb_array_length(NEW.outcomes)>0 OR NEW.processed=total))
   THEN RAISE EXCEPTION 'Invalid import transition' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'Invalid import transition' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'Invalid import transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- 4. The step-scoped lock: the same bounded checks and locks as app.payroll_txn_import_lock_bindings (0688), over only
--    the given rows' immutable bindings, so one step holds only its own runs, employments, pay items and cycles.
CREATE FUNCTION app.payroll_txn_import_lock_step_bindings(p_attempt uuid, p_rows integer[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE a_id uuid;a_tenant uuid;a_companies jsonb;step jsonb;bound jsonb;field text;uuid_pattern text:='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL OR app.current_user_id() IS NULL OR NOT app.principal_snapshot_current() OR NOT app.is_admin() THEN
  RAISE EXCEPTION 'Import access denied' USING ERRCODE='42501'; END IF;
 IF p_rows IS NULL OR cardinality(p_rows) NOT BETWEEN 1 AND 1000 OR array_position(p_rows,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'Import step unavailable' USING ERRCODE='22023'; END IF;
 SELECT x.id,x.tenant_id,x.company_ids,(SELECT coalesce(jsonb_object_agg(b.key,b.value),'{}'::jsonb) FROM jsonb_each(x.bindings) b
   WHERE b.key=ANY(SELECT r::text FROM unnest(p_rows) r))
  INTO a_id,a_tenant,a_companies,step FROM public.payroll_txn_import_attempt x WHERE x.id=p_attempt AND x.tenant_id=app.current_tenant_id();
 IF a_id IS NULL OR jsonb_array_length(a_companies)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a_companies) c WHERE NOT app.is_admin_for(c::uuid)) THEN
  RAISE EXCEPTION 'Import access denied' USING ERRCODE='42501'; END IF;
 -- Stored JSON is immutable, not trusted: runtime INSERT remains subject to direct-input abuse.
 FOR bound IN SELECT value FROM jsonb_each(step) LOOP
  IF jsonb_typeof(bound)<>'object' OR NOT (bound ?& ARRAY['employmentId','companyId','componentId','intendedCycleId','targetBatchId','payPeriod']) THEN
   RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
  FOREACH field IN ARRAY ARRAY['employmentId','companyId','componentId'] LOOP
   IF (bound->>field ~ uuid_pattern) IS NOT TRUE THEN RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['intendedCycleId','targetBatchId'] LOOP
   IF bound->field<>'null'::jsonb AND (bound->>field ~ uuid_pattern) IS NOT TRUE THEN RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
  END LOOP;
  IF NOT (a_companies ? ((bound->>'companyId')::uuid)::text) THEN RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
 END LOOP;
 -- Filter by actual company before each role-bypassing lock, then verify relationships under locks.
 PERFORM b.id FROM public.payroll_batch b WHERE b.tenant_id=a_tenant AND a_companies ? b.company_id::text AND b.id IN
  (SELECT (value->>'targetBatchId')::uuid FROM jsonb_each(step)) ORDER BY b.id FOR UPDATE;
 PERFORM e.id FROM public.employment e WHERE e.tenant_id=a_tenant AND a_companies ? e.company_id::text AND e.id IN
  (SELECT (value->>'employmentId')::uuid FROM jsonb_each(step)) ORDER BY e.id FOR SHARE;
 PERFORM c.id FROM public.pay_component c WHERE c.tenant_id=a_tenant AND c.id IN
  (SELECT (value->>'componentId')::uuid FROM jsonb_each(step)) ORDER BY c.id FOR SHARE;
 PERFORM c.id FROM public.payroll_cycle c WHERE c.tenant_id=a_tenant AND a_companies ? c.company_id::text AND c.id IN
  (SELECT (value->>'intendedCycleId')::uuid FROM jsonb_each(step)) ORDER BY c.id FOR SHARE;
 FOR bound IN SELECT value FROM jsonb_each(step) LOOP
  IF NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=(bound->>'companyId')::uuid AND c.tenant_id=a_tenant)
   OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=(bound->>'employmentId')::uuid AND e.tenant_id=a_tenant AND e.company_id=(bound->>'companyId')::uuid)
   -- Pay components are tenant-wide catalogue rows, with no company ownership column.
   OR NOT EXISTS(SELECT 1 FROM public.pay_component c WHERE c.id=(bound->>'componentId')::uuid AND c.tenant_id=a_tenant)
   OR (bound->>'intendedCycleId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_cycle c WHERE c.id=(bound->>'intendedCycleId')::uuid AND c.tenant_id=a_tenant AND c.company_id=(bound->>'companyId')::uuid))
   OR (bound->>'targetBatchId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_batch r WHERE r.id=(bound->>'targetBatchId')::uuid AND r.tenant_id=a_tenant AND r.company_id=(bound->>'companyId')::uuid AND r.pay_period=bound->>'payPeriod')) THEN
   RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
 END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_txn_import_lock_step_bindings(uuid,integer[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_txn_import_lock_step_bindings(uuid,integer[]) TO ai_hr_app;
--> statement-breakpoint
-- 5. The background queue: 10,000-row progress, the new states, and the reverting batches it now also carries.
ALTER TABLE public.payroll_individual_import_job DROP CONSTRAINT payroll_individual_import_job_processed_check;
--> statement-breakpoint
ALTER TABLE public.payroll_individual_import_job ADD CONSTRAINT payroll_individual_import_job_processed_check CHECK (processed BETWEEN 0 AND 10000);
--> statement-breakpoint
ALTER TABLE public.payroll_individual_import_job DROP CONSTRAINT payroll_individual_import_job_state_check;
--> statement-breakpoint
ALTER TABLE public.payroll_individual_import_job ADD CONSTRAINT payroll_individual_import_job_state_check
 CHECK (state IN ('pending','validating','ready','confirmed','importing','completed','failed','stopped','reverting','reverted'));
--> statement-breakpoint
-- The requesting administrator's session, under which the worker removes the rows (as job.context is the creator's).
ALTER TABLE public.payroll_individual_import_job ADD COLUMN revert_context jsonb CHECK (revert_context IS NULL OR jsonb_typeof(revert_context)='object');
--> statement-breakpoint
CREATE INDEX payroll_individual_import_job_active ON public.payroll_individual_import_job (created_at,id)
 WHERE state IN ('pending','validating','confirmed','importing','reverting');
--> statement-breakpoint
DROP INDEX public.payroll_individual_import_job_queue;
--> statement-breakpoint
-- Any in-scope administrator may revert (as 0688 allows), so the queue row is flagged through this bounded helper
-- rather than a broad UPDATE grant: only a completed or stopped batch whose import this caller has just moved to
-- reverting under its own row security, and only with this caller's own session.
CREATE FUNCTION app.payroll_individual_import_request_revert(p_job uuid, p_context jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE j_id uuid;j_tenant uuid;j_companies jsonb;j_state text;j_attempt uuid;
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL OR app.current_user_id() IS NULL OR NOT app.principal_snapshot_current() OR NOT app.is_admin() THEN
  RAISE EXCEPTION 'Import access denied' USING ERRCODE='42501'; END IF;
 IF p_context IS NULL OR jsonb_typeof(p_context)<>'object' OR p_context->>'tenantId' IS DISTINCT FROM app.current_tenant_id()::text
  OR p_context->>'userId' IS DISTINCT FROM app.current_user_id()::text THEN
  RAISE EXCEPTION 'Import access denied' USING ERRCODE='42501'; END IF;
 SELECT j.id,j.tenant_id,j.company_ids,j.state,j.attempt_id INTO j_id,j_tenant,j_companies,j_state,j_attempt
  FROM public.payroll_individual_import_job j WHERE j.id=p_job AND j.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF j_id IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(j_companies) c WHERE NOT app.is_admin_for(c::uuid)) THEN
  RAISE EXCEPTION 'Import access denied' USING ERRCODE='42501'; END IF;
 IF j_state NOT IN ('completed','stopped','reverting') OR NOT EXISTS(SELECT 1 FROM public.payroll_txn_import_attempt a
  WHERE a.id=j_attempt AND a.tenant_id=j_tenant AND a.state='reverting' AND a.revert_requested_by=app.current_user_id()) THEN RETURN false; END IF;
 UPDATE public.payroll_individual_import_job SET state='reverting',revert_context=p_context,error=NULL,finished_at=NULL WHERE id=j_id;
 RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_individual_import_request_revert(uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_individual_import_request_revert(uuid,jsonb) TO ai_hr_app;
