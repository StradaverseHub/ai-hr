-- Keep the native storage and typed record writers behind the Workforce screen actions.
CREATE FUNCTION app.workforce_records_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,owner_function,trigger_type,deferred) AS (
  VALUES
   ('employment','app.access_workforce_employment_action_guard()'::regprocedure,27,false),
   ('employment','app.access_workforce_lifecycle_update()'::regprocedure,19,false),
   ('employment','app.access_workforce_service_info_update()'::regprocedure,19,false),
   ('person','app.access_profile_value_guard()'::regprocedure,21,true),
   ('employee_dependent','app.access_profile_value_guard()'::regprocedure,29,true),
   ('employee_qualification','app.access_profile_value_guard()'::regprocedure,29,true),
   ('person_emergency_contact','app.access_profile_value_guard()'::regprocedure,29,true)
 )
 SELECT NOT EXISTS(
  SELECT FROM expected e
  WHERE NOT EXISTS(
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid=to_regclass('public.'||e.relation) AND t.tgfoid=e.owner_function
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A')
    AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND p.proowner=c.relowner AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.workforce_records_bindings_complete() FROM PUBLIC,ai_hr_app;
