-- UNALLOCATED DRAFT on branch claude/bulkjob-payroll-20261110 (payroll processing as a background bulk job): not a
-- reservation, not an installation allocation. The journal position (idx 9951, when 1793330099951) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md.
--
-- Payroll processing runs on the shared bulk-job kernel (9003). The web action admits the job and moves the run
-- draft -> processing in one short transaction; the worker writes payslips in short chunks under the run's own
-- company/month and payroll-inputs keys, and one short finalize moves processing -> processed. A failed or cancelled
-- job discards its payslips and returns the run to draft.
--
-- 1. Run-level durable lease. processing_job_id is set exactly while status = 'processing'. It replaces holding the
--    payroll period key for the whole run: every other lifecycle owner already refuses a run that is not in the
--    status it needs, and the chunks fence on this column.
ALTER TABLE payroll_batch ADD COLUMN processing_job_id uuid, ADD COLUMN processing_started_at timestamptz;
--> statement-breakpoint
-- Writers reviewed: only core/payroll-processing-job.ts sets 'processing' (with the job id) and only its finalize
-- (processing -> processed) and discard (processing -> draft) leave it, clearing the job id in the same UPDATE.
-- Every other status writer moves a row that was never 'processing'. No existing row is 'processing'.
-- status::text throughout this file: the drizzle migrator applies every pending file in one transaction, and an enum
-- value added in that transaction (9950) cannot be used as a constant before it commits.
ALTER TABLE payroll_batch ADD CONSTRAINT payroll_batch_processing_lease
 CHECK ((status::text = 'processing') = (processing_job_id IS NOT NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE payroll_batch VALIDATE CONSTRAINT payroll_batch_processing_lease;
--> statement-breakpoint
-- Runs of one company process one at a time (a later month reads the earlier month's payslips): the job looks
-- up the company's other processing runs through this index.
CREATE INDEX payroll_batch_processing ON payroll_batch(tenant_id, company_id, processing_started_at) WHERE processing_job_id IS NOT NULL;
--> statement-breakpoint
-- 2. The retired Attendance Formula guard fires on every transition that produces payroll figures. Processing now
--    reaches 'processed' through 'processing', so both legs are guarded, exactly as draft -> processed was.
DROP TRIGGER payroll_retired_attendance_formula_status ON public.payroll_batch;
--> statement-breakpoint
CREATE TRIGGER payroll_retired_attendance_formula_status BEFORE UPDATE OF status ON public.payroll_batch
 FOR EACH ROW WHEN (
  (OLD.status::text='draft' AND NEW.status::text IN ('processing','processed','closed'))
  OR (OLD.status::text='processing' AND NEW.status::text IN ('processed','closed'))
  OR (OLD.status::text='processed' AND NEW.status::text IN ('processed','closed'))
 ) EXECUTE FUNCTION app.payroll_retired_attendance_formula_status_guard();
--> statement-breakpoint
-- 3. Kernel extension: exclusive 'none'. A kind whose own durable lease provides exclusivity (here the run's
--    processing_job_id, one per run) does not limit its creator to one active job: an operator may start the runs
--    of several companies back to back. The derived key is the job's own id, so the one-active index never refuses.
--    Combined release: this follows the roster kernel extension (tenant_queue, watched_at), so the constraint and
--    the admission function below are the one kernel's union of every exclusivity: tenant, creator, tenant_queue
--    (key 'queue:'||id; the worker's claim serialises the kind) and none (key = the job's own id).
ALTER TABLE bulk_job_kind DROP CONSTRAINT bulk_job_kind_exclusive_check;
--> statement-breakpoint
ALTER TABLE bulk_job_kind ADD CONSTRAINT bulk_job_kind_exclusive_check CHECK(exclusive IN ('tenant','creator','tenant_queue','none'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.bulk_job_admit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE mode text;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id()
 OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Bulk job access denied' USING ERRCODE='42501';END IF;
 SELECT k.exclusive INTO mode FROM public.bulk_job_kind k WHERE k.kind=NEW.kind;
 IF mode IS NULL THEN RAISE EXCEPTION 'Unknown bulk job kind' USING ERRCODE='22023';END IF;
 NEW.context:=jsonb_build_object('tenantId',app.current_tenant_id(),'userId',app.current_user_id(),
  'roles',to_jsonb(app.current_roles()),'grants',coalesce(nullif(current_setting('app.grants',true),'')::jsonb,'[]'::jsonb));
 NEW.exclusive_key:=CASE mode WHEN 'tenant' THEN 'tenant' WHEN 'creator' THEN NEW.created_by::text
  WHEN 'tenant_queue' THEN 'queue:'||NEW.id::text ELSE NEW.id::text END;
 NEW.state:='queued';NEW.outcome:=NULL;NEW.lease_token:=NULL;NEW.lease_expires_at:=NULL;NEW.notice_event_id:=NULL;NEW.notified_at:=NULL;
 NEW.created_at:=now();NEW.updated_at:=now();NEW.finished_at:=NULL;NEW.watched_at:=NULL;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- 4. The kind. No Import History scope: the creator reads the job while their captured grants stay current; every
--    payroll operator sees the run's own 'processing' status through payroll_batch.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive) VALUES('payroll_process',NULL,'none');
--> statement-breakpoint
-- 5. The effective-batch view (0660) projects every payroll_batch column, listed when it was created; the readers'
--    projection (db/schema.ts payrollHistoryBatchView) now includes the two lease columns. Rebuilt with 0660's own
--    expressions, so the existing columns are unchanged and the new ones are appended in table order.
DO $$ DECLARE columns text; BEGIN
 SELECT string_agg(CASE a.attname
  WHEN 'totals' THEN 'CASE WHEN b.history_import_attempt_id IS NULL AND NOT app.payroll_history_batch_adopted(b.id) THEN b.totals ELSE app.payroll_history_batch_totals(b.id) END AS totals'
  WHEN 'employee_count' THEN 'CASE WHEN b.history_import_attempt_id IS NULL AND NOT app.payroll_history_batch_adopted(b.id) THEN b.employee_count ELSE (app.payroll_history_batch_totals(b.id)->>''employeeCount'')::integer END AS employee_count'
  ELSE format('b.%I',a.attname) END,',' ORDER BY a.attnum) INTO columns
 FROM pg_attribute a WHERE a.attrelid='public.payroll_batch'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 EXECUTE 'CREATE OR REPLACE VIEW public.payroll_history_effective_batch WITH (security_invoker=true) AS SELECT '||columns||' FROM public.payroll_batch b';
END $$;
