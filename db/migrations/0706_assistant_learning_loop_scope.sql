-- WP11 (R5, S8; ADR-0151 §4.6d amendment 2026-10-29): make the Assistant learning loop real.
-- Reserved as 0695 / when 1793330000021 for the AI architecture programme. Append-only: no earlier
-- migration file, policy or function body is edited; every change below is additive or a widened CHECK.
--
-- 1. Promotion scope. The approver chooses who a promotion applies to: the candidate owner only ('user',
--    every existing row), one company subtree ('company') or the whole tenant ('tenant'). Wider scopes are
--    admitted only for the canonical specialist kind and only for a candidate with NO personal signal
--    provenance, so another person's consumption never needs the author's feedback/outcome custody.
-- 2. Scheduled maintenance. The tenant's named agent principal (0672) may read promotion metadata and
--    retire a promotion for expiry, exhaustion or a measured outcome regression. It holds no grant and
--    gains no HR row, feedback, job or provider access. Its rollback rows name the principal, not a user.
-- 3. Measured outcome input. app.assistant_action_outcome_summary (0674) also answers the tenant's agent
--    principal, counts only (tenant-wide), so the nightly sweep can measure regressions without a login.

ALTER TABLE public.ai_agent_promotion
 ADD COLUMN scope text NOT NULL DEFAULT 'user' CHECK(scope IN('user','company','tenant')),
 ADD COLUMN company_id uuid REFERENCES public.company(id);
--> statement-breakpoint
ALTER TABLE public.ai_agent_promotion ADD CONSTRAINT ai_agent_promotion_scope_company CHECK((scope='company')=(company_id IS NOT NULL));
--> statement-breakpoint
-- Whether a promotion's scope covers the CURRENT app principal. Reads only app_user/employment/company
-- (not FORCE-RLS) and never an ai_agent_* table, so policies below cannot recurse through it.
-- Company scope follows company isolation: the caller's person must hold a non-terminated employment
-- in that company or one of its descendants. An agent or personless login is never covered by company.
CREATE FUNCTION app.ai_agent_scope_covers_current_user(p_tenant uuid,p_scope text,p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND p_tenant IS NOT NULL AND p_tenant=app.current_tenant_id() AND CASE p_scope
  WHEN 'tenant' THEN EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=p_tenant)
  WHEN 'company' THEN p_company IS NOT NULL AND EXISTS(SELECT 1 FROM public.app_user u
   JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
   WHERE u.id=app.current_user_id() AND u.tenant_id=p_tenant AND (e.terminated_on IS NULL OR e.terminated_on>=current_date)
    AND (e.company_id=p_company OR app.is_company_descendant(e.company_id,p_company)))
  ELSE false END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_agent_scope_covers_current_user(uuid,text,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_agent_scope_covers_current_user(uuid,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Writers: every existing promotion INSERT names no scope (default 'user'). A wider scope must name a
-- company of the same tenant (company scope only), a canonical specialist candidate, and a candidate
-- whose provenance carries no personal feedback or native-outcome refs.
CREATE POLICY ai_agent_promotion_scope_admission ON public.ai_agent_promotion AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK(scope='user' OR (
  (scope='tenant' OR EXISTS(SELECT 1 FROM public.company c WHERE c.id=ai_agent_promotion.company_id AND c.tenant_id=ai_agent_promotion.tenant_id))
  AND EXISTS(SELECT 1 FROM public.ai_agent_candidate c WHERE c.id=ai_agent_promotion.candidate_id AND c.tenant_id=ai_agent_promotion.tenant_id AND c.kind='canonical_specialist_v1')
  AND EXISTS(SELECT 1 FROM public.ai_agent_candidate_provenance p WHERE p.candidate_id=ai_agent_promotion.candidate_id AND p.tenant_id=ai_agent_promotion.tenant_id
   AND p.refs='[]'::jsonb AND p.native_refs='[]'::jsonb)));
--> statement-breakpoint
-- Covered consumers (other users of the tenant/company) see and consume the promotion, its candidate
-- metadata, its signal-free provenance and its retirement. Own-only feedback/job custody is unchanged.
CREATE POLICY ai_agent_promotion_scoped_read ON public.ai_agent_promotion FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND scope<>'user' AND app.ai_agent_scope_covers_current_user(tenant_id,scope,company_id));
--> statement-breakpoint
CREATE POLICY ai_agent_promotion_scoped_consume ON public.ai_agent_promotion FOR UPDATE TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND scope<>'user' AND app.ai_agent_scope_covers_current_user(tenant_id,scope,company_id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND scope<>'user' AND app.ai_agent_scope_covers_current_user(tenant_id,scope,company_id));
--> statement-breakpoint
CREATE POLICY ai_agent_candidate_scoped_read ON public.ai_agent_candidate FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND kind='canonical_specialist_v1' AND EXISTS(SELECT 1 FROM public.ai_agent_promotion p
  WHERE p.candidate_id=ai_agent_candidate.id AND p.tenant_id=ai_agent_candidate.tenant_id AND p.scope<>'user'
   AND app.ai_agent_scope_covers_current_user(p.tenant_id,p.scope,p.company_id)));
