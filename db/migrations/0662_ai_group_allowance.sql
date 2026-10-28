-- 0662 — group AI allowances (owner-approved 28 October 2026; reserved by the AI allocator: when 1793160000000).
-- A group allowance is a per-login TEMPLATE set once for a role, a company or a department, stored as three new
-- kinds of ai_control_policy row so it inherits that table's RLS, grants, write policy, guard and audit trail.
-- Precedence for a login: its individual policy; else the MOST SPECIFIC matching group tier (department, then
-- company, then role), every matching row of that tier applying (so the strictest limit binds); else the
-- tenant default. Limits never add together. Company/department membership is the login's CURRENT assignment
-- (not superseded, valid today in Asia/Kuala_Lumpur; a legacy assignment without its own company uses the
-- employment's). Role membership is a role_assignment row. Group administrators alone may write group rows:
-- the 0541 write policy admits non-company kinds only for app.is_group_admin(), so it needs no change.
ALTER TABLE ai_control_policy DROP CONSTRAINT ai_control_policy_kind_check;
--> statement-breakpoint
ALTER TABLE ai_control_policy ADD CONSTRAINT ai_control_policy_kind_check CHECK(kind IN ('feature','company','user','user_default','group_role','group_company','group_department'));
--> statement-breakpoint
ALTER TABLE ai_control_policy DROP CONSTRAINT ai_control_policy_check;
--> statement-breakpoint
ALTER TABLE ai_control_policy ADD CONSTRAINT ai_control_policy_check CHECK(
 (kind='feature' AND subject_id IS NULL AND feature_id IS NOT NULL AND scope_key='feature:'||feature_id AND daily_requests IS NULL AND monthly_tokens IS NULL)
 OR(kind IN ('company','user') AND subject_id IS NOT NULL AND feature_id IS NULL AND scope_key=kind||':'||subject_id::text)
 OR(kind='user_default' AND subject_id IS NULL AND feature_id IS NULL AND scope_key='user_default')
 OR(kind='group_role' AND subject_id IS NULL AND feature_id IS NULL
  AND scope_key IN ('group_role:employee','group_role:manager','group_role:hr_admin','group_role:super_admin','group_role:payroll_partner','group_role:performance_comp_partner','group_role:performance_partner'))
 OR(kind IN ('group_company','group_department') AND subject_id IS NOT NULL AND feature_id IS NULL AND scope_key=kind||':'||subject_id::text));
--> statement-breakpoint
-- Group rows may be removed ("no group allowance"), like individual rows; the history stays in the event stream.
CREATE OR REPLACE FUNCTION app.ai_control_policy_delete_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(OLD.tenant_id::text));
 IF OLD.kind NOT IN ('user','group_role','group_company','group_department') THEN RAISE EXCEPTION 'Only an individual user or group allowance can be removed';END IF;
 RETURN OLD;
END $$;
--> statement-breakpoint
-- 0648's guard, plus the two group kinds that name a subject (the 0541 tenant checks, applied to them).
CREATE OR REPLACE FUNCTION app.ai_control_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(NEW.tenant_id::text));
 IF NEW.kind='feature' AND NEW.feature_id='feedback_planning' THEN RAISE EXCEPTION 'Platform managed feature';END IF;
 IF NEW.kind='company' AND NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.subject_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Unknown company';END IF;
 IF NEW.kind='user' AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=NEW.subject_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Unknown user';END IF;
 IF NEW.kind='group_company' AND NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.subject_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Unknown company';END IF;
 IF NEW.kind='group_department' AND NOT EXISTS(SELECT 1 FROM department WHERE id=NEW.subject_id AND tenant_id=NEW.tenant_id AND archived_at IS NULL) THEN RAISE EXCEPTION 'Unknown department';END IF;
 IF NEW.kind='feature' AND NEW.feature_id NOT IN ('hr_assistant','provider_evaluation','module_agent_evaluation','personnel_import_mapping','module_agent_planning','payroll_explanation','pay_rule_draft','report_insight','performance_assistant') THEN RAISE EXCEPTION 'Unknown AI feature';END IF;
 NEW.updated_by_user_id:=app.current_user_id();NEW.updated_at:=now();
 RETURN NEW;
