-- Centrally reserved source-only: 0627_module_agent_improvement, journal idx 620, timestamp 1793023949850.
-- UNJOURNALED / UNAPPLIED. Supersedes surrendered AI0613-0620 reservations.
-- Preserve frozen0612 and human0620_onehr_panel_manager_anonymity (idx613/1793023949843).
-- Refresh canonical prefix and actual staging watermark before release-owner journal/application.
CREATE TABLE public.ai_agent_candidate (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 owner_user_id uuid NOT NULL REFERENCES public.app_user(id), author_user_id uuid NOT NULL REFERENCES public.app_user(id),
 module_code text NOT NULL, version integer NOT NULL CHECK(version>0),
 kind text NOT NULL CHECK(kind IN('typed_route_priority_v1','read_plan_prompt_v1')), configuration jsonb NOT NULL,
 candidate_digest text NOT NULL CHECK(candidate_digest~'^[a-f0-9]{64}$'),
 baseline_digest text NOT NULL CHECK(baseline_digest~'^[a-f0-9]{64}$'),
 source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 engine_digest text NOT NULL CHECK(engine_digest~'^[a-f0-9]{64}$'),
 policy_digest text NOT NULL CHECK(policy_digest~'^[a-f0-9]{64}$'),
 input_digest text NOT NULL CHECK(input_digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id),UNIQUE(tenant_id,owner_user_id,module_code,version)
);
--> statement-breakpoint
CREATE TABLE public.ai_agent_evaluation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 candidate_id uuid NOT NULL,evaluator_user_id uuid NOT NULL REFERENCES public.app_user(id),
 suite_digest text NOT NULL CHECK(suite_digest~'^[a-f0-9]{64}$'),
 receipt text NOT NULL CHECK(length(receipt) BETWEEN 1 AND 65536),
 completed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(candidate_id,tenant_id) REFERENCES public.ai_agent_candidate(id,tenant_id)
);
--> statement-breakpoint
CREATE TABLE public.ai_agent_promotion (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 candidate_id uuid NOT NULL,owner_user_id uuid NOT NULL REFERENCES public.app_user(id),module_code text NOT NULL,
 approver_user_id uuid NOT NULL REFERENCES public.app_user(id),
 receipt text NOT NULL CHECK(length(receipt) BETWEEN 1 AND 65536),
 max_jobs integer NOT NULL CHECK(max_jobs BETWEEN 1 AND 100),used_jobs integer NOT NULL DEFAULT 0 CHECK(used_jobs>=0 AND used_jobs<=max_jobs),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(candidate_id,tenant_id) REFERENCES public.ai_agent_candidate(id,tenant_id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
--> statement-breakpoint
CREATE TABLE public.ai_agent_rollback (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 promotion_id uuid NOT NULL REFERENCES public.ai_agent_promotion(id),actor_user_id uuid NOT NULL REFERENCES public.app_user(id),
 reason text NOT NULL CHECK(reason IN ('human','security_regression','quality_regression','source_changed','expired','exhausted')),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(promotion_id)
);
--> statement-breakpoint
ALTER TABLE public.ai_agent_candidate ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_candidate FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_evaluation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_evaluation FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_promotion ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_promotion FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_rollback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_rollback FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ai_agent_candidate_read ON public.ai_agent_candidate FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND (owner_user_id=app.current_user_id() OR app.is_group_admin()));
CREATE POLICY ai_agent_candidate_create ON public.ai_agent_candidate FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND owner_user_id=app.current_user_id() AND author_user_id=app.current_user_id() AND app.is_group_admin());
CREATE POLICY ai_agent_evaluation_read ON public.ai_agent_evaluation FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND app.is_group_admin());
CREATE POLICY ai_agent_evaluation_create ON public.ai_agent_evaluation FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND evaluator_user_id=app.current_user_id() AND app.is_group_admin()
 AND EXISTS(SELECT 1 FROM public.ai_agent_candidate c WHERE c.id=candidate_id AND c.tenant_id=ai_agent_evaluation.tenant_id AND c.author_user_id<>app.current_user_id()));
