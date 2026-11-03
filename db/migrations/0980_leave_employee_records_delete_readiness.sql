CREATE FUNCTION app.leave_employee_records_delete_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,handler,trigger_type) AS (
  VALUES
   ('leave_request','aaa_leave_request_access','app.claim_native_source_statement_lock()'::regprocedure,30),
   ('leave_request','aaa_leave_request_mutation','app.leave_request_mutation_guard()'::regprocedure,19),
   ('leave_request','aaa_leave_approved_cancellation','app.leave_approved_cancellation_guard()'::regprocedure,19),
   ('leave_cancellation_request','aaa_leave_give_back_request_identity','app.leave_give_back_request_identity_guard()'::regprocedure,23)
 )
 SELECT NOT has_table_privilege('ai_hr_app','public.leave_request','DELETE')
 AND NOT EXISTS (
  SELECT FROM expected e WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid=to_regclass('public.'||e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.handler
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND NOT t.tgdeferrable
    AND p.proowner=c.relowner AND p.prosecdef AND c.relrowsecurity
    AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.leave_employee_records_delete_bindings_complete() FROM PUBLIC,ai_hr_app;
