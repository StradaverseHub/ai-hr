-- UNALLOCATED / UNJOURNALED / UNAPPLIED. Requires0642 diagnostic configuration contract.
-- No journal/index/timestamp is inferred; release owner coordinates actual allocation.
-- Replace ONLY exact known parsed CHECK expressions, never a guessed generated constraint name.
DO $migration$
DECLARE expected text; actual_name text; targets integer;
BEGIN
 CREATE TEMP TABLE aihr_answer_constraint_oracle (LIKE public.ai_agent_candidate EXCLUDING CONSTRAINTS) ON COMMIT DROP;
 ALTER TABLE pg_temp.aihr_answer_constraint_oracle ADD CONSTRAINT expected_kind CHECK(kind IN('typed_route_priority_v1','read_plan_prompt_v1','canonical_specialist_v1'));
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT expected FROM pg_constraint WHERE conrelid='pg_temp.aihr_answer_constraint_oracle'::regclass AND conname='expected_kind';
 SELECT count(*),min(conname) INTO targets,actual_name FROM pg_constraint WHERE conrelid='public.ai_agent_candidate'::regclass AND contype='c' AND pg_get_expr(conbin,conrelid)=expected;
 IF targets<>1 THEN RAISE EXCEPTION 'Conversation candidate kind prerequisite changed';END IF;
 EXECUTE format('ALTER TABLE public.ai_agent_candidate DROP CONSTRAINT %I',actual_name);
 EXECUTE format('ALTER TABLE public.ai_agent_candidate ADD CONSTRAINT %I CHECK(kind IN(''typed_route_priority_v1'',''read_plan_prompt_v1'',''canonical_specialist_v1'',''assistant_answer_prompt_v1''))',actual_name);
 ALTER TABLE pg_temp.aihr_answer_constraint_oracle ADD CONSTRAINT expected_configuration CHECK((kind IN('typed_route_priority_v1','read_plan_prompt_v1') AND module_code='assistant') OR
 (kind='canonical_specialist_v1' AND module_code IN('employees','org','leave','ess','approvals','knowledge_base','payroll','attendance','claims','performance','rewards','lifecycle','toil','multi_cycle_payroll','typed_pay_components','country-my','notifications','system_explorer','assistant','system_testing') AND
 (configuration=jsonb_build_object('kind','canonical_specialist_v1','module',module_code,'playbook','canonical_domain_v1') OR configuration=jsonb_build_object('kind','canonical_specialist_v1','module',module_code,'playbook','canonical_followup_v1'))));
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT expected FROM pg_constraint WHERE conrelid='pg_temp.aihr_answer_constraint_oracle'::regclass AND conname='expected_configuration';
 SELECT count(*),min(conname) INTO targets,actual_name FROM pg_constraint WHERE conrelid='public.ai_agent_candidate'::regclass AND contype='c' AND pg_get_expr(conbin,conrelid)=expected;
 IF targets<>1 THEN RAISE EXCEPTION 'Conversation candidate configuration prerequisite changed';END IF;
 EXECUTE format('ALTER TABLE public.ai_agent_candidate DROP CONSTRAINT %I',actual_name);
 EXECUTE format('ALTER TABLE public.ai_agent_candidate ADD CONSTRAINT %I CHECK((kind IN(''typed_route_priority_v1'',''read_plan_prompt_v1'') AND module_code=''assistant'') OR
 (kind=''assistant_answer_prompt_v1'' AND module_code=''assistant'' AND (configuration=jsonb_build_object(''kind'',''assistant_answer_prompt_v1'',''variant'',''baseline_v1'') OR configuration=jsonb_build_object(''kind'',''assistant_answer_prompt_v1'',''variant'',''focused_v1''))) OR
 (kind=''canonical_specialist_v1'' AND module_code IN(''employees'',''org'',''leave'',''ess'',''approvals'',''knowledge_base'',''payroll'',''attendance'',''claims'',''performance'',''rewards'',''lifecycle'',''toil'',''multi_cycle_payroll'',''typed_pay_components'',''country-my'',''notifications'',''system_explorer'',''assistant'',''system_testing'') AND
 (configuration=jsonb_build_object(''kind'',''canonical_specialist_v1'',''module'',module_code,''playbook'',''canonical_domain_v1'') OR configuration=jsonb_build_object(''kind'',''canonical_specialist_v1'',''module'',module_code,''playbook'',''canonical_followup_v1''))))',actual_name);
 DROP TABLE pg_temp.aihr_answer_constraint_oracle;