CREATE POLICY ai_agent_promotion_read ON public.ai_agent_promotion FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND (owner_user_id=app.current_user_id() OR app.is_group_admin()));
CREATE POLICY ai_agent_promotion_create ON public.ai_agent_promotion FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND approver_user_id=app.current_user_id() AND app.is_group_admin());
CREATE POLICY ai_agent_promotion_consume ON public.ai_agent_promotion FOR UPDATE TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND owner_user_id=app.current_user_id())
 WITH CHECK(tenant_id=app.current_tenant_id() AND owner_user_id=app.current_user_id());
CREATE POLICY ai_agent_rollback_read ON public.ai_agent_rollback FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND (app.is_group_admin() OR EXISTS(SELECT 1 FROM public.ai_agent_promotion p WHERE p.id=promotion_id AND p.tenant_id=ai_agent_rollback.tenant_id AND p.owner_user_id=app.current_user_id())));
CREATE POLICY ai_agent_rollback_create ON public.ai_agent_rollback FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id()
 AND (app.is_group_admin() OR (reason='source_changed' AND EXISTS(SELECT 1 FROM public.ai_agent_promotion p WHERE p.id=promotion_id AND p.tenant_id=ai_agent_rollback.tenant_id AND p.owner_user_id=app.current_user_id()))));
--> statement-breakpoint
REVOKE ALL ON public.ai_agent_candidate,public.ai_agent_evaluation,public.ai_agent_promotion,public.ai_agent_rollback FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON public.ai_agent_candidate,public.ai_agent_evaluation,public.ai_agent_promotion,public.ai_agent_rollback TO ai_hr_app;
GRANT UPDATE(used_jobs) ON public.ai_agent_promotion TO ai_hr_app;

--> statement-breakpoint
CREATE TABLE public.ai_agent_job_receipt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 user_id uuid NOT NULL REFERENCES public.app_user(id),promotion_id uuid REFERENCES public.ai_agent_promotion(id),
 -- v1 synthetic/audit receipts retain NULL lifecycle metadata; only v2 commands reopen as jobs.
 request_nonce uuid,requested_plan_digest text CHECK(requested_plan_digest~'^[a-f0-9]{64}$'),
 expires_at timestamptz,
 receipt text NOT NULL CHECK(length(receipt) BETWEEN 1 AND 65536),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((request_nonce IS NULL AND requested_plan_digest IS NULL AND expires_at IS NULL) OR
  (request_nonce IS NOT NULL AND requested_plan_digest IS NOT NULL AND expires_at IS NOT NULL AND expires_at>created_at AND expires_at<=created_at+interval '720 hours')),
 UNIQUE(tenant_id,user_id,request_nonce)
);
--> statement-breakpoint
ALTER TABLE public.ai_agent_job_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_job_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_agent_job_own ON public.ai_agent_job_receipt FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id());
CREATE POLICY ai_agent_job_create ON public.ai_agent_job_receipt FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id()
 AND (promotion_id IS NULL OR EXISTS(SELECT 1 FROM public.ai_agent_promotion p WHERE p.id=promotion_id AND p.tenant_id=ai_agent_job_receipt.tenant_id AND p.owner_user_id=app.current_user_id())));
REVOKE ALL ON public.ai_agent_job_receipt FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON public.ai_agent_job_receipt TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.guard_agent_permit_increment() RETURNS trigger LANGUAGE plpgsql
 SET search_path=public,pg_temp AS $$ BEGIN
 IF NEW.used_jobs<>OLD.used_jobs+1 THEN RAISE EXCEPTION 'Agent permit transition refused';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_agent_permit_increment() FROM PUBLIC;
CREATE TRIGGER ai_agent_permit_monotonic BEFORE UPDATE ON public.ai_agent_promotion
 FOR EACH ROW EXECUTE FUNCTION app.guard_agent_permit_increment();

