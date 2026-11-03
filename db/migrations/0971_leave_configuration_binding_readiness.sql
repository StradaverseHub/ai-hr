-- Leave Type and Grade Group publication retains the exact catalogue, member,
-- deferred reference and cascade checks.
CREATE FUNCTION app.leave_configuration_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,owner_function,trigger_type,deferred) AS (
  VALUES
   ('leave_type','module_catalogue_action','app.module_catalogue_action_guard()'::regprocedure,31,false),
   ('leave_type','module_leave_type_reference_guard','app.module_leave_type_reference_guard()'::regprocedure,17,true),
   ('grade_group','module_grade_group_source','app.module_grade_group_source_record()'::regprocedure,13,false),
   ('grade_group','module_grade_group_action','app.module_catalogue_action_guard()'::regprocedure,31,false),
   ('grade_group','module_grade_group_action_final','app.module_catalogue_action_guard()'::regprocedure,29,true),
   ('grade_group_member','module_grade_group_member','app.module_grade_group_member_guard()'::regprocedure,31,false),
   ('grade_group_member','module_grade_group_member_final','app.module_grade_group_member_guard()'::regprocedure,29,true)
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
 ) AND NOT has_table_privilege('ai_hr_app','app.module_grade_group_source','INSERT,UPDATE,DELETE');
$$;
REVOKE ALL ON FUNCTION app.leave_configuration_bindings_complete() FROM PUBLIC,ai_hr_app;
