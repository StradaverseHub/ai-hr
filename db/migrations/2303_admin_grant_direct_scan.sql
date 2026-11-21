-- Evaluate the current session's company grants directly. Keep the JSON helper
-- for callers evaluating someone else's proposed or stored grants.
DO $guard$
DECLARE
  previous pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO previous FROM pg_catalog.pg_proc
  WHERE oid = pg_catalog.to_regprocedure('app.is_admin_for(uuid)');
  IF NOT FOUND OR pg_catalog.md5(previous.prosrc) IS DISTINCT FROM '0cdcac6b6a1ff41aac4ace796d6e1419'
    OR previous.prosecdef OR previous.proisstrict OR previous.proleakproof
    OR previous.proparallel <> 'u' OR previous.provolatile <> 's' OR previous.proconfig IS NOT NULL
  THEN
    RAISE EXCEPTION 'Unexpected company administrator predicate predecessor' USING ERRCODE = '55000';
  END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.is_admin_for(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.current_grants() g
    WHERE g.role IN ('hr_admin', 'super_admin')
      AND (g.company_id IS NULL OR g.company_id = p_company
        OR app.is_company_descendant(p_company, g.company_id))
  )
$$;
