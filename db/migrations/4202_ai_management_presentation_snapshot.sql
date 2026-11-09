-- AI management displays provider metadata and spend status from one current read-only snapshot.
-- Command and evaluation functions retain their existing read-committed authority.
DO $preimage$
DECLARE expected record; observed pg_proc;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('app.ai_provider_candidate_view_v1()','fbc841dcc882fb47fd029c0266d98a79',true),
  ('app.ai_spend_status()','a823975bb8f40ba340bd0d00b40b61b1',true),
  ('app._ai_provider_evaluation_actor_valid()','7dc7f619cef60de2c0a2515b5df0b074',false)
 ) e(signature,body_hash,app_execute) LOOP
  SELECT * INTO observed FROM pg_catalog.pg_proc WHERE oid=to_regprocedure(expected.signature);
  IF observed.oid IS NULL OR observed.proowner<>current_user::regrole OR NOT observed.prosecdef
   OR md5(observed.prosrc) IS DISTINCT FROM expected.body_hash
   OR (SELECT count(*) FROM aclexplode(coalesce(observed.proacl,acldefault('f',observed.proowner))))<>CASE WHEN expected.app_execute THEN 2 ELSE 1 END
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(observed.proacl,acldefault('f',observed.proowner))) a
     WHERE a.grantor<>observed.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable
      OR NOT (a.grantee=observed.proowner OR (expected.app_execute AND a.grantee='ai_hr_app'::regrole)))
  THEN RAISE EXCEPTION 'Unexpected AI management presentation predecessor: %',expected.signature USING ERRCODE='55000'; END IF;
 END LOOP;
END $preimage$;
--> statement-breakpoint
CREATE FUNCTION app._ai_provider_presentation_actor_valid() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT session_user='ai_hr_app' AND nullif(current_setting('app.agent_principal_id',true),'') IS NULL
 AND app.current_tenant_id() IS NOT NULL AND app.current_user_id() IS NOT NULL
 AND current_setting('transaction_isolation')='repeatable read' AND current_setting('transaction_read_only')='on' AND app.is_group_admin()
 AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app_user u JOIN tenant t ON t.id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL
 AND NOT app.login_blocked(u.id) AND t.status IN('active','trial'))
$$;
REVOKE ALL ON FUNCTION app._ai_provider_presentation_actor_valid() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_provider_candidate_view_v1()
 RETURNS TABLE(id uuid,version_token uuid,provider text,model text,key_last4 text,provider_options jsonb,updated_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF (app._ai_provider_evaluation_actor_valid() OR app._ai_provider_presentation_actor_valid()) IS NOT TRUE THEN RAISE EXCEPTION 'AI candidate unavailable';END IF;
 RETURN QUERY SELECT c.id,c.version_token,c.provider,c.model,c.key_last4,c.provider_options,c.updated_at FROM ai_provider_candidate c
 WHERE c.tenant_id=app.current_tenant_id();
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_spend_status() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF (app._ai_provider_evaluation_actor_valid() OR app._ai_provider_presentation_actor_valid()) IS NOT TRUE THEN RAISE EXCEPTION 'AI spend administration unavailable';END IF;
 SELECT jsonb_build_object('currency','USD','unit','nano_usd','semantics','application_inference_allocation','certifiedLiveRoutes',0,
 'reviewedCarrierRecords',((SELECT count(*)::int FROM app.ai_spend_reviewed_carrier_catalog r JOIN app.ai_spend_capability c ON c.digest=r.capability_digest WHERE r.tenant_id=app.current_tenant_id() AND r.reviewed_at<=now() AND r.expires_at>now() AND r.revoked_at IS NULL AND c.verified_at<=now() AND c.expires_at>now() AND c.revoked_at IS NULL AND c.provider='openrouter' AND c.model=r.model AND c.operation=r.operation AND c.source_digest=r.source_digest AND c.max_request_nanos=1)+(SELECT count(*)::int FROM app.ai_spend_reviewed_metered_carrier_catalog r JOIN app.ai_spend_capability c ON c.digest=r.capability_digest WHERE r.tenant_id=app.current_tenant_id() AND r.reviewed_at<=now() AND r.expires_at>now() AND r.revoked_at IS NULL AND c.verified_at<=now() AND c.expires_at>now() AND c.revoked_at IS NULL AND c.provider='openrouter' AND c.model=r.model AND c.operation=r.operation AND c.source_digest=r.source_digest AND c.max_request_nanos::numeric=(r.native_context_tokens::numeric*r.prompt_usd_per_million+r.completion_tokens::numeric*r.completion_usd_per_million)*1000)),
 'liveCapability','not_verified_here',
 'budgets',coalesce((SELECT jsonb_agg(jsonb_build_object('scopeKey',scope_key,'monthlyNanos',monthly_nanos::text,'rootNanos',root_nanos::text) ORDER BY scope_key) FROM app.ai_spend_budget WHERE tenant_id=app.current_tenant_id()),'[]'::jsonb),
 'heldNanos',coalesce((SELECT sum(reserved_nanos)::text FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND state='held'),'0'),
 'confirmedNanos',(SELECT sum(confirmed_nanos)::text FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND confirmed_nanos IS NOT NULL),
 'breached',EXISTS(SELECT 1 FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND state='breach')) INTO result;
 RETURN result;
END $$;
