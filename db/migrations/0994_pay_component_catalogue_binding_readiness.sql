CREATE FUNCTION app.pay_component_catalogue_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,handler,trigger_type,deferred) AS (
  SELECT 'public.'||relation,'financial_setup_action','app.financial_setup_write_guard()'::regprocedure,29,true
  FROM unnest(ARRAY['pay_component','payroll_import_code','pay_formula','pay_formula_revision',
    'pay_formula_event','pay_formula_accumulation','pay_formula_test']) e(relation)
  UNION ALL VALUES
   ('public.pay_component','a00_financial_catalog_lock','app.financial_catalog_statement_lock()'::regprocedure,30,false),
   ('public.pay_component','financial_catalog_source','app.financial_catalog_capture()'::regprocedure,29,false),
   ('public.domain_event','financial_catalog_event','app.financial_catalog_capture_event()'::regprocedure,5,false),
   ('app.financial_catalog_rank_effect','financial_catalog_rank_complete','app.financial_catalog_rank_complete()'::regprocedure,5,true)
 )
 SELECT NOT EXISTS (
  SELECT FROM expected e WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   CROSS JOIN pg_class owner_table
   WHERE t.tgrelid=to_regclass(e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.handler
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND owner_table.oid='public.access_capability'::regclass
    AND p.proowner=owner_table.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 ) AND NOT EXISTS (
  SELECT FROM unnest(ARRAY['pay_formula','pay_formula_revision','pay_formula_event','pay_formula_accumulation']) e(relation)
  WHERE NOT EXISTS (
   SELECT FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
   WHERE p.polrelid=to_regclass('public.'||e.relation) AND p.polname='formula_read' AND p.polcmd='r' AND c.relrowsecurity
    AND EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.objid=p.oid
     AND d.refclassid='pg_proc'::regclass AND d.refobjid='app.pay_formula_catalog_access()'::regprocedure)
  )
 );
$$;
REVOKE ALL ON FUNCTION app.pay_component_catalogue_bindings_complete() FROM PUBLIC,ai_hr_app;
