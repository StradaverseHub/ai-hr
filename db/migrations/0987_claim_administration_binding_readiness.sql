CREATE FUNCTION app.claim_administration_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT app.claim_own_bindings_complete() AND app.claim_decision_bindings_complete()
 AND EXISTS (
  SELECT FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
  WHERE p.polrelid='public.claim_attachment'::regclass AND p.polname='claim_own_receipt_read'
   AND p.polcmd='r' AND NOT p.polpermissive AND c.relrowsecurity
   AND p.polroles=ARRAY['ai_hr_app'::regrole::oid]
   AND EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.objid=p.oid
    AND d.refclassid='pg_proc'::regclass AND d.refobjid='app.claim_own_receipt_read_allowed(uuid,uuid)'::regprocedure)
 )
 AND NOT EXISTS (
  SELECT FROM (VALUES('app.module_claim_effect'),('app.claim_own_receipt_effect')) AS proof(relation)
  WHERE has_table_privilege('ai_hr_app',proof.relation,'SELECT,INSERT,UPDATE,DELETE')
 );
$$;
REVOKE ALL ON FUNCTION app.claim_administration_bindings_complete() FROM PUBLIC,ai_hr_app;
