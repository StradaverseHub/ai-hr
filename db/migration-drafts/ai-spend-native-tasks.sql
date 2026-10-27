-- UNALLOCATED / UNJOURNALED / UNAPPLIED. After spend-allocation + receipt reconciliation.
-- Source-owned identities only. No raw question, HR payload, prompt hash or credential is stored.
-- Native source roots survive retries/source revisions/time windows; no automated TTL may delete
-- a root and thereby replenish its lifetime allowance. Erasure/accounting policy needs explicit owner.
CREATE TABLE app.ai_spend_task(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),created_by uuid NOT NULL REFERENCES public.app_user(id),
 feature_id text NOT NULL CHECK(feature_id IN('hr_assistant','readiness_reminders','claims_triage','payroll_hypotheses')),
 source_kind text NOT NULL CHECK(source_kind IN('assistant_question','readiness_template','claim_request','payroll_batch')),
 source_id uuid NOT NULL,operation text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,feature_id,source_kind,source_id,operation)
);
ALTER TABLE app.ai_spend_task ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_spend_task FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._ai_spend_task_source_allowed(feature text,kind text,native_id uuid,operation text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.current_tenant_id() IS NOT NULL AND app.current_user_id() IS NOT NULL AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM app_user u JOIN tenant t ON t.id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND t.status IN('active','trial'))
 AND CASE
 WHEN feature='hr_assistant' AND kind='assistant_question' AND operation='question' THEN EXISTS(SELECT 1 FROM assistant_grant g WHERE g.tenant_id=app.current_tenant_id() AND g.app_user_id=app.current_user_id() AND g.revoked_at IS NULL)
 WHEN feature='claims_triage' AND kind='claim_request' AND operation='triage' THEN EXISTS(SELECT 1 FROM claim_request q WHERE q.id=native_id AND q.tenant_id=app.current_tenant_id() AND q.status='pending' AND q.employment_id=ANY(app.visible_employment_ids()))
 WHEN feature='payroll_hypotheses' AND kind='payroll_batch' AND operation='hypotheses' THEN EXISTS(SELECT 1 FROM payroll_batch b WHERE b.id=native_id AND b.tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(b.company_id)
  AND NOT EXISTS(SELECT 1 FROM payslip s WHERE s.batch_id=b.id AND s.tenant_id=b.tenant_id AND app.can_admin_payroll_employment(s.employment_id) IS NOT TRUE))
 WHEN feature='readiness_reminders' AND kind='readiness_template' AND native_id=app.current_tenant_id() AND operation~'^(no_compensation|no_bank_account|no_identity|no_tax_number|no_epf_number|no_socso_number):(employee|hr)$' THEN app.is_admin()
 ELSE false END
