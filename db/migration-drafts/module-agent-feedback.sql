-- UNALLOCATED SOURCE DRAFT. Do not journal/apply until parent coordinates allocation and migration proof.
-- Private explicit-consent feedback metadata only. No prompt, answer, attachment, employee fact or model rating.
CREATE TABLE public.ai_agent_feedback (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 user_id uuid NOT NULL REFERENCES public.app_user(id),
 exchange_id uuid NOT NULL REFERENCES public.assistant_exchange(id) ON DELETE CASCADE,
 outcome text NOT NULL CHECK (outcome IN ('helpful','needs_correction','incorrect')),
 consented boolean NOT NULL CHECK (consented),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
 UNIQUE (tenant_id,user_id,exchange_id),
 CHECK (expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
--> statement-breakpoint
ALTER TABLE public.ai_agent_feedback ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ai_agent_feedback FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ai_agent_feedback_own ON public.ai_agent_feedback FOR ALL TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND user_id=app.current_user_id())
 WITH CHECK (tenant_id=app.current_tenant_id() AND user_id=app.current_user_id()
  AND EXISTS (SELECT 1 FROM public.assistant_exchange e WHERE e.id=exchange_id
   AND e.tenant_id=app.current_tenant_id() AND e.app_user_id=app.current_user_id()));
--> statement-breakpoint
REVOKE ALL ON public.ai_agent_feedback FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON public.ai_agent_feedback TO ai_hr_app;
