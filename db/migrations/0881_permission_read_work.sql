-- Skip only the admin visibility arm when the canonical coarse admin predicate is false.
-- Every original tenant/company, self, manager and HOD condition remains in the query.
-- Reuse the pure grant predicate's query plan; evaluate its inputs and hierarchy afresh.
CREATE OR REPLACE FUNCTION app.visible_employment_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $permission_read$
DECLARE performance_has_admin boolean := false;
BEGIN
 IF EXISTS(SELECT 1 FROM employment WHERE tenant_id=app.current_tenant_id()) THEN
  -- Preserve malformed grant errors before the coarse shortcut; never retain permission results.
  PERFORM g.company_id FROM app.current_grants() g;
  performance_has_admin := app.is_admin();
 END IF;
  RETURN (
WITH RECURSIVE
  -- The caller's employments that can_see_employment's manager and HOD arms iterate over:
  -- `employment me JOIN app_user u ON u.person_id = me.person_id WHERE u.id = app.current_user_id()
  --  AND me.tenant_id = app.current_tenant_id() AND me.terminated_on IS NULL`.
  me AS (
    SELECT e.id, e.company_id
    FROM employment e
    JOIN app_user u ON u.person_id = e.person_id
    WHERE u.id = app.current_user_id()
      AND e.tenant_id = app.current_tenant_id()
      AND e.terminated_on IS NULL
  ),
  -- (a) ADMIN arm: `e.tenant_id = app.current_tenant_id() AND app.is_admin_for(e.company_id)`.
  -- is_admin_for depends only on the company id and the session's grants, so it is evaluated once per
  -- DISTINCT company of the tenant's employments instead of once per employment.
  -- An optimization fence is necessary: without it PostgreSQL pushes is_admin_for below
  -- DISTINCT and repeats the same grant check for every employment in a company.
  tenant_company AS MATERIALIZED (
    SELECT DISTINCT e.company_id FROM employment e WHERE e.tenant_id = app.current_tenant_id() AND performance_has_admin
  ),
  admin_company AS MATERIALIZED (
    SELECT c.company_id
    FROM tenant_company c
    WHERE app.is_admin_for(c.company_id)
  ),
  -- (c) MANAGER arm: app.is_admin_report_of(subject, me.id) for every caller employment `me`, as ONE
  -- recursive walk seeded from all of them. Each path carries the company of the seed employment it
  -- started from (is_admin_report_of's `mgr.root_company`), so the company clamp on every hop is the
  -- clamp of THAT path's root — never another of the caller's employments'. UNION over
  -- (root_company, emp, depth) yields, per root company, exactly the union of the per-manager sets.
  down AS (
    SELECT m.company_id AS root_company, rl.subordinate_employment_id AS emp, 1 AS depth
    FROM me m
    JOIN reporting_line rl ON rl.manager_employment_id = m.id
    JOIN employment sub ON sub.id = rl.subordinate_employment_id
    WHERE rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND sub.terminated_on IS NULL
      AND app.is_company_descendant(sub.company_id, m.company_id)
    UNION
    SELECT d.root_company, rl.subordinate_employment_id, d.depth + 1
    FROM down d
    JOIN reporting_line rl ON rl.manager_employment_id = d.emp
    JOIN employment mid ON mid.id = rl.manager_employment_id
    JOIN employment sub ON sub.id = rl.subordinate_employment_id
    WHERE rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND mid.terminated_on IS NULL
      AND sub.terminated_on IS NULL
      AND d.depth < 64
      AND app.is_company_descendant(sub.company_id, d.root_company)
  ),
  -- (d) HOD arm: app.heads_department_of(subject, me.id) (0121) for every caller employment `me`.
  -- caller_dept = heads_department_of's caller_dept per caller (current assignment, department set;
  -- `e.terminated_on IS NULL` is already in `me`), kept only for a caller that ALSO manages at least one
  -- current administrative reporting line — heads_department_of's second EXISTS, which depends on the
  -- caller alone, so filtering that caller's rows here is the same condition.
  caller_dept AS (
    SELECT m.id AS caller, a.department_id AS dept, d.company_id AS company
    FROM me m
    JOIN assignment a ON a.employment_id = m.id
    JOIN department d ON d.id = a.department_id
    WHERE a.valid_to IS NULL AND a.superseded_at IS NULL
      AND a.department_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM reporting_line rl
        WHERE rl.manager_employment_id = m.id
          AND rl.line_type = 'administrative'
          AND rl.superseded_at IS NULL
          AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      )
  ),
  -- The department subtree per caller (inclusive). A hop is admitted when the child department's company
  -- descends from the company of ANY of THAT caller's departments — heads_department_of's
  -- `JOIN caller_dept cd ON true WHERE app.is_company_descendant(d.company_id, cd.company)`, whose
  -- caller_dept holds one caller's rows only. depth < 64 as there. UNION (not UNION ALL) only removes
  -- duplicate rows; the set of reachable departments is the same.
  dept_down AS (
    SELECT cd.caller, cd.dept AS id, 0 AS depth
    FROM caller_dept cd
    UNION
    SELECT dd.caller, d.id, dd.depth + 1
    FROM dept_down dd
    JOIN department d ON d.parent_department_id = dd.id
    JOIN caller_dept cd ON cd.caller = dd.caller
    WHERE app.is_company_descendant(d.company_id, cd.company)
      AND dd.depth < 64
  ),
  -- heads_department_of's subject_dept: the subject's current assignment lies in the subtree.
  hod AS (
    SELECT a.employment_id
    FROM assignment a
    WHERE a.valid_to IS NULL AND a.superseded_at IS NULL
      AND a.department_id IS NOT NULL
      AND a.department_id IN (SELECT dd.id FROM dept_down dd)
  ),
  visible AS (
    SELECT e.id
    FROM employment e
    WHERE e.tenant_id = app.current_tenant_id()
      AND e.company_id IN (SELECT ac.company_id FROM admin_company ac)
    UNION
    -- (b) SELF arm: `e.tenant_id = app.current_tenant_id() AND u.id = app.current_user_id()`.
    SELECT e.id
    FROM employment e
    JOIN app_user u ON u.person_id = e.person_id
    WHERE e.tenant_id = app.current_tenant_id()
      AND u.id = app.current_user_id()
    UNION
    SELECT d.emp FROM down d
    UNION
    SELECT h.employment_id FROM hod h
  )
  SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}'::uuid[]) FROM visible v WHERE v.id IS NOT NULL
  );
END;
$permission_read$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.grants_have_role_for(grants jsonb,wanted_role text,wanted_company uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app
AS $grant_plan$
BEGIN
 RETURN (
SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(grants,'[]'::jsonb)) g
 WHERE g->>'role'=wanted_role AND (g->>'companyId' IS NULL OR (g->>'companyId')::uuid=wanted_company OR app.is_company_descendant(wanted_company,(g->>'companyId')::uuid)))
 );
END;
$grant_plan$;
