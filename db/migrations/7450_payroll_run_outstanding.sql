-- a1a80747 (approved plan r2): the stored answer "who is still owed processing on this processed run", which the Payroll
-- Process list reads in one set-based statement instead of evaluating the Close rule per run in the request.
-- employment_ids holds the run's close-pending employees (core/payroll.ts runOutstandingTx: new or pending employees
-- with no payslip, and employees held for income tax review); the recalculation mark stays on payroll_batch and is read
-- live beside it. NULL employment_ids means "not worked out yet". Written only by the payroll owner
-- (core/payroll-run-outstanding.ts) under a payroll administrator of the run's company; visible wherever the run is.
-- No existing table, row, policy or function changes.
CREATE TABLE public.payroll_run_outstanding(
 batch_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 employment_ids jsonb,
 refreshed_at timestamp with time zone,
 requested_at timestamp with time zone,
 CONSTRAINT payroll_run_outstanding_batch_fk FOREIGN KEY(batch_id) REFERENCES public.payroll_batch(id) ON DELETE CASCADE,
 CONSTRAINT payroll_run_outstanding_tenant_fk FOREIGN KEY(tenant_id) REFERENCES public.tenant(id),
 CONSTRAINT payroll_run_outstanding_ids_array CHECK(employment_ids IS NULL OR jsonb_typeof(employment_ids)='array'),
 CONSTRAINT payroll_run_outstanding_refreshed CHECK((employment_ids IS NULL)=(refreshed_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE public.payroll_run_outstanding ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_run_outstanding FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.payroll_run_outstanding FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON public.payroll_run_outstanding TO ai_hr_app;
--> statement-breakpoint
-- Visible exactly where the run is: the EXISTS reads payroll_batch under the reader's own row security.
CREATE POLICY payroll_run_outstanding_read ON public.payroll_run_outstanding FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.payroll_batch b
  WHERE b.id=payroll_run_outstanding.batch_id AND b.tenant_id=payroll_run_outstanding.tenant_id));
--> statement-breakpoint
-- Written only by a payroll administrator of the run's company (the refresh job runs under one).
CREATE POLICY payroll_run_outstanding_insert ON public.payroll_run_outstanding FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.payroll_batch b
  WHERE b.id=payroll_run_outstanding.batch_id AND b.tenant_id=payroll_run_outstanding.tenant_id AND app.can_admin_payroll_for(b.company_id)));
--> statement-breakpoint
CREATE POLICY payroll_run_outstanding_update ON public.payroll_run_outstanding FOR UPDATE TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.payroll_batch b
  WHERE b.id=payroll_run_outstanding.batch_id AND b.tenant_id=payroll_run_outstanding.tenant_id AND app.can_admin_payroll_for(b.company_id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.payroll_batch b
  WHERE b.id=payroll_run_outstanding.batch_id AND b.tenant_id=payroll_run_outstanding.tenant_id AND app.can_admin_payroll_for(b.company_id)));
--> statement-breakpoint
CREATE POLICY payroll_run_outstanding_delete ON public.payroll_run_outstanding FOR DELETE TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.payroll_batch b
  WHERE b.id=payroll_run_outstanding.batch_id AND b.tenant_id=payroll_run_outstanding.tenant_id AND app.can_admin_payroll_for(b.company_id)));
--> statement-breakpoint
-- The refresh runs on the shared bulk-job kernel's default lane: the run ids to work out (at most 200 per job).
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
VALUES('payroll_run_outstanding_refresh',NULL,'none','{"batchIds":"array"}'::jsonb,10240,false);
