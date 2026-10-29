-- WP4 / R9: connection checks have metadata-only receipts, outside workload allowances.
ALTER TABLE ai_model_run DROP CONSTRAINT ai_model_run_operation_check;
--> statement-breakpoint
ALTER TABLE ai_model_run ADD CONSTRAINT ai_model_run_operation_check CHECK(operation IN('draft','conversation','image','probe'));
--> statement-breakpoint
CREATE FUNCTION app.ai_probe_start(wanted_provider text,wanted_model text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();rid uuid;
BEGIN
 IF tid IS NULL OR uid IS NULL OR NOT app._ai_provider_evaluation_actor_valid()
 OR wanted_provider IS NULL OR wanted_provider NOT IN('anthropic','openai','google','openrouter','ai_gateway')
 OR wanted_model IS NULL OR length(wanted_model) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'AI connection check unavailable';END IF;
 INSERT INTO ai_model_run(tenant_id,user_id,feature_id,operation,provider,model,state,reserved_tokens)
 VALUES(tid,uid,'provider_evaluation','probe',wanted_provider,wanted_model,'pending',0) RETURNING id INTO rid;
 RETURN rid;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_probe_start(text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_probe_start(text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_admit(wanted_feature text,wanted_operation text,wanted_provider text,wanted_model text,reserve bigint,forced_pause boolean DEFAULT false)
 RETURNS TABLE(run_id uuid,allowed boolean,blocked_reason text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();companies uuid[];policy record;reason text;rid uuid;used_requests bigint;used_tokens bigint;inflight bigint;
 day_start timestamptz:=date_trunc('day',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur';
 month_start timestamptz:=date_trunc('month',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur';
BEGIN
 IF reserve IS NULL OR reserve<0 OR reserve>1000000000 OR wanted_operation IS NULL
 OR wanted_operation NOT IN ('draft','conversation','image') THEN RAISE EXCEPTION 'Invalid AI request';END IF;
 SELECT c.company_ids,CASE WHEN c.feature_paused THEN 'paused' END INTO companies,reason
 FROM app._ai_control_context(wanted_feature,forced_pause) c;
 -- Precedence (app._ai_applicable_policies): individual, else the most specific matching group tier, else the
 -- tenant default. Group and default allowances are per-login templates, so they count that login's own runs.
 FOR policy IN SELECT * FROM app._ai_applicable_policies(wanted_feature,companies) ORDER BY scope_key LOOP
  IF reason IS NOT NULL THEN EXIT;END IF;
  IF NOT policy.enabled THEN reason:='paused';EXIT;END IF;
  -- All actual pending reservations count, including old/orphaned admissions. No clock or TTL frees
  -- an in-flight slot; only the existing canonical settlement can move it out of pending.
  IF policy.max_concurrent IS NOT NULL THEN
   SELECT count(*) INTO inflight FROM ai_model_run r WHERE r.tenant_id=tid AND r.operation<>'probe' AND r.state='pending'
    AND((policy.kind='user' AND r.user_id=policy.subject_id) OR(policy.kind IN ('user_default','group_role','group_company','group_department') AND r.user_id=uid) OR(policy.kind='company' AND policy.subject_id=ANY(r.company_ids)) OR(policy.kind='feature' AND r.feature_id=policy.feature_id));
   IF inflight>=policy.max_concurrent THEN reason:='concurrent_limit';EXIT;END IF;
  END IF;
  SELECT count(*) FILTER(WHERE r.started_at>=day_start),coalesce(sum(coalesce(r.actual_tokens,r.reserved_tokens)) FILTER(WHERE r.started_at>=month_start),0)
   INTO used_requests,used_tokens FROM ai_model_run r WHERE r.tenant_id=tid AND r.operation<>'probe' AND r.state<>'blocked' AND r.started_at>=month_start
   AND((policy.kind='user' AND r.user_id=policy.subject_id) OR(policy.kind IN ('user_default','group_role','group_company','group_department') AND r.user_id=uid) OR(policy.kind='company' AND policy.subject_id=ANY(r.company_ids)) OR(policy.kind='feature' AND r.feature_id=policy.feature_id));
  IF policy.daily_requests IS NOT NULL AND used_requests>=policy.daily_requests THEN reason:='daily_limit';EXIT;END IF;
  IF policy.monthly_tokens IS NOT NULL AND used_tokens+reserve>policy.monthly_tokens THEN reason:='monthly_limit';EXIT;END IF;
 END LOOP;
 INSERT INTO ai_model_run(tenant_id,user_id,company_ids,feature_id,operation,provider,model,state,reason,reserved_tokens)
 VALUES(tid,uid,companies,wanted_feature,wanted_operation,left(wanted_provider,40),left(wanted_model,200),CASE WHEN reason IS NULL THEN 'pending' ELSE 'blocked' END,reason,reserve) RETURNING id INTO rid;
 RETURN QUERY SELECT rid,reason IS NULL,reason;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_company_usage() RETURNS TABLE(company_id uuid,feature_id text,daily_requests bigint,monthly_tokens bigint,held_tokens bigint,blocked bigint,failed bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT c.id,r.feature_id,count(*) FILTER(WHERE r.state<>'blocked' AND r.started_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur'),
 coalesce(sum(r.actual_tokens) FILTER(WHERE r.state<>'blocked'),0)::bigint,coalesce(sum(r.reserved_tokens) FILTER(WHERE r.state<>'blocked' AND r.actual_tokens IS NULL),0)::bigint,
 count(*) FILTER(WHERE r.state='blocked'),count(*) FILTER(WHERE r.state='failed')
 FROM company c JOIN ai_model_run r ON r.tenant_id=c.tenant_id AND c.id=ANY(r.company_ids)
 WHERE r.operation<>'probe' AND c.tenant_id=app.current_tenant_id() AND app.is_admin_for(c.id)
 AND r.started_at>=date_trunc('month',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur'
 GROUP BY c.id,r.feature_id
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_feature_usage() RETURNS TABLE(feature_id text,daily_requests bigint,monthly_tokens bigint,held_tokens bigint,blocked bigint,failed bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT r.feature_id,count(*) FILTER(WHERE r.state<>'blocked' AND r.started_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur'),
 coalesce(sum(r.actual_tokens) FILTER(WHERE r.state<>'blocked'),0)::bigint,coalesce(sum(r.reserved_tokens) FILTER(WHERE r.state<>'blocked' AND r.actual_tokens IS NULL),0)::bigint,
 count(*) FILTER(WHERE r.state='blocked'),count(*) FILTER(WHERE r.state='failed')
 FROM ai_model_run r WHERE r.operation<>'probe' AND r.tenant_id=app.current_tenant_id()
 AND(app.is_group_admin() OR EXISTS(SELECT 1 FROM company c WHERE c.tenant_id=r.tenant_id AND c.id=ANY(r.company_ids) AND app.is_admin_for(c.id)))
 AND r.started_at>=date_trunc('month',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur'
 GROUP BY r.feature_id
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app._ai_spend_policy_context(wanted_feature text,wanted_root uuid,wanted_kind text,admitted_run uuid)
 RETURNS TABLE(monetary_required boolean,company_ids uuid[]) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();controls record;p app.ai_spend_budget;
 saved_statement text:=current_setting('statement_timeout');saved_lock text:=current_setting('lock_timeout');
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR uid IS NULL OR NOT app.principal_snapshot_current() OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
 OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=uid AND u.tenant_id=tid AND u.archived_at IS NULL AND NOT app.login_blocked(uid))
 OR (wanted_root IS NULL)<>(wanted_kind IS NULL) THEN RAISE EXCEPTION 'Current AI admission policy unavailable';END IF;
 -- Same physical control interval as ai_admit and ALL budget writers. Scope is canonical, not posted.
 SELECT * INTO STRICT controls FROM app._ai_control_context(wanted_feature,false);
 company_ids:=controls.company_ids;
 IF wanted_root IS NULL AND wanted_feature IN('provider_evaluation','module_agent_evaluation','module_agent_planning','hr_assistant','readiness_reminders','claims_triage','payroll_hypotheses','performance_assistant') THEN RAISE EXCEPTION 'Actual AI task root required';END IF;
 IF wanted_root IS NOT NULL AND NOT app._ai_optional_root_allowed(wanted_root,wanted_feature,wanted_kind) THEN RAISE EXCEPTION 'Actual AI task root unavailable';END IF;
 SELECT EXISTS(SELECT 1 FROM app.ai_spend_budget b WHERE b.tenant_id=tid AND(b.kind='tenant' OR(b.kind='user' AND b.subject_id=uid) OR(b.kind='company' AND b.subject_id=ANY(controls.company_ids)) OR(b.kind='feature' AND b.feature_id=wanted_feature)) AND(b.monthly_nanos IS NOT NULL OR b.root_nanos IS NOT NULL)) INTO monetary_required;
 IF admitted_run IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.ai_model_run m WHERE m.id=admitted_run AND m.tenant_id=tid AND m.user_id=uid AND m.feature_id=wanted_feature AND m.state='pending' AND m.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'AI policy exclusion requires this admission';END IF;
 IF monetary_required AND wanted_root IS NULL THEN RAISE EXCEPTION 'This monetary limit requires a native AI task root';END IF;
 -- Clearing allocations never clears a confirmed breach: rooted/capped admissions remain paused.
 -- The pre-existing ordinary rootless/no-cap boundary is unchanged.
 IF (monetary_required OR wanted_root IS NOT NULL) AND EXISTS(SELECT 1 FROM app.ai_spend_reservation b WHERE b.tenant_id=tid AND b.state='breach') THEN RAISE EXCEPTION 'AI spend ceiling breach requires review';END IF;
 IF monetary_required THEN
  FOR p IN SELECT * FROM app.ai_spend_budget b WHERE b.tenant_id=tid AND(b.kind='tenant' OR(b.kind='user' AND b.subject_id=uid) OR(b.kind='company' AND b.subject_id=ANY(controls.company_ids)) OR(b.kind='feature' AND b.feature_id=wanted_feature)) ORDER BY b.scope_key LOOP
   -- Conservative cutover: absent authenticated monetary evidence remains UNKNOWN, including after
   -- process death/month rollover. No new prospective-period exception or zero-cost inference.
   IF p.monthly_nanos IS NOT NULL AND EXISTS(SELECT 1 FROM public.ai_model_run a WHERE a.tenant_id=tid AND a.operation<>'probe' AND a.state<>'blocked' AND a.id IS DISTINCT FROM admitted_run
    AND NOT EXISTS(SELECT 1 FROM app.ai_spend_reservation paid WHERE paid.run_id=a.id)
    AND(p.kind='tenant' OR(p.kind='user' AND a.user_id=uid) OR(p.kind='company' AND p.subject_id=ANY(a.company_ids)) OR(p.kind='feature' AND a.feature_id=p.feature_id))) THEN RAISE EXCEPTION 'Unpriced AI history requires monetary review';END IF;
   IF p.root_nanos IS NOT NULL AND(EXISTS(SELECT 1 FROM app.ai_spend_admission_scope a WHERE a.tenant_id=tid AND a.money_mode='uncapped' AND(a.root_id=wanted_root OR(a.root_id IS NULL AND
    (p.kind='tenant' OR(p.kind='user' AND a.user_id=uid) OR(p.kind='company' AND p.subject_id=ANY(a.company_ids)) OR(p.kind='feature' AND a.feature_id=p.feature_id)))))
    OR EXISTS(SELECT 1 FROM public.ai_model_run a WHERE a.tenant_id=tid AND a.operation<>'probe' AND a.state<>'blocked' AND a.id IS DISTINCT FROM admitted_run
     AND NOT EXISTS(SELECT 1 FROM app.ai_spend_reservation paid WHERE paid.run_id=a.id) AND NOT EXISTS(SELECT 1 FROM app.ai_spend_admission_scope owned WHERE owned.run_id=a.id)
     AND(p.kind='tenant' OR(p.kind='user' AND a.user_id=uid) OR(p.kind='company' AND p.subject_id=ANY(a.company_ids)) OR(p.kind='feature' AND a.feature_id=p.feature_id)))) THEN RAISE EXCEPTION 'Unpriced AI task history requires monetary review';END IF;
  END LOOP;
 END IF;
 RETURN NEXT;
 PERFORM set_config('statement_timeout',saved_statement,true),set_config('lock_timeout',saved_lock,true);
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_optional_spend_status() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE status jsonb;
BEGIN
 status:=app.ai_spend_status();
 RETURN status||jsonb_build_object('unpricedUnknownRuns',(SELECT count(*) FROM public.ai_model_run a WHERE a.tenant_id=app.current_tenant_id() AND a.operation<>'probe' AND a.state<>'blocked' AND NOT EXISTS(SELECT 1 FROM app.ai_spend_reservation paid WHERE paid.run_id=a.id)));
END $$;
