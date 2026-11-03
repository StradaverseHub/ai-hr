CREATE FUNCTION app.notice_parent_current_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current()
 AND app.lifecycle_reward_notice_legacy_allowed(t,u,cap,co)
 AND CASE split_part(cap,'.',1)
  WHEN 'notices' THEN CASE WHEN co IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(co) END
  WHEN 'notices_global' THEN co IS NULL AND app.is_group_admin()
  ELSE false END;
$$;
REVOKE ALL ON FUNCTION app.notice_parent_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.notice_author_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,handler,trigger_type,definer) AS (
  VALUES
   ('notice','notice_owner_guard','app.guard_notice_owner()'::regprocedure,31,false),
   ('notice','notice_action_write','app.notice_action_write_guard()'::regprocedure,31,true),
   ('notice','notice_action_lock','app.notice_action_statement_lock()'::regprocedure,30,true),
   ('notice_attachment','notice_attachment_action_write','app.notice_action_write_guard()'::regprocedure,7,true),
   ('notice_attachment','notice_attachment_action_lock','app.notice_action_statement_lock()'::regprocedure,6,true)
 )
 SELECT NOT EXISTS (
  SELECT FROM expected e WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid=to_regclass('public.'||e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.handler
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND NOT t.tgdeferrable AND c.relrowsecurity
    AND p.proowner=c.relowner AND p.prosecdef=e.definer AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 ) AND EXISTS (
  SELECT FROM pg_policy p
  WHERE p.polrelid='public.notice'::regclass AND p.polname='notice_admin_rls'
   AND EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.objid=p.oid
    AND d.refclassid='pg_proc'::regclass AND d.refobjid='app.notice_owner_action_allowed(uuid,text)'::regprocedure)
 );
$$;
REVOKE ALL ON FUNCTION app.notice_author_bindings_complete() FROM PUBLIC,ai_hr_app;
