-- Own-recipient membership is a primitive fact, not an administrator capability.
-- Avoid reopening recipient RLS (and administrator checks) for every recipient of the parent.
DO $notice_parent_membership$
DECLARE predecessor record; original_policy jsonb; native_owner name;
BEGIN
 IF to_regprocedure('app.has_own_notice_recipient(uuid)') IS NOT NULL THEN
  RAISE EXCEPTION 'Absent own Notice membership helper required';
 END IF;
 FOR predecessor IN SELECT * FROM (VALUES
  ('employment','employment_rls','220bf00f62d67d5d3e96feabc73c4e5e0b77e0fbf4b45953b1f9e1c0bb68ecab'),
  ('notice_recipient','notice_recipient_self_rls','7b13502011a62cc7d9108d3446f84084fcbed4d2cefb18f80592101f29d7a936'),
  ('notice','notice_recipient_read_rls','dc987f5ab34e36384ef13c8a24887f927c1bd5952cb8eaf04a655aa855abd604')
 ) expected(table_name,policy_name,body_sha256) LOOP
  IF (SELECT encode(sha256(convert_to(pg_get_expr(p.polqual,p.polrelid),'UTF8')),'hex')
      FROM pg_policy p WHERE p.polrelid=format('public.%I',predecessor.table_name)::regclass AND p.polname=predecessor.policy_name)
     IS DISTINCT FROM predecessor.body_sha256 THEN
   RAISE EXCEPTION 'Reviewed own Notice membership policy predecessor required';
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid IN ('public.employment'::regclass,'public.notice_recipient'::regclass)
  AND NOT p.polpermissive AND EXISTS(SELECT 1 FROM unnest(p.polroles) role_id WHERE role_id=0 OR pg_has_role('ai_hr_app',role_id,'member'))) THEN
  RAISE EXCEPTION 'Unexpected restrictive policy on own Notice membership inputs';
 END IF;
 SELECT to_jsonb(p)-'polqual' INTO STRICT original_policy FROM pg_policy p
  WHERE p.polrelid='public.notice'::regclass AND p.polname='notice_recipient_read_rls';
 SELECT pg_get_userbyid(proowner) INTO STRICT native_owner FROM pg_proc WHERE oid='app.can_manage_notice(uuid)'::regprocedure;
 EXECUTE $function_definition$
 CREATE FUNCTION app.has_own_notice_recipient(wanted_notice uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
 SELECT (SELECT app.principal_snapshot_current()) AND EXISTS(
  SELECT 1 FROM public.app_user u
  JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
  JOIN public.notice_recipient nr ON nr.employment_id=e.id AND nr.tenant_id=e.tenant_id
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
   AND nr.notice_id=wanted_notice AND app.is_self_person(e.person_id)
 )
 $body$
 $function_definition$;
 EXECUTE format('ALTER FUNCTION app.has_own_notice_recipient(uuid) OWNER TO %I',native_owner);
 REVOKE ALL ON FUNCTION app.has_own_notice_recipient(uuid) FROM PUBLIC,ai_hr_app;
 GRANT EXECUTE ON FUNCTION app.has_own_notice_recipient(uuid) TO ai_hr_app;
 ALTER POLICY notice_recipient_read_rls ON public.notice
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current())
  AND published_at IS NOT NULL AND archived_at IS NULL
  AND start_on-1<=current_date AND current_date<=end_on+1
  AND app.has_own_notice_recipient(id));
 IF (SELECT to_jsonb(p)-'polqual' FROM pg_policy p WHERE p.polrelid='public.notice'::regclass AND p.polname='notice_recipient_read_rls')
    IS DISTINCT FROM original_policy THEN
  RAISE EXCEPTION 'Notice recipient policy attributes changed unexpectedly';
 END IF;
END;
$notice_parent_membership$;