--> statement-breakpoint
CREATE INDEX ai_agent_evaluation_latest ON public.ai_agent_evaluation(candidate_id,evaluator_user_id,completed_at DESC,id DESC);

--> statement-breakpoint
CREATE INDEX ai_agent_job_expiry ON public.ai_agent_job_receipt(tenant_id,expires_at,id) WHERE expires_at IS NOT NULL;

--> statement-breakpoint
-- Explicit own opinions, never evaluator PASS or HR/model training text.
CREATE TABLE public.ai_agent_job_feedback (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 user_id uuid NOT NULL REFERENCES public.app_user(id),job_id uuid NOT NULL REFERENCES public.ai_agent_job_receipt(id) ON DELETE CASCADE,
 outcome text NOT NULL CHECK(outcome IN('helpful','needs_correction','incorrect')),consented boolean NOT NULL CHECK(consented),
 receipt text NOT NULL CHECK(length(receipt) BETWEEN 1 AND 65536),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '720 hours'),UNIQUE(tenant_id,user_id,job_id)
);
--> statement-breakpoint
CREATE TABLE public.ai_agent_candidate_provenance (
 candidate_id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenant(id),owner_user_id uuid NOT NULL REFERENCES public.app_user(id),
 refs jsonb NOT NULL CHECK(jsonb_typeof(refs)='array' AND jsonb_array_length(refs)<=10),
 receipt text NOT NULL CHECK(length(receipt) BETWEEN 1 AND 65536),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(candidate_id,tenant_id) REFERENCES public.ai_agent_candidate(id,tenant_id)
);
--> statement-breakpoint
ALTER TABLE public.ai_agent_job_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_job_feedback FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_candidate_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_candidate_provenance FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_agent_job_feedback_own ON public.ai_agent_job_feedback FOR ALL TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id())
 WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND EXISTS(
  SELECT 1 FROM public.ai_agent_job_receipt j WHERE j.id=job_id AND j.tenant_id=ai_agent_job_feedback.tenant_id AND j.user_id=app.current_user_id() AND j.request_nonce IS NOT NULL AND j.expires_at>now()));
CREATE POLICY ai_agent_provenance_read ON public.ai_agent_candidate_provenance FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND(owner_user_id=app.current_user_id() OR app.is_group_admin()));
CREATE POLICY ai_agent_provenance_create ON public.ai_agent_candidate_provenance FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND owner_user_id=app.current_user_id() AND app.is_group_admin() AND EXISTS(
  SELECT 1 FROM public.ai_agent_candidate c WHERE c.id=candidate_id AND c.tenant_id=ai_agent_candidate_provenance.tenant_id AND c.owner_user_id=app.current_user_id() AND c.author_user_id=app.current_user_id()));
REVOKE ALL ON public.ai_agent_job_feedback,public.ai_agent_candidate_provenance FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,DELETE ON public.ai_agent_job_feedback TO ai_hr_app;
GRANT UPDATE(outcome,receipt,created_at,expires_at) ON public.ai_agent_job_feedback TO ai_hr_app;
GRANT SELECT,INSERT ON public.ai_agent_candidate_provenance TO ai_hr_app;
--> statement-breakpoint
-- FORCE-RLS definer policies expose no generic reader. The only EXECUTE surface below returns BOOL
-- for refs ALREADY bound to one currently visible candidate; application SQL keeps own-only feedback.
CREATE POLICY ai_agent_candidate_signal_owner ON public.ai_agent_candidate FOR SELECT TO PUBLIC
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_candidate'::regclass))
  AND tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND(owner_user_id=app.current_user_id() OR app.is_group_admin()));
CREATE POLICY ai_agent_provenance_signal_owner ON public.ai_agent_candidate_provenance FOR SELECT TO PUBLIC
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_candidate_provenance'::regclass))
  AND tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND(owner_user_id=app.current_user_id() OR app.is_group_admin()));
