CREATE FUNCTION app.clocking_site_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,owner_function,trigger_type) AS (
  VALUES
   ('clocking_location','module_clocking_site_access','app.clocking_site_write_admission()'::regprocedure,30),
   ('clocking_location','module_clocking_site_action','app.clocking_site_guard()'::regprocedure,31),
   ('clocking_location','module_clocking_site_born','app.clocking_site_born()'::regprocedure,5),
   ('clocking_location_company','module_clocking_site_company_access','app.module_configuration_write_lock()'::regprocedure,30),
   ('clocking_location_company','module_clocking_site_company_action','app.clocking_site_company_guard()'::regprocedure,31)
 )
 SELECT NOT EXISTS(
  SELECT FROM expected e WHERE NOT EXISTS(
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid=to_regclass('public.'||e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.owner_function
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND NOT t.tgdeferrable
    AND c.relrowsecurity AND p.proowner=c.relowner AND p.prosecdef
    AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.clocking_site_bindings_complete() FROM PUBLIC,ai_hr_app;
