-- Board 124a979e (approved plan item 9): a payroll input saved by somebody who cannot administer payroll for the
-- employee's company cannot mark the processed runs it makes stale (the mark writes payroll_batch, which only a payroll
-- administrator of the run's company may write). The save records the employment, the months it reaches and the change
-- categories here instead, in its own transaction; the next Payroll Process list refresh, run under a payroll
-- administrator of the employee's current company (core/payroll-run-outstanding.ts), marks the runs through the normal
-- mark helper and deletes the rows in one transaction. Append and consume only: no UPDATE grant.
-- from_period / until_period are pay months (YYYY-MM), until inclusive; NULL means unbounded on that side.
-- No existing table, row, policy or function changes; the new table starts empty.
CREATE TABLE public.payroll_recalc_pending(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 employment_id uuid NOT NULL,
 from_period text,
 until_period text,
 categories text[] NOT NULL,
 requested_at timestamp with time zone NOT NULL DEFAULT now(),
 requested_by uuid,
 CONSTRAINT payroll_recalc_pending_tenant_fk FOREIGN KEY(tenant_id) REFERENCES public.tenant(id),
 CONSTRAINT payroll_recalc_pending_employment_fk FOREIGN KEY(employment_id) REFERENCES public.employment(id) ON DELETE CASCADE,
 CONSTRAINT payroll_recalc_pending_from_month CHECK(from_period IS NULL OR from_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 CONSTRAINT payroll_recalc_pending_until_month CHECK(until_period IS NULL OR until_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 CONSTRAINT payroll_recalc_pending_window CHECK(from_period IS NULL OR until_period IS NULL OR from_period<=until_period),
 CONSTRAINT payroll_recalc_pending_categories CHECK(cardinality(categories) BETWEEN 1 AND 16)
);
--> statement-breakpoint
CREATE INDEX payroll_recalc_pending_tenant_employment_idx ON public.payroll_recalc_pending(tenant_id,employment_id);
--> statement-breakpoint
CREATE INDEX payroll_recalc_pending_employment_idx ON public.payroll_recalc_pending(employment_id);
--> statement-breakpoint
ALTER TABLE public.payroll_recalc_pending ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_recalc_pending FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.payroll_recalc_pending FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON public.payroll_recalc_pending TO ai_hr_app;
--> statement-breakpoint
-- Recorded by the saving principal for an employment it can see (the EXISTS reads employment under the saver's own row
-- security), as itself. Never requires payroll administration: that is the whole point of the table.
CREATE POLICY payroll_recalc_pending_insert ON public.payroll_recalc_pending FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND requested_by IS NOT DISTINCT FROM app.current_user_id()
  AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=payroll_recalc_pending.employment_id AND e.tenant_id=payroll_recalc_pending.tenant_id));
--> statement-breakpoint
-- Read and consumed only by a payroll administrator of the employee's current company.
CREATE POLICY payroll_recalc_pending_read ON public.payroll_recalc_pending FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.employment e
  WHERE e.id=payroll_recalc_pending.employment_id AND e.tenant_id=payroll_recalc_pending.tenant_id AND app.can_admin_payroll_for(e.company_id)));
--> statement-breakpoint
CREATE POLICY payroll_recalc_pending_consume ON public.payroll_recalc_pending FOR DELETE TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.employment e
  WHERE e.id=payroll_recalc_pending.employment_id AND e.tenant_id=payroll_recalc_pending.tenant_id AND app.can_admin_payroll_for(e.company_id)));