-- This BOOL surface moves cross-table policy SQL behind an early actual-principal guard.
-- A physical maintenance owner without an app identity must not need candidate SELECT merely
-- to plan its own expired-only RLS query. No job/feedback query occurs here (no RLS recursion).
CREATE FUNCTION app.agent_signal_custody_visible(wanted_kind text,wanted_id uuid,wanted_tenant uuid,wanted_owner uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
BEGIN
 IF wanted_kind IS NULL OR wanted_kind NOT IN('job','feedback') OR wanted_id IS NULL
  OR wanted_tenant IS NULL OR wanted_owner IS NULL THEN RETURN false;END IF;
 IF app.current_user_id() IS NULL OR app.current_tenant_id() IS NULL THEN RETURN false;END IF;
 IF wanted_tenant IS DISTINCT FROM app.current_tenant_id() OR app.principal_snapshot_current() IS DISTINCT FROM true
  OR current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.ai_agent_candidate c JOIN public.ai_agent_candidate_provenance p
  ON p.candidate_id=c.id AND p.tenant_id=c.tenant_id AND p.owner_user_id=c.owner_user_id
  WHERE c.tenant_id=wanted_tenant AND c.owner_user_id=wanted_owner
   AND(c.owner_user_id=app.current_user_id() OR app.is_group_admin())
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.refs) r
    WHERE CASE wanted_kind WHEN 'job' THEN r->>'jobId' ELSE r->>'id' END=wanted_id::text));
END $$;
REVOKE ALL ON FUNCTION app.agent_signal_custody_visible(text,uuid,uuid,uuid) FROM PUBLIC;
-- Trusted app role only. A separately provisioned physical maintenance table owner requires
-- explicit EXECUTE on this one guarded helper; table ownership alone never grants candidate
-- SELECT, app membership, BYPASSRLS or arbitrary SQL logins authority over claimed GUCs.
-- Missing actual app identity still returns false before candidate/provenance SQL is executed.
GRANT EXECUTE ON FUNCTION app.agent_signal_custody_visible(text,uuid,uuid,uuid) TO ai_hr_app;
CREATE POLICY ai_agent_job_feedback_signal_owner ON public.ai_agent_job_feedback FOR SELECT TO PUBLIC
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_job_feedback'::regclass))
  AND tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
  AND app.agent_signal_custody_visible('feedback',id,tenant_id,user_id));
CREATE POLICY ai_agent_job_signal_owner ON public.ai_agent_job_receipt FOR SELECT TO PUBLIC
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_job_receipt'::regclass))
  AND tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
  AND app.agent_signal_custody_visible('job',id,tenant_id,user_id));
