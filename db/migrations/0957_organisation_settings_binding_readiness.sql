-- Verify installed enforcement for the Organisation Settings package before exposing its actions.
CREATE FUNCTION app.organisation_settings_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH row_guards(relation_name,after_write) AS (
  SELECT name,name IN ('profile_option','ai_provider_config')
  FROM unnest(ARRAY['company','department','position','cost_center','business_unit','job_grade',
   'profile_option','employee_id_config','people_general_policy','label_company_assignment','company_logo',
   'dashboard_card_config','login_presentation','session_policy','tenant_setting','email_design',
   'email_design_version','email_asset','notification_email_policy','ai_provider_config','entra_connector',
   'test_case','test_case_version','test_assignment','test_catalogue_update']) AS names(name)
 ), expected_triggers(relation_name,trigger_name,trigger_type,owner_function) AS (
  SELECT relation_name,'organisation_settings_action',CASE WHEN after_write THEN 29 ELSE 31 END,
   'app.organisation_settings_write_guard()'::regprocedure FROM row_guards
  UNION ALL VALUES
   ('ai_provider_candidate','ai_configuration_native_write_guard',29,'app.ai_configuration_native_write_guard()'::regprocedure),
   ('ai_provider_protocol_evaluation','ai_configuration_native_write_guard',29,'app.ai_configuration_native_write_guard()'::regprocedure),
   ('ai_provider_protocol_evaluation','ai_configuration_protocol_authority',21,'app.ai_configuration_evaluation_authority_guard()'::regprocedure),
   ('employee_home_configuration_revision','organisation_settings_upsert_lock',6,'app.organisation_settings_upsert_lock()'::regprocedure)
 ), expected_policies(relation_name,policy_name,command,permissive) AS (
  VALUES
   ('employee_home_configuration_revision','employee_home_configuration_read','r',true),
   ('employee_home_configuration_revision','employee_home_configuration_insert','a',true),
   ('test_case','settings_test_case_read','r',false),
   ('test_case_version','settings_test_version_read','r',false),
   ('test_assignment','settings_test_assignment_read','r',false),
   ('test_catalogue_update','settings_test_catalogue_read','r',false),
   ('test_execution','settings_testing_execution_read','r',false),
   ('test_run','settings_testing_run_read','r',false),
   ('test_execution_attachment','settings_testing_attachment_read','r',false),
   ('test_run','settings_testing_run_insert','a',false),
   ('test_run','settings_testing_run_update','w',false)
 )
 SELECT NOT EXISTS (
  SELECT FROM expected_triggers e
  WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   JOIN pg_class c ON c.oid='public.access_capability'::regclass
   WHERE t.tgrelid=to_regclass('public.'||e.relation_name) AND t.tgname=e.trigger_name
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND t.tgfoid=e.owner_function
    AND p.proowner=c.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 ) AND NOT EXISTS (
  SELECT FROM expected_policies e
  WHERE NOT EXISTS (
   SELECT FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
   WHERE p.polrelid=to_regclass('public.'||e.relation_name) AND p.polname=e.policy_name
    AND p.polcmd::text=e.command AND p.polpermissive=e.permissive AND c.relrowsecurity
    AND (p.polqual IS NOT NULL OR p.polwithcheck IS NOT NULL)
  )
 );
$$;
REVOKE ALL ON FUNCTION app.organisation_settings_bindings_complete() FROM PUBLIC,ai_hr_app;
