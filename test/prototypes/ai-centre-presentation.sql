-- DISPOSABLE CI PROTOTYPE ONLY. No migration allocation, installation or GET adoption.
-- Guard complete native predecessors before factoring only pure read projections.
-- Value helpers retain original RC statement freshness (VOLATILE) but contain only SELECT/RETURN;
-- public presentation entry points additionally require an actual RR/RO transaction.
DO $guard$
DECLARE p pg_proc;
BEGIN
 IF current_setting('aihr.ai_presentation_fixture.database',true) IS DISTINCT FROM current_database()
  OR left(current_database(),12) IS DISTINCT FROM 'ai_hr_test_w' THEN RAISE EXCEPTION 'Owned disposable AI presentation fixture required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='app.ai_provider_candidate_view_v1()'::regprocedure;
 IF p.proowner IS DISTINCT FROM 'postgres'::regrole::oid OR p.pronamespace IS DISTINCT FROM 'app'::regnamespace::oid
  OR p.proname IS DISTINCT FROM 'ai_provider_candidate_view_v1' OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR p.proargtypes IS DISTINCT FROM ''::oidvector OR p.pronargs<>0 OR p.pronargdefaults<>0 OR p.proargdefaults IS NOT NULL
  OR p.proargnames IS DISTINCT FROM ARRAY['id','version_token','provider','model','key_last4','provider_options','updated_at']::text[] OR p.proallargtypes IS DISTINCT FROM ARRAY[2950,2950,25,25,25,3802,1184]::oid[]
  OR p.proargmodes IS DISTINCT FROM ARRAY['t','t','t','t','t','t','t']::"char"[] OR p.prorettype IS DISTINCT FROM 'record'::regtype::oid
  OR p.proretset IS DISTINCT FROM true OR p.prokind<>'f' OR p.provariadic<>0 OR p.prosqlbody IS NOT NULL OR p.probin IS NOT NULL OR p.protrftypes IS NOT NULL
  OR p.procost<>100 OR p.prorows<>1000 OR p.prosupport<>0::oid
  OR NOT p.prosecdef OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
  OR cardinality(p.proconfig) IS DISTINCT FROM 1 OR regexp_replace(p.proconfig[1],'\s','','g') IS DISTINCT FROM 'search_path=public,pg_temp'
  OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantor<>p.proowner OR a.grantee NOT IN(p.proowner,'ai_hr_app'::regrole::oid) OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
  OR p.prosrc IS DISTINCT FROM $expected$
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI candidate unavailable';END IF;
 RETURN QUERY SELECT c.id,c.version_token,c.provider,c.model,c.key_last4,c.provider_options,c.updated_at FROM ai_provider_candidate c
 WHERE c.tenant_id=app.current_tenant_id();
END $expected$ THEN
  RAISE EXCEPTION 'AI presentation predecessor ai_provider_candidate_view_v1 differs' USING ERRCODE='55000';
 END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='app.ai_spend_status()'::regprocedure;
 IF p.proowner IS DISTINCT FROM 'postgres'::regrole::oid OR p.pronamespace IS DISTINCT FROM 'app'::regnamespace::oid
  OR p.proname IS DISTINCT FROM 'ai_spend_status' OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR p.proargtypes IS DISTINCT FROM ''::oidvector OR p.pronargs<>0 OR p.pronargdefaults<>0 OR p.proargdefaults IS NOT NULL
  OR p.proargnames IS DISTINCT FROM NULL::text[] OR p.proallargtypes IS DISTINCT FROM NULL::oid[]
  OR p.proargmodes IS DISTINCT FROM NULL::"char"[] OR p.prorettype IS DISTINCT FROM 'jsonb'::regtype::oid
  OR p.proretset IS DISTINCT FROM false OR p.prokind<>'f' OR p.provariadic<>0 OR p.prosqlbody IS NOT NULL OR p.probin IS NOT NULL OR p.protrftypes IS NOT NULL
  OR p.procost<>100 OR p.prorows<>0 OR p.prosupport<>0::oid
  OR NOT p.prosecdef OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
  OR cardinality(p.proconfig) IS DISTINCT FROM 1 OR regexp_replace(p.proconfig[1],'\s','','g') IS DISTINCT FROM 'search_path=public,pg_temp'
  OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantor<>p.proowner OR a.grantee NOT IN(p.proowner,'ai_hr_app'::regrole::oid) OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
  OR p.prosrc IS DISTINCT FROM $expected$
