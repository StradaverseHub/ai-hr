-- Category View must retain the exact source, audit and live authority checks
-- around the underlying payroll permission grant.
CREATE FUNCTION app.report_category_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,owner_function,trigger_type,deferred) AS (
  VALUES
   ('public.payroll_permission_grant','report_permission_source','app.report_permission_row_guard()'::regprocedure,31,false),
   ('public.payroll_permission_grant','report_permission_born','app.report_permission_row_born()'::regprocedure,29,false),
   ('app.report_permission_mutation','report_permission_complete','app.report_permission_complete()'::regprocedure,17,true),
   ('app.access_control_epoch','report_permission_authority_recheck','app.report_permission_authority_changed()'::regprocedure,17,false),
   ('app.module_company_hierarchy_epoch','report_permission_hierarchy_recheck','app.report_permission_hierarchy_recheck()'::regprocedure,21,false)
 )
 SELECT NOT EXISTS(
  SELECT FROM expected e
  WHERE NOT EXISTS(
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   JOIN pg_class c ON c.oid='public.access_capability'::regclass
   WHERE t.tgrelid=to_regclass(e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.owner_function
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A')
    AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND p.proowner=c.relowner AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.report_category_bindings_complete() FROM PUBLIC,ai_hr_app;
