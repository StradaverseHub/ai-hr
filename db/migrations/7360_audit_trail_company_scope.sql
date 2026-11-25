-- Audit Trail company scope, Phase 1 (ADR-0182, owner decision 25 Nov 2026, amends ADR-0015 §1).
--
-- The shared domain_event read policy lets ANY administrator read the whole tenant's ledger: app.is_admin() is
-- true for an hr_admin granted a single company. Phase 1 narrows what the Audit Trail READS show such an
-- administrator, without changing the shared policy (about fifteen other features, including delete-safety and
-- repeat-submit checks, still rely on it; Phase 2 moves them before the policy itself is narrowed).
--
-- This migration adds two read helpers. Neither changes a row, policy, grant on a table, or existing function.
--   app.admin_company_ids() uuid[]
--     The companies the session administers: app.is_admin_for(company) over the tenant's companies, archived
--     included (their history still belongs to them), subtree semantics as is_admin_for. Empty, never NULL.
--   app.audit_admin_aggregates() TABLE(aggregate_type text, aggregate_id uuid)
--     The audit aggregates that belong to those companies: the company itself, the company-owned rows whose
--     events record the row id as aggregate_id (payroll run, pay period, payroll cycle, approval policy, shift,
--     payroll policy, position, review cycle, department, cost centre, business unit, statutory report,
--     attendance allowance policy), the login accounts of people employed in them (sign-in, recovery and
--     account events carry no company), and those people's person, statutory and compensation records (profile,
--     bank and salary events that carry no subject column; the per-employee History already admits them). A row whose company_id is NULL (group-wide) is not listed: it is a
--     group-level record, visible to group administrators only (owner decision 2a).
-- Both are SECURITY DEFINER so they read the anchor tables once, without each table's per-row policy, and both
-- are bounded by the current tenant and the session's own grants. They are called once per statement from the
-- Audit Trail predicate (core/read.ts auditCompanyScope) as uncorrelated sub-selects, so PostgreSQL plans them
-- as InitPlans / hashed SubPlans, never once per event row. Group administrators never evaluate them: the
-- predicate short-circuits on (SELECT app.is_group_admin()).
CREATE FUNCTION app.admin_company_ids() RETURNS uuid[]
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}'::uuid[])
 FROM public.company c
 WHERE c.tenant_id=app.current_tenant_id() AND app.is_admin_for(c.id)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.admin_company_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.admin_company_ids() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.audit_admin_aggregates() RETURNS TABLE(aggregate_type text, aggregate_id uuid)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH scope AS (SELECT unnest(app.admin_company_ids()) AS company_id),
 t AS (SELECT app.current_tenant_id() AS tenant_id)
 SELECT 'company'::text, s.company_id FROM scope s
 UNION ALL SELECT 'payroll-batch', x.id FROM public.payroll_batch x, t WHERE x.tenant_id=t.tenant_id AND x.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT 'pay-period', x.id FROM public.pay_period x, t WHERE x.tenant_id=t.tenant_id AND x.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT 'payroll-cycle', x.id FROM public.payroll_cycle x, t WHERE x.tenant_id=t.tenant_id AND x.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT 'leave-approval-policy', x.id FROM public.leave_approval_policy x, t WHERE x.tenant_id=t.tenant_id AND x.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT 'shift', x.id FROM public.shift x, t WHERE x.tenant_id=t.tenant_id AND x.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT 'payroll-policy', x.id FROM public.payroll_policy x, t WHERE x.tenant_id=t.tenant_id AND x.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT 'position', x.id FROM public."position" x, t WHERE x.tenant_id=t.tenant_id AND x.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT 'review-cycle', x.id FROM public.review_cycle x, t WHERE x.tenant_id=t.tenant_id AND x.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT 'department', x.id FROM public.department x, t WHERE x.tenant_id=t.tenant_id AND x.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT 'cost-center', x.id FROM public.cost_center x, t WHERE x.tenant_id=t.tenant_id AND x.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT 'business-unit', x.id FROM public.business_unit x, t WHERE x.tenant_id=t.tenant_id AND x.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT 'statutory-report', x.id FROM public.statutory_report x, t WHERE x.tenant_id=t.tenant_id AND x.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT 'attendance-allowance-policy', x.id FROM public.attendance_allowance_policy x, t WHERE x.tenant_id=t.tenant_id AND x.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT DISTINCT 'app-user', u.id FROM public.app_user u JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id, t
  WHERE u.tenant_id=t.tenant_id AND e.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT DISTINCT 'person', e.person_id FROM public.employment e, t WHERE e.tenant_id=t.tenant_id AND e.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT DISTINCT 'employee-statutory', m.id FROM public.employee_statutory_my m JOIN public.employment e ON e.person_id=m.person_id AND e.tenant_id=m.tenant_id, t
  WHERE m.tenant_id=t.tenant_id AND e.company_id IN (SELECT company_id FROM scope)
 UNION ALL SELECT 'compensation', x.id FROM public.compensation x JOIN public.employment e ON e.id=x.employment_id AND e.tenant_id=x.tenant_id, t
  WHERE x.tenant_id=t.tenant_id AND e.company_id IN (SELECT company_id FROM scope)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.audit_admin_aggregates() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.audit_admin_aggregates() TO ai_hr_app;