DECLARE result jsonb;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI spend administration unavailable';END IF;
 SELECT jsonb_build_object('currency','USD','unit','nano_usd','semantics','application_inference_allocation','certifiedLiveRoutes',0,
 'reviewedCarrierRecords',((SELECT count(*)::int FROM app.ai_spend_reviewed_carrier_catalog r JOIN app.ai_spend_capability c ON c.digest=r.capability_digest WHERE r.tenant_id=app.current_tenant_id() AND r.reviewed_at<=now() AND r.expires_at>now() AND r.revoked_at IS NULL AND c.verified_at<=now() AND c.expires_at>now() AND c.revoked_at IS NULL AND c.provider='openrouter' AND c.model=r.model AND c.operation=r.operation AND c.source_digest=r.source_digest AND c.max_request_nanos=1)+(SELECT count(*)::int FROM app.ai_spend_reviewed_metered_carrier_catalog r JOIN app.ai_spend_capability c ON c.digest=r.capability_digest WHERE r.tenant_id=app.current_tenant_id() AND r.reviewed_at<=now() AND r.expires_at>now() AND r.revoked_at IS NULL AND c.verified_at<=now() AND c.expires_at>now() AND c.revoked_at IS NULL AND c.provider='openrouter' AND c.model=r.model AND c.operation=r.operation AND c.source_digest=r.source_digest AND c.max_request_nanos::numeric=(r.native_context_tokens::numeric*r.prompt_usd_per_million+r.completion_tokens::numeric*r.completion_usd_per_million)*1000)),
 'liveCapability','not_verified_here',
 'budgets',coalesce((SELECT jsonb_agg(jsonb_build_object('scopeKey',scope_key,'monthlyNanos',monthly_nanos::text,'rootNanos',root_nanos::text) ORDER BY scope_key) FROM app.ai_spend_budget WHERE tenant_id=app.current_tenant_id()),'[]'::jsonb),
 'heldNanos',coalesce((SELECT sum(reserved_nanos)::text FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND state='held'),'0'),
 'confirmedNanos',(SELECT sum(confirmed_nanos)::text FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND confirmed_nanos IS NOT NULL),
 'breached',EXISTS(SELECT 1 FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND state='breach')) INTO result;
 RETURN result;
END $expected$ THEN
  RAISE EXCEPTION 'AI presentation predecessor ai_spend_status differs' USING ERRCODE='55000';
 END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='app.ai_optional_spend_status()'::regprocedure;
 IF p.proowner IS DISTINCT FROM 'postgres'::regrole::oid OR p.pronamespace IS DISTINCT FROM 'app'::regnamespace::oid
  OR p.proname IS DISTINCT FROM 'ai_optional_spend_status' OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR p.proargtypes IS DISTINCT FROM ''::oidvector OR p.pronargs<>0 OR p.pronargdefaults<>0 OR p.proargdefaults IS NOT NULL
  OR p.proargnames IS DISTINCT FROM NULL::text[] OR p.proallargtypes IS DISTINCT FROM NULL::oid[]
  OR p.proargmodes IS DISTINCT FROM NULL::"char"[] OR p.prorettype IS DISTINCT FROM 'jsonb'::regtype::oid
  OR p.proretset IS DISTINCT FROM false OR p.prokind<>'f' OR p.provariadic<>0 OR p.prosqlbody IS NOT NULL OR p.probin IS NOT NULL OR p.protrftypes IS NOT NULL
  OR p.procost<>100 OR p.prorows<>0 OR p.prosupport<>0::oid
  OR NOT p.prosecdef OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
  OR cardinality(p.proconfig) IS DISTINCT FROM 1 OR regexp_replace(p.proconfig[1],'\s','','g') IS DISTINCT FROM 'search_path=public,pg_temp'
  OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantor<>p.proowner OR a.grantee NOT IN(p.proowner,'ai_hr_app'::regrole::oid) OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
  OR p.prosrc IS DISTINCT FROM $expected$
DECLARE status jsonb;
BEGIN
 status:=app.ai_spend_status();
 RETURN status||jsonb_build_object('unpricedUnknownRuns',(SELECT count(*) FROM public.ai_model_run a WHERE a.tenant_id=app.current_tenant_id() AND a.operation<>'probe' AND a.state<>'blocked' AND NOT EXISTS(SELECT 1 FROM app.ai_spend_reservation paid WHERE paid.run_id=a.id)));
