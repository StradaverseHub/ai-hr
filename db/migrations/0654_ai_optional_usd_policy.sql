-- AI optional USD policy (N8). After 0651 (allocation, receipt, native tasks, reviewed carriers) and 0648.
-- Preserve every existing value, including 0.
-- Explicit human policy: USD limits optional; native source/identity and nonmoney admission mandatory.
ALTER TABLE app.ai_spend_budget ALTER COLUMN monthly_nanos DROP NOT NULL;
ALTER TABLE app.ai_spend_budget ALTER COLUMN root_nanos DROP NOT NULL;
ALTER TABLE app.ai_spend_budget ADD CONSTRAINT ai_spend_budget_some_cap CHECK(monthly_nanos IS NOT NULL OR root_nanos IS NOT NULL);
--> statement-breakpoint
-- No source payload/HR facts. Unknown unpriced costs cannot be manufactured as zero or TTL-released.
-- Rootless legacy calls retain ordinary admission only without any applicable monetary threshold.
CREATE TABLE app.ai_spend_admission_scope(
 run_id uuid PRIMARY KEY REFERENCES public.ai_model_run(id),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 user_id uuid REFERENCES public.app_user(id),company_ids uuid[] NOT NULL,feature_id text NOT NULL,
 root_id uuid,root_kind text,request_digest text CHECK(request_digest~'^[a-f0-9]{64}$'),
 configuration_digest text CHECK(configuration_digest~'^[a-f0-9]{64}$'),
 capture_kind text NOT NULL DEFAULT 'actual_admission' CHECK(capture_kind IN('actual_admission','historical_unknown')),
 money_mode text NOT NULL CHECK(money_mode IN('capped','uncapped')),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((capture_kind='actual_admission' AND user_id IS NOT NULL AND configuration_digest IS NOT NULL AND((root_id IS NULL AND root_kind IS NULL AND money_mode='uncapped') OR(root_id IS NOT NULL AND root_kind IN('agent','evaluation') AND request_digest IS NOT NULL)))
 OR(capture_kind='historical_unknown' AND root_id IS NULL AND root_kind IS NULL AND request_digest IS NULL AND configuration_digest IS NULL AND money_mode='uncapped')),
 FOREIGN KEY(tenant_id,root_id) REFERENCES app.ai_spend_root(tenant_id,root_id)
);
ALTER TABLE app.ai_spend_admission_scope ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_spend_admission_scope FROM PUBLIC,ai_hr_app;
-- Install during the coordinated quiesced migration window. These are historical UNKNOWN markers,
-- not guessed native-root/configuration receipts. The NO ACTION run FK deliberately retains the
-- existing finance/usage metadata until explicit monetary review; no prompts/answers are copied.
INSERT INTO app.ai_spend_admission_scope(run_id,tenant_id,user_id,company_ids,feature_id,capture_kind,money_mode,created_at)
 SELECT m.id,m.tenant_id,m.user_id,m.company_ids,m.feature_id,'historical_unknown','uncapped',m.started_at FROM public.ai_model_run m
 WHERE m.state<>'blocked' AND NOT EXISTS(SELECT 1 FROM app.ai_spend_reservation priced WHERE priced.run_id=m.id);
