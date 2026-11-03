-- Check the physical controls for Work Schedule catalogue and dated child rows.
CREATE FUNCTION app.attendance_schedule_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,owner_function,trigger_type,deferred) AS (
  SELECT name,'module_attendance_rule_guard','app.module_attendance_rule_guard()'::regprocedure,29,true
  FROM unnest(ARRAY['attendance_rule','attendance_rule_ot_row','attendance_rule_shift','attendance_rotation','attendance_exception_revision']) AS names(name)
  UNION ALL
  SELECT name,'module_configuration_write_lock','app.module_configuration_write_lock()'::regprocedure,30,false
  FROM unnest(ARRAY['attendance_rule','attendance_rule_ot_row','attendance_rule_shift','attendance_rotation','attendance_exception_revision']) AS names(name)
  UNION ALL VALUES ('attendance_rule','module_attendance_delete_floor','app.module_attendance_delete_floor()'::regprocedure,11,false)
 )
 SELECT NOT EXISTS(
  SELECT FROM expected e
  WHERE NOT EXISTS(
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid=to_regclass('public.'||e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.owner_function
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A')
    AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND c.relrowsecurity AND p.proowner=c.relowner AND p.prosecdef
    AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.attendance_schedule_bindings_complete() FROM PUBLIC,ai_hr_app;