END $migration$;
--> statement-breakpoint
CREATE TABLE public.ai_assistant_answer_evaluation_arm(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenant(id),candidate_id uuid NOT NULL,
 evaluator_user_id uuid NOT NULL REFERENCES public.app_user(id),evaluator_person_id uuid REFERENCES public.person(id) ON DELETE CASCADE,
 provider_fingerprint text NOT NULL CHECK(provider_fingerprint~'^[a-f0-9]{64}$'),suite_digest text NOT NULL CHECK(suite_digest~'^[a-f0-9]{64}$'),
 fixture_id text NOT NULL CHECK(length(fixture_id) BETWEEN 1 AND 160),arm text NOT NULL CHECK(arm IN('baseline','candidate')),
 passed boolean NOT NULL,receipt text NOT NULL CHECK(octet_length(receipt) BETWEEN 1 AND 16384),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '30 days'),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '31 days'),FOREIGN KEY(candidate_id,tenant_id) REFERENCES public.ai_agent_candidate(id,tenant_id) ON DELETE CASCADE,
 UNIQUE(tenant_id,candidate_id,evaluator_user_id,provider_fingerprint,suite_digest,fixture_id,arm)
);
CREATE INDEX ai_answer_arm_expiry ON public.ai_assistant_answer_evaluation_arm(expires_at,id);
ALTER TABLE public.ai_assistant_answer_evaluation_arm ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_assistant_answer_evaluation_arm FORCE ROW LEVEL SECURITY;
CREATE POLICY answer_arm_read ON public.ai_assistant_answer_evaluation_arm FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND (evaluator_user_id=app.current_user_id() OR app.is_group_admin()));
CREATE POLICY answer_arm_create ON public.ai_assistant_answer_evaluation_arm FOR INSERT TO ai_hr_app WITH CHECK(tenant_id=app.current_tenant_id() AND evaluator_user_id=app.current_user_id() AND app.principal_snapshot_current() AND app.is_group_admin() AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=ai_assistant_answer_evaluation_arm.evaluator_user_id AND a.tenant_id=ai_assistant_answer_evaluation_arm.tenant_id AND a.person_id IS NOT DISTINCT FROM ai_assistant_answer_evaluation_arm.evaluator_person_id) AND EXISTS(SELECT 1 FROM public.ai_agent_candidate c WHERE c.id=ai_assistant_answer_evaluation_arm.candidate_id AND c.tenant_id=ai_assistant_answer_evaluation_arm.tenant_id AND c.kind='assistant_answer_prompt_v1' AND c.author_user_id<>app.current_user_id()));
CREATE POLICY answer_arm_retry ON public.ai_assistant_answer_evaluation_arm FOR UPDATE TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND evaluator_user_id=app.current_user_id() AND app.principal_snapshot_current() AND app.is_group_admin() AND NOT passed) WITH CHECK(tenant_id=app.current_tenant_id() AND evaluator_user_id=app.current_user_id() AND app.principal_snapshot_current() AND app.is_group_admin());
CREATE POLICY answer_arm_erase ON public.ai_assistant_answer_evaluation_arm FOR DELETE TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND evaluator_user_id=app.current_user_id());
REVOKE ALL ON public.ai_assistant_answer_evaluation_arm FROM PUBLIC,ai_hr_app;
-- App INSERT cannot choose created_at/expires_at: a future created_at would satisfy the 31-day CHECK
-- while keeping checkpoint metadata beyond its retention bound. Upsert retry still updates only these two.
GRANT SELECT,DELETE ON public.ai_assistant_answer_evaluation_arm TO ai_hr_app;
GRANT INSERT(id,tenant_id,candidate_id,evaluator_user_id,evaluator_person_id,provider_fingerprint,suite_digest,fixture_id,arm,passed,receipt) ON public.ai_assistant_answer_evaluation_arm TO ai_hr_app;
GRANT UPDATE(passed,receipt) ON public.ai_assistant_answer_evaluation_arm TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE public.ai_assistant_answer_evaluation_intent(
 id uuid PRIMARY KEY,incarnation bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),candidate_id uuid NOT NULL,
 evaluator_user_id uuid NOT NULL REFERENCES public.app_user(id),evaluator_person_id uuid REFERENCES public.person(id) ON DELETE CASCADE,
 source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),provider_fingerprint text NOT NULL CHECK(provider_fingerprint~'^[a-f0-9]{64}$'),suite_digest text NOT NULL CHECK(suite_digest~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','completed')),evaluation_id uuid UNIQUE REFERENCES public.ai_agent_evaluation(id) ON DELETE CASCADE,
 receipt text NOT NULL CHECK(octet_length(receipt) BETWEEN 1 AND 8192),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '30 days'),
 FOREIGN KEY(candidate_id,tenant_id) REFERENCES public.ai_agent_candidate(id,tenant_id) ON DELETE CASCADE,
 CHECK((state='pending' AND evaluation_id IS NULL) OR(state='completed' AND evaluation_id IS NOT NULL)),CHECK(expires_at>created_at AND expires_at<=created_at+interval '31 days')
);
ALTER TABLE public.ai_assistant_answer_evaluation_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_assistant_answer_evaluation_intent FORCE ROW LEVEL SECURITY;
CREATE INDEX answer_evaluation_intent_expiry ON public.ai_assistant_answer_evaluation_intent(expires_at,id);
CREATE POLICY answer_intent_read ON public.ai_assistant_answer_evaluation_intent FOR SELECT TO PUBLIC USING(tenant_id=app.current_tenant_id() AND evaluator_user_id=app.current_user_id() AND app.principal_snapshot_current());
CREATE POLICY answer_intent_create ON public.ai_assistant_answer_evaluation_intent FOR INSERT TO ai_hr_app WITH CHECK(tenant_id=app.current_tenant_id() AND evaluator_user_id=app.current_user_id() AND app.principal_snapshot_current() AND app.is_group_admin() AND state='pending' AND evaluation_id IS NULL AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=ai_assistant_answer_evaluation_intent.evaluator_user_id AND a.tenant_id=ai_assistant_answer_evaluation_intent.tenant_id AND a.person_id IS NOT DISTINCT FROM ai_assistant_answer_evaluation_intent.evaluator_person_id) AND EXISTS(SELECT 1 FROM public.ai_agent_candidate c WHERE c.id=ai_assistant_answer_evaluation_intent.candidate_id AND c.tenant_id=ai_assistant_answer_evaluation_intent.tenant_id AND c.kind='assistant_answer_prompt_v1' AND c.author_user_id<>app.current_user_id()));
CREATE POLICY answer_intent_finish ON public.ai_assistant_answer_evaluation_intent FOR UPDATE TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND evaluator_user_id=app.current_user_id() AND state='pending' AND app.principal_snapshot_current() AND app.is_group_admin()) WITH CHECK(tenant_id=app.current_tenant_id() AND evaluator_user_id=app.current_user_id() AND state='completed' AND EXISTS(SELECT 1 FROM public.ai_agent_evaluation e WHERE e.id=ai_assistant_answer_evaluation_intent.evaluation_id AND e.tenant_id=ai_assistant_answer_evaluation_intent.tenant_id AND e.candidate_id=ai_assistant_answer_evaluation_intent.candidate_id AND e.evaluator_user_id=ai_assistant_answer_evaluation_intent.evaluator_user_id AND e.suite_digest=ai_assistant_answer_evaluation_intent.suite_digest AND e.xmin=pg_current_xact_id()::xid));
CREATE POLICY answer_intent_erase ON public.ai_assistant_answer_evaluation_intent FOR DELETE TO PUBLIC USING(tenant_id=app.current_tenant_id() AND evaluator_user_id=app.current_user_id() AND app.principal_snapshot_current());
REVOKE ALL ON public.ai_assistant_answer_evaluation_intent FROM PUBLIC,ai_hr_app;
GRANT SELECT,DELETE ON public.ai_assistant_answer_evaluation_intent TO ai_hr_app;
GRANT INSERT(id,tenant_id,candidate_id,evaluator_user_id,evaluator_person_id,source_digest,provider_fingerprint,suite_digest,receipt) ON public.ai_assistant_answer_evaluation_intent TO ai_hr_app;
GRANT UPDATE(state,evaluation_id) ON public.ai_assistant_answer_evaluation_intent TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE public.ai_assistant_answer_strategy_use(
 id uuid PRIMARY KEY,incarnation bigint GENERATED ALWAYS AS IDENTITY NOT NULL,tenant_id uuid NOT NULL REFERENCES public.tenant(id),user_id uuid NOT NULL REFERENCES public.app_user(id),person_id uuid REFERENCES public.person(id) ON DELETE CASCADE,
 promotion_id uuid REFERENCES public.ai_agent_promotion(id),candidate_digest text NOT NULL CHECK(candidate_digest~'^[a-f0-9]{64}$'),provider_fingerprint text NOT NULL CHECK(provider_fingerprint~'^[a-f0-9]{64}$'),source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','completed')),exchange_id uuid UNIQUE REFERENCES public.assistant_exchange(id) ON DELETE CASCADE,
 receipt text NOT NULL CHECK(octet_length(receipt) BETWEEN 1 AND 8192),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '30 days'),
 CHECK((state='pending' AND exchange_id IS NULL) OR(state='completed' AND exchange_id IS NOT NULL)),CHECK(expires_at>created_at AND expires_at<=created_at+interval '31 days')
);
CREATE INDEX ai_answer_use_expiry ON public.ai_assistant_answer_strategy_use(expires_at,id);
ALTER TABLE public.ai_assistant_answer_strategy_use ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_assistant_answer_strategy_use FORCE ROW LEVEL SECURITY;
CREATE POLICY answer_use_read ON public.ai_assistant_answer_strategy_use FOR SELECT TO PUBLIC USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current());
CREATE POLICY answer_use_create ON public.ai_assistant_answer_strategy_use FOR INSERT TO ai_hr_app WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND state='pending' AND exchange_id IS NULL AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=ai_assistant_answer_strategy_use.user_id AND a.tenant_id=ai_assistant_answer_strategy_use.tenant_id AND a.person_id IS NOT DISTINCT FROM ai_assistant_answer_strategy_use.person_id) AND(promotion_id IS NULL OR EXISTS(SELECT 1 FROM public.ai_agent_promotion actual WHERE actual.id=ai_assistant_answer_strategy_use.promotion_id AND actual.tenant_id=ai_assistant_answer_strategy_use.tenant_id AND actual.owner_user_id=ai_assistant_answer_strategy_use.user_id)));
CREATE POLICY answer_use_complete ON public.ai_assistant_answer_strategy_use FOR UPDATE TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND state='pending' AND app.principal_snapshot_current()) WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND state='completed' AND EXISTS(SELECT 1 FROM public.assistant_exchange e WHERE e.id=ai_assistant_answer_strategy_use.exchange_id AND e.tenant_id=ai_assistant_answer_strategy_use.tenant_id AND e.app_user_id=ai_assistant_answer_strategy_use.user_id AND e.xmin=pg_current_xact_id()::xid));
CREATE POLICY answer_use_erase ON public.ai_assistant_answer_strategy_use FOR DELETE TO PUBLIC USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current());
REVOKE ALL ON public.ai_assistant_answer_strategy_use FROM PUBLIC,ai_hr_app;
GRANT SELECT,DELETE ON public.ai_assistant_answer_strategy_use TO ai_hr_app;
GRANT INSERT(id,tenant_id,user_id,person_id,promotion_id,candidate_digest,provider_fingerprint,source_digest,receipt) ON public.ai_assistant_answer_strategy_use TO ai_hr_app;
GRANT UPDATE(state,exchange_id) ON public.ai_assistant_answer_strategy_use TO ai_hr_app;
--> statement-breakpoint
-- No role/bypass grant: ordinary physical owners maintain expired rows only, including UPDATE
-- visibility needed solely for the runner's existing FOR UPDATE SKIP LOCKED deletion batches.
DO $policies$
DECLARE relation_name text;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['ai_assistant_answer_evaluation_arm','ai_assistant_answer_strategy_use','ai_assistant_answer_evaluation_intent'] LOOP
  EXECUTE format('CREATE POLICY answer_expired_owner_read ON public.%I FOR SELECT TO PUBLIC USING(expires_at<=clock_timestamp() AND current_user=session_user AND session_user<>''ai_hr_app'' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=%L::regclass)))',relation_name,'public.'||relation_name);
  EXECUTE format('CREATE POLICY answer_expired_owner_update ON public.%I FOR UPDATE TO PUBLIC USING(expires_at<=clock_timestamp() AND current_user=session_user AND session_user<>''ai_hr_app'' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=%L::regclass))) WITH CHECK(expires_at<=clock_timestamp())',relation_name,'public.'||relation_name);
  EXECUTE format('CREATE POLICY answer_expired_owner_delete ON public.%I FOR DELETE TO PUBLIC USING(expires_at<=clock_timestamp() AND current_user=session_user AND session_user<>''ai_hr_app'' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=%L::regclass)))',relation_name,'public.'||relation_name);
 END LOOP;
