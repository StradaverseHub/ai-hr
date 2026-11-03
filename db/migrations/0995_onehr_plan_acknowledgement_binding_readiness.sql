CREATE FUNCTION app.onehr_plan_acknowledgement_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS (
  SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
  WHERE t.tgrelid='public.performance_onehr_plan'::regclass
   AND t.tgname='z_financial_onehr_plan_acknowledgement_guard'
   AND t.tgfoid='app.financial_onehr_plan_acknowledgement_guard()'::regprocedure
   AND t.tgtype=23 AND t.tgenabled IN ('O','A') AND NOT t.tgdeferrable AND c.relrowsecurity
   AND p.proowner=c.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
 ) AND NOT has_table_privilege('ai_hr_app','app.financial_onehr_plan_effect','SELECT,INSERT,UPDATE,DELETE');
$$;
REVOKE ALL ON FUNCTION app.onehr_plan_acknowledgement_bindings_complete() FROM PUBLIC,ai_hr_app;