--> statement-breakpoint
CREATE FUNCTION app.agent_candidate_signals_current(wanted_candidate uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
DECLARE c public.ai_agent_candidate%ROWTYPE;p public.ai_agent_candidate_provenance%ROWTYPE;r jsonb;
BEGIN
 IF wanted_candidate IS NULL OR app.current_user_id() IS NULL OR app.current_tenant_id() IS NULL
  OR NOT app.principal_snapshot_current() OR current_setting('transaction_isolation')<>'read committed' THEN RETURN false;END IF;
 SELECT * INTO c FROM public.ai_agent_candidate WHERE id=wanted_candidate AND tenant_id=app.current_tenant_id()
  AND(owner_user_id=app.current_user_id() OR app.is_group_admin());IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO p FROM public.ai_agent_candidate_provenance WHERE candidate_id=c.id AND tenant_id=c.tenant_id AND owner_user_id=c.owner_user_id;
 IF NOT FOUND OR coalesce(jsonb_typeof(p.refs),'')<>'array' OR jsonb_array_length(p.refs)>10 THEN RETURN false;END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('agent-signals:'||c.tenant_id::text||':'||c.owner_user_id::text,0)) THEN RETURN false;END IF;
 IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p.refs))<>jsonb_array_length(p.refs) THEN RETURN false;END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p.refs) LOOP
  IF coalesce(jsonb_typeof(r),'')<>'object' THEN RETURN false;END IF;
  IF coalesce(jsonb_typeof(r->'id'),'')<>'string' OR coalesce(jsonb_typeof(r->'jobId'),'')<>'string' OR coalesce(jsonb_typeof(r->'receiptDigest'),'')<>'string' OR coalesce(jsonb_typeof(r->'jobReceiptDigest'),'')<>'string' THEN RETURN false;END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(r))<>4 OR coalesce(r->>'id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR coalesce(r->>'jobId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR coalesce(r->>'receiptDigest','')!~'^[a-f0-9]{64}$' OR coalesce(r->>'jobReceiptDigest','')!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
  IF NOT EXISTS(SELECT 1 FROM public.ai_agent_job_feedback f JOIN public.ai_agent_job_receipt j ON j.id=f.job_id AND j.tenant_id=f.tenant_id AND j.user_id=f.user_id
   WHERE f.id=(r->>'id')::uuid AND j.id=(r->>'jobId')::uuid AND f.tenant_id=c.tenant_id AND f.user_id=c.owner_user_id AND f.expires_at>now() AND j.expires_at>now() AND j.request_nonce IS NOT NULL
    AND encode(sha256(convert_to(f.receipt,'UTF8')),'hex')=r->>'receiptDigest'
    AND encode(sha256(convert_to(j.receipt,'UTF8')),'hex')=r->>'jobReceiptDigest') THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.agent_candidate_signals_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.agent_candidate_signals_current(uuid) TO ai_hr_app;
CREATE INDEX ai_agent_job_feedback_expiry ON public.ai_agent_job_feedback(tenant_id,expires_at,id);

--> statement-breakpoint
-- Human-authored questions are never stored here. The authenticated encrypted receipt contains
-- only digests, typed proposed modules, source/provider bindings and honest request observations.
CREATE TABLE public.ai_agent_plan_proposal (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 user_id uuid NOT NULL REFERENCES public.app_user(id),request_nonce uuid NOT NULL,
 promotion_id uuid NOT NULL REFERENCES public.ai_agent_promotion(id),
 state text NOT NULL CHECK(state IN('reserved','ready','refused','failed')),
 receipt text NOT NULL CHECK(length(receipt) BETWEEN 1 AND 65536),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 consumed_job_id uuid REFERENCES public.ai_agent_job_receipt(id) ON DELETE CASCADE,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
 CHECK(consumed_job_id IS NULL OR state='ready'),UNIQUE(tenant_id,user_id,request_nonce)
);
--> statement-breakpoint
ALTER TABLE public.ai_agent_plan_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_plan_proposal FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_agent_plan_own ON public.ai_agent_plan_proposal FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id());
CREATE POLICY ai_agent_plan_create ON public.ai_agent_plan_proposal FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id()
 AND EXISTS(SELECT 1 FROM public.ai_agent_promotion p JOIN public.ai_agent_candidate c ON c.id=p.candidate_id AND c.tenant_id=p.tenant_id
  WHERE p.id=promotion_id AND p.tenant_id=ai_agent_plan_proposal.tenant_id AND p.owner_user_id=app.current_user_id() AND c.kind='read_plan_prompt_v1'));
CREATE POLICY ai_agent_plan_update ON public.ai_agent_plan_proposal FOR UPDATE TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id())
 WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id()
 AND (consumed_job_id IS NULL OR EXISTS(SELECT 1 FROM public.ai_agent_job_receipt j WHERE j.id=consumed_job_id AND j.tenant_id=ai_agent_plan_proposal.tenant_id AND j.user_id=app.current_user_id())));