END $policies$;
--> statement-breakpoint
-- History erasure invalidates ALL same-user inflight bindings, including baseline questions.
-- This trigger accepts no target argument, does not recreate markers and refunds no consumed job.
CREATE FUNCTION app.answer_strategy_history_erased() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN IF OLD.tenant_id=app.current_tenant_id() AND OLD.app_user_id=app.current_user_id() AND app.principal_snapshot_current() THEN DELETE FROM public.ai_assistant_answer_strategy_use WHERE tenant_id=OLD.tenant_id AND user_id=OLD.app_user_id;END IF;RETURN NULL;END $$;
REVOKE ALL ON FUNCTION app.answer_strategy_history_erased() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_answer_strategy_history_erased AFTER DELETE ON public.assistant_exchange FOR EACH ROW EXECUTE FUNCTION app.answer_strategy_history_erased();
--> statement-breakpoint
-- Same-Tx PDPA participation reuses the existing actual canonical erasure admission/audit. Original
-- effect-time PERSON and currently linked PERSON are independent predicates; no broad historical USER
-- expansion can delete a new person's unrelated later rows after an account relink.
CREATE FUNCTION app._answer_metadata_erasure_authorized(wanted_tenant uuid,original_person uuid,wanted_user uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND wanted_tenant=app.current_tenant_id() AND EXISTS(
 SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=wanted_tenant AND i.user_id=app.current_user_id() AND app.can_admin_employment(i.employment_id)
 AND (i.person_id=original_person OR EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=wanted_user AND a.tenant_id=wanted_tenant AND a.person_id=i.person_id)))
