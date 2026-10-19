-- ADR-0116 amendment: one tenant-wide DEFAULT per-user allowance. It applies to every login with no
-- individual user policy; an individual policy REPLACES it for that login (they never stack). Calls
-- without a login (scheduled agents) are unaffected. Group administrators alone may write it: the 0541
-- write policy admits non-company rows only for app.is_group_admin(), so it needs no change.
ALTER TABLE ai_control_policy DROP CONSTRAINT ai_control_policy_kind_check;
--> statement-breakpoint
ALTER TABLE ai_control_policy ADD CONSTRAINT ai_control_policy_kind_check CHECK(kind IN ('feature','company','user','user_default'));
--> statement-breakpoint
ALTER TABLE ai_control_policy DROP CONSTRAINT ai_control_policy_check;
--> statement-breakpoint
ALTER TABLE ai_control_policy ADD CONSTRAINT ai_control_policy_check CHECK(
 (kind='feature' AND subject_id IS NULL AND feature_id IS NOT NULL AND scope_key='feature:'||feature_id AND daily_requests IS NULL AND monthly_tokens IS NULL)
 OR(kind IN ('company','user') AND subject_id IS NOT NULL AND feature_id IS NULL AND scope_key=kind||':'||subject_id::text)
 OR(kind='user_default' AND subject_id IS NULL AND feature_id IS NULL AND scope_key='user_default'));
--> statement-breakpoint
-- Every login may read the default that governs it, as it may read its own individual policy.
DROP POLICY ai_control_policy_read ON ai_control_policy;
--> statement-breakpoint
CREATE POLICY ai_control_policy_read ON ai_control_policy FOR SELECT USING(tenant_id=app.current_tenant_id() AND
 (app.is_group_admin() OR kind IN ('feature','user_default') OR(kind='user' AND subject_id=app.current_user_id()) OR(kind='company' AND app.is_admin_for(subject_id))));
--> statement-breakpoint
-- "Use default" removes a login's individual policy. Only individual user rows may be removed; the
-- change history lives in the ai-control event stream and run rows are untouched.
CREATE FUNCTION app.ai_control_policy_delete_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(OLD.tenant_id::text));
 IF OLD.kind<>'user' THEN RAISE EXCEPTION 'Only an individual user allowance can be removed';END IF;
 RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER ai_control_policy_delete_guard BEFORE DELETE ON ai_control_policy FOR EACH ROW EXECUTE FUNCTION app.ai_control_policy_delete_guard();
--> statement-breakpoint
GRANT DELETE ON ai_control_policy TO ai_hr_app;
--> statement-breakpoint
-- Same signature, result and reasons as 0541 (callers are unchanged); only policy selection differs.
CREATE OR REPLACE FUNCTION app.ai_admit(wanted_feature text,wanted_operation text,wanted_provider text,wanted_model text,reserve bigint,forced_pause boolean DEFAULT false)
 RETURNS TABLE(run_id uuid,allowed boolean,blocked_reason text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE switch_key text;switch_on jsonb;tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();companies uuid[];policy record;reason text:=CASE WHEN forced_pause THEN 'paused' END;rid uuid;used_requests bigint;used_tokens bigint;
 day_start timestamptz:=date_trunc('day',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur';
 month_start timestamptz:=date_trunc('month',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur';
BEGIN
 IF tid IS NULL OR reserve IS NULL OR reserve<0 OR reserve>1000000000 OR wanted_operation NOT IN ('draft','conversation','image')
 OR wanted_feature NOT IN ('hr_assistant','readiness_reminders','claims_triage','payroll_hypotheses','payroll_explanation','pay_rule_draft','report_insight','performance_360','performance_tc','performance_pm','performance_review','performance_idp','performance_calib','performance_assistant','feedback_planning') THEN RAISE EXCEPTION 'Invalid AI request';END IF;
 IF NOT EXISTS(SELECT 1 FROM tenant WHERE id=tid AND status IN ('active','trial')) THEN RAISE EXCEPTION 'AI unavailable';END IF;
 IF uid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=uid AND tenant_id=tid) THEN RAISE EXCEPTION 'Unknown actor';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}') INTO companies FROM company c WHERE c.tenant_id=tid AND(app.is_admin_for(c.id) OR EXISTS(SELECT 1 FROM employment e WHERE e.tenant_id=tid AND e.company_id=c.id AND app.can_see_employment(e.id)));
 IF EXISTS(SELECT 1 FROM ai_control_policy p WHERE p.tenant_id=tid AND p.kind='feature' AND p.feature_id=wanted_feature AND NOT p.enabled) THEN reason:='paused';END IF;
 -- Re-read canonical switches at admission; a page/session snapshot can predate a pause.
 switch_key:=CASE wanted_feature WHEN 'readiness_reminders' THEN 'notifications.readiness_nudge_enabled'
 WHEN 'claims_triage' THEN 'claims.input_triage_enabled' WHEN 'payroll_hypotheses' THEN 'payroll.anomaly_hypotheses_enabled'
 WHEN 'performance_360' THEN 'performance.ai_360_enabled' WHEN 'performance_tc' THEN 'performance.ai_tc_enabled'
 WHEN 'performance_pm' THEN 'performance.ai_pm_enabled' WHEN 'performance_review' THEN 'performance.ai_review_enabled'
 WHEN 'performance_idp' THEN 'performance.ai_idp_enabled' WHEN 'performance_calib' THEN 'performance.ai_calib_enabled' END;
 IF switch_key IS NOT NULL THEN
  SELECT coalesce(nullif(t.value,'null'::jsonb),d.default_value) INTO switch_on FROM setting_definition d LEFT JOIN tenant_setting t ON t.key=d.key AND t.tenant_id=tid WHERE d.key=switch_key;
  IF switch_on IS DISTINCT FROM 'true'::jsonb THEN reason:='paused';END IF;
 END IF;
 -- The tenant default stands in for a login's individual policy only while that login has none.
 FOR policy IN SELECT p.* FROM ai_control_policy p WHERE p.tenant_id=tid AND
 ((p.kind='feature' AND p.feature_id=wanted_feature) OR(p.kind='user' AND p.subject_id=uid) OR(p.kind='company' AND p.subject_id=ANY(companies))
 OR(p.kind='user_default' AND uid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_control_policy o WHERE o.tenant_id=tid AND o.kind='user' AND o.subject_id=uid))) ORDER BY p.scope_key LOOP
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
