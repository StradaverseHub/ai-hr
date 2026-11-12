-- PostgreSQL caches the static PL/pgSQL statements in each backend. The same
-- queries still evaluate current identity and grants against the caller's MVCC
-- snapshot on every invocation. No principal or authorization result is cached.
DO $guard$
DECLARE previous pg_catalog.pg_proc%ROWTYPE;
BEGIN
 SELECT * INTO STRICT previous FROM pg_catalog.pg_proc WHERE oid='app.principal_snapshot_current()'::regprocedure;
 IF pg_catalog.md5(previous.prosrc) IS DISTINCT FROM '82cbdc97ad0be823234dfb5684ecb150'
    OR previous.prolang <> (SELECT oid FROM pg_catalog.pg_language WHERE lanname='sql')
    OR NOT previous.prosecdef OR previous.provolatile <> 's'
    OR previous.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
 THEN
  RAISE EXCEPTION 'Unexpected app.principal_snapshot_current() predecessor' USING ERRCODE='55000';
 END IF;
 SELECT * INTO STRICT previous FROM pg_catalog.pg_proc WHERE oid='app.principal(uuid)'::regprocedure;
 IF pg_catalog.md5(previous.prosrc) IS DISTINCT FROM 'bf0b94a67a720f75e4b718252896fd55'
    OR previous.prolang <> (SELECT oid FROM pg_catalog.pg_language WHERE lanname='sql')
    OR NOT previous.prosecdef OR previous.provolatile <> 's'
    OR previous.proconfig IS DISTINCT FROM ARRAY['search_path=public']
 THEN
  RAISE EXCEPTION 'Unexpected app.principal(uuid) predecessor' USING ERRCODE='55000';
 END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.principal(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, person_id uuid, grants jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $principal$
BEGIN
 RETURN QUERY
  SELECT u.tenant_id, u.person_id,
         COALESCE(
           jsonb_agg(jsonb_build_object('role', ra.role, 'companyId', ra.company_id))
             FILTER (WHERE ra.role IS NOT NULL),
           '[]'::jsonb
         )
  FROM app_user u
  LEFT JOIN role_assignment ra ON ra.app_user_id = u.id
  WHERE u.id = p_user_id
  GROUP BY u.tenant_id, u.person_id;
END;
$principal$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.principal_snapshot_current() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $snapshot$
BEGIN
 RETURN EXISTS(
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
 );
END;
$snapshot$;
