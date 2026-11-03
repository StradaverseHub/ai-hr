CREATE FUNCTION app.claim_own_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,handler,trigger_type,deferred) AS (
  VALUES
   ('public.claim_request','claim_own_request','app.claim_own_request_guard()'::regprocedure,31,false),
   ('public.claim_request','claim_own_request_final','app.claim_own_request_guard()'::regprocedure,29,true),
   ('public.claim_request','claim_payment_and_cancel_guard','app.claim_payment_and_cancel_guard()'::regprocedure,21,true),
   ('public.claim_request','module_claim_write_lock','app.module_configuration_write_lock()'::regprocedure,30,false),
   ('public.claim_attachment','claim_own_receipt','app.claim_own_receipt_guard()'::regprocedure,31,false),
   ('public.claim_attachment','claim_own_receipt_final','app.claim_own_receipt_guard()'::regprocedure,29,true),
   ('app.claim_draft_delete_effect','claim_draft_delete_complete','app.claim_draft_delete_complete()'::regprocedure,21,true),
   ('app.claim_own_receipt_effect','claim_receipt_effect_complete','app.claim_receipt_effect_complete()'::regprocedure,21,true),
   ('app.module_claim_effect','claim_native_effect_complete','app.claim_native_effect_complete()'::regprocedure,21,true)
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
 ) AND EXISTS (
  SELECT FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
  WHERE p.polrelid='public.claim_request'::regclass AND p.polname='claim_own_action_read'
   AND p.polcmd='r' AND NOT p.polpermissive AND c.relrowsecurity
   AND p.polroles=ARRAY['ai_hr_app'::regrole::oid]
   AND EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.objid=p.oid
    AND d.refclassid='pg_proc'::regclass AND d.refobjid='app.claim_own_read_allowed(uuid,boolean)'::regprocedure)
 );
$$;
REVOKE ALL ON FUNCTION app.claim_own_bindings_complete() FROM PUBLIC,ai_hr_app;
