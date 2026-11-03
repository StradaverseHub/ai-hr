-- The hierarchy recheck observes updates to an existing epoch.
CREATE OR REPLACE FUNCTION app.leave_own_application_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,handler,trigger_type,deferred) AS (
  VALUES
   ('public.leave_request','module_leave_pending_application','app.leave_pending_application_guard()'::regprocedure,7,false),
   ('public.leave_request','aaa_leave_request_mutation','app.leave_request_mutation_guard()'::regprocedure,19,false),
   ('public.leave_request','aaa_leave_request_access','app.claim_native_source_statement_lock()'::regprocedure,30,false),
   ('app.leave_own_withdraw_effect','leave_own_withdraw_complete','app.leave_own_withdraw_complete()'::regprocedure,17,true),
   ('public.leave_request','leave_own_withdraw_request_recheck','app.leave_own_withdraw_recheck()'::regprocedure,17,false),
   ('public.leave_ledger','leave_own_withdraw_ledger_recheck','app.leave_own_withdraw_recheck()'::regprocedure,29,false),
   ('app.access_control_epoch','leave_own_withdraw_control_recheck','app.leave_own_withdraw_recheck()'::regprocedure,17,false),
   ('app.module_company_hierarchy_epoch','leave_own_withdraw_company_recheck','app.leave_own_withdraw_recheck()'::regprocedure,17,false),
   ('public.employment','leave_own_withdraw_subject_recheck','app.leave_own_withdraw_recheck()'::regprocedure,25,false)
 )
 SELECT NOT has_table_privilege('ai_hr_app','app.leave_own_withdraw_effect','SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('ai_hr_app','public.leave_request','DELETE')
  AND NOT EXISTS (
   SELECT FROM expected e WHERE NOT EXISTS (
    SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
    WHERE t.tgrelid=to_regclass(e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.handler
     AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
     AND p.proowner=c.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
   )
  );
$$;
REVOKE ALL ON FUNCTION app.leave_own_application_bindings_complete() FROM PUBLIC,ai_hr_app;
