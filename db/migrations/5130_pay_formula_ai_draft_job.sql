-- Background AI Formula Generator (12 November 2026). Allocated 5130 / idx 4530 / when 1793330004830, above the
-- candidate's 5129 and PR 240's reserved 5128 (docs/MIGRATION-ALLOCATION.md). One new table; no existing object changes.
--
-- Payroll > Pay Formula Builder > AI Formula Generator used to wait for the model inside the request, under the
-- gateway's 22 s request-path cap; the configured model regularly takes longer, so drafts failed. The draft is now
-- produced after the request returns (core/pay-formula-ai-job.ts) and this table carries its state so the screen can
-- poll it and a reload can resume it.
--
-- One row per login (primary key tenant_id, user_id): the latest generation of that user. A new start replaces a
-- finished or overdue row; a running row is never replaced, so one login has at most one provider call in flight.
-- The row holds no requirement text (only its digest, to recognise a resumed request) and no employee data: the result
-- is exactly the adjudicated draft today's synchronous screen received. It never saves, activates or applies anything.
-- Reads stop returning a row at expires_at; expired rows of the tenant are deleted by the next start.
CREATE TABLE public.pay_formula_ai_draft_job (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.app_user(id) ON DELETE CASCADE,
 id uuid NOT NULL,
 requirement_digest text NOT NULL CHECK(requirement_digest~'^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('running','succeeded','failed')),
 reason text CHECK(reason IN ('timeout','provider_unavailable','invalid_draft','paused','daily_limit','monthly_limit',
  'concurrent_limit','review_required','unavailable','access_changed','failed')),
 result jsonb CHECK(result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=262144)),
 timeout_ms integer NOT NULL CHECK(timeout_ms BETWEEN 1000 AND 120000),
 started_at timestamptz NOT NULL DEFAULT now(),
 deadline_at timestamptz NOT NULL,
 finished_at timestamptz,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,user_id),
 CHECK(deadline_at>started_at AND deadline_at<=started_at+interval '5 minutes'),
 CHECK(expires_at>started_at AND expires_at<=coalesce(finished_at,started_at)+interval '2 hours'),
 CHECK((state='running' AND reason IS NULL AND result IS NULL AND finished_at IS NULL)
  OR (state='succeeded' AND reason IS NULL AND result IS NOT NULL AND finished_at IS NOT NULL)
  OR (state='failed' AND reason IS NOT NULL AND result IS NULL AND finished_at IS NOT NULL))
);
--> statement-breakpoint
-- The tenant-wide expired purge reads this index (policy pay_formula_ai_draft_job_expired_delete).
CREATE INDEX pay_formula_ai_draft_job_expiry ON public.pay_formula_ai_draft_job(tenant_id,expires_at);
--> statement-breakpoint
-- Remove bootstrap default CRUD grants before granting only the intended privileges below.
REVOKE ALL ON public.pay_formula_ai_draft_job FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE public.pay_formula_ai_draft_job ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pay_formula_ai_draft_job FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Only the requesting login, in its own tenant, while its captured roles and grants are still current.
CREATE POLICY pay_formula_ai_draft_job_own_read ON public.pay_formula_ai_draft_job FOR SELECT TO ai_hr_app USING(
 tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current());
--> statement-breakpoint
CREATE POLICY pay_formula_ai_draft_job_own_insert ON public.pay_formula_ai_draft_job FOR INSERT TO ai_hr_app WITH CHECK(
 tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current()
 AND state='running' AND reason IS NULL AND result IS NULL);
--> statement-breakpoint
CREATE POLICY pay_formula_ai_draft_job_own_update ON public.pay_formula_ai_draft_job FOR UPDATE TO ai_hr_app USING(
 tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current()) WITH CHECK(
 tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.principal_snapshot_current());
--> statement-breakpoint
-- A login discards its own finished draft (never a running one).
CREATE POLICY pay_formula_ai_draft_job_own_delete ON public.pay_formula_ai_draft_job FOR DELETE TO ai_hr_app USING(
 tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND state<>'running');
--> statement-breakpoint
-- Expired rows of the tenant. A DELETE with no WHERE clause applies only the DELETE policies (no SELECT visibility is
-- needed, as in 0628), so the start path removes the tenant's expired rows without reading them, through the expiry
-- index. Running rows of other logins are never deletable before they expire.
CREATE POLICY pay_formula_ai_draft_job_expired_delete ON public.pay_formula_ai_draft_job FOR DELETE TO ai_hr_app USING(
 tenant_id=app.current_tenant_id() AND expires_at<=now());
--> statement-breakpoint
GRANT SELECT,DELETE ON public.pay_formula_ai_draft_job TO ai_hr_app;
--> statement-breakpoint
GRANT INSERT(tenant_id,user_id,id,requirement_digest,state,timeout_ms,started_at,deadline_at,expires_at) ON public.pay_formula_ai_draft_job TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE(id,requirement_digest,state,reason,result,timeout_ms,started_at,deadline_at,finished_at,expires_at) ON public.pay_formula_ai_draft_job TO ai_hr_app;
