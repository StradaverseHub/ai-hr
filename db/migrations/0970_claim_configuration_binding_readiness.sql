-- Claim maintenance preserves catalogue reads for employees and binds the actual
-- administrative mutations, including deferred dated-band replacement.
CREATE FUNCTION app.claim_configuration_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(relation,trigger_name,owner_function,trigger_type,deferred) AS (
  SELECT name,'module_configuration_action','app.module_configuration_action_guard()'::regprocedure,31,false
  FROM unnest(ARRAY['claim_type','claim_item','claim_policy','claim_mileage_rate','claim_form_field']) AS names(name)
  UNION ALL VALUES
   ('claim_policy','claim_configuration_range_close','app.claim_configuration_range_close()'::regprocedure,17,true),
   ('claim_mileage_rate','claim_configuration_range_close','app.claim_configuration_range_close()'::regprocedure,17,true)
 )
 SELECT NOT EXISTS(
  SELECT FROM expected e
  WHERE NOT EXISTS(
   SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgrelid=to_regclass('public.'||e.relation) AND t.tgname=e.trigger_name AND t.tgfoid=e.owner_function
    AND t.tgtype=e.trigger_type AND t.tgenabled IN ('O','A')
    AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND c.relrowsecurity AND p.proowner=c.relowner AND p.prosecdef
    AND NOT has_function_privilege('ai_hr_app',p.oid,'EXECUTE')
  )
 ) AND NOT has_table_privilege('ai_hr_app','app.module_action_resource','INSERT,UPDATE,DELETE')
   AND NOT has_table_privilege('ai_hr_app','app.module_configuration_insert_receipt','INSERT,UPDATE,DELETE');
$$;
REVOKE ALL ON FUNCTION app.claim_configuration_bindings_complete() FROM PUBLIC,ai_hr_app;
