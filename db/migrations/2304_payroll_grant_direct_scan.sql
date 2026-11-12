-- Keep payroll's company-scoped HR, super-admin and Payroll Partner checks
-- on the current session grants without rebuilding them as JSON.
DO $guard$
DECLARE
  previous pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO previous FROM pg_catalog.pg_proc
  WHERE oid = pg_catalog.to_regprocedure('app.can_admin_payroll_for(uuid)');
  IF NOT FOUND OR pg_catalog.md5(previous.prosrc) IS DISTINCT FROM '7ac8c0b2718a499231f3d2dbc09ab15c'
    OR previous.prosecdef OR previous.proisstrict OR previous.proleakproof
    OR previous.proparallel <> 'u' OR previous.provolatile <> 's' OR previous.proconfig IS NOT NULL
  THEN
    RAISE EXCEPTION 'Unexpected company Payroll predicate predecessor' USING ERRCODE = '55000';
  END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_admin_payroll_for(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.current_grants() g
    WHERE g.role IN ('hr_admin', 'super_admin', 'payroll_partner')
      AND (g.company_id IS NULL OR g.company_id = p_company
        OR app.is_company_descendant(p_company, g.company_id))
  )
$$;
