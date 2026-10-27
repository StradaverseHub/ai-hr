-- AI concurrency controls (N2). Requires 0541 and the forwarded 0621; replaces app.ai_admit with the same signature.
-- Extends canonical admission under its EXISTING tenant ai-control lock and applicable-policy owner.
-- NULL is no additional cap; zero stops new calls. No invoice/spend cap or TTL recovery is inferred.
ALTER TABLE public.ai_control_policy ADD COLUMN max_concurrent integer CHECK(max_concurrent BETWEEN 0 AND 1000000);
--> statement-breakpoint
-- Plain CREATE INDEX: Drizzle applies a migration run inside one transaction, so CONCURRENTLY is not
-- available. The build holds a SHARE lock on ai_model_run (AI admissions/settlements wait) for its duration.
CREATE INDEX ai_model_run_pending_scope ON public.ai_model_run(tenant_id,user_id,feature_id) WHERE state='pending';
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
 -- The tenant default stands in for a login's individual policy only while that login has none.
 FOR policy IN SELECT * FROM app._ai_applicable_policies(wanted_feature,companies) ORDER BY scope_key LOOP
  IF reason IS NOT NULL THEN EXIT;END IF;
  IF NOT policy.enabled THEN reason:='paused';EXIT;END IF;
  -- All actual pending reservations count, including old/orphaned admissions. No clock or TTL frees
  -- an in-flight slot; only the existing canonical settlement can move it out of pending.
  IF policy.max_concurrent IS NOT NULL THEN
   SELECT count(*) INTO inflight FROM ai_model_run r WHERE r.tenant_id=tid AND r.state='pending'
    AND((policy.kind='user' AND r.user_id=policy.subject_id) OR(policy.kind='user_default' AND r.user_id=uid) OR(policy.kind='company' AND policy.subject_id=ANY(r.company_ids)) OR(policy.kind='feature' AND r.feature_id=policy.feature_id));
   IF inflight>=policy.max_concurrent THEN reason:='concurrent_limit';EXIT;END IF;
  END IF;
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
