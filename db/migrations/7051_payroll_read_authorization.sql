-- These definers call authorization code that reads the forced-RLS company hierarchy.
-- Migration 7040 already protects the original-employer reader.
ALTER FUNCTION app.payroll_tax_import_source_revision(uuid) SET row_security = on;
ALTER FUNCTION app.payroll_import_tax_reader_compatible(uuid, uuid, jsonb) SET row_security = on;
ALTER FUNCTION app.payroll_tax_basis_reader_compatible(uuid, uuid) SET row_security = on;
ALTER FUNCTION app.pay_formula_saved(text) SET row_security = on;
ALTER FUNCTION app.pay_formula_active(text) SET row_security = on;
ALTER FUNCTION app.pay_formula_category(uuid, text) SET row_security = on;
--> statement-breakpoint
-- Ended employment blocks interactive login. Preserve the existing self-history
-- reads for a current employee-only identity without authorizing any admin claim.
CREATE FUNCTION app.payroll_leaver_self_history() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET row_security = on
AS $$
  SELECT app.current_roles() = ARRAY['employee']::text[]
    AND EXISTS (SELECT 1 FROM app.current_grants())
    AND EXISTS (
      SELECT 1 FROM public.app_user u
      WHERE u.id = app.current_user_id() AND u.tenant_id = app.current_tenant_id()
        AND u.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM app.current_grants() claimed
          WHERE claimed.role IS DISTINCT FROM 'employee' OR NOT EXISTS (
            SELECT 1 FROM public.role_assignment actual
            WHERE actual.app_user_id = u.id AND actual.tenant_id = u.tenant_id
              AND actual.role = 'employee'
              AND (actual.company_id IS NULL OR actual.company_id = claimed.company_id)
          )
        )
        AND EXISTS (
          SELECT 1 FROM public.employment e
          WHERE e.person_id = u.person_id AND e.tenant_id = u.tenant_id
            AND e.blacklisted_at IS NULL
            AND LEAST(e.resignation_date, e.last_working_date, e.terminated_on) < current_date
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.employment e
          WHERE e.person_id = u.person_id AND e.tenant_id = u.tenant_id
            AND (
              LEAST(e.resignation_date, e.last_working_date, e.terminated_on) IS NULL
              OR LEAST(e.resignation_date, e.last_working_date, e.terminated_on) >= current_date
            )
        )
    );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_leaver_self_history() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_leaver_self_history() TO ai_hr_app;
--> statement-breakpoint
-- Check the session-wide predicates once per statement. An eligible former
-- employee can read only their own payslips and the batches containing them.
CREATE POLICY payroll_batch_current_human_read ON public.payroll_batch
  AS RESTRICTIVE FOR SELECT TO ai_hr_app
  USING (CASE
    WHEN (SELECT app.current_user_id() IS NULL OR app.principal_snapshot_current()) THEN true
    WHEN (SELECT app.payroll_leaver_self_history()) THEN EXISTS (
      SELECT 1 FROM public.payslip s
      JOIN public.employment e ON e.id = s.employment_id AND e.tenant_id = s.tenant_id
      WHERE s.batch_id = payroll_batch.id AND s.tenant_id = payroll_batch.tenant_id
        AND app.is_self_person(e.person_id)
    )
    ELSE false
  END);
CREATE POLICY payslip_current_human_read ON public.payslip
  AS RESTRICTIVE FOR SELECT TO ai_hr_app
  USING (CASE
    WHEN (SELECT app.current_user_id() IS NULL OR app.principal_snapshot_current()) THEN true
    WHEN (SELECT app.payroll_leaver_self_history()) THEN EXISTS (
      SELECT 1 FROM public.employment e
      WHERE e.id = payslip.employment_id AND e.tenant_id = payslip.tenant_id
        AND app.is_self_person(e.person_id)
    )
    ELSE false
  END);
