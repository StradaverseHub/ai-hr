CREATE FUNCTION app.lifecycle_assigned_task_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,handler,trigger_type,deferred) AS (
  VALUES
   ('public.lc_onboarding_case','lifecycle_native_effect_capture','app.lifecycle_native_effect_capture()'::regprocedure,29,false),
   ('public.lc_onboarding_case_revision','lifecycle_native_effect_capture','app.lifecycle_native_effect_capture()'::regprocedure,29,false),
   ('public.lc_v9_case','lifecycle_native_effect_capture','app.lifecycle_native_effect_capture()'::regprocedure,29,false),
   ('public.lc_v9_case_revision','lifecycle_native_effect_capture','app.lifecycle_native_effect_capture()'::regprocedure,29,false),
   ('public.domain_event','lifecycle_row_transaction_capture','app.lifecycle_row_transaction_capture()'::regprocedure,5,false),
   ('app.lifecycle_native_effect_context','lifecycle_native_effect_cleanup','app.lifecycle_native_effect_cleanup()'::regprocedure,17,true)
 )
 SELECT NOT has_table_privilege('ai_hr_app','app.lifecycle_native_effect_context','SELECT,INSERT,UPDATE,DELETE')
 AND NOT EXISTS (
  SELECT FROM expected e WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   CROSS JOIN pg_class owner_table
   WHERE t.tgrelid=to_regclass(e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.handler
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND owner_table.oid='public.access_capability'::regclass
    AND p.proowner=owner_table.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.lifecycle_assigned_task_bindings_complete() FROM PUBLIC,ai_hr_app;
