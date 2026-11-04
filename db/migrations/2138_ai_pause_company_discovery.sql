-- One canonical control owner. Pause prerequisites need company discovery only when a
-- company policy can deny them. Admission/policy readers always retain full discovery.
-- The necessary check remains under the same native ai-control barrier; no decision cache.
DO $$
DECLARE c record;a record;
BEGIN
 SELECT * INTO c FROM pg_proc WHERE oid=to_regprocedure('app._ai_control_context(text,boolean)');
 SELECT * INTO a FROM pg_proc WHERE oid=to_regprocedure('app.ai_action_unpaused(text,boolean)');
 IF c.oid IS NULL OR a.oid IS NULL
  OR md5(c.prosrc) IS DISTINCT FROM '19d4162a8d5ac5d108ec52594e80571f' OR md5(a.prosrc) IS DISTINCT FROM 'db91f23aa055f02e0f592fbd9c411003'
  OR NOT c.prosecdef OR NOT a.prosecdef OR c.proisstrict OR a.proisstrict OR c.proleakproof OR a.proleakproof
  OR c.provolatile<>'v' OR a.provolatile<>'v' OR c.proparallel<>'u' OR a.proparallel<>'u'
  OR c.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
  OR a.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
  OR c.proowner<>a.proowner OR c.pronargdefaults<>0 OR a.pronargdefaults<>1
  OR pg_get_expr(a.proargdefaults,0) IS DISTINCT FROM 'false'
  OR to_regprocedure('app._ai_control_context_for_purpose(text,boolean,boolean)') IS NOT NULL THEN
  RAISE EXCEPTION 'Unexpected AI control context; review before optimizing pause discovery' USING ERRCODE='55000';
 END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app._ai_control_context_for_purpose(wanted_feature text,forced_pause boolean,pause_only boolean)
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
 feature_paused:=coalesce(forced_pause,false);
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
REVOKE ALL ON FUNCTION app._ai_control_context_for_purpose(text,boolean,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Preserve the established definer owner, including installations whose migration login differs.
DO $$
DECLARE control_owner text;
BEGIN
 SELECT pg_get_userbyid(proowner) INTO STRICT control_owner FROM pg_proc
 WHERE oid='app._ai_control_context(text,boolean)'::regprocedure;
 EXECUTE format('ALTER FUNCTION app._ai_control_context_for_purpose(text,boolean,boolean) OWNER TO %I',control_owner);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app._ai_control_context(wanted_feature text,forced_pause boolean)
 RETURNS TABLE(company_ids uuid[],feature_paused boolean) LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=public,pg_temp AS $$
BEGIN
 RETURN QUERY SELECT * FROM app._ai_control_context_for_purpose(wanted_feature,forced_pause,false);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_action_unpaused(wanted_feature text,forced_pause boolean DEFAULT false)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE controls record;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Fresh AI action controls require Read Committed';
 END IF;
 SELECT * INTO STRICT controls FROM app._ai_control_context_for_purpose(wanted_feature,forced_pause,true);
 RETURN NOT controls.feature_paused AND NOT EXISTS(
  SELECT 1 FROM app._ai_applicable_policies(wanted_feature,controls.company_ids) p WHERE NOT p.enabled);
END $$;