CREATE INDEX ai_spend_uncapped_root ON app.ai_spend_admission_scope(tenant_id,root_id) WHERE money_mode='uncapped';
CREATE INDEX ai_spend_uncapped_scope ON app.ai_spend_admission_scope(tenant_id,user_id,feature_id) WHERE money_mode='uncapped';
--> statement-breakpoint
CREATE FUNCTION app._ai_optional_root_allowed(wanted_root uuid,wanted_feature text,wanted_kind text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT wanted_root IS NOT NULL AND wanted_kind IN('agent','evaluation') AND(
 (wanted_feature='provider_evaluation' AND EXISTS(SELECT 1 FROM ai_provider_candidate x WHERE x.id=wanted_root AND x.tenant_id=app.current_tenant_id() AND app._ai_provider_evaluation_actor_valid())) OR
 (wanted_feature IN('module_agent_evaluation','module_agent_planning') AND EXISTS(SELECT 1 FROM ai_agent_candidate x WHERE x.id=wanted_root AND x.tenant_id=app.current_tenant_id() AND(x.owner_user_id=app.current_user_id() OR app.is_group_admin()))) OR
 app._ai_spend_task_root_current(wanted_root,wanted_feature,wanted_kind))
$$;
REVOKE ALL ON FUNCTION app._ai_optional_root_allowed(uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._ai_spend_policy_context(wanted_feature text,wanted_root uuid,wanted_kind text,admitted_run uuid)
 RETURNS TABLE(monetary_required boolean,company_ids uuid[]) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();controls record;p app.ai_spend_budget;
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
   IF p.monthly_nanos IS NOT NULL AND EXISTS(SELECT 1 FROM public.ai_model_run a WHERE a.tenant_id=tid AND a.state<>'blocked' AND a.id IS DISTINCT FROM admitted_run
    AND NOT EXISTS(SELECT 1 FROM app.ai_spend_reservation paid WHERE paid.run_id=a.id)
    AND(p.kind='tenant' OR(p.kind='user' AND a.user_id=uid) OR(p.kind='company' AND p.subject_id=ANY(a.company_ids)) OR(p.kind='feature' AND a.feature_id=p.feature_id))) THEN RAISE EXCEPTION 'Unpriced AI history requires monetary review';END IF;
   IF p.root_nanos IS NOT NULL AND(EXISTS(SELECT 1 FROM app.ai_spend_admission_scope a WHERE a.tenant_id=tid AND a.money_mode='uncapped' AND(a.root_id=wanted_root OR(a.root_id IS NULL AND
    (p.kind='tenant' OR(p.kind='user' AND a.user_id=uid) OR(p.kind='company' AND p.subject_id=ANY(a.company_ids)) OR(p.kind='feature' AND a.feature_id=p.feature_id)))))
    OR EXISTS(SELECT 1 FROM public.ai_model_run a WHERE a.tenant_id=tid AND a.state<>'blocked' AND a.id IS DISTINCT FROM admitted_run
     AND NOT EXISTS(SELECT 1 FROM app.ai_spend_reservation paid WHERE paid.run_id=a.id) AND NOT EXISTS(SELECT 1 FROM app.ai_spend_admission_scope owned WHERE owned.run_id=a.id)
     AND(p.kind='tenant' OR(p.kind='user' AND a.user_id=uid) OR(p.kind='company' AND p.subject_id=ANY(a.company_ids)) OR(p.kind='feature' AND a.feature_id=p.feature_id)))) THEN RAISE EXCEPTION 'Unpriced AI task history requires monetary review';END IF;
  END LOOP;
 END IF;
 RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION app._ai_spend_policy_context(text,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- No caller may omit a historical run from cutover checks. Only private actual-admission owners
-- can pass the verified fresh run to the helper while completing that same top-level transaction.
CREATE FUNCTION app.ai_spend_policy_context(wanted_feature text,wanted_root uuid,wanted_kind text)
 RETURNS TABLE(monetary_required boolean,company_ids uuid[]) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT * FROM app._ai_spend_policy_context(wanted_feature,wanted_root,wanted_kind,NULL)
$$;
REVOKE ALL ON FUNCTION app.ai_spend_policy_context(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_policy_context(text,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_spend_record_admission(wanted_run uuid,wanted_root uuid,wanted_kind text,wanted_request text,wanted_configuration text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();r public.ai_model_run;policy record;
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR uid IS NULL OR wanted_configuration IS NULL OR wanted_configuration!~'^[a-f0-9]{64}$' OR(wanted_request IS NOT NULL AND wanted_request!~'^[a-f0-9]{64}$')
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'AI admission custody unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 SELECT * INTO r FROM public.ai_model_run WHERE id=wanted_run AND tenant_id=tid AND user_id=uid FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state<>'pending' OR NOT EXISTS(SELECT 1 FROM public.ai_model_run m WHERE m.id=r.id AND m.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'AI admission custody requires this actual admission';END IF;
 SELECT * INTO STRICT policy FROM app._ai_spend_policy_context(r.feature_id,wanted_root,wanted_kind,r.id);
 IF r.company_ids IS DISTINCT FROM policy.company_ids THEN RAISE EXCEPTION 'AI admission company scope changed';END IF;
 IF wanted_root IS NOT NULL THEN
  IF wanted_request IS NULL THEN RAISE EXCEPTION 'AI native task request required';END IF;
  INSERT INTO app.ai_spend_root(tenant_id,root_id,kind) VALUES(tid,wanted_root,wanted_kind) ON CONFLICT DO NOTHING;
 END IF;
 IF policy.monetary_required THEN
  IF NOT EXISTS(SELECT 1 FROM app.ai_spend_reservation x WHERE x.run_id=r.id AND x.tenant_id=tid AND x.user_id=uid AND x.root_id=wanted_root AND x.request_digest=wanted_request AND x.configuration_digest=wanted_configuration AND x.state='held') THEN RAISE EXCEPTION 'Verified AI monetary reservation required';END IF;
 ELSE IF EXISTS(SELECT 1 FROM app.ai_spend_reservation x WHERE x.run_id=r.id) THEN RAISE EXCEPTION 'AI monetary policy changed';END IF;END IF;
 INSERT INTO app.ai_spend_admission_scope(run_id,tenant_id,user_id,company_ids,feature_id,root_id,root_kind,request_digest,configuration_digest,money_mode)
 VALUES(r.id,tid,uid,r.company_ids,r.feature_id,wanted_root,wanted_kind,wanted_request,wanted_configuration,CASE WHEN policy.monetary_required THEN 'capped' ELSE 'uncapped' END);
END $$;
REVOKE ALL ON FUNCTION app.ai_spend_record_admission(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_record_admission(uuid,uuid,text,text,text) TO ai_hr_app;
--> statement-breakpoint
-- Same canonical reservation and receipt contract. Only optional dimensions/missing tenant row differ.
CREATE OR REPLACE FUNCTION app.ai_spend_reserve(wanted_run uuid,wanted_root uuid,wanted_kind text,wanted_capability text,wanted_request text,wanted_nanos bigint,wanted_configuration text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();r ai_model_run;c app.ai_spend_capability;p app.ai_spend_budget;policy record;
 used numeric;root_used numeric;month_start timestamptz:=date_trunc('month',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur';
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR uid IS NULL OR wanted_kind NOT IN('agent','evaluation') OR wanted_root IS NULL OR wanted_request IS NULL OR wanted_request!~'^[a-f0-9]{64}$' OR wanted_nanos IS NULL OR wanted_nanos<=0 OR wanted_configuration IS NULL OR wanted_configuration!~'^[a-f0-9]{64}$'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'AI spend allocation unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 IF NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=uid AND u.tenant_id=tid AND u.archived_at IS NULL AND NOT app.login_blocked(uid)) THEN RAISE EXCEPTION 'AI spend allocation unavailable';END IF;
 SELECT * INTO r FROM ai_model_run WHERE id=wanted_run AND tenant_id=tid AND user_id=uid FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state<>'pending' OR NOT EXISTS(SELECT 1 FROM ai_model_run fresh WHERE fresh.id=r.id AND fresh.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'AI spend allocation requires this admission';END IF;
 SELECT * INTO STRICT policy FROM app._ai_spend_policy_context(r.feature_id,wanted_root,wanted_kind,r.id);
 IF NOT policy.monetary_required OR r.company_ids IS DISTINCT FROM policy.company_ids THEN RAISE EXCEPTION 'AI monetary policy unavailable';END IF;
 SELECT * INTO c FROM app.ai_spend_capability WHERE digest=wanted_capability AND provider=r.provider AND model=r.model AND operation=r.operation AND revoked_at IS NULL AND verified_at<=now() AND expires_at>now();
 IF NOT FOUND OR c.max_request_nanos<>wanted_nanos THEN RAISE EXCEPTION 'AI spend ceiling unavailable';END IF;
 IF EXISTS(SELECT 1 FROM app.ai_spend_reservation WHERE run_id=wanted_run) THEN RAISE EXCEPTION 'AI spend already reserved';END IF;
 INSERT INTO app.ai_spend_root(tenant_id,root_id,kind) VALUES(tid,wanted_root,wanted_kind) ON CONFLICT DO NOTHING;
 FOR p IN SELECT * FROM app.ai_spend_budget WHERE tenant_id=tid AND(kind='tenant' OR(kind='user' AND subject_id=uid) OR(kind='company' AND subject_id=ANY(r.company_ids)) OR(kind='feature' AND feature_id=r.feature_id)) ORDER BY scope_key LOOP
  SELECT coalesce(sum(CASE WHEN state='held' THEN reserved_nanos ELSE confirmed_nanos END),0) INTO used FROM app.ai_spend_reservation x WHERE x.tenant_id=tid AND(x.state='held' OR x.created_at>=month_start)
   AND(p.kind='tenant' OR(p.kind='user' AND x.user_id=uid) OR(p.kind='company' AND p.subject_id=ANY(x.company_ids)) OR(p.kind='feature' AND x.feature_id=p.feature_id));
  SELECT coalesce(sum(CASE WHEN state='held' THEN reserved_nanos ELSE confirmed_nanos END),0) INTO root_used FROM app.ai_spend_reservation x WHERE x.tenant_id=tid AND x.root_id=wanted_root;
  IF(p.monthly_nanos IS NOT NULL AND used+wanted_nanos>p.monthly_nanos) OR(p.root_nanos IS NOT NULL AND root_used+wanted_nanos>p.root_nanos) THEN RAISE EXCEPTION 'AI spend allocation exhausted';END IF;
 END LOOP;
 INSERT INTO app.ai_spend_reservation(run_id,tenant_id,root_id,user_id,company_ids,feature_id,capability_digest,request_digest,configuration_digest,reserved_nanos)
 VALUES(wanted_run,tid,wanted_root,uid,r.company_ids,r.feature_id,wanted_capability,wanted_request,wanted_configuration,wanted_nanos);
END $$;
REVOKE ALL ON FUNCTION app.ai_spend_reserve(uuid,uuid,text,text,text,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_reserve(uuid,uuid,text,text,text,bigint,text) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_spend_budget_save(wanted_kind text,wanted_subject uuid,wanted_feature text,monthly bigint,root_limit bigint)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();k text;
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR NOT app._ai_provider_evaluation_actor_valid() OR wanted_kind IS NULL OR wanted_kind NOT IN('tenant','user','company','feature') OR monthly<0 OR root_limit<0 THEN RAISE EXCEPTION 'AI spend administration unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 IF wanted_kind='tenant' THEN IF wanted_subject IS NOT NULL OR wanted_feature IS NOT NULL THEN RAISE EXCEPTION 'Invalid spend scope';END IF;k:='tenant';
 ELSIF wanted_kind='feature' THEN IF wanted_subject IS NOT NULL OR wanted_feature IS NULL OR wanted_feature NOT IN('provider_evaluation','module_agent_evaluation','module_agent_planning','hr_assistant','readiness_reminders','claims_triage','payroll_hypotheses','performance_assistant','performance_review') THEN RAISE EXCEPTION 'Invalid spend scope';END IF;k:='feature:'||wanted_feature;
 ELSE IF wanted_feature IS NOT NULL OR wanted_subject IS NULL OR(wanted_kind='user' AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=wanted_subject AND tenant_id=tid)) OR(wanted_kind='company' AND NOT EXISTS(SELECT 1 FROM company WHERE id=wanted_subject AND tenant_id=tid)) THEN RAISE EXCEPTION 'Invalid spend scope';END IF;k:=wanted_kind||':'||wanted_subject::text;END IF;
 IF monthly IS NULL AND root_limit IS NULL THEN DELETE FROM app.ai_spend_budget WHERE tenant_id=tid AND scope_key=k;
 ELSE INSERT INTO app.ai_spend_budget(tenant_id,scope_key,kind,subject_id,feature_id,monthly_nanos,root_nanos,updated_by) VALUES(tid,k,wanted_kind,wanted_subject,wanted_feature,monthly,root_limit,app.current_user_id())
  ON CONFLICT(tenant_id,scope_key) DO UPDATE SET monthly_nanos=excluded.monthly_nanos,root_nanos=excluded.root_nanos,updated_by=excluded.updated_by,updated_at=now();END IF;
END $$;
REVOKE ALL ON FUNCTION app.ai_spend_budget_save(text,uuid,text,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_budget_save(text,uuid,text,bigint,bigint) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_optional_spend_status() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE status jsonb;
BEGIN
 status:=app.ai_spend_status();
 RETURN status||jsonb_build_object('unpricedUnknownRuns',(SELECT count(*) FROM public.ai_model_run a WHERE a.tenant_id=app.current_tenant_id() AND a.state<>'blocked' AND NOT EXISTS(SELECT 1 FROM app.ai_spend_reservation paid WHERE paid.run_id=a.id)));
END $$;
REVOKE ALL ON FUNCTION app.ai_optional_spend_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_optional_spend_status() TO ai_hr_app;