$$;
REVOKE ALL ON FUNCTION app._answer_metadata_erasure_authorized(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app._answer_metadata_erasure_authorized(uuid,uuid,uuid) TO ai_hr_app;
CREATE POLICY answer_arm_pdpa_read ON public.ai_assistant_answer_evaluation_arm FOR SELECT TO PUBLIC USING(app._answer_metadata_erasure_authorized(tenant_id,evaluator_person_id,evaluator_user_id));
CREATE POLICY answer_use_pdpa_read ON public.ai_assistant_answer_strategy_use FOR SELECT TO PUBLIC USING(app._answer_metadata_erasure_authorized(tenant_id,person_id,user_id));
CREATE POLICY answer_intent_pdpa_read ON public.ai_assistant_answer_evaluation_intent FOR SELECT TO PUBLIC USING(app._answer_metadata_erasure_authorized(tenant_id,evaluator_person_id,evaluator_user_id));
CREATE POLICY answer_intent_pdpa_delete ON public.ai_assistant_answer_evaluation_intent FOR DELETE TO PUBLIC USING(app._answer_metadata_erasure_authorized(tenant_id,evaluator_person_id,evaluator_user_id));
CREATE POLICY answer_arm_pdpa_delete ON public.ai_assistant_answer_evaluation_arm FOR DELETE TO PUBLIC USING(app._answer_metadata_erasure_authorized(tenant_id,evaluator_person_id,evaluator_user_id));
CREATE POLICY answer_use_pdpa_delete ON public.ai_assistant_answer_strategy_use FOR DELETE TO PUBLIC USING(app._answer_metadata_erasure_authorized(tenant_id,person_id,user_id));
CREATE TABLE app.assistant_answer_erasure_intent(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,person_id uuid NOT NULL,employment_id uuid NOT NULL,cleared integer NOT NULL CHECK(cleared>=0),PRIMARY KEY(xact_id,tenant_id,person_id));
REVOKE ALL ON app.assistant_answer_erasure_intent FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.assistant_conversation_metadata_redact(subject_employment uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.assistant_review_erasure_intent%ROWTYPE;n integer:=0;k integer:=0;
BEGIN
 SELECT * INTO i FROM app.assistant_review_erasure_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND employment_id=subject_employment;
 IF NOT FOUND OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(subject_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Conversation metadata erasure unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM public.ai_assistant_answer_evaluation_arm a WHERE a.tenant_id=i.tenant_id AND(a.evaluator_person_id=i.person_id OR EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=a.evaluator_user_id AND u.tenant_id=i.tenant_id AND u.person_id=i.person_id));GET DIAGNOSTICS n=ROW_COUNT;
 DELETE FROM public.ai_assistant_answer_strategy_use a WHERE a.tenant_id=i.tenant_id AND(a.person_id=i.person_id OR EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=a.user_id AND u.tenant_id=i.tenant_id AND u.person_id=i.person_id));GET DIAGNOSTICS k=ROW_COUNT;n:=n+k;
 DELETE FROM public.ai_assistant_answer_evaluation_intent a WHERE a.tenant_id=i.tenant_id AND(a.evaluator_person_id=i.person_id OR EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=a.evaluator_user_id AND u.tenant_id=i.tenant_id AND u.person_id=i.person_id));GET DIAGNOSTICS k=ROW_COUNT;n:=n+k;
 INSERT INTO app.assistant_answer_erasure_intent VALUES(pg_current_xact_id(),i.tenant_id,i.user_id,i.person_id,i.employment_id,n);
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.assistant_conversation_metadata_redact(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_conversation_metadata_redact(uuid) TO ai_hr_app;
CREATE FUNCTION app.assistant_answer_erasure_audited() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event_id uuid;
BEGIN
 SELECT i.event_id INTO event_id FROM app.assistant_review_erasure_intent i WHERE i.xact_id=NEW.xact_id AND i.tenant_id=NEW.tenant_id AND i.user_id=NEW.user_id AND i.person_id=NEW.person_id AND i.employment_id=NEW.employment_id;
 IF event_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.id=event_id AND e.tenant_id=NEW.tenant_id AND e.event_type='pii.erased' AND e.aggregate_type='person' AND e.aggregate_id=NEW.person_id AND e.actor_id=NEW.user_id AND e.subject_employment_id=NEW.employment_id AND coalesce(e.payload->'erasedFields' ? 'assistantConversationLearning',false)=(NEW.cleared>0)) THEN RAISE EXCEPTION 'Conversation metadata erasure audit unavailable' USING ERRCODE='42501';END IF;
 -- The existing0622 barrier remains after this temporary audit row retires, including after an
 -- explicit SET CONSTRAINTS IMMEDIATE. Later same-Tx metadata capture must still refuse below.
 DELETE FROM app.assistant_answer_erasure_intent WHERE xact_id=NEW.xact_id AND tenant_id=NEW.tenant_id AND person_id=NEW.person_id;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.assistant_answer_erasure_audited() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER assistant_answer_erasure_audited AFTER INSERT ON app.assistant_answer_erasure_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assistant_answer_erasure_audited();
