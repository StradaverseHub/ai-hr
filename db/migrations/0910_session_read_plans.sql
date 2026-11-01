-- Reuse query plans, never session validity, login eligibility or permission results.
-- The canonical SQL expressions, volatility, definer, search paths and execute ACLs are unchanged.
CREATE OR REPLACE FUNCTION app.principal_snapshot_current() RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $session_plan$
BEGIN
 RETURN (
SELECT EXISTS(
  SELECT 1 FROM app.principal(app.current_user_id()) p
  JOIN public.app_user u ON u.id=app.current_user_id() AND u.tenant_id=p.tenant_id
  WHERE p.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND NOT EXISTS(SELECT 1 FROM unnest(app.current_roles()) claimed(role)
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.grants) actual
     WHERE actual->>'role'=claimed.role))
   AND NOT EXISTS(SELECT 1 FROM app.current_grants() claimed
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.grants) actual
     WHERE actual->>'role'=claimed.role AND
      (nullif(actual->>'companyId','') IS NULL
       OR nullif(actual->>'companyId','')::uuid=claimed.company_id
       OR (claimed.company_id IS NOT NULL AND app.is_company_descendant(claimed.company_id,nullif(actual->>'companyId','')::uuid)))))
 )
 );
END;
$session_plan$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.login_blocked_on(p_user_id uuid,p_as_of date) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $session_plan$
BEGIN
 RETURN (
SELECT CASE WHEN p_as_of IS NULL THEN true ELSE EXISTS(
  SELECT 1 FROM public.app_user u WHERE u.id=p_user_id AND (
   u.archived_at IS NOT NULL OR (
    u.person_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=u.person_id)
    AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=u.person_id AND e.blacklisted_at IS NULL
     AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
      OR p_as_of<=LEAST(e.resignation_date,e.last_working_date,e.terminated_on)))
   )
  )
 ) END
 );
END;
$session_plan$;
