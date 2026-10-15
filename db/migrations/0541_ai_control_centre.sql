-- Central limits are additive to existing grants, module gates and business-specific draft quotas.
CREATE TABLE ai_control_policy (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),scope_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('feature','company','user')),subject_id uuid,feature_id text,
 enabled boolean NOT NULL DEFAULT true,daily_requests integer CHECK(daily_requests BETWEEN 0 AND 1000000),
 monthly_tokens bigint CHECK(monthly_tokens BETWEEN 0 AND 1000000000000),updated_by_user_id uuid REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,scope_key),
 CHECK((kind='feature' AND subject_id IS NULL AND feature_id IS NOT NULL AND scope_key='feature:'||feature_id AND daily_requests IS NULL AND monthly_tokens IS NULL)
 OR(kind IN ('company','user') AND subject_id IS NOT NULL AND feature_id IS NULL AND scope_key=kind||':'||subject_id::text))
);
--> statement-breakpoint
CREATE TABLE ai_model_run (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),user_id uuid REFERENCES app_user(id),company_ids uuid[] NOT NULL DEFAULT '{}',
 feature_id text NOT NULL,operation text NOT NULL CHECK(operation IN ('draft','conversation','image')),provider text NOT NULL,model text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','completed','failed','blocked')),reason text,
 reserved_tokens bigint NOT NULL CHECK(reserved_tokens>=0),actual_tokens bigint CHECK(actual_tokens>=0),started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz
);
--> statement-breakpoint
CREATE INDEX ai_model_run_period ON ai_model_run(tenant_id,started_at);
--> statement-breakpoint
CREATE INDEX ai_model_run_user ON ai_model_run(tenant_id,user_id,started_at);
--> statement-breakpoint
CREATE INDEX ai_model_run_company ON ai_model_run USING gin(company_ids);
--> statement-breakpoint
ALTER TABLE ai_control_policy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_model_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ai_control_policy_read ON ai_control_policy FOR SELECT USING(tenant_id=app.current_tenant_id() AND
 (app.is_group_admin() OR kind='feature' OR(kind='user' AND subject_id=app.current_user_id()) OR(kind='company' AND app.is_admin_for(subject_id))));
--> statement-breakpoint
CREATE POLICY ai_control_policy_write ON ai_control_policy FOR ALL USING(tenant_id=app.current_tenant_id() AND (app.is_group_admin() OR(kind='company' AND app.is_admin_for(subject_id))))
 WITH CHECK(tenant_id=app.current_tenant_id() AND (app.is_group_admin() OR(kind='company' AND app.is_admin_for(subject_id))));