$$;
REVOKE ALL ON FUNCTION app._ai_spend_task_source_allowed(text,text,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_spend_task_issue(wanted_feature text,wanted_source_kind text,wanted_source_id uuid,wanted_operation text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE root uuid;source uuid:=wanted_source_id;controls record;
BEGIN
 PERFORM app._ai_spend_bounds();
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
 OR wanted_feature IS NULL OR wanted_source_kind IS NULL OR wanted_operation IS NULL OR NOT app._ai_spend_task_source_allowed(wanted_feature,wanted_source_kind,wanted_source_id,wanted_operation) THEN RAISE EXCEPTION 'AI spend task unavailable';END IF;
 SELECT * INTO STRICT controls FROM app._ai_control_context(wanted_feature,false);
 IF controls.feature_paused OR EXISTS(SELECT 1 FROM app._ai_applicable_policies(wanted_feature,controls.company_ids) p WHERE NOT p.enabled) THEN RAISE EXCEPTION 'AI spend task paused';END IF;
 IF wanted_source_kind='assistant_question' THEN
  IF wanted_source_id IS NOT NULL THEN RAISE EXCEPTION 'AI question task must be source issued';END IF;
  -- One invocation is one new human question intent. Internal turns never call this issuer again.
  source:=gen_random_uuid();
 END IF;
 INSERT INTO app.ai_spend_task(tenant_id,created_by,feature_id,source_kind,source_id,operation)
 VALUES(app.current_tenant_id(),app.current_user_id(),wanted_feature,wanted_source_kind,source,wanted_operation)
 ON CONFLICT(tenant_id,feature_id,source_kind,source_id,operation) DO NOTHING;
 SELECT t.id INTO STRICT root FROM app.ai_spend_task t WHERE t.tenant_id=app.current_tenant_id() AND t.feature_id=wanted_feature AND t.source_kind=wanted_source_kind AND t.source_id=source AND t.operation=wanted_operation;
 RETURN root;
END $$;
REVOKE ALL ON FUNCTION app.ai_spend_task_issue(text,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_task_issue(text,text,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._ai_spend_task_root_current(wanted_root uuid,wanted_feature text,wanted_kind text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT wanted_kind='agent' AND EXISTS(SELECT 1 FROM app.ai_spend_task t WHERE t.id=wanted_root AND t.tenant_id=app.current_tenant_id() AND t.feature_id=wanted_feature
 AND(t.source_kind<>'assistant_question' OR t.created_by=app.current_user_id()) AND app._ai_spend_task_source_allowed(t.feature_id,t.source_kind,t.source_id,t.operation))
$$;
REVOKE ALL ON FUNCTION app._ai_spend_task_root_current(uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_spend_reserve(wanted_run uuid,wanted_root uuid,wanted_kind text,wanted_capability text,wanted_request text,wanted_nanos bigint,wanted_configuration text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();r ai_model_run;c app.ai_spend_capability;p app.ai_spend_budget;
 used numeric;root_used numeric;month_start timestamptz:=date_trunc('month',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur';
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR uid IS NULL OR wanted_kind NOT IN('agent','evaluation') OR wanted_root IS NULL OR wanted_request!~'^[a-f0-9]{64}$' OR wanted_nanos IS NULL OR wanted_nanos<=0 OR wanted_configuration IS NULL OR wanted_configuration!~'^[a-f0-9]{64}$'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'AI spend allocation unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 IF NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=uid AND u.tenant_id=tid AND u.archived_at IS NULL AND NOT app.login_blocked(uid)) THEN RAISE EXCEPTION 'AI spend allocation unavailable';END IF;
 SELECT * INTO r FROM ai_model_run WHERE id=wanted_run AND tenant_id=tid AND user_id=uid FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state<>'pending' OR NOT EXISTS(SELECT 1 FROM ai_model_run fresh WHERE fresh.id=r.id AND fresh.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'AI spend allocation requires this admission';END IF;
 -- A native persisted candidate is nominated, not a random browser UUID. Current native/source
 -- authorization remains the trusted source callback; independent evaluators share the SAME root.
 IF NOT(r.feature_id='provider_evaluation' AND EXISTS(SELECT 1 FROM ai_provider_candidate x WHERE x.id=wanted_root AND x.tenant_id=tid AND app._ai_provider_evaluation_actor_valid()))
 AND NOT(r.feature_id IN('module_agent_evaluation','module_agent_planning') AND EXISTS(SELECT 1 FROM ai_agent_candidate x WHERE x.id=wanted_root AND x.tenant_id=tid AND(x.owner_user_id=uid OR app.is_group_admin()))) AND NOT app._ai_spend_task_root_current(wanted_root,r.feature_id,wanted_kind) THEN RAISE EXCEPTION 'AI spend root unavailable';END IF;
 SELECT * INTO c FROM app.ai_spend_capability WHERE digest=wanted_capability AND provider=r.provider AND model=r.model AND operation=r.operation AND revoked_at IS NULL AND verified_at<=now() AND expires_at>now();
 IF NOT FOUND OR c.max_request_nanos<>wanted_nanos THEN RAISE EXCEPTION 'AI spend ceiling unavailable';END IF;
 IF EXISTS(SELECT 1 FROM app.ai_spend_reservation WHERE run_id=wanted_run) THEN RAISE EXCEPTION 'AI spend already reserved';END IF;
 IF NOT EXISTS(SELECT 1 FROM app.ai_spend_budget WHERE tenant_id=tid AND kind='tenant') THEN RAISE EXCEPTION 'AI spend budget missing';END IF;
 IF EXISTS(SELECT 1 FROM app.ai_spend_reservation WHERE tenant_id=tid AND state='breach') THEN RAISE EXCEPTION 'AI spend ceiling breach requires review';END IF;
 INSERT INTO app.ai_spend_root(tenant_id,root_id,kind) VALUES(tid,wanted_root,wanted_kind) ON CONFLICT DO NOTHING;
 -- kind records the initial use only. Evaluation and an agent using the SAME persisted
 -- candidate share this root, rather than changing purpose to mint another lifetime allowance.
 FOR p IN SELECT * FROM app.ai_spend_budget WHERE tenant_id=tid AND(kind='tenant' OR(kind='user' AND subject_id=uid) OR(kind='company' AND subject_id=ANY(r.company_ids)) OR(kind='feature' AND feature_id=r.feature_id)) ORDER BY scope_key LOOP
  -- Unknown exposure survives month rollover and process death; no TTL or success flag releases it.
  SELECT coalesce(sum(CASE WHEN state='held' THEN reserved_nanos ELSE confirmed_nanos END),0) INTO used FROM app.ai_spend_reservation x WHERE x.tenant_id=tid AND(x.state='held' OR x.created_at>=month_start)
   AND(p.kind='tenant' OR(p.kind='user' AND x.user_id=uid) OR(p.kind='company' AND p.subject_id=ANY(x.company_ids)) OR(p.kind='feature' AND x.feature_id=p.feature_id));
  -- Full root exposure is cumulative across evaluators, arms, retries, features and time windows.
  SELECT coalesce(sum(CASE WHEN state='held' THEN reserved_nanos ELSE confirmed_nanos END),0) INTO root_used FROM app.ai_spend_reservation x WHERE x.tenant_id=tid AND x.root_id=wanted_root;
  IF used+wanted_nanos>p.monthly_nanos OR root_used+wanted_nanos>p.root_nanos THEN RAISE EXCEPTION 'AI spend allocation exhausted';END IF;
 END LOOP;
 INSERT INTO app.ai_spend_reservation(run_id,tenant_id,root_id,user_id,company_ids,feature_id,capability_digest,request_digest,configuration_digest,reserved_nanos)
 VALUES(wanted_run,tid,wanted_root,uid,r.company_ids,r.feature_id,wanted_capability,wanted_request,wanted_configuration,wanted_nanos);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_spend_reserve(uuid,uuid,text,text,text,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_reserve(uuid,uuid,text,text,text,bigint,text) TO ai_hr_app;


--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_spend_budget_save(wanted_kind text,wanted_subject uuid,wanted_feature text,monthly bigint,root_limit bigint)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();k text;
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR NOT app._ai_provider_evaluation_actor_valid() OR wanted_kind NOT IN('tenant','user','company','feature') OR monthly IS NULL OR root_limit IS NULL OR monthly<0 OR root_limit<0 THEN RAISE EXCEPTION 'AI spend administration unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 IF wanted_kind='tenant' THEN IF wanted_subject IS NOT NULL OR wanted_feature IS NOT NULL THEN RAISE EXCEPTION 'Invalid spend scope';END IF;k:='tenant';
 ELSIF wanted_kind='feature' THEN IF wanted_subject IS NOT NULL OR wanted_feature IS NULL OR wanted_feature NOT IN('provider_evaluation','module_agent_evaluation','module_agent_planning','hr_assistant','readiness_reminders','claims_triage','payroll_hypotheses') THEN RAISE EXCEPTION 'Invalid spend scope';END IF;k:='feature:'||wanted_feature;
 ELSE IF wanted_feature IS NOT NULL OR wanted_subject IS NULL OR(wanted_kind='user' AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=wanted_subject AND tenant_id=tid)) OR(wanted_kind='company' AND NOT EXISTS(SELECT 1 FROM company WHERE id=wanted_subject AND tenant_id=tid)) THEN RAISE EXCEPTION 'Invalid spend scope';END IF;k:=wanted_kind||':'||wanted_subject::text;END IF;
 INSERT INTO app.ai_spend_budget(tenant_id,scope_key,kind,subject_id,feature_id,monthly_nanos,root_nanos,updated_by) VALUES(tid,k,wanted_kind,wanted_subject,wanted_feature,monthly,root_limit,app.current_user_id())
 ON CONFLICT(tenant_id,scope_key) DO UPDATE SET monthly_nanos=excluded.monthly_nanos,root_nanos=excluded.root_nanos,updated_by=excluded.updated_by,updated_at=now();
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_spend_budget_save(text,uuid,text,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_budget_save(text,uuid,text,bigint,bigint) TO ai_hr_app;
