-- OneHR setup revisions have no application Delete course.
REVOKE DELETE ON public.performance_onehr_cycle FROM ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.performance_cycle_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,handler,trigger_type,deferred) AS (
  VALUES
   ('review_cycle','z_financial_performance_cycle_guard','app.financial_performance_cycle_guard()'::regprocedure,31,false),
   ('performance_onehr_cycle','financial_onehr_setup_guard','app.financial_onehr_setup_guard()'::regprocedure,23,false),
   ('compensation','financial_action_write','app.access_financial_write_guard()'::regprocedure,29,true),
   ('compensation','financial_compensation_birth','app.financial_compensation_birth()'::regprocedure,21,false)
 )
 SELECT NOT has_table_privilege('ai_hr_app','public.performance_onehr_cycle','DELETE')
 AND NOT EXISTS (
  SELECT FROM expected e WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid=to_regclass('public.'||e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.handler
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND p.proowner=c.relowner AND p.prosecdef AND c.relrowsecurity AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.performance_cycle_bindings_complete() FROM PUBLIC,ai_hr_app;
