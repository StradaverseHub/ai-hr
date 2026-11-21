-- Keep effective-dated company ancestry and tenant checks on every hop.
-- Avoid a recursive SQL plan for each access predicate evaluation.
DO $guard$
DECLARE
  previous pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO previous FROM pg_catalog.pg_proc
  WHERE oid = pg_catalog.to_regprocedure('app.company_org_descendant_for_tenant(uuid,uuid,uuid)');
  IF NOT FOUND OR pg_catalog.md5(previous.prosrc) IS DISTINCT FROM '54a42a4016a905df5f0d00551dc07117'
    OR previous.prosecdef IS DISTINCT FROM true
    OR previous.provolatile <> 's'
    OR previous.prorettype IS DISTINCT FROM 'boolean'::regtype::oid
    OR previous.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
  THEN
    RAISE EXCEPTION 'Unexpected company ancestry predecessor' USING ERRCODE = '55000';
  END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.company_org_descendant_for_tenant(p_tenant uuid,p_child uuid,p_ancestor uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  current_company uuid := p_child;
  visited uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_tenant IS NULL OR p_ancestor IS NULL THEN
    RETURN false;
  END IF;
  WHILE current_company IS NOT NULL AND NOT (current_company = ANY(visited)) LOOP
    PERFORM 1 FROM public.company c WHERE c.tenant_id = p_tenant AND c.id = current_company;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    IF current_company = p_ancestor THEN
      RETURN true;
    END IF;
    visited := array_append(visited, current_company);
    current_company := app.company_org_parent_for_tenant(p_tenant,current_company);
  END LOOP;
  RETURN false;
END;
$$;
