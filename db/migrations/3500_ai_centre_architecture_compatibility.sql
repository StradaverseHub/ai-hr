-- Append-only reconciliation after the complete 709 + 36 journal prefix.
-- Drizzle applies the pending batch atomically. Preserve every predecessor SQL byte.
-- Pin the actual final pending catalogue, then restore the installed centre wrappers.
DO $guard$
DECLARE expected record;p pg_proc;control_owner oid;
BEGIN
 SELECT proowner INTO control_owner FROM pg_proc WHERE oid=to_regprocedure('app.ai_centre_assert_running(integer)');
 IF control_owner IS NULL OR control_owner IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid=to_regclass('public.teras_mandate_control')) THEN
  RAISE EXCEPTION 'Unexpected AI Centre compatibility owner' USING ERRCODE='55000';END IF;
 FOR expected IN SELECT * FROM (VALUES
  ('app._ai_control_context(text,boolean)','a9ea819594d4adbde182910b573287da','plpgsql','search_path=public, pg_temp',0,'wanted_feature text, forced_pause boolean','TABLE(company_ids uuid[], feature_paused boolean)',false,true,'v'),
  ('app._ai_control_context_before_centre(text,boolean)','0d00bc269a9b69d02a8b42d70eba8cce','plpgsql','search_path=public, pg_temp',0,'wanted_feature text, forced_pause boolean','TABLE(company_ids uuid[], feature_paused boolean)',false,true,'v'),
  ('app._ai_control_context_for_purpose(text,boolean,boolean)','5b8e33e202929d3bf676aa5ede19c60b','plpgsql','search_path=public, pg_temp',0,'wanted_feature text, forced_pause boolean, pause_only boolean','TABLE(company_ids uuid[], feature_paused boolean)',false,true,'v'),
  ('app.ai_action_unpaused(text,boolean)','ea9ffc3c72ab52761f6a2786aa2be521','plpgsql','search_path=public, pg_temp',1,'wanted_feature text, forced_pause boolean DEFAULT false','boolean',true,true,'v'),
  ('app.ai_agent_action_unpaused(text)','4e4a28ce82612c9d3ef3531e58a92202','plpgsql','search_path=public, pg_temp',0,'wanted_action text','boolean',true,true,'v'),
  ('app.ai_agent_action_unpaused_before_centre(text)','96a2c89c92efcad817c0777a0cd8ad83','plpgsql','search_path=public, pg_temp',0,'wanted_action text','boolean',false,true,'v'),
  ('app.ai_centre_assert_running(integer)','8d360ee91d6f16d1633a7378afcb20f0','plpgsql','search_path=pg_catalog, public, pg_temp',1,'expected_generation integer DEFAULT NULL::integer','integer',true,true,'v'),
  ('app.ai_centre_control_lock()','5cb40550d7a210ee0a4c27a4fb3923c9','plpgsql','search_path=pg_catalog, public, pg_temp',0,'','trigger',false,false,'v'),
  ('app.ai_centre_control_state()','2245b81060d6103fb00a9447b862f478','plpgsql','search_path=pg_catalog, public, pg_temp',0,'','TABLE(stopped boolean, generation integer, pending integer)',true,true,'v'),
  ('app.ai_centre_read_allowed(text)','11ca5bb7b301da7adab9ae9248ada711','plpgsql','search_path=pg_catalog, public, pg_temp',0,'wanted_key text','boolean',true,true,'v'),
  ('app.ai_centre_read_controls()','5be5915f1add0b6793cab275f00a0a49','sql','search_path=pg_catalog, public, pg_temp',0,'','TABLE(function_key text, enabled boolean)',true,true,'s')
 ) AS e(signature,body_hash,language,configuration,defaults,arguments,result,app_execute,definer,volatility)
 LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(expected.signature);
  IF p.oid IS NULL OR md5(p.prosrc) IS DISTINCT FROM expected.body_hash
   OR p.proowner<>control_owner OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname=expected.language)
   OR p.prokind<>'f' OR p.prosecdef IS DISTINCT FROM expected.definer OR p.proisstrict OR p.proleakproof
   OR p.provolatile::text<>expected.volatility OR p.proparallel<>'u'
   OR p.proconfig IS DISTINCT FROM ARRAY[expected.configuration] OR p.pronargdefaults<>expected.defaults
   OR pg_get_function_arguments(p.oid) IS DISTINCT FROM expected.arguments OR pg_get_function_result(p.oid) IS DISTINCT FROM expected.result
   OR has_function_privilege('ai_hr_app',p.oid,'EXECUTE') IS DISTINCT FROM expected.app_execute
   OR (SELECT count(*) FROM pg_proc q WHERE q.pronamespace=p.pronamespace AND q.proname=p.proname)<>1
   OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>(CASE WHEN expected.app_execute THEN 2 ELSE 1 END)
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantor<>p.proowner OR a.is_grantable OR a.privilege_type<>'EXECUTE'
     OR (a.grantee<>p.proowner AND (NOT expected.app_execute OR a.grantee<>'ai_hr_app'::regrole)))
  THEN RAISE EXCEPTION 'Unexpected AI Centre compatibility predecessor: %',expected.signature USING ERRCODE='55000';END IF;
 END LOOP;
