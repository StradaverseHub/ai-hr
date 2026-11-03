-- Reroute authority must remain separate from the assigned approval course.
CREATE FUNCTION app.profile_maintenance_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(trigger_name,owner_function,trigger_type,deferred) AS (
  VALUES
   ('profile_changes_maintenance_lock','app.profile_changes_maintenance_lock()'::regprocedure,18,false),
   ('profile_changes_maintenance_write','app.profile_changes_maintenance_write_guard()'::regprocedure,19,false),
   ('profile_changes_maintenance_final','app.profile_changes_maintenance_write_guard()'::regprocedure,17,true)
 )
 SELECT NOT EXISTS(
  SELECT FROM expected e
  WHERE NOT EXISTS(
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid='public.profile_change_request'::regclass AND t.tgname=e.trigger_name
    AND t.tgfoid=e.owner_function AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A')
    AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND c.relrowsecurity AND p.proowner=c.relowner AND p.prosecdef
    AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.profile_maintenance_bindings_complete() FROM PUBLIC,ai_hr_app;
