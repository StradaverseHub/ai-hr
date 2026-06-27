-- Hierarchy Management (ADR-0052) — part 2 of 2: recursive administrative-graph visibility +
-- department-tree (HOD) visibility, and delegation-scoped leave-request access.
--
-- Today app.can_see_employment matches only a DIRECT administrative manager (a single-hop EXISTS,
-- migrations 0001/0016). The ask is "managers see direct + INDIRECT reports" and "an HOD sees the
-- whole department tree". This rewrites the manager branch to a recursive DOWN-walk and adds an HOD
-- department-tree branch. Self + admin branches are kept byte-identical to 0016. RLS for compensation
-- (0060, admin-or-self) is unaffected: indirect managers gain employment visibility, NOT pay visibility.
-- (The `delegate` enum value was added in migration 0108 and is referenced freely here.)

-- ── 2a. Recursive admin-report predicate: subject_emp is a direct OR indirect admin report of manager_emp ──
-- Mirrors wouldCreateAdminCycle (core/org.ts) but walks DOWN the active administrative graph from the
-- manager. Each hop requires the edge to be active (administrative, not superseded, in its valid window)
-- AND the intermediate manager at that hop to be a live (non-terminated) employment, so a terminated
-- mid-level manager's subtree is not reachable through them. D2 (ADR-0052): the walk is clamped to the
-- manager's own company subtree (app.is_company_descendant) so a report in a sibling company is NOT
-- surfaced unless the manager has a separate grant there. Depth-capped at 64 to bound runaway recursion.
CREATE OR REPLACE FUNCTION app.is_admin_report_of(subject_emp uuid, manager_emp uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH RECURSIVE mgr AS (
    SELECT company_id AS root_company FROM employment WHERE id = manager_emp
  ),
  down AS (
    -- Seed: direct reports of the manager (depth 1).
    SELECT rl.subordinate_employment_id AS emp, 1 AS depth
    FROM reporting_line rl
    JOIN employment sub ON sub.id = rl.subordinate_employment_id
    JOIN mgr ON true
    WHERE rl.manager_employment_id = manager_emp
      AND rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND sub.terminated_on IS NULL
      AND app.is_company_descendant(sub.company_id, mgr.root_company)
    UNION
    -- Recurse: reports of any reachable (non-terminated) intermediate manager.
    SELECT rl.subordinate_employment_id, d.depth + 1
    FROM reporting_line rl
    JOIN employment mid ON mid.id = rl.manager_employment_id
    JOIN employment sub ON sub.id = rl.subordinate_employment_id
    JOIN down d ON d.emp = rl.manager_employment_id
    JOIN mgr ON true
    WHERE rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND mid.terminated_on IS NULL
      AND sub.terminated_on IS NULL
      AND d.depth < 64
      AND app.is_company_descendant(sub.company_id, mgr.root_company)
  )
  SELECT EXISTS (SELECT 1 FROM down WHERE emp = subject_emp);
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.is_admin_report_of(uuid, uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 2b. HOD department-tree predicate (D1 = derived). caller_emp heads subject_emp's department ──
-- True when there exists a department D such that caller_emp is the administrative manager whose CURRENT
-- assignment.department_id = D, and D is ancestor-or-self of subject_emp's CURRENT assignment department
-- (walking department.parent_department_id). "Current" uses valid_to IS NULL AND superseded_at IS NULL —
-- the same temporal predicate orgChartData's assignment join uses. The caller must not be terminated and
-- must actually manage at least one report (so a rank-and-file member is not treated as the head).
CREATE OR REPLACE FUNCTION app.heads_department_of(subject_emp uuid, caller_emp uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH caller_dept AS (
    SELECT a.department_id AS dept
    FROM assignment a
    JOIN employment e ON e.id = a.employment_id
    WHERE a.employment_id = caller_emp
      AND a.valid_to IS NULL AND a.superseded_at IS NULL
      AND a.department_id IS NOT NULL
      AND e.terminated_on IS NULL
  ),
  subject_dept AS (
    SELECT a.department_id AS dept
    FROM assignment a
    WHERE a.employment_id = subject_emp
      AND a.valid_to IS NULL AND a.superseded_at IS NULL
      AND a.department_id IS NOT NULL
  ),
  -- All departments in the subtree rooted at the caller's department (inclusive).
  subtree AS (
    WITH RECURSIVE down AS (
      SELECT dept AS id FROM caller_dept
      UNION ALL
      SELECT d.id FROM department d JOIN down ON d.parent_department_id = down.id
    )
    SELECT id FROM down
  )
  SELECT EXISTS (
    SELECT 1
    FROM subject_dept sd
    JOIN subtree st ON st.id = sd.dept
    WHERE EXISTS (SELECT 1 FROM caller_dept)
      AND EXISTS (
        SELECT 1 FROM reporting_line rl
        WHERE rl.manager_employment_id = caller_emp
          AND rl.line_type = 'administrative'
          AND rl.superseded_at IS NULL
          AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      )
  );
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.heads_department_of(uuid, uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 2c. Rewrite app.can_see_employment: self + admin branches byte-identical to 0016; manager branch is
-- now the recursive DOWN-walk; new HOD branch. Both the manager and HOD branches resolve the caller via
-- ALL of their employments (a person can hold concurrent employments — proven by Slice D), so visibility
-- is the UNION over every caller employment. No delegation branch (delegation is approver-routing only).
CREATE OR REPLACE FUNCTION app.can_see_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
      SELECT 1 FROM employment e
      WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND app.is_admin_for(e.company_id)
    )
    OR EXISTS (
      SELECT 1 FROM employment e JOIN app_user u ON u.person_id = e.person_id
      WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND u.id = app.current_user_id()
    )
    OR EXISTS (
      -- Recursive administrative-manager branch (direct + indirect reports), over all caller employments.
      SELECT 1 FROM employment me
        JOIN app_user u ON u.person_id = me.person_id
      WHERE u.id = app.current_user_id()
        AND me.tenant_id = app.current_tenant_id()
        AND me.terminated_on IS NULL
        AND app.is_admin_report_of(emp_id, me.id)
    )
    OR EXISTS (
      -- HOD department-tree branch, over all caller employments.
      SELECT 1 FROM employment me
        JOIN app_user u ON u.person_id = me.person_id
      WHERE u.id = app.current_user_id()
        AND me.tenant_id = app.current_tenant_id()
        AND me.terminated_on IS NULL
        AND app.heads_department_of(emp_id, me.id)
    );
$$;
--> statement-breakpoint

-- ── Index supporting the recursive DOWN-walk seed (manager → first hop) ──
-- The down-walk seeds and recurses on manager_employment_id; reporting_line_mgr_idx covers the column but
-- not the active-line predicate. A partial index on (manager, line_type) WHERE superseded_at IS NULL keeps
-- the per-row recursive seed cheap on a Chin Hin-scale tree.
CREATE INDEX IF NOT EXISTS reporting_line_mgr_active_idx
  ON reporting_line (manager_employment_id, line_type)
  WHERE superseded_at IS NULL;
--> statement-breakpoint

-- ── Delegation-scoped leave-request access. A delegate must be able to READ + UPDATE the specific leave
-- requests they are routed to decide (the delegator's direct reports' requests), WITHOUT gaining general
-- employment/compensation visibility (no can_see_employment delegate branch — that stays cut). This helper
-- is request-LEVEL: true when the subject's CURRENT direct administrative manager has an ACTIVE `delegate`
-- edge to the caller, re-validated at access time. Mirrors assertCanDecide's app-layer check so the DB
-- lets the row through and the service guard authorises the decision. One hop only (no transitive chain).
CREATE OR REPLACE FUNCTION app.can_decide_via_delegation(subject_emp uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM reporting_line del               -- the delegate edge: subordinate = delegator, manager = delegate
    JOIN reporting_line adm               -- subject's current direct administrative manager = the delegator
      ON adm.subordinate_employment_id = subject_emp
     AND adm.line_type = 'administrative'
     AND adm.manager_employment_id = del.subordinate_employment_id
     AND adm.valid_from <= current_date AND (adm.valid_to IS NULL OR adm.valid_to > current_date)
     AND adm.superseded_at IS NULL
    JOIN employment adm_mgr ON adm_mgr.id = adm.manager_employment_id AND adm_mgr.terminated_on IS NULL
    JOIN employment del_emp ON del_emp.id = del.manager_employment_id      -- the delegate (caller)
    JOIN app_user u ON u.person_id = del_emp.person_id
    -- Compare via ::text so this migration (which runs in the same transaction as the ADD VALUE in 0108)
    -- does not trip PostgreSQL's "unsafe use of new enum value" guard on the freshly-added 'delegate'.
    WHERE del.line_type::text = 'delegate'
      AND del.tenant_id = app.current_tenant_id()
      AND del.valid_from <= current_date AND (del.valid_to IS NULL OR del.valid_to > current_date)
      AND del.superseded_at IS NULL
      AND u.id = app.current_user_id()
  );
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.can_decide_via_delegation(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Widen leave_request RLS so a routed delegate can read/decide the request (but nothing else).
DROP POLICY leave_request_rls ON leave_request;
--> statement-breakpoint
CREATE POLICY leave_request_rls ON leave_request FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_decide_via_delegation(employment_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_decide_via_delegation(employment_id))
  );
--> statement-breakpoint
-- And the approval STEP rows, so the delegate can read + clear the direct_manager step. (The ledger is
-- intentionally NOT widened — a delegate clears their step and the chain advances to HR, which finalizes
-- under an admin context, so a delegate never reads/writes the subject's leave_ledger.)
DROP POLICY leave_approval_step_rls ON leave_approval_step;
--> statement-breakpoint
CREATE POLICY leave_approval_step_rls ON leave_approval_step FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(subject_employment_id) OR app.can_decide_via_delegation(subject_employment_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(subject_employment_id) OR app.can_decide_via_delegation(subject_employment_id))
  );