END $expected$ THEN
  RAISE EXCEPTION 'AI presentation predecessor ai_optional_spend_status differs' USING ERRCODE='55000';
 END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='app._ai_provider_evaluation_actor_valid()'::regprocedure;
 IF p.proowner IS DISTINCT FROM 'postgres'::regrole::oid OR p.pronamespace IS DISTINCT FROM 'app'::regnamespace::oid
  OR p.proname IS DISTINCT FROM '_ai_provider_evaluation_actor_valid' OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='sql')
  OR p.proargtypes IS DISTINCT FROM ''::oidvector OR p.pronargs<>0 OR p.pronargdefaults<>0 OR p.proargdefaults IS NOT NULL
  OR p.proargnames IS DISTINCT FROM NULL::text[] OR p.proallargtypes IS DISTINCT FROM NULL::oid[]
  OR p.proargmodes IS DISTINCT FROM NULL::"char"[] OR p.prorettype IS DISTINCT FROM 'boolean'::regtype::oid
  OR p.proretset IS DISTINCT FROM false OR p.prokind<>'f' OR p.provariadic<>0 OR p.prosqlbody IS NOT NULL OR p.probin IS NOT NULL OR p.protrftypes IS NOT NULL
  OR p.procost<>100 OR p.prorows<>0 OR p.prosupport<>0::oid
  OR NOT p.prosecdef OR p.proisstrict OR p.proleakproof OR p.provolatile<>'s' OR p.proparallel<>'u'
  OR cardinality(p.proconfig) IS DISTINCT FROM 1 OR regexp_replace(p.proconfig[1],'\s','','g') IS DISTINCT FROM 'search_path=public,pg_temp'
  OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantor<>p.proowner OR a.grantee<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
  OR p.prosrc IS DISTINCT FROM $expected$
 SELECT app.current_tenant_id() IS NOT NULL AND app.current_user_id() IS NOT NULL
 AND current_setting('transaction_isolation')='read committed' AND app.is_group_admin()
 AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app_user u JOIN tenant t ON t.id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL
 AND NOT app.login_blocked(u.id) AND t.status IN('active','trial'))
$expected$ THEN
  RAISE EXCEPTION 'AI presentation predecessor _ai_provider_evaluation_actor_valid differs' USING ERRCODE='55000';
 END IF;
 IF to_regprocedure('app._ai_presentation_actor_valid()') IS NOT NULL THEN RAISE EXCEPTION 'AI presentation name already owned' USING ERRCODE='55000';END IF;
 IF to_regprocedure('app._ai_presentation_candidate_rows()') IS NOT NULL THEN RAISE EXCEPTION 'AI presentation name already owned' USING ERRCODE='55000';END IF;
 IF to_regprocedure('app._ai_presentation_spend_value()') IS NOT NULL THEN RAISE EXCEPTION 'AI presentation name already owned' USING ERRCODE='55000';END IF;
 IF to_regprocedure('app._ai_presentation_optional_spend_value(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'AI presentation name already owned' USING ERRCODE='55000';END IF;
 IF to_regprocedure('app.ai_provider_candidate_presentation_v1()') IS NOT NULL THEN RAISE EXCEPTION 'AI presentation name already owned' USING ERRCODE='55000';END IF;
 IF to_regprocedure('app.ai_optional_spend_presentation_status_v1()') IS NOT NULL THEN RAISE EXCEPTION 'AI presentation name already owned' USING ERRCODE='55000';END IF;
END;
$guard$;

CREATE FUNCTION app._ai_presentation_actor_valid() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $value$
 SELECT app.current_tenant_id() IS NOT NULL AND app.current_user_id() IS NOT NULL
 AND current_setting('transaction_isolation')='repeatable read' AND current_setting('transaction_read_only')='on' AND app.is_group_admin()
 AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app_user u JOIN tenant t ON t.id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL
 AND NOT app.login_blocked(u.id) AND t.status IN('active','trial'))
$value$;
REVOKE ALL ON FUNCTION app._ai_presentation_actor_valid() FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app._ai_presentation_candidate_rows() RETURNS TABLE(id uuid,version_token uuid,provider text,model text,key_last4 text,provider_options jsonb,updated_at timestamptz) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $value$
 SELECT c.id,c.version_token,c.provider,c.model,c.key_last4,c.provider_options,c.updated_at FROM ai_provider_candidate c
 WHERE c.tenant_id=app.current_tenant_id()