CREATE FUNCTION app.answer_metadata_capture_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p uuid;u uuid;t uuid;
BEGIN
 t:=NEW.tenant_id;IF TG_TABLE_NAME='ai_assistant_answer_strategy_use' THEN p:=NEW.person_id;u:=NEW.user_id;ELSE p:=NEW.evaluator_person_id;u:=NEW.evaluator_user_id;END IF;
 IF EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND(i.person_id=p OR EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.person_id=i.person_id))) OR EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=t AND e.event_type='pii.erased' AND e.aggregate_type='person' AND e.xmin=pg_current_xact_id()::xid AND(e.aggregate_id=p OR EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.person_id=e.aggregate_id))) THEN RAISE EXCEPTION 'Conversation metadata capture unavailable after erasure' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' THEN IF TG_TABLE_NAME='ai_assistant_answer_evaluation_arm' THEN IF OLD.passed THEN RAISE EXCEPTION 'Passing conversation evidence is immutable' USING ERRCODE='42501';END IF;END IF;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.answer_metadata_capture_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER answer_arm_capture_guard BEFORE INSERT OR UPDATE ON public.ai_assistant_answer_evaluation_arm FOR EACH ROW EXECUTE FUNCTION app.answer_metadata_capture_guard();
CREATE TRIGGER answer_use_capture_guard BEFORE INSERT OR UPDATE ON public.ai_assistant_answer_strategy_use FOR EACH ROW EXECUTE FUNCTION app.answer_metadata_capture_guard();
CREATE TRIGGER answer_intent_capture_guard BEFORE INSERT OR UPDATE ON public.ai_assistant_answer_evaluation_intent FOR EACH ROW EXECUTE FUNCTION app.answer_metadata_capture_guard();
--> statement-breakpoint
-- Identity-only metadata invalidation bridge for the actual own transcript redaction owner. No
-- target is posted; no Assistant grant/module/provider admission or financial refund is inferred.
-- SINGLE shared owner (evaluation fence). Scope: the CURRENT app user's strategy-use markers AND
-- evaluation intents, pending or completed, in the current tenant; checkpoint arms are not deleted
-- (explicit metadata erase and PDPA own those). Lock order: callers take blocking exclusive Access
-- first (assistant_transcripts_erase_own / assertAiPrincipalTx); this TRY then re-enters it, and the
-- intent custody trigger re-enters again. Without prior Access a competing holder refuses 55P03.
CREATE FUNCTION app.assistant_answer_invalidate_own_strategy_uses() RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();n integer;k integer;
BEGIN
 IF t IS NULL OR u IS NULL OR app.principal_snapshot_current() IS NOT TRUE OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Conversation metadata retirement unavailable' USING ERRCODE='42501';END IF;
 -- First source phase, or reentrant under the admitted transcript owner's existing Access interval.
 -- A competing actor/admission is a whole-command refusal, never a wait/partial-success erasure.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0)) THEN RAISE EXCEPTION 'Conversation metadata retirement is busy' USING ERRCODE='55P03';END IF;
 DELETE FROM public.ai_assistant_answer_strategy_use WHERE tenant_id=t AND user_id=u;GET DIAGNOSTICS n=ROW_COUNT;
 DELETE FROM public.ai_assistant_answer_evaluation_intent WHERE tenant_id=t AND evaluator_user_id=u;GET DIAGNOSTICS k=ROW_COUNT;RETURN n+k;
