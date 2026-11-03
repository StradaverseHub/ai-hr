CREATE FUNCTION app.attendance_schedule_controls_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,owner_function,trigger_type) AS (
  VALUES
   ('attendance_rotation','module_rotation_access','app.module_configuration_write_lock()'::regprocedure,6),
   ('attendance_rotation','aaa_module_rotation_action','app.attendance_rotation_action_guard()'::regprocedure,7),
   ('attendance_rule','aaa_schedule_duty_action','app.attendance_schedule_control_guard()'::regprocedure,23),
   ('attendance_exception_revision','aaa_schedule_exception_action','app.attendance_schedule_control_guard()'::regprocedure,7),
   ('attendance_exception_revision','module_schedule_exception_access','app.module_configuration_write_lock()'::regprocedure,6)
 )
 SELECT app.attendance_schedule_bindings_complete() AND NOT EXISTS(
  SELECT FROM expected e WHERE NOT EXISTS(
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid=to_regclass('public.'||e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.owner_function
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND NOT t.tgdeferrable
    AND c.relrowsecurity AND p.proowner=c.relowner AND p.prosecdef
    AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.attendance_schedule_controls_bindings_complete() FROM PUBLIC,ai_hr_app;
