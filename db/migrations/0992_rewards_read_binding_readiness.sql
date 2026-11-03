CREATE FUNCTION app.rewards_configuration_current_legacy_allowed(t uuid,u uuid,cap text,co uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT t=app.current_tenant_id() AND u=app.current_user_id() AND app.principal_snapshot_current()
 AND cap='rewards.view' AND app.lifecycle_reward_notice_legacy_allowed(t,u,cap,co)
 AND CASE WHEN co IS NULL THEN app.is_group_admin() ELSE app.reward_admin(co) END;
$$;
REVOKE ALL ON FUNCTION app.rewards_configuration_current_legacy_allowed(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.rewards_read_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH expected(signature,runtime_execute) AS (
  VALUES
   ('app.reward_annual_calculation(uuid,integer)',true),
   ('app.reward_offcycle_calculation(uuid,integer)',true),
   ('app.reward_unit_verification_counts(uuid)',true),
   ('app.reward_senior_membership_metadata(uuid)',true),
   ('app.reward_senior_evidence_read(uuid,uuid)',true),
   ('app.reward_governance_review(uuid)',true),
   ('app.reward_configuration_review(uuid)',true),
   ('app.reward_calc_annual_unit(uuid,integer)',false),
   ('app.reward_calc_projection(jsonb,jsonb,text[],uuid,jsonb)',false)
 )
 SELECT NOT EXISTS (
  SELECT FROM expected e WHERE NOT EXISTS (
   SELECT FROM pg_proc p CROSS JOIN pg_class owner_table
   WHERE p.oid=to_regprocedure(e.signature) AND owner_table.oid='public.access_capability'::regclass
    AND p.proowner=owner_table.relowner AND p.provolatile IN ('s','i')
    AND has_function_privilege('ai_hr_app',p.oid,'EXECUTE')=e.runtime_execute
    AND (NOT e.runtime_execute OR p.prosecdef AND p.provolatile='s')
  )
 );
$$;
REVOKE ALL ON FUNCTION app.rewards_read_bindings_complete() FROM PUBLIC,ai_hr_app;