--> statement-breakpoint
CREATE POLICY ai_agent_provenance_scoped_read ON public.ai_agent_candidate_provenance FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND refs='[]'::jsonb AND native_refs='[]'::jsonb AND EXISTS(SELECT 1 FROM public.ai_agent_promotion p
  WHERE p.candidate_id=ai_agent_candidate_provenance.candidate_id AND p.tenant_id=ai_agent_candidate_provenance.tenant_id AND p.scope<>'user'
   AND app.ai_agent_scope_covers_current_user(p.tenant_id,p.scope,p.company_id)));
--> statement-breakpoint
CREATE POLICY ai_agent_rollback_scoped_read ON public.ai_agent_rollback FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.ai_agent_promotion p
  WHERE p.id=ai_agent_rollback.promotion_id AND p.tenant_id=ai_agent_rollback.tenant_id AND p.scope<>'user'
   AND app.ai_agent_scope_covers_current_user(p.tenant_id,p.scope,p.company_id)));
--> statement-breakpoint
-- A covered consumer may retire the shared promotion only on the same objective triggers an owner may
-- use for a specialist: its source changed, or the canonical interpreter refused its configuration.
CREATE POLICY ai_agent_rollback_scoped_retire ON public.ai_agent_rollback FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND reason IN('quality_regression','source_changed')
  AND EXISTS(SELECT 1 FROM public.ai_agent_promotion p JOIN public.ai_agent_candidate c ON c.id=p.candidate_id AND c.tenant_id=p.tenant_id
   WHERE p.id=ai_agent_rollback.promotion_id AND p.tenant_id=ai_agent_rollback.tenant_id AND p.scope<>'user' AND c.kind='canonical_specialist_v1'
    AND app.ai_agent_scope_covers_current_user(p.tenant_id,p.scope,p.company_id)));
--> statement-breakpoint
CREATE POLICY ai_agent_job_create_scoped ON public.ai_agent_job_receipt FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND promotion_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.ai_agent_promotion p WHERE p.id=ai_agent_job_receipt.promotion_id AND p.tenant_id=ai_agent_job_receipt.tenant_id
   AND p.scope<>'user' AND app.ai_agent_scope_covers_current_user(p.tenant_id,p.scope,p.company_id)));
--> statement-breakpoint
-- Rollback actor: a user (every existing writer) or the tenant's scheduled agent principal (0672).
-- Every existing row and writer sets actor_user_id, so exactly one actor holds for all of them.
ALTER TABLE public.ai_agent_rollback ALTER COLUMN actor_user_id DROP NOT NULL,
 ADD COLUMN actor_agent_principal_id uuid REFERENCES app.ai_agent_principal(id);
--> statement-breakpoint
ALTER TABLE public.ai_agent_rollback ADD CONSTRAINT ai_agent_rollback_one_actor CHECK(num_nonnulls(actor_user_id,actor_agent_principal_id)=1);
--> statement-breakpoint
-- Widened reason set (0627 named this inline CHECK ai_agent_rollback_reason_check): adds the measured
-- outcome regression. Every existing reason stays valid, so existing rows satisfy the new CHECK.
ALTER TABLE public.ai_agent_rollback DROP CONSTRAINT ai_agent_rollback_reason_check;
--> statement-breakpoint
ALTER TABLE public.ai_agent_rollback ADD CONSTRAINT ai_agent_rollback_reason_check
 CHECK(reason IN('human','security_regression','quality_regression','source_changed','expired','exhausted','outcome_regression'));
--> statement-breakpoint
-- The scheduled principal: promotion/candidate metadata and rollbacks of its own tenant, and retirement
-- for expiry, exhaustion or measured outcome regression only. No feedback, job, provenance or HR rows.
CREATE POLICY ai_agent_promotion_agent_read ON public.ai_agent_promotion FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY ai_agent_candidate_agent_read ON public.ai_agent_candidate FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY ai_agent_rollback_agent_read ON public.ai_agent_rollback FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY ai_agent_rollback_agent_retire ON public.ai_agent_rollback FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND actor_user_id IS NULL AND actor_agent_principal_id IS NOT NULL
  AND actor_agent_principal_id=app.current_agent_principal() AND reason IN('expired','exhausted','outcome_regression')
  AND EXISTS(SELECT 1 FROM public.ai_agent_promotion p WHERE p.id=ai_agent_rollback.promotion_id AND p.tenant_id=ai_agent_rollback.tenant_id));