$value$;
REVOKE ALL ON FUNCTION app._ai_presentation_candidate_rows() FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app._ai_presentation_spend_value() RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $value$
DECLARE result jsonb;
BEGIN
 SELECT jsonb_build_object('currency','USD','unit','nano_usd','semantics','application_inference_allocation','certifiedLiveRoutes',0,
 'reviewedCarrierRecords',((SELECT count(*)::int FROM app.ai_spend_reviewed_carrier_catalog r JOIN app.ai_spend_capability c ON c.digest=r.capability_digest WHERE r.tenant_id=app.current_tenant_id() AND r.reviewed_at<=now() AND r.expires_at>now() AND r.revoked_at IS NULL AND c.verified_at<=now() AND c.expires_at>now() AND c.revoked_at IS NULL AND c.provider='openrouter' AND c.model=r.model AND c.operation=r.operation AND c.source_digest=r.source_digest AND c.max_request_nanos=1)+(SELECT count(*)::int FROM app.ai_spend_reviewed_metered_carrier_catalog r JOIN app.ai_spend_capability c ON c.digest=r.capability_digest WHERE r.tenant_id=app.current_tenant_id() AND r.reviewed_at<=now() AND r.expires_at>now() AND r.revoked_at IS NULL AND c.verified_at<=now() AND c.expires_at>now() AND c.revoked_at IS NULL AND c.provider='openrouter' AND c.model=r.model AND c.operation=r.operation AND c.source_digest=r.source_digest AND c.max_request_nanos::numeric=(r.native_context_tokens::numeric*r.prompt_usd_per_million+r.completion_tokens::numeric*r.completion_usd_per_million)*1000)),
 'liveCapability','not_verified_here',
 'budgets',coalesce((SELECT jsonb_agg(jsonb_build_object('scopeKey',scope_key,'monthlyNanos',monthly_nanos::text,'rootNanos',root_nanos::text) ORDER BY scope_key) FROM app.ai_spend_budget WHERE tenant_id=app.current_tenant_id()),'[]'::jsonb),
 'heldNanos',coalesce((SELECT sum(reserved_nanos)::text FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND state='held'),'0'),
 'confirmedNanos',(SELECT sum(confirmed_nanos)::text FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND confirmed_nanos IS NOT NULL),
 'breached',EXISTS(SELECT 1 FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND state='breach')) INTO result;
 RETURN result;
END $value$;
REVOKE ALL ON FUNCTION app._ai_presentation_spend_value() FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app._ai_presentation_optional_spend_value(status_value jsonb) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $value$
 SELECT status_value||jsonb_build_object('unpricedUnknownRuns',(SELECT count(*) FROM public.ai_model_run a WHERE a.tenant_id=app.current_tenant_id() AND a.operation<>'probe' AND a.state<>'blocked' AND NOT EXISTS(SELECT 1 FROM app.ai_spend_reservation paid WHERE paid.run_id=a.id)))
$value$;
REVOKE ALL ON FUNCTION app._ai_presentation_optional_spend_value(jsonb) FROM PUBLIC,ai_hr_app;

CREATE OR REPLACE FUNCTION app.ai_provider_candidate_view_v1()
 RETURNS TABLE(id uuid,version_token uuid,provider text,model text,key_last4 text,provider_options jsonb,updated_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $wrapper$
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI candidate unavailable';END IF;
 RETURN QUERY SELECT * FROM app._ai_presentation_candidate_rows();
END $wrapper$;
CREATE OR REPLACE FUNCTION app.ai_spend_status() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $wrapper$
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI spend administration unavailable';END IF;
 RETURN app._ai_presentation_spend_value();
END $wrapper$;
CREATE OR REPLACE FUNCTION app.ai_optional_spend_status() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $wrapper$
DECLARE status jsonb;
BEGIN
 status:=app.ai_spend_status();
 RETURN app._ai_presentation_optional_spend_value(status);
END $wrapper$;

CREATE FUNCTION app.ai_provider_candidate_presentation_v1()
 RETURNS TABLE(id uuid,version_token uuid,provider text,model text,key_last4 text,provider_options jsonb,updated_at timestamptz) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $projection$
BEGIN
 IF app._ai_presentation_actor_valid() IS NOT TRUE THEN RAISE EXCEPTION 'AI candidate unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT * FROM app._ai_presentation_candidate_rows();
END $projection$;
REVOKE ALL ON FUNCTION app.ai_provider_candidate_presentation_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_provider_candidate_presentation_v1() TO ai_hr_app;
CREATE FUNCTION app.ai_optional_spend_presentation_status_v1() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $projection$
BEGIN
 IF app._ai_presentation_actor_valid() IS NOT TRUE THEN RAISE EXCEPTION 'AI spend allocation unavailable' USING ERRCODE='42501';END IF;
 RETURN app._ai_presentation_optional_spend_value(app._ai_presentation_spend_value());
END $projection$;
REVOKE ALL ON FUNCTION app.ai_optional_spend_presentation_status_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_optional_spend_presentation_status_v1() TO ai_hr_app;
