-- Necessary role presence only. Positive company/group/subtree authority stays with the
-- unchanged canonical grants_have_role_for predicate. No principal, grant or result is cached.
DO $$
DECLARE p record;
BEGIN
 SELECT prosrc,prosecdef,proisstrict,proleakproof,proparallel,provolatile,proconfig INTO p
 FROM pg_proc WHERE oid=to_regprocedure('app.grants_admin_for(jsonb,uuid)');
 IF NOT FOUND OR btrim(p.prosrc) IS DISTINCT FROM
  'SELECT app.grants_have_role_for(grants,''hr_admin'',wanted_company) OR app.grants_have_role_for(grants,''super_admin'',wanted_company)'
  OR p.prosecdef OR p.proisstrict OR p.proleakproof OR p.proparallel<>'u' OR p.provolatile<>'s' OR p.proconfig IS NOT NULL THEN
  RAISE EXCEPTION 'Unexpected administrator grant predicate; review before optimizing' USING ERRCODE='55000';
 END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.grants_admin_for(grants jsonb,wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM pg_catalog.jsonb_array_elements(coalesce(grants,'[]'::jsonb)) candidate
  WHERE candidate->>'role' IN ('hr_admin','super_admin')
 ) THEN (app.grants_have_role_for(grants,'hr_admin',wanted_company)
  OR app.grants_have_role_for(grants,'super_admin',wanted_company)) ELSE false END
$$;
