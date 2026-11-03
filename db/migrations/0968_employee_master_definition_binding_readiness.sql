-- A saved definition and its schedule keep separate native write guards.
CREATE FUNCTION app.employee_master_definition_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,owner_function,trigger_type) AS (
  VALUES
   ('custom_report','aaa_employee_master_access','app.workforce_write_order_fence()'::regprocedure,30),
   ('custom_report','employee_master_definition_action','app.employee_master_definition_guard()'::regprocedure,31),
   ('custom_report_schedule','aaa_employee_master_schedule_access','app.workforce_write_order_fence()'::regprocedure,30),
   ('custom_report_schedule','employee_master_schedule_action','app.employee_master_schedule_guard()'::regprocedure,31)
 )
 SELECT app.employee_master_view_bindings_complete() AND NOT EXISTS(
  SELECT FROM expected e
  WHERE NOT EXISTS(
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid=to_regclass('public.'||e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.owner_function
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND NOT t.tgdeferrable
    AND c.relrowsecurity AND p.proowner=c.relowner AND p.prosecdef
    AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.employee_master_definition_bindings_complete() FROM PUBLIC,ai_hr_app;