END $$;
--> statement-breakpoint
-- The group tier for the CURRENT login: empty when the login has an individual policy or matches no group.
CREATE FUNCTION app._ai_group_policies() RETURNS SETOF public.ai_control_policy LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH me AS (
  SELECT u.id,u.person_id,u.tenant_id FROM app_user u
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
  AND NOT EXISTS(SELECT 1 FROM ai_control_policy o WHERE o.tenant_id=u.tenant_id AND o.kind='user' AND o.subject_id=u.id)),
 placed AS (
  SELECT a.department_id,coalesce(a.company_id,e.company_id) AS company_id
  FROM me JOIN employment e ON e.person_id=me.person_id AND e.tenant_id=me.tenant_id
  JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
  WHERE a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND(a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)),
 matching AS (
  SELECT p.id,CASE p.kind WHEN 'group_department' THEN 1 WHEN 'group_company' THEN 2 ELSE 3 END AS tier
  FROM ai_control_policy p JOIN me ON p.tenant_id=me.tenant_id
  WHERE(p.kind='group_department' AND p.subject_id IN(SELECT department_id FROM placed))
  OR(p.kind='group_company' AND p.subject_id IN(SELECT company_id FROM placed))
  OR(p.kind='group_role' AND EXISTS(SELECT 1 FROM role_assignment r WHERE r.tenant_id=me.tenant_id AND r.app_user_id=me.id AND p.scope_key='group_role:'||r.role::text)))
 SELECT p.* FROM ai_control_policy p JOIN matching m ON m.id=p.id
 WHERE m.tier=(SELECT min(tier) FROM matching) ORDER BY p.scope_key
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._ai_group_policies() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Same signature as 0621; the group tier sits between the individual policy and the tenant default.
CREATE OR REPLACE FUNCTION app._ai_applicable_policies(wanted_feature text,wanted_companies uuid[])
 RETURNS SETOF public.ai_control_policy LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p.* FROM ai_control_policy p WHERE p.tenant_id=app.current_tenant_id() AND
 ((p.kind='feature' AND p.feature_id=wanted_feature) OR(p.kind='user' AND p.subject_id=app.current_user_id()) OR(p.kind='company' AND p.subject_id=ANY(wanted_companies))
 OR(p.id IN(SELECT g.id FROM app._ai_group_policies() g))
 OR(p.kind='user_default' AND app.current_user_id() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_control_policy o WHERE o.tenant_id=app.current_tenant_id() AND o.kind='user' AND o.subject_id=app.current_user_id())
  AND NOT EXISTS(SELECT 1 FROM app._ai_group_policies()))) ORDER BY p.scope_key
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._ai_applicable_policies(text,uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- 0648's admission, unchanged except that group allowances count the current login's own runs.
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
   SELECT count(*) INTO inflight FROM ai_model_run r WHERE r.tenant_id=tid AND r.state='pending'
    AND((policy.kind='user' AND r.user_id=policy.subject_id) OR(policy.kind IN ('user_default','group_role','group_company','group_department') AND r.user_id=uid) OR(policy.kind='company' AND policy.subject_id=ANY(r.company_ids)) OR(policy.kind='feature' AND r.feature_id=policy.feature_id));
   IF inflight>=policy.max_concurrent THEN reason:='concurrent_limit';EXIT;END IF;
  END IF;
  SELECT count(*) FILTER(WHERE r.started_at>=day_start),coalesce(sum(coalesce(r.actual_tokens,r.reserved_tokens)) FILTER(WHERE r.started_at>=month_start),0)
   INTO used_requests,used_tokens FROM ai_model_run r WHERE r.tenant_id=tid AND r.state<>'blocked' AND r.started_at>=month_start
   AND((policy.kind='user' AND r.user_id=policy.subject_id) OR(policy.kind IN ('user_default','group_role','group_company','group_department') AND r.user_id=uid) OR(policy.kind='company' AND policy.subject_id=ANY(r.company_ids)) OR(policy.kind='feature' AND r.feature_id=policy.feature_id));
  IF policy.daily_requests IS NOT NULL AND used_requests>=policy.daily_requests THEN reason:='daily_limit';EXIT;END IF;
  IF policy.monthly_tokens IS NOT NULL AND used_tokens+reserve>policy.monthly_tokens THEN reason:='monthly_limit';EXIT;END IF;
 END LOOP;
 INSERT INTO ai_model_run(tenant_id,user_id,company_ids,feature_id,operation,provider,model,state,reason,reserved_tokens)
 VALUES(tid,uid,companies,wanted_feature,wanted_operation,left(wanted_provider,40),left(wanted_model,200),CASE WHEN reason IS NULL THEN 'pending' ELSE 'blocked' END,reason,reserve) RETURNING id INTO rid;
 RETURN QUERY SELECT rid,reason IS NULL,reason;
END $$;