--> statement-breakpoint
-- 0674's outcome counts, unchanged for logins (same guard, same company scoping), additionally answered
-- for the tenant's scheduled agent principal across the whole tenant. Counts only, never rows.
CREATE OR REPLACE FUNCTION app.assistant_action_outcome_summary(p_from timestamptz)
 RETURNS TABLE(action_kind text,prepared integer,awaiting integer,completed integer,discarded integer,
  expired integer,refused integer,reversed integer,first_prepared_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();g boolean;a boolean;at_time timestamptz:=clock_timestamp();
BEGIN
 a:=app.current_agent_principal() IS NOT NULL;
 IF t IS NULL OR p_from IS NULL OR p_from>at_time OR (NOT a AND (app.current_user_id() IS NULL
  OR app.principal_snapshot_current() IS NOT TRUE OR app.is_admin() IS NOT TRUE)) THEN
  RAISE EXCEPTION 'Outcome summary unavailable' USING ERRCODE='42501';END IF;
 g:=a OR app.is_group_admin();
 RETURN QUERY
 WITH scoped AS (
  SELECT r.* FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=t AND (a OR CASE WHEN r.company_id IS NULL THEN g ELSE app.is_admin_for(r.company_id) END)),
 firsts AS (SELECT s.action_kind AS k,min(s.created_at) AS f FROM scoped s GROUP BY s.action_kind),
 win AS (
  SELECT s.action_kind AS k,s.state,s.expires_at,
   CASE WHEN s.state<>'completed' THEN false
    WHEN s.action_kind='leave.apply' THEN EXISTS(SELECT 1 FROM public.leave_request q
     WHERE q.id=s.leave_request_id AND q.tenant_id=t AND q.status::text IN ('rejected','cancelled'))
    WHEN s.action_kind='claims.submit' THEN EXISTS(SELECT 1 FROM public.claim_request q
     WHERE q.id=s.claim_submission_id AND q.tenant_id=t AND q.status::text IN ('rejected','cancelled'))
    WHEN s.action_kind='attendance.correction.request' THEN EXISTS(SELECT 1 FROM public.attendance_correction q
     WHERE q.id=s.attendance_correction_id AND q.tenant_id=t AND q.status::text IN ('rejected','cancelled'))
    WHEN s.action_kind='ess.profile.request' THEN EXISTS(SELECT 1 FROM public.profile_change_request q
     WHERE q.id=s.profile_request_id AND q.tenant_id=t AND q.status::text='rejected')
    WHEN s.action_kind='leave.edit' THEN EXISTS(SELECT 1 FROM public.domain_event receipt
     JOIN public.domain_event later ON later.tenant_id=receipt.tenant_id AND later.aggregate_type='leave-request'
      AND later.aggregate_id=receipt.aggregate_id AND later.id<>receipt.id AND later.occurred_at>receipt.occurred_at
      AND later.event_type IN ('leave-request.edited','leave-request.self-cancelled','leave-request.cancelled')
     WHERE receipt.id=s.receipt_event_id AND receipt.tenant_id=t AND receipt.aggregate_id=s.receipt_subject_id)
    ELSE false END AS rev
  FROM scoped s WHERE s.created_at>=p_from AND s.created_at<=at_time)
 SELECT f.k,count(w.k)::int,
  count(*) FILTER (WHERE w.state='awaiting_confirmation' AND w.expires_at>at_time)::int,
  count(*) FILTER (WHERE w.state='completed')::int,
  count(*) FILTER (WHERE w.state='discarded')::int,
  count(*) FILTER (WHERE w.state='expired' OR (w.state='awaiting_confirmation' AND w.expires_at<=at_time))::int,
  count(*) FILTER (WHERE w.state='refused')::int,
  CASE WHEN f.k IN ('leave.apply','claims.submit','attendance.correction.request','ess.profile.request','leave.edit')
   THEN count(*) FILTER (WHERE w.rev)::int END,
  f.f
 FROM firsts f LEFT JOIN win w ON w.k=f.k GROUP BY f.k,f.f ORDER BY f.k;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assistant_action_outcome_summary(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.assistant_action_outcome_summary(timestamptz) TO ai_hr_app;
