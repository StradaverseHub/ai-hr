-- Board item 8d02748a — readable "Imported by" on every import log. DRAFT, UNALLOCATED (coordinator reallocates).
-- Functions only: no table, column, constraint, policy or data change.
--
-- One set-wise SECURITY DEFINER read per log page (never one call per row). For each requested log row that the
-- caller may already see under that log's own read rule, it returns the facts needed to label the people
-- RECORDED on that row (creator, reverter, audit actor): name, coded employments and, for a login with no
-- person, the last 6 characters of the login id (as Admin > Users shows it). Nothing else is disclosed and no
-- other person can be looked up: a row the caller cannot see, another tenant's row or an actor not recorded on
-- the row returns nothing. Person/employment RLS would hide an importer outside a company-scoped viewer's scope,
-- which is why this mirrors the 0602/0675 actor-label functions instead of joining under viewer RLS.
--
-- Rollback (manual, only if never relied upon):
--   DROP FUNCTION app.import_log_actor_facts(text, uuid[]);
CREATE FUNCTION app.import_log_actor_facts(p_log text, p_rows uuid[])
RETURNS TABLE(row_id uuid, is_creator boolean, actor_user_id uuid, user_exists boolean, full_name text,
  login_suffix text, import_date date, company_ids uuid[], employments jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH viewer AS (
  SELECT app.current_tenant_id() AS tenant_id
  WHERE app.current_tenant_id() IS NOT NULL AND app.current_user_id() IS NOT NULL
   AND coalesce(cardinality(p_rows),0) BETWEEN 1 AND 500 AND app.principal_snapshot_current()
 ), pairs AS (
  -- Payroll > Individual Transaction import batches (read rule: 2460 payroll_individual_import_job_read).
  SELECT j.id AS row_id, true AS is_creator, j.created_by AS user_id, NULL::uuid AS person_id, j.created_at,
   ARRAY(SELECT c::uuid FROM jsonb_array_elements_text(j.company_ids) c) AS company_ids
  FROM public.payroll_individual_import_job j JOIN viewer v ON j.tenant_id=v.tenant_id
  WHERE p_log='payroll_individual_job' AND j.id=ANY(p_rows) AND app.is_admin()
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(j.company_ids) c WHERE NOT app.is_admin_for(c::uuid))
  UNION ALL
  -- Payroll > Individual Transaction import attempts (read rule: 0688 payroll_txn_import_scope): creator,
  -- reverter and the attempt's own audit events.
  SELECT a.id, x.is_creator, x.user_id, NULL::uuid, a.created_at,
   ARRAY(SELECT c::uuid FROM jsonb_array_elements_text(a.company_ids) c)
  FROM public.payroll_txn_import_attempt a JOIN viewer v ON a.tenant_id=v.tenant_id
  CROSS JOIN LATERAL (
   SELECT true, a.created_by
   UNION SELECT false, a.reverted_by WHERE a.reverted_by IS NOT NULL
   UNION SELECT false, e.actor_id FROM public.domain_event e
    WHERE e.tenant_id=a.tenant_id AND e.aggregate_type='payroll-txn-import' AND e.aggregate_id=a.id AND e.actor_id IS NOT NULL
  ) x(is_creator,user_id)
  WHERE p_log='payroll_individual_attempt' AND a.id=ANY(p_rows) AND app.is_admin()
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(a.company_ids) c WHERE NOT app.is_admin_for(c::uuid))
  UNION ALL
  -- Payroll > Import payroll history (read rule: 0602 app.payroll_history_attempt_access).
  SELECT a.id, x.is_creator, x.user_id, NULL::uuid, a.created_at, a.company_ids
  FROM public.payroll_history_import_attempt a JOIN viewer v ON a.tenant_id=v.tenant_id
  CROSS JOIN LATERAL (
   SELECT true, a.created_by
   UNION SELECT false, e.actor_id FROM public.payroll_history_import_event e WHERE e.attempt_id=a.id AND e.tenant_id=a.tenant_id
  ) x(is_creator,user_id)
  WHERE p_log='payroll_history' AND a.id=ANY(p_rows) AND app.payroll_history_attempt_access(a.id)
  UNION ALL
  -- Personnel > Import History (read rule: 0675 app.import_attempt_access).
  SELECT a.id, x.is_creator, x.user_id, NULL::uuid, a.created_at, a.company_ids
  FROM public.import_attempt a JOIN viewer v ON a.tenant_id=v.tenant_id
  CROSS JOIN LATERAL (
   SELECT true, a.created_by
   UNION SELECT false, e.actor_id FROM public.import_attempt_event e WHERE e.attempt_id=a.id AND e.tenant_id=a.tenant_id
  ) x(is_creator,user_id)
  WHERE p_log='import_attempt' AND a.id=ANY(p_rows) AND app.import_attempt_access(a.id,'view',false)
  UNION ALL
  -- Attendance clocking and Leave data imports record the PERSON plus the login id as text
  -- (read rule: 0518/0497/0490 tenant administrators).
  SELECT r.id, true,
   CASE WHEN r.created_by_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN r.created_by_user_id::uuid END,
   r.created_by_person_id, r.created_at, '{}'::uuid[]
  FROM (
   SELECT c.id, c.tenant_id, c.created_by_user_id, c.created_by_person_id, c.created_at FROM public.clocking_import_run c WHERE p_log='clocking_run' AND c.id=ANY(p_rows)
   UNION ALL
   SELECT b.id, b.tenant_id, b.created_by_user_id, b.created_by_person_id, b.created_at FROM public.leave_bf_import_run b WHERE p_log='leave_bf_run' AND b.id=ANY(p_rows)
   UNION ALL
   SELECT h.id, h.tenant_id, h.created_by_user_id, h.created_by_person_id, h.created_at FROM public.leave_history_import_run h WHERE p_log='leave_history_run' AND h.id=ANY(p_rows)
  ) r JOIN viewer v ON r.tenant_id=v.tenant_id
  WHERE app.is_admin()
 )
 SELECT p.row_id, p.is_creator, p.user_id, u.id IS NOT NULL,
  nullif(btrim(pe.full_name),''),
  CASE WHEN u.id IS NOT NULL AND nullif(btrim(pe.full_name),'') IS NULL THEN right(u.workos_user_id,6) END,
  (p.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date,
  p.company_ids,
  coalesce((SELECT jsonb_agg(jsonb_build_object('employeeCode',btrim(e.employee_code),'companyId',e.company_id,
     'hiredOn',e.hired_on,'terminatedOn',e.terminated_on,'lastWorkingDate',e.last_working_date) ORDER BY e.hired_on DESC,e.id)
    FROM public.employment e
    WHERE e.tenant_id=v.tenant_id AND e.person_id=pe.id AND nullif(btrim(e.employee_code),'') IS NOT NULL
     AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL),'[]'::jsonb)
 FROM (SELECT DISTINCT q.row_id, q.is_creator, q.user_id, q.person_id, q.created_at, q.company_ids FROM pairs q) p
 CROSS JOIN viewer v
 LEFT JOIN public.app_user u ON u.id=p.user_id AND u.tenant_id=v.tenant_id
 LEFT JOIN public.person pe ON pe.id=coalesce(u.person_id,p.person_id) AND pe.tenant_id=v.tenant_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_log_actor_facts(text,uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.import_log_actor_facts(text,uuid[]) TO ai_hr_app;
