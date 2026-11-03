CREATE FUNCTION app.onehr_panel_feedback_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,handler,trigger_type) AS (
  VALUES
   ('performance_onehr_panel','z_financial_onehr_feedback_delta_guard','app.financial_onehr_feedback_delta_guard()'::regprocedure,23),
   ('performance_assessment_draft','z_financial_onehr_draft_write_guard','app.financial_onehr_draft_write_guard()'::regprocedure,31)
 )
 SELECT NOT has_table_privilege('ai_hr_app','app.financial_onehr_feedback_effect','SELECT,INSERT,UPDATE,DELETE')
 AND NOT EXISTS (
  SELECT FROM expected e WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid=to_regclass('public.'||e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.handler
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND NOT t.tgdeferrable AND c.relrowsecurity
    AND p.proowner=c.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.onehr_panel_feedback_bindings_complete() FROM PUBLIC,ai_hr_app;
