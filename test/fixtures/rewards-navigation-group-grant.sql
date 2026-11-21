-- Test-only comparison. Keep the same function owner and execution privileges.
DO $proof$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
  WHERE p.oid='app.reward_current_group_roles()'::regprocedure AND r.rolname=current_user
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')=
      'a5b0666ffec7b7519f53e0f18f6717080f9d815417220d6269ff3efb175ba3af'
 ) THEN
  RAISE EXCEPTION 'Unexpected Rewards whole-group role predecessor or owner';
 END IF;
END
$proof$;

CREATE OR REPLACE FUNCTION app.reward_current_group_roles() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH candidate_roles AS MATERIALIZED (
  SELECT grant_row.role FROM public.reward_group_role_grant grant_row
  WHERE grant_row.tenant_id=app.current_tenant_id()
    AND grant_row.user_id=app.current_user_id() AND grant_row.active
 )
 SELECT role FROM candidate_roles
 WHERE CASE WHEN EXISTS (SELECT 1 FROM candidate_roles) THEN
  app.principal_snapshot_current()
  AND app.reward_not_viewing_as()
  AND app.reward_group_person_eligible(app.current_user_id())
 ELSE false END;
$$;
