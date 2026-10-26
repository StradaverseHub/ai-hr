-- Parent allocation 0602 coordinated with actual Operator/efficiency owners on 26 October 2026.
-- STILL UNJOURNALED/UNAPPLIED: resolve existing Operator 0601 rollout order before journaling.
-- SOURCE DRAFT ONLY: no migration number or journal entry has been allocated. Do not apply this
-- manually. Integrate after Board 3's verified release, with a centrally allocated migration, then
-- validate the restricted-owner upgrade and app-role behavior. No endpoint currently calls this API.
-- ADR-0131: deterministic confirmation checks pauses without admitting a model run. The context and
-- applicable-policy selectors are shared with admission. Quotas still apply only to model admissions.
CREATE FUNCTION app._ai_control_context(wanted_feature text,forced_pause boolean)
 RETURNS TABLE(company_ids uuid[],feature_paused boolean) LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=public,pg_temp AS $$
DECLARE switch_key text;switch_on jsonb;tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();
BEGIN
 IF tid IS NULL OR wanted_feature IS NULL OR wanted_feature NOT IN ('hr_assistant','readiness_reminders','claims_triage','payroll_hypotheses','payroll_explanation','pay_rule_draft','report_insight','performance_360','performance_tc','performance_pm','performance_review','performance_idp','performance_calib','performance_assistant','feedback_planning') THEN RAISE EXCEPTION 'Invalid AI feature';END IF;
 IF NOT EXISTS(SELECT 1 FROM tenant WHERE id=tid AND status IN ('active','trial')) THEN RAISE EXCEPTION 'AI unavailable';END IF;
 IF uid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=uid AND tenant_id=tid) THEN RAISE EXCEPTION 'Unknown actor';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 feature_paused:=coalesce(forced_pause,false);
 SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}') INTO company_ids FROM company c WHERE c.tenant_id=tid AND(app.is_admin_for(c.id) OR EXISTS(SELECT 1 FROM employment e WHERE e.tenant_id=tid AND e.company_id=c.id AND app.can_see_employment(e.id)));
 IF EXISTS(SELECT 1 FROM ai_control_policy p WHERE p.tenant_id=tid AND p.kind='feature' AND p.feature_id=wanted_feature AND NOT p.enabled) THEN feature_paused:=true;END IF;
 -- Re-read canonical switches at admission; a page/session snapshot can predate a pause.
 switch_key:=CASE wanted_feature WHEN 'readiness_reminders' THEN 'notifications.readiness_nudge_enabled'
 WHEN 'claims_triage' THEN 'claims.input_triage_enabled' WHEN 'payroll_hypotheses' THEN 'payroll.anomaly_hypotheses_enabled'
 WHEN 'performance_360' THEN 'performance.ai_360_enabled' WHEN 'performance_tc' THEN 'performance.ai_tc_enabled'
 WHEN 'performance_pm' THEN 'performance.ai_pm_enabled' WHEN 'performance_review' THEN 'performance.ai_review_enabled'
 WHEN 'performance_idp' THEN 'performance.ai_idp_enabled' WHEN 'performance_calib' THEN 'performance.ai_calib_enabled' END;
 IF switch_key IS NOT NULL THEN
  SELECT coalesce(nullif(t.value,'null'::jsonb),d.default_value) INTO switch_on FROM setting_definition d LEFT JOIN tenant_setting t ON t.key=d.key AND t.tenant_id=tid WHERE d.key=switch_key;
  IF switch_on IS DISTINCT FROM 'true'::jsonb THEN feature_paused:=true;END IF;
 END IF;
 RETURN NEXT;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._ai_control_context(text,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._ai_applicable_policies(wanted_feature text,wanted_companies uuid[])
 RETURNS SETOF public.ai_control_policy LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p.* FROM ai_control_policy p WHERE p.tenant_id=app.current_tenant_id() AND
 ((p.kind='feature' AND p.feature_id=wanted_feature) OR(p.kind='user' AND p.subject_id=app.current_user_id()) OR(p.kind='company' AND p.subject_id=ANY(wanted_companies))
 OR(p.kind='user_default' AND app.current_user_id() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_control_policy o WHERE o.tenant_id=app.current_tenant_id() AND o.kind='user' AND o.subject_id=app.current_user_id()))) ORDER BY p.scope_key
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._ai_applicable_policies(text,uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- This answers only whether the applicable controls are unpaused. It grants no action/data authority,
-- makes no provider call, and reads/writes no usage counters. Keep the transaction open through the
-- governed effect: the ai-control lock serializes the policy writers until that transaction ends.
CREATE FUNCTION app.ai_action_unpaused(wanted_feature text,forced_pause boolean DEFAULT false)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE controls record;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Fresh AI action controls require Read Committed';
 END IF;
 SELECT * INTO STRICT controls FROM app._ai_control_context(wanted_feature,forced_pause);
 RETURN NOT controls.feature_paused AND NOT EXISTS(
  SELECT 1 FROM app._ai_applicable_policies(wanted_feature,controls.company_ids) p WHERE NOT p.enabled);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_action_unpaused(text,boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_action_unpaused(text,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_admit(wanted_feature text,wanted_operation text,wanted_provider text,wanted_model text,reserve bigint,forced_pause boolean DEFAULT false)
 RETURNS TABLE(run_id uuid,allowed boolean,blocked_reason text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();companies uuid[];policy record;reason text;rid uuid;used_requests bigint;used_tokens bigint;
 day_start timestamptz:=date_trunc('day',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur';
 month_start timestamptz:=date_trunc('month',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur';
BEGIN
 IF reserve IS NULL OR reserve<0 OR reserve>1000000000 OR wanted_operation IS NULL
 OR wanted_operation NOT IN ('draft','conversation','image') THEN RAISE EXCEPTION 'Invalid AI request';END IF;
 SELECT c.company_ids,CASE WHEN c.feature_paused THEN 'paused' END INTO companies,reason
 FROM app._ai_control_context(wanted_feature,forced_pause) c;
 -- The tenant default stands in for a login's individual policy only while that login has none.
 FOR policy IN SELECT * FROM app._ai_applicable_policies(wanted_feature,companies) ORDER BY scope_key LOOP
  IF reason IS NOT NULL THEN EXIT;END IF;
  IF NOT policy.enabled THEN reason:='paused';EXIT;END IF;
  SELECT count(*) FILTER(WHERE r.started_at>=day_start),coalesce(sum(coalesce(r.actual_tokens,r.reserved_tokens)) FILTER(WHERE r.started_at>=month_start),0)
   INTO used_requests,used_tokens FROM ai_model_run r WHERE r.tenant_id=tid AND r.state<>'blocked' AND r.started_at>=month_start
   AND((policy.kind='user' AND r.user_id=policy.subject_id) OR(policy.kind='user_default' AND r.user_id=uid) OR(policy.kind='company' AND policy.subject_id=ANY(r.company_ids)) OR(policy.kind='feature' AND r.feature_id=policy.feature_id));
  IF policy.daily_requests IS NOT NULL AND used_requests>=policy.daily_requests THEN reason:='daily_limit';EXIT;END IF;
  IF policy.monthly_tokens IS NOT NULL AND used_tokens+reserve>policy.monthly_tokens THEN reason:='monthly_limit';EXIT;END IF;
 END LOOP;
 INSERT INTO ai_model_run(tenant_id,user_id,company_ids,feature_id,operation,provider,model,state,reason,reserved_tokens)
 VALUES(tid,uid,companies,wanted_feature,wanted_operation,left(wanted_provider,40),left(wanted_model,200),CASE WHEN reason IS NULL THEN 'pending' ELSE 'blocked' END,reason,reserve) RETURNING id INTO rid;
 RETURN QUERY SELECT rid,reason IS NULL,reason;
END $$;