--> statement-breakpoint
CREATE POLICY ai_model_run_read ON ai_model_run FOR SELECT USING(tenant_id=app.current_tenant_id() AND(app.is_group_admin() OR user_id=app.current_user_id()));
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON ai_control_policy TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON ai_model_run TO ai_hr_app;
--> statement-breakpoint
REVOKE DELETE,TRUNCATE ON ai_control_policy FROM ai_hr_app;
--> statement-breakpoint
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON ai_model_run FROM ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_control_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(NEW.tenant_id::text));
 IF NEW.kind='feature' AND NEW.feature_id='feedback_planning' THEN RAISE EXCEPTION 'Platform managed feature';END IF;
 IF NEW.kind='company' AND NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.subject_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Unknown company';END IF;
 IF NEW.kind='user' AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=NEW.subject_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Unknown user';END IF;
 IF NEW.kind='feature' AND NEW.feature_id NOT IN ('hr_assistant','payroll_explanation','pay_rule_draft','report_insight','performance_assistant') THEN RAISE EXCEPTION 'Unknown AI feature';END IF;
 NEW.updated_by_user_id:=app.current_user_id();NEW.updated_at:=now();
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ai_control_policy_guard BEFORE INSERT OR UPDATE ON ai_control_policy FOR EACH ROW EXECUTE FUNCTION app.ai_control_policy_guard();
--> statement-breakpoint
-- The narrow admission function owns atomic counters. No caller can supply a tenant or actor ID.
CREATE FUNCTION app.ai_admit(wanted_feature text,wanted_operation text,wanted_provider text,wanted_model text,reserve bigint)
 RETURNS TABLE(run_id uuid,allowed boolean,blocked_reason text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE switch_key text;switch_on jsonb;tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();companies uuid[];policy record;reason text;rid uuid;used_requests bigint;used_tokens bigint;
 day_start timestamptz:=date_trunc('day',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur';
 month_start timestamptz:=date_trunc('month',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur';
BEGIN
 IF tid IS NULL OR reserve IS NULL OR reserve<0 OR reserve>1000000000 OR wanted_operation NOT IN ('draft','conversation','image')
 OR wanted_feature NOT IN ('hr_assistant','readiness_reminders','claims_triage','payroll_hypotheses','payroll_explanation','pay_rule_draft','report_insight','performance_360','performance_tc','performance_pm','performance_review','performance_idp','performance_calib','performance_assistant','feedback_planning') THEN RAISE EXCEPTION 'Invalid AI request';END IF;
 IF NOT EXISTS(SELECT 1 FROM tenant WHERE id=tid AND status IN ('active','trial')) THEN RAISE EXCEPTION 'AI unavailable';END IF;
 IF uid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=uid AND tenant_id=tid) THEN RAISE EXCEPTION 'Unknown actor';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 SELECT coalesce(array_agg(c.id),'{}') INTO companies FROM company c WHERE c.tenant_id=tid AND(app.is_admin_for(c.id) OR EXISTS(SELECT 1 FROM employment e WHERE e.tenant_id=tid AND e.company_id=c.id AND e.terminated_on IS NULL AND app.can_see_employment(e.id)));
 IF EXISTS(SELECT 1 FROM ai_control_policy p WHERE p.tenant_id=tid AND p.kind='feature' AND p.feature_id=wanted_feature AND NOT p.enabled) THEN reason:='paused';END IF;
 -- Re-read canonical switches at admission; a page/session snapshot can predate a pause.
 switch_key:=CASE wanted_feature WHEN 'readiness_reminders' THEN 'notifications.readiness_nudge_enabled'
 WHEN 'claims_triage' THEN 'claims.input_triage_enabled' WHEN 'payroll_hypotheses' THEN 'payroll.anomaly_hypotheses_enabled'
 WHEN 'performance_360' THEN 'performance.ai_360_enabled' WHEN 'performance_tc' THEN 'performance.ai_tc_enabled'
 WHEN 'performance_pm' THEN 'performance.ai_pm_enabled' WHEN 'performance_review' THEN 'performance.ai_review_enabled'
 WHEN 'performance_idp' THEN 'performance.ai_idp_enabled' WHEN 'performance_calib' THEN 'performance.ai_calib_enabled' END;
 IF switch_key IS NOT NULL THEN
  SELECT coalesce(t.value,d.default_value) INTO switch_on FROM setting_definition d LEFT JOIN tenant_setting t ON t.key=d.key AND t.tenant_id=tid WHERE d.key=switch_key;
  IF switch_on IS DISTINCT FROM 'true'::jsonb THEN reason:='paused';END IF;
 END IF;
 FOR policy IN SELECT p.* FROM ai_control_policy p WHERE p.tenant_id=tid AND
 ((p.kind='feature' AND p.feature_id=wanted_feature) OR(p.kind='user' AND p.subject_id=uid) OR(p.kind='company' AND p.subject_id=ANY(companies))) ORDER BY p.scope_key LOOP
  IF reason IS NOT NULL THEN EXIT;END IF;
  IF NOT policy.enabled THEN reason:='paused';EXIT;END IF;
  SELECT count(*) FILTER(WHERE r.started_at>=day_start),coalesce(sum(coalesce(r.actual_tokens,r.reserved_tokens)) FILTER(WHERE r.started_at>=month_start),0)
   INTO used_requests,used_tokens FROM ai_model_run r WHERE r.tenant_id=tid AND r.state<>'blocked' AND r.started_at>=month_start
   AND((policy.kind='user' AND r.user_id=policy.subject_id) OR(policy.kind='company' AND policy.subject_id=ANY(r.company_ids)) OR(policy.kind='feature' AND r.feature_id=policy.feature_id));
  IF policy.daily_requests IS NOT NULL AND used_requests>=policy.daily_requests THEN reason:='daily_limit';EXIT;END IF;
  IF policy.monthly_tokens IS NOT NULL AND used_tokens+reserve>policy.monthly_tokens THEN reason:='monthly_limit';EXIT;END IF;
 END LOOP;
 INSERT INTO ai_model_run(tenant_id,user_id,company_ids,feature_id,operation,provider,model,state,reason,reserved_tokens)
 VALUES(tid,uid,companies,wanted_feature,wanted_operation,left(wanted_provider,40),left(wanted_model,200),CASE WHEN reason IS NULL THEN 'pending' ELSE 'blocked' END,reason,reserve) RETURNING id INTO rid;
 RETURN QUERY SELECT rid,reason IS NULL,reason;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.ai_settle(wanted_run uuid,succeeded boolean,tokens bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF tokens IS NOT NULL AND(tokens<0 OR tokens>1000000000) THEN RAISE EXCEPTION 'Invalid AI usage';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(app.current_tenant_id()::text));
 UPDATE ai_model_run SET state=CASE WHEN succeeded THEN 'completed' ELSE 'failed' END,actual_tokens=tokens,finished_at=now()
 WHERE id=wanted_run AND tenant_id=app.current_tenant_id() AND user_id IS NOT DISTINCT FROM app.current_user_id() AND state='pending';
 IF NOT FOUND THEN RAISE EXCEPTION 'AI request not found';END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_admit(text,text,text,text,bigint),app.ai_settle(uuid,boolean,bigint) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_admit(text,text,text,text,bigint),app.ai_settle(uuid,boolean,bigint) TO ai_hr_app;

--> statement-breakpoint
-- Scoped aggregate: company admins see totals for their companies, never other actors' run rows.
CREATE FUNCTION app.ai_company_usage() RETURNS TABLE(company_id uuid,feature_id text,daily_requests bigint,monthly_tokens bigint,held_tokens bigint,blocked bigint,failed bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT c.id,r.feature_id,count(*) FILTER(WHERE r.state<>'blocked' AND r.started_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur'),
 coalesce(sum(r.actual_tokens) FILTER(WHERE r.state<>'blocked'),0)::bigint,coalesce(sum(r.reserved_tokens) FILTER(WHERE r.state<>'blocked' AND r.actual_tokens IS NULL),0)::bigint,
 count(*) FILTER(WHERE r.state='blocked'),count(*) FILTER(WHERE r.state='failed')
 FROM company c JOIN ai_model_run r ON r.tenant_id=c.tenant_id AND c.id=ANY(r.company_ids)
 WHERE c.tenant_id=app.current_tenant_id() AND app.is_admin_for(c.id)
 AND r.started_at>=date_trunc('month',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur'
 GROUP BY c.id,r.feature_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_company_usage() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_company_usage() TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.ai_feature_usage() RETURNS TABLE(feature_id text,daily_requests bigint,monthly_tokens bigint,held_tokens bigint,blocked bigint,failed bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT r.feature_id,count(*) FILTER(WHERE r.state<>'blocked' AND r.started_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur'),
 coalesce(sum(r.actual_tokens) FILTER(WHERE r.state<>'blocked'),0)::bigint,coalesce(sum(r.reserved_tokens) FILTER(WHERE r.state<>'blocked' AND r.actual_tokens IS NULL),0)::bigint,
 count(*) FILTER(WHERE r.state='blocked'),count(*) FILTER(WHERE r.state='failed')
 FROM ai_model_run r WHERE r.tenant_id=app.current_tenant_id()
 AND(app.is_group_admin() OR EXISTS(SELECT 1 FROM company c WHERE c.tenant_id=r.tenant_id AND c.id=ANY(r.company_ids) AND app.is_admin_for(c.id)))
 AND r.started_at>=date_trunc('month',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur'
 GROUP BY r.feature_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_feature_usage() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_feature_usage() TO ai_hr_app;