END $guard$;
--> statement-breakpoint
-- Transaction-private custody of OIDs, ABI, owner, ACL and untouched definitions.
CREATE TEMP TABLE pg_temp.ai_centre_compatibility_preimage ON COMMIT DROP AS
 SELECT p.oid,p.oid::regprocedure::text AS signature,p.prosrc,p.proconfig,
  to_jsonb(p)-'prosrc'-'proconfig' AS attributes,pg_get_functiondef(p.oid) AS definition
 FROM pg_proc p WHERE p.oid=ANY(ARRAY[
  'app._ai_control_context(text,boolean)'::regprocedure,'app._ai_control_context_before_centre(text,boolean)'::regprocedure,
  'app._ai_control_context_for_purpose(text,boolean,boolean)'::regprocedure,'app.ai_action_unpaused(text,boolean)'::regprocedure,
  'app.ai_agent_action_unpaused(text)'::regprocedure,'app.ai_agent_action_unpaused_before_centre(text)'::regprocedure,
  'app.ai_centre_assert_running(integer)'::regprocedure,'app.ai_centre_control_lock()'::regprocedure,
  'app.ai_centre_control_state()'::regprocedure,'app.ai_centre_read_allowed(text)'::regprocedure,'app.ai_centre_read_controls()'::regprocedure]::oid[]);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app._ai_control_context_for_purpose(wanted_feature text,forced_pause boolean,pause_only boolean)
 RETURNS TABLE(company_ids uuid[],feature_paused boolean) LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=public,pg_temp AS $$
DECLARE switch_key text;switch_on jsonb;tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();
BEGIN
 IF tid IS NULL OR wanted_feature IS NULL OR wanted_feature NOT IN ('hr_assistant','provider_evaluation','module_agent_evaluation','personnel_import_mapping','module_agent_planning','readiness_reminders','claims_triage','payroll_hypotheses','payroll_explanation','pay_rule_draft','report_insight','performance_360','performance_tc','performance_pm','performance_review','performance_idp','performance_calib','performance_assistant','feedback_planning') THEN RAISE EXCEPTION 'Invalid AI feature';END IF;
 IF NOT EXISTS(SELECT 1 FROM tenant WHERE id=tid AND status IN ('active','trial')) THEN RAISE EXCEPTION 'AI unavailable';END IF;
 IF uid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=uid AND tenant_id=tid) THEN RAISE EXCEPTION 'Unknown actor';END IF;
 IF current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='on' THEN
  PERFORM pg_advisory_xact_lock_shared(hashtext('ai-control'),hashtext(tid::text));
 ELSE PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text)); END IF;
 feature_paused:=coalesce(forced_pause,false) OR EXISTS(SELECT 1 FROM public.teras_mandate_control c WHERE c.tenant_id=tid AND c.stopped);
 IF pause_only IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM ai_control_policy p WHERE p.tenant_id=tid AND p.kind='company' AND NOT p.enabled) THEN
 WITH navigation_visible AS MATERIALIZED(SELECT unnest(app.visible_employment_ids())AS id)
 SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}') INTO company_ids FROM company c WHERE c.tenant_id=tid
 AND(app.is_admin_for(c.id) OR EXISTS(SELECT 1 FROM employment e JOIN navigation_visible v ON v.id=e.id
 WHERE e.tenant_id=tid AND e.company_id=c.id AND app.can_see_employment(e.id)));
 ELSE company_ids:='{}'::uuid[];END IF;
 -- One switch owner per feature: its setting when it has one, otherwise its `feature:` policy row.
 SELECT s.setting_key INTO switch_key FROM app.ai_feature_setting s WHERE s.feature_id=wanted_feature;
 IF switch_key IS NULL AND EXISTS(SELECT 1 FROM ai_control_policy p WHERE p.tenant_id=tid AND p.kind='feature' AND p.feature_id=wanted_feature AND NOT p.enabled) THEN feature_paused:=true;END IF;
 -- Re-read canonical switches at admission; a page/session snapshot can predate a pause.
 IF switch_key IS NOT NULL THEN
  SELECT coalesce(nullif(t.value,'null'::jsonb),d.default_value) INTO switch_on FROM setting_definition d
   LEFT JOIN tenant_setting t ON t.key=d.key AND t.tenant_id=tid AND(d.scope='tenant' OR t.source<>'customer') WHERE d.key=switch_key;
  IF switch_on IS DISTINCT FROM 'true'::jsonb THEN feature_paused:=true;END IF;
 END IF;
 RETURN NEXT;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app._ai_control_context_before_centre(wanted_feature text,forced_pause boolean)
 RETURNS TABLE(company_ids uuid[],feature_paused boolean) LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=public,pg_temp AS $$
