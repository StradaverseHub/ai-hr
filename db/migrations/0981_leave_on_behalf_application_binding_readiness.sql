CREATE FUNCTION app.leave_on_behalf_application_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT count(*)=2
 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
 WHERE t.tgrelid='public.leave_request'::regclass
  AND (t.tgname,t.tgfoid,t.tgtype) IN (
   ('module_leave_pending_application','app.leave_pending_application_guard()'::regprocedure,7),
   ('aaa_leave_request_access','app.claim_native_source_statement_lock()'::regprocedure,30)
  )
  AND t.tgenabled IN ('O','A') AND NOT t.tgdeferrable AND c.relrowsecurity
  AND p.proowner=c.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE');
$$;
REVOKE ALL ON FUNCTION app.leave_on_behalf_application_bindings_complete() FROM PUBLIC,ai_hr_app;
