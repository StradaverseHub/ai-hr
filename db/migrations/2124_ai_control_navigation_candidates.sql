-- Reuse bounded visible-employment candidates for AI company-policy discovery.
-- Every positive retains app.can_see_employment; admin-only empty companies are preserved.
-- No decision/result cache, admission, quota, policy, ACL, owner or lock change.
-- Keep the exclusive ai-control lock: the same owner participates in budget admission.
CREATE OR REPLACE FUNCTION app._ai_control_context(wanted_feature text,forced_pause boolean)
 RETURNS TABLE(company_ids uuid[],feature_paused boolean) LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=public,pg_temp AS $$
DECLARE switch_key text;switch_on jsonb;tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();
BEGIN
 IF tid IS NULL OR wanted_feature IS NULL OR wanted_feature NOT IN ('hr_assistant','provider_evaluation','module_agent_evaluation','personnel_import_mapping','module_agent_planning','readiness_reminders','claims_triage','payroll_hypotheses','payroll_explanation','pay_rule_draft','report_insight','performance_360','performance_tc','performance_pm','performance_review','performance_idp','performance_calib','performance_assistant','feedback_planning') THEN RAISE EXCEPTION 'Invalid AI feature';END IF;
 IF NOT EXISTS(SELECT 1 FROM tenant WHERE id=tid AND status IN ('active','trial')) THEN RAISE EXCEPTION 'AI unavailable';END IF;
 IF uid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=uid AND tenant_id=tid) THEN RAISE EXCEPTION 'Unknown actor';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 feature_paused:=coalesce(forced_pause,false);
 WITH navigation_visible AS MATERIALIZED(SELECT unnest(app.visible_employment_ids())AS id)
 SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}') INTO company_ids FROM company c WHERE c.tenant_id=tid
 AND(app.is_admin_for(c.id) OR EXISTS(SELECT 1 FROM employment e JOIN navigation_visible v ON v.id=e.id
 WHERE e.tenant_id=tid AND e.company_id=c.id AND app.can_see_employment(e.id)));
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