END $$;
REVOKE ALL ON FUNCTION app.assistant_answer_invalidate_own_strategy_uses() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_answer_invalidate_own_strategy_uses() TO ai_hr_app;

--> statement-breakpoint
-- A copied id/ciphertext cannot resurrect an old in-process marker. Identity incarnation always
-- advances on INSERT, and app INSERT/UPDATE column grants cannot override it or rewind its sequence.
DO $incarnations$
DECLARE relation_name text;sequence_name text;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['ai_assistant_answer_strategy_use','ai_assistant_answer_evaluation_intent'] LOOP
  SELECT pg_get_serial_sequence('public.'||relation_name,'incarnation') INTO sequence_name;
  IF sequence_name IS NULL THEN RAISE EXCEPTION 'Conversation marker incarnation unavailable';END IF;
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC,ai_hr_app',sequence_name);
 END LOOP;
END $incarnations$;
-- Every physical intent deletion (including FK/PDPA/owner expiry) joins exclusive Access. Source
-- admissions/checkpoints already own shared Access, so marker presence cannot race within their Tx.
CREATE FUNCTION app.answer_evaluation_intent_custody() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;owned boolean;
BEGIN
 IF TG_OP='DELETE' THEN t:=OLD.tenant_id;SELECT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0)) INTO owned;
 ELSE t:=NEW.tenant_id;SELECT pg_try_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0)) INTO owned;END IF;
 IF owned IS NOT TRUE THEN RAISE EXCEPTION 'Conversation evaluation custody is busy' USING ERRCODE='55P03';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.answer_evaluation_intent_custody() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER answer_evaluation_intent_custody BEFORE INSERT OR UPDATE OR DELETE ON public.ai_assistant_answer_evaluation_intent FOR EACH ROW EXECUTE FUNCTION app.answer_evaluation_intent_custody();
