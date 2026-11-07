-- Append-only HR remarks on a specific recorded payroll comparison.
CREATE TABLE public.payroll_reconciliation_remark (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  company_id uuid NOT NULL,
  employment_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES public.app_user(id),
  previous_period text NOT NULL CHECK (previous_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  current_period text NOT NULL CHECK (current_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND previous_period < current_period),
  scope_digest text NOT NULL CHECK (scope_digest ~ '^[0-9a-f]{64}$'),
  body text NOT NULL CHECK (length(body) <= 1000),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
  FOREIGN KEY (employment_id,tenant_id) REFERENCES public.employment(id,tenant_id),
  UNIQUE (tenant_id,company_id,previous_period,current_period,scope_digest,employment_id,revision)
);
--> statement-breakpoint
CREATE FUNCTION app.payroll_reconciliation_remark_access(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current()
 AND (app.has_role_for('hr_admin',target) OR app.has_role_for('super_admin',target))
 AND app.pay_formula_category(target,'compensation')
 AND EXISTS (
   SELECT 1 FROM public.tenant t JOIN public.tenant_module tm ON tm.tenant_id=t.id
   WHERE t.id=app.current_tenant_id() AND t.status IN ('active','trial')
     AND tm.module_code='payroll' AND tm.status IN ('active','trial')
     AND (tm.company_id IS NULL OR tm.company_id=target)
     AND (tm.expires_at IS NULL OR tm.expires_at>now())
 )
$$;
REVOKE ALL ON FUNCTION app.payroll_reconciliation_remark_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_reconciliation_remark_access(uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE public.payroll_reconciliation_remark ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_reconciliation_remark FROM PUBLIC,ai_hr_app;
GRANT SELECT, INSERT ON public.payroll_reconciliation_remark TO ai_hr_app;
CREATE POLICY payroll_reconciliation_remark_read ON public.payroll_reconciliation_remark FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.payroll_reconciliation_remark_access(company_id));
CREATE POLICY payroll_reconciliation_remark_append ON public.payroll_reconciliation_remark FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id()
   AND app.payroll_reconciliation_remark_access(company_id)
   AND EXISTS (
     SELECT 1 FROM public.payslip p
     JOIN public.payroll_batch b ON b.id=p.batch_id AND b.tenant_id=p.tenant_id
     WHERE p.tenant_id=payroll_reconciliation_remark.tenant_id
       AND p.employment_id=payroll_reconciliation_remark.employment_id
       AND b.company_id=payroll_reconciliation_remark.company_id
       AND b.pay_period IN (payroll_reconciliation_remark.current_period,payroll_reconciliation_remark.previous_period)
       AND b.status IN ('processed','closed') AND b.needs_recalc_at IS NULL
   ));
--> statement-breakpoint
CREATE FUNCTION app.payroll_reconciliation_company_in_use(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.principal_snapshot_current() AND app.is_admin() AND EXISTS (
   SELECT 1 FROM public.company c WHERE c.id=target AND c.tenant_id=app.current_tenant_id()
     AND app.is_admin_for(coalesce(app.company_org_current_parent(c.id),c.id))
 ) THEN EXISTS (
   SELECT 1 FROM public.payroll_reconciliation_remark r
   WHERE r.company_id=target AND r.tenant_id=app.current_tenant_id()
 ) ELSE false END
$$;
REVOKE ALL ON FUNCTION app.payroll_reconciliation_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_reconciliation_company_in_use(uuid) TO ai_hr_app;
