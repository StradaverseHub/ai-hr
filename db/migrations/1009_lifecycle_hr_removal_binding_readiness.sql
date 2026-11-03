CREATE FUNCTION app.lifecycle_current_legacy_allowed(t uuid,u uuid,cap text,co uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current()
  AND cap IN ('lifecycle.view','lifecycle.edit')
  AND app.lifecycle_reward_notice_legacy_allowed(t,u,cap,co);
$$;
REVOKE ALL ON FUNCTION app.lifecycle_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The scoped HR command requires both its exact current View and Execute.
-- Assigned removal still follows its independent native group course.
DO $guard$
DECLARE definition text; anchor text:=' IF app.function_action_allowed(key,''execute'',c.company_id)IS NOT TRUE';
BEGIN
 definition:=pg_get_functiondef('app.onboarding_exception_update(uuid,integer,text,jsonb)'::regprocedure);
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'HR exception removal admission changed';
 END IF;
 EXECUTE replace(definition,anchor,anchor||
  ' OR native_command=''removeItemHR'' AND app.function_action_allowed(key,''view'',c.company_id)IS NOT TRUE');
END;
$guard$;
--> statement-breakpoint
DO $readers$
DECLARE definition text; anchor text;
BEGIN
 definition:=pg_get_functiondef('app.onboarding_case_labels(uuid)'::regprocedure);
 anchor:='WHERE id=p_case AND tenant_id=app.current_tenant_id() AND';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'Onboarding case labels admission changed';
 END IF;
 EXECUTE replace(definition,anchor,anchor||
  ' (NOT app.is_admin_for(company_id) OR app.lifecycle_reward_notice_action(''lifecycle'',''view'',company_id)) AND');

 definition:=pg_get_functiondef('app.onboarding_v9_case_values(uuid)'::regprocedure);
 anchor:='IF NOT FOUND THEN RETURN NULL; END IF;';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'Onboarding case values admission changed';
 END IF;
 EXECUTE replace(definition,anchor,
  'IF NOT FOUND OR (app.is_admin_for(c.company_id) AND NOT app.lifecycle_reward_notice_action(''lifecycle'',''view'',c.company_id)) THEN RETURN NULL; END IF;');
END;
$readers$;
--> statement-breakpoint
CREATE FUNCTION app.lifecycle_hr_removal_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH guards(relation,trigger_name,handler,kind,deferred) AS (
  VALUES
   ('lc_case','lifecycle_action_guard','app.lifecycle_legacy_action_guard()'::regprocedure,29,true),
   ('lc_v9_case','lifecycle_offboarding_action','app.lifecycle_offboarding_write_guard()'::regprocedure,23,false),
   ('lc_v9_file','lifecycle_case_file_action','app.lifecycle_offboarding_write_guard()'::regprocedure,7,false),
   ('lc_onboarding_case','lifecycle_administration_action','app.lifecycle_onboarding_administration_guard()'::regprocedure,23,false),
   ('lc_onboarding_private','lifecycle_administration_action','app.lifecycle_onboarding_administration_guard()'::regprocedure,23,false)
 ), reads(relation,policy_name,handler) AS (
  VALUES
   ('lc_case','lifecycle_action_read','app.lifecycle_legacy_record_read(text,jsonb)'::regprocedure),
   ('lc_onboarding_case','lifecycle_administrative_read','app.lifecycle_reward_notice_action(text,text,uuid)'::regprocedure),
   ('lc_onboarding_case_revision','lifecycle_administrative_read','app.lifecycle_reward_notice_action(text,text,uuid)'::regprocedure),
   ('lc_onboarding_private','lifecycle_administrative_read','app.lifecycle_reward_notice_action(text,text,uuid)'::regprocedure),
   ('lc_onboarding_private_revision','lifecycle_administrative_read','app.lifecycle_reward_notice_action(text,text,uuid)'::regprocedure),
   ('lc_v9_case','v9_case_read','app.lifecycle_reward_notice_action(text,text,uuid)'::regprocedure),
   ('lc_v9_case_revision','v9_case_revision_read','app.lifecycle_reward_notice_action(text,text,uuid)'::regprocedure),
   ('lc_v9_file','v9_file_read','app.lifecycle_reward_notice_action(text,text,uuid)'::regprocedure)
 )
 SELECT app.lifecycle_delivery_bindings_complete()
  AND NOT EXISTS (
   SELECT FROM guards e WHERE NOT EXISTS (
    SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.oid=to_regclass('public.'||e.relation) AND c.relrowsecurity AND p.proowner=c.relowner
     AND t.tgname=e.trigger_name AND t.tgfoid=e.handler AND t.tgtype=e.kind AND t.tgenabled IN ('O','A')
     AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
     AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
   )
  ) AND NOT EXISTS (
   SELECT FROM reads e WHERE NOT EXISTS (
    SELECT FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
    WHERE c.oid=to_regclass('public.'||e.relation) AND c.relrowsecurity AND p.polname=e.policy_name AND p.polcmd='r'
     AND EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.objid=p.oid
      AND d.refclassid='pg_proc'::regclass AND d.refobjid=e.handler)
   )
  );
$$;
REVOKE ALL ON FUNCTION app.lifecycle_hr_removal_bindings_complete() FROM PUBLIC,ai_hr_app;
