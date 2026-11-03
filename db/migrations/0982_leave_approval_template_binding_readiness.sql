CREATE FUNCTION app.leave_approval_template_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT count(*)=2
 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
 WHERE t.tgrelid='public.leave_approval_template'::regclass
  AND (t.tgname,t.tgfoid,t.tgtype) IN (
   ('module_leave_approval_template_action','app.leave_approval_template_guard()'::regprocedure,31),
   ('module_leave_approval_template_lock','app.module_configuration_write_lock()'::regprocedure,30)
  )
  AND t.tgenabled IN ('O','A') AND NOT t.tgdeferrable AND c.relrowsecurity
  AND p.proowner=c.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE');
$$;
REVOKE ALL ON FUNCTION app.leave_approval_template_bindings_complete() FROM PUBLIC,ai_hr_app;