CREATE POLICY ai_agent_plan_erase ON public.ai_agent_plan_proposal FOR DELETE TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id());
REVOKE ALL ON public.ai_agent_plan_proposal FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,DELETE ON public.ai_agent_plan_proposal TO ai_hr_app;
GRANT UPDATE(state,receipt,consumed_job_id) ON public.ai_agent_plan_proposal TO ai_hr_app;
CREATE INDEX ai_agent_plan_expiry ON public.ai_agent_plan_proposal(tenant_id,expires_at,id);
--> statement-breakpoint
CREATE FUNCTION app.guard_agent_plan_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF OLD.state<>'reserved' AND NEW.state<>OLD.state THEN RAISE EXCEPTION 'Agent plan transition refused';END IF;
 IF OLD.consumed_job_id IS NOT NULL AND NEW.consumed_job_id IS DISTINCT FROM OLD.consumed_job_id THEN RAISE EXCEPTION 'Agent plan replay refused';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_agent_plan_transition() FROM PUBLIC;
CREATE TRIGGER ai_agent_plan_transition BEFORE UPDATE ON public.ai_agent_plan_proposal FOR EACH ROW EXECUTE FUNCTION app.guard_agent_plan_transition();

--> statement-breakpoint
-- Physical owner/session only: never an app SECURITY DEFINER cleanup identity.
CREATE POLICY ai_agent_job_receipt_expired_connection_read ON public.ai_agent_job_receipt FOR SELECT TO PUBLIC
 USING(current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_job_receipt'::regclass)) AND coalesce(expires_at,created_at+interval '720 hours')<=now());
CREATE POLICY ai_agent_job_receipt_expired_connection_delete ON public.ai_agent_job_receipt FOR DELETE TO PUBLIC
 USING(current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_job_receipt'::regclass)) AND coalesce(expires_at,created_at+interval '720 hours')<=now());
CREATE POLICY ai_agent_job_receipt_expired_connection_lock ON public.ai_agent_job_receipt FOR UPDATE TO PUBLIC
 USING(current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_job_receipt'::regclass)) AND coalesce(expires_at,created_at+interval '720 hours')<=now()) WITH CHECK(false);
CREATE POLICY ai_agent_job_feedback_expired_connection_read ON public.ai_agent_job_feedback FOR SELECT TO PUBLIC
 USING(current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_job_feedback'::regclass)) AND expires_at<=now());
CREATE POLICY ai_agent_job_feedback_expired_connection_delete ON public.ai_agent_job_feedback FOR DELETE TO PUBLIC
 USING(current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_job_feedback'::regclass)) AND expires_at<=now());
CREATE POLICY ai_agent_job_feedback_expired_connection_lock ON public.ai_agent_job_feedback FOR UPDATE TO PUBLIC
 USING(current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_job_feedback'::regclass)) AND expires_at<=now()) WITH CHECK(false);
CREATE POLICY ai_agent_candidate_provenance_expired_connection_read ON public.ai_agent_candidate_provenance FOR SELECT TO PUBLIC
 USING(current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_candidate_provenance'::regclass)) AND created_at+interval '720 hours'<=now());
CREATE POLICY ai_agent_candidate_provenance_expired_connection_delete ON public.ai_agent_candidate_provenance FOR DELETE TO PUBLIC
 USING(current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_candidate_provenance'::regclass)) AND created_at+interval '720 hours'<=now());
CREATE POLICY ai_agent_candidate_provenance_expired_connection_lock ON public.ai_agent_candidate_provenance FOR UPDATE TO PUBLIC
 USING(current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_candidate_provenance'::regclass)) AND created_at+interval '720 hours'<=now()) WITH CHECK(false);
CREATE POLICY ai_agent_plan_proposal_expired_connection_read ON public.ai_agent_plan_proposal FOR SELECT TO PUBLIC
 USING(current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_plan_proposal'::regclass)) AND expires_at<=now());
CREATE POLICY ai_agent_plan_proposal_expired_connection_delete ON public.ai_agent_plan_proposal FOR DELETE TO PUBLIC
 USING(current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_plan_proposal'::regclass)) AND expires_at<=now());
CREATE POLICY ai_agent_plan_proposal_expired_connection_lock ON public.ai_agent_plan_proposal FOR UPDATE TO PUBLIC
 USING(current_user=session_user AND session_user<>'ai_hr_app' AND session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_plan_proposal'::regclass)) AND expires_at<=now()) WITH CHECK(false);