BEGIN
 RETURN QUERY SELECT * FROM app._ai_control_context_for_purpose(wanted_feature,forced_pause,false);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app._ai_control_context(wanted_feature text,forced_pause boolean)
 RETURNS TABLE(company_ids uuid[],feature_paused boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN QUERY SELECT c.company_ids,c.feature_paused OR EXISTS(SELECT 1 FROM public.teras_mandate_control t WHERE t.tenant_id=app.current_tenant_id() AND t.stopped)
 FROM app._ai_control_context_before_centre(wanted_feature,forced_pause) c;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_agent_action_unpaused_before_centre(wanted_action text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Fresh AI action controls require Read Committed';END IF;
 IF tid IS NULL OR wanted_action IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_action_kind k WHERE k.id=wanted_action) THEN RAISE EXCEPTION 'Unknown agent action';END IF;
 IF current_setting('transaction_read_only')='on' THEN
  PERFORM pg_advisory_xact_lock_shared(hashtext('ai-control'),hashtext(tid::text));
 ELSE PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text)); END IF;
 RETURN NOT EXISTS(SELECT 1 FROM app.ai_agent_action_pause p WHERE p.tenant_id=tid AND p.action_id=wanted_action AND p.paused);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_agent_action_unpaused(wanted_action text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN app.ai_agent_action_unpaused_before_centre(wanted_action) AND NOT EXISTS(SELECT 1 FROM public.teras_mandate_control c WHERE c.tenant_id=app.current_tenant_id() AND c.stopped);
END $$;
--> statement-breakpoint
DO $postimage$
DECLARE expected record;before_row record;p pg_proc;
BEGIN
 IF (SELECT count(*) FROM pg_temp.ai_centre_compatibility_preimage)<>11 THEN RAISE EXCEPTION 'AI Centre preimage custody unavailable' USING ERRCODE='55000';END IF;
 FOR before_row IN SELECT * FROM pg_temp.ai_centre_compatibility_preimage LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(before_row.signature);
  IF p.oid IS DISTINCT FROM before_row.oid OR (to_jsonb(p)-'prosrc'-'proconfig') IS DISTINCT FROM before_row.attributes THEN
   RAISE EXCEPTION 'AI Centre native identity changed: %',before_row.signature USING ERRCODE='55000';END IF;
  IF before_row.signature NOT IN('app._ai_control_context(text,boolean)','app._ai_control_context_before_centre(text,boolean)','app._ai_control_context_for_purpose(text,boolean,boolean)','app.ai_agent_action_unpaused(text)','app.ai_agent_action_unpaused_before_centre(text)')
   AND pg_get_functiondef(p.oid) IS DISTINCT FROM before_row.definition THEN
   RAISE EXCEPTION 'AI Centre unrelated owner changed: %',before_row.signature USING ERRCODE='55000';END IF;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
  ('app._ai_control_context_for_purpose(text,boolean,boolean)','1ef73e989fb4a6132bbeb87da9d939a8','search_path=public, pg_temp'),
  ('app._ai_control_context_before_centre(text,boolean)','a9ea819594d4adbde182910b573287da','search_path=public, pg_temp'),
  ('app._ai_control_context(text,boolean)','6fed6382d06a984f065d4b5e45d82941','search_path=pg_catalog, public, pg_temp'),
  ('app.ai_agent_action_unpaused_before_centre(text)','4e4a28ce82612c9d3ef3531e58a92202','search_path=public, pg_temp'),
  ('app.ai_agent_action_unpaused(text)','78c47da2aa44829087308d36d8cc66b1','search_path=pg_catalog, public, pg_temp')
 ) AS e(signature,body_hash,configuration) LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(expected.signature);
  IF md5(p.prosrc) IS DISTINCT FROM expected.body_hash OR p.proconfig IS DISTINCT FROM ARRAY[expected.configuration] THEN
   RAISE EXCEPTION 'AI Centre compatibility postimage differs: %',expected.signature USING ERRCODE='55000';END IF;
 END LOOP;
END $postimage$;
