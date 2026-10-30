-- Coordinated source append; ordinary owner migration only. No installation claim.
-- Retention is a native company-administration fact, not permission to read private traces.
CREATE FUNCTION app.pay_formula_company_in_use(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.current_user_id() IS NOT NULL
  AND app.current_agent_principal() IS NULL
  AND app.principal_snapshot_current()
  AND EXISTS(
   SELECT 1 FROM public.company c
   WHERE c.id=wanted_company
    AND c.tenant_id=app.current_tenant_id()
    AND app.is_admin_for(c.id)
    AND (
     EXISTS(SELECT 1 FROM public.pay_formula_test r
      WHERE r.tenant_id=c.tenant_id AND r.company_id=c.id)
     OR EXISTS(SELECT 1 FROM public.pay_formula_evaluation r
      WHERE r.tenant_id=c.tenant_id AND r.company_id=c.id)
    )
  )
$$;
REVOKE ALL ON FUNCTION app.pay_formula_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pay_formula_company_in_use(uuid) TO ai_hr_app;
