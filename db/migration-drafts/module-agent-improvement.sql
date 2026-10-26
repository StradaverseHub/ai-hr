-- UNALLOCATED SOURCE DRAFT. No journal number reserved. Do not apply manually.
-- Digests/configuration only: no prompts, answers, model self-ratings or cross-user HR learning data.
CREATE TABLE public.ai_agent_candidate (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 owner_user_id uuid NOT NULL REFERENCES public.app_user(id), author_user_id uuid NOT NULL REFERENCES public.app_user(id),
 module_code text NOT NULL, version integer NOT NULL CHECK(version>0),
 kind text NOT NULL CHECK(kind='typed_route_priority_v1'), configuration jsonb NOT NULL,
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
 FOREIGN KEY(candidate_id,tenant_id) REFERENCES public.ai_agent_candidate(id,tenant_id),
 UNIQUE(candidate_id,evaluator_user_id)
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
REVOKE ALL ON public.ai_agent_candidate,public.ai_agent_evaluation,public.ai_agent_promotion,public.ai_agent_rollback FROM PUBLIC;
GRANT SELECT,INSERT ON public.ai_agent_candidate,public.ai_agent_evaluation,public.ai_agent_promotion,public.ai_agent_rollback TO ai_hr_app;
GRANT UPDATE(used_jobs) ON public.ai_agent_promotion TO ai_hr_app;

--> statement-breakpoint
CREATE TABLE public.ai_agent_job_receipt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 user_id uuid NOT NULL REFERENCES public.app_user(id),promotion_id uuid NOT NULL REFERENCES public.ai_agent_promotion(id),
 receipt text NOT NULL CHECK(length(receipt) BETWEEN 1 AND 65536),created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.ai_agent_job_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_job_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_agent_job_own ON public.ai_agent_job_receipt FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id());
CREATE POLICY ai_agent_job_create ON public.ai_agent_job_receipt FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id()
 AND EXISTS(SELECT 1 FROM public.ai_agent_promotion p WHERE p.id=promotion_id AND p.tenant_id=ai_agent_job_receipt.tenant_id AND p.owner_user_id=app.current_user_id()));
REVOKE ALL ON public.ai_agent_job_receipt FROM PUBLIC;
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
