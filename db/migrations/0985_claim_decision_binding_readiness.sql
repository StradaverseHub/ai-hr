CREATE FUNCTION app.claim_decision_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,handler,trigger_type,deferred) AS (
  VALUES
   ('public.claim_request','claim_command','app.claim_command_guard()'::regprocedure,23,false),
   ('public.claim_request','claim_command_final','app.claim_command_guard()'::regprocedure,21,true),
   ('public.claim_request','claim_command_born','app.claim_command_born()'::regprocedure,21,false),
   ('public.claim_request','claim_command_source_lock','app.claim_command_statement_lock()'::regprocedure,22,false),
   ('public.claim_request','claim_delegate_write_guard','app.claim_delegated_decision_write_guard()'::regprocedure,19,false),
   ('app.claim_command_effect','claim_command_effect_complete','app.claim_command_effect_complete()'::regprocedure,21,true)
 )
 SELECT NOT has_table_privilege('ai_hr_app','app.claim_command_effect','SELECT,INSERT,UPDATE,DELETE')
 AND NOT EXISTS (
  SELECT FROM expected e WHERE NOT EXISTS (
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   CROSS JOIN pg_class owner_table
   WHERE t.tgrelid=to_regclass(e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.handler
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A') AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND owner_table.oid='public.access_capability'::regclass
    AND p.proowner=owner_table.relowner AND p.prosecdef AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 ) AND EXISTS (
  SELECT FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
  WHERE p.polrelid='public.claim_request'::regclass AND p.polname='claim_assigned_command'
   AND p.polcmd='w' AND c.relrowsecurity AND p.polroles=ARRAY['ai_hr_app'::regrole::oid]
   AND EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.objid=p.oid
    AND d.refclassid='pg_proc'::regclass AND d.refobjid='app.claim_assigned_current(uuid)'::regprocedure)
 );
$$;
REVOKE ALL ON FUNCTION app.claim_decision_bindings_complete() FROM PUBLIC,ai_hr_app;
