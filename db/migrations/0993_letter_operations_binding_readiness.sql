CREATE FUNCTION app.letter_operations_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,handler,trigger_type,deferred) AS (
  SELECT 'public.'||relation,'financial_letter_action_write','app.access_letter_write_guard()'::regprocedure,31,false
  FROM unnest(ARRAY['letter_capability_grant','letter_asset','letter_policy_version','letter_merge_field_version',
   'letter_automation_rule_version','letter_template','letter_template_version','letter_template_field',
   'letter_generation_batch','letter_record','letter_revision','letter_approval_decision','letter_artifact']) e(relation)
  UNION ALL VALUES
   ('public.letter_job','financial_letter_job_action','app.access_letter_job_action_guard()'::regprocedure,29,true),
   ('public.letter_counter','financial_letter_counter_action','app.access_letter_counter_action_guard()'::regprocedure,23,false),
   ('public.letter_recipient_event','financial_letter_recipient_function','app.access_letter_recipient_function_guard()'::regprocedure,7,false),
   ('public.letter_access_token','financial_letter_recipient_function','app.access_letter_recipient_function_guard()'::regprocedure,7,false),
   ('public.letter_recipient_event','financial_letter_recipient_function_final','app.access_letter_recipient_function_guard()'::regprocedure,5,true),
   ('public.letter_access_token','financial_letter_recipient_function_final','app.access_letter_recipient_function_guard()'::regprocedure,5,true),
   ('app.financial_letter_proposed_birth','financial_letter_proposed_birth_complete','app.financial_letter_proposed_birth_validate()'::regprocedure,5,true)
 ), reads(relation,policy_name,handler) AS (
  VALUES
   ('public.letter_record','financial_letter_function_read','app.letter_function_action(text,text,uuid)'::regprocedure),
   ('public.letter_asset','financial_letter_signature_read','app.letter_function_action(text,text,uuid)'::regprocedure),
   ('public.letter_access_token','financial_letter_token_read','app.letter_recipient_function_action(text)'::regprocedure)
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
  SELECT FROM reads e WHERE NOT EXISTS (
   SELECT FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
   WHERE p.polrelid=to_regclass(e.relation) AND p.polname=e.policy_name
    AND p.polcmd='r' AND NOT p.polpermissive AND c.relrowsecurity
    AND EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.objid=p.oid
     AND d.refclassid='pg_proc'::regclass AND d.refobjid=e.handler)
  )
 );
$$;
REVOKE ALL ON FUNCTION app.letter_operations_bindings_complete() FROM PUBLIC,ai_hr_app;
