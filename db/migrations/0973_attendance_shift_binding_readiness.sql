CREATE FUNCTION app.attendance_shift_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,owner_function,trigger_type,deferred) AS (
  VALUES
   ('public.shift','module_shift_access','app.module_configuration_write_lock()'::regprocedure,30,false),
   ('public.shift','module_shift_action','app.attendance_shift_guard()'::regprocedure,31,false),
   ('public.shift_ot_window','module_shift_window_access','app.module_configuration_write_lock()'::regprocedure,30,false),
   ('public.shift_ot_window','module_shift_window_action','app.attendance_shift_window_guard()'::regprocedure,31,false),
   ('public.attendance_rule_shift','module_shift_initial_membership','app.shift_initial_membership_record()'::regprocedure,7,false),
   ('app.shift_constructor_source','module_shift_initial_membership_complete','app.shift_initial_membership_complete()'::regprocedure,17,true),
   ('app.access_control_epoch','shift_constructor_authority_recheck','app.shift_constructor_authority_changed()'::regprocedure,17,false)
 )
 SELECT NOT EXISTS(
  SELECT FROM expected e WHERE NOT EXISTS(
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   JOIN pg_class c ON c.oid='public.access_capability'::regclass
   WHERE t.tgrelid=to_regclass(e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.owner_function
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A')
    AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND p.proowner=c.relowner AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 ) AND NOT has_table_privilege('ai_hr_app','app.shift_constructor_source','INSERT,UPDATE,DELETE');
$$;
REVOKE ALL ON FUNCTION app.attendance_shift_bindings_complete() FROM PUBLIC,ai_hr_app;
