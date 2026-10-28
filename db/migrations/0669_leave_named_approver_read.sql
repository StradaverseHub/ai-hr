-- Named leave approvers can READ the leave requests they are, or were, asked to approve, and nothing else.
--
-- OWNER DECISION (28 October 2026, relayed by the AI GAPS session): a leave approval step whose approver is
-- a specifically named employee (`specific_employee`, the fixed approver snapshot of 0467/0468) must let that
-- person SEE the request, even when they are neither the employee's manager nor HR. Before this, the request
-- was routed to them (notifications, escalation, the decide gate in core/leave.ts all name them) while RLS
-- hid the row. The 0109 leave_request policy admits only can_see_employment (self, admin, the administrative
-- reporting tree, heads) and a routed delegate.
--
-- ── WHO ──────────────────────────────────────────────────────────────────────────────────────────────
-- The caller is a USER (app.current_user_id()). Their PERSON is app_user.person_id. A step names an
-- EMPLOYMENT, either leave_approval_step.approver_employment_id with approver_kind = 'specific_employee', or
-- an any-one alternate {kind: 'specific_employee', employmentId} in approver_alternates (0468). The caller
-- is that approver when the named employment belongs to their person, in this tenant, and that employment
-- has not ended (terminated_on NULL or not yet passed). An approver who has left loses the read, even for
-- history. HR can still clear such a step (the decide gate's admin override), so the chain never depends on it.
--
-- ── WHAT (the scope is the request, never the employee) ──────────────────────────────────────────────
-- The request ids where ANY step names the caller: the current pending step, a later one, or a decided
-- one (history). Steps are a snapshot written at submission (ADR-0071 1(g)). When a template is edited the
-- snapshot keeps its approver, who still decides it. When the request itself is edited, its pending steps
-- are deleted and regenerated (core/leave.ts), so a person no longer named loses the read on the next statement.
--
-- Only these rows become readable:
--   leave_request, leave_approval_step, leave_request_date (per-date breakdown), leave_request_attachment
--   (the supporting document the approver decides on),
-- through NEW PERMISSIVE FOR SELECT policies. The existing FOR ALL policies are NOT altered. Postgres ORs
-- permissive policies per command, so INSERT/UPDATE/DELETE and SELECT … FOR UPDATE still need the old
-- policy. A named approver gains no write, no decision path through RLS, and no row of employment, person,
-- assignment, leave_ledger (balance), domain_event or any other table. Their reads of those keep
-- returning nothing, so a joined projection yields NULL for the employee's balance, profile and history.
--
-- The employee's display NAME is the one fact an approver needs that lives outside those tables. It is
-- returned by app.named_leave_approver_requests(uuid[]) with the subject employment id and company id (the
-- inbox's company-scope fence needs those), for requests in the caller's named set ONLY. This follows the 0472
-- name-only pattern: person RLS is not widened (that would publish IC, address, contacts…).
--
-- ── COMPANY ISOLATION ─────────────────────────────────────────────────────────────────────────────────
-- Tenant is enforced on every relation. Company is NOT clamped here, deliberately, matching the decide gate.
-- The approver is chosen by an HR administrator per company policy (leave_approval_policy.company_id), and
-- that explicit routing IS the authorization. Requests from any company where the caller is not named stay
-- invisible because the set is built only from steps that name them.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────────────────
-- app.named_leave_approver_request_ids() uuid[] is set-based like 0515's app.visible_employment_ids(): each
-- policy compares `id = ANY ((SELECT …)::uuid[])`, an InitPlan computed once per statement, not per row.
-- Both functions are STABLE SECURITY DEFINER with search_path = pg_catalog, public, pg_temp and every
-- relation schema-qualified (0312/0472: pg_temp is otherwise searched first). EXECUTE is revoked from
-- PUBLIC and granted to ai_hr_app. No session, an unknown id, another tenant's id and a colleague's
-- request all return the empty set / no rows, never an error, so neither function can probe which ids exist.
--
-- ⚠️ NUMBERING. Filename 0669 reserved in the claude/migration-inventory-20261027 registry (ebe6304ae). It journals
-- AFTER 0670_ai_orchestrator_wave1_receipts (idx 654, when 1793190000000, applied first on staging): idx 655, when
-- re-timed to 1793200000000 (registry 00b903bef). The filename sorts below 0670, but the migrator orders by journal
-- idx/when, never by filename. If a later `when` is applied first, re-time this (unapplied) entry again.
--
-- Rollback:
--   DROP POLICY leave_request_named_approver_read ON public.leave_request;
--   DROP POLICY leave_approval_step_named_approver_read ON public.leave_approval_step;
--   DROP POLICY leave_request_date_named_approver_read ON public.leave_request_date;
--   DROP POLICY leave_request_attachment_named_approver_read ON public.leave_request_attachment;
--   DROP FUNCTION app.named_leave_approver_requests(uuid[]);
--   DROP FUNCTION app.named_leave_approver_request_ids();

CREATE FUNCTION app.named_leave_approver_request_ids() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT s.leave_request_id), '{}'::uuid[])
  FROM public.app_user u
  JOIN public.employment ae
    ON ae.person_id = u.person_id AND ae.tenant_id = u.tenant_id
   AND (ae.terminated_on IS NULL OR ae.terminated_on >= current_date)
  JOIN public.leave_approval_step s
    ON s.tenant_id = ae.tenant_id
   AND (
     (s.approver_kind = 'specific_employee' AND s.approver_employment_id = ae.id)
     OR (jsonb_typeof(s.approver_alternates) = 'array' AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(s.approver_alternates) a(el)
       WHERE jsonb_typeof(a.el) = 'object'
         AND a.el ->> 'kind' = 'specific_employee'
         AND lower(a.el ->> 'employmentId') = ae.id::text))
   )
  WHERE u.id = app.current_user_id()
    AND u.tenant_id = app.current_tenant_id()
    AND u.person_id IS NOT NULL;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.named_leave_approver_request_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.named_leave_approver_request_ids() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.named_leave_approver_requests(p_leave_request_ids uuid[])
  RETURNS TABLE(leave_request_id uuid, employment_id uuid, company_id uuid, employee_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT lr.id, e.id, e.company_id, p.full_name
  FROM public.leave_request lr
  JOIN public.employment e ON e.id = lr.employment_id AND e.tenant_id = lr.tenant_id
  JOIN public.person p ON p.id = e.person_id AND p.tenant_id = e.tenant_id
  WHERE lr.id = ANY(p_leave_request_ids)
    AND lr.id = ANY(app.named_leave_approver_request_ids())
    AND lr.tenant_id = app.current_tenant_id();
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.named_leave_approver_requests(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.named_leave_approver_requests(uuid[]) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY leave_request_named_approver_read ON public.leave_request FOR SELECT
  USING (tenant_id = app.current_tenant_id() AND id = ANY ((SELECT app.named_leave_approver_request_ids())::uuid[]));
--> statement-breakpoint
CREATE POLICY leave_approval_step_named_approver_read ON public.leave_approval_step FOR SELECT
  USING (tenant_id = app.current_tenant_id() AND leave_request_id = ANY ((SELECT app.named_leave_approver_request_ids())::uuid[]));
--> statement-breakpoint
CREATE POLICY leave_request_date_named_approver_read ON public.leave_request_date FOR SELECT
  USING (tenant_id = app.current_tenant_id() AND leave_request_id = ANY ((SELECT app.named_leave_approver_request_ids())::uuid[]));
--> statement-breakpoint
CREATE POLICY leave_request_attachment_named_approver_read ON public.leave_request_attachment FOR SELECT
  USING (tenant_id = app.current_tenant_id() AND leave_request_id = ANY ((SELECT app.named_leave_approver_request_ids())::uuid[]));
