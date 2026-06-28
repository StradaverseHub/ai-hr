-- Fix-2 — two confirmed RLS defects (SECURITY).
--
-- H2 (HIGH) — cross-company disclosure via the HOD department tree. app.heads_department_of() (0109)
-- walks department.parent_department_id with NO company clamp, unlike the recursive manager branch
-- (app.is_admin_report_of, which clamps every hop with app.is_company_descendant). If an admin mis-parents
-- a Company-A department under a Company-B parent, any HOD of the B-parent sees Company-A employees across
-- every can_see_employment-gated table. Fix: clamp the recursive department walk to the caller's company
-- subtree — every department in the subtree must satisfy app.is_company_descendant(dept.company_id,
-- caller_company). The belt-and-braces write-time guard lives in core/admin.ts createDepartment.
--
-- Loan-ledger self-write (MEDIUM, financial integrity) — employee_loan / loan_repayment (0120) RLS used
-- can_see_employment for BOTH USING and WITH CHECK. Because can_see_employment is true for the SELF
-- employee, a loan subject can INSERT/UPDATE/DELETE their own loan / repayment rows directly under RLS (the
-- admin-only rule was enforced only in the service layer — no DB backstop). Fix: mirror the compensation
-- pattern (0060) — USING stays can_see_employment (subject may SEE their loan) but WITH CHECK becomes
-- can_admin_employment (admin / authorized-writer only).
--
-- Rollback: re-CREATE OR REPLACE app.heads_department_of without the company clamp; DROP+CREATE the two loan
-- policies with WITH CHECK = can_see_employment.

-- ── H2: heads_department_of clamped to the caller's company subtree ──
-- Identical to 0109 (LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public) except the recursive
-- subtree walk only follows department.parent_department_id edges that stay inside the caller's company
-- subtree. caller_company is the company of the caller's CURRENT assignment department; a department whose
-- company is not a descendant of caller_company is never added to the subtree, so a mis-parented A-dept
-- under a B-parent is unreachable to a B HOD.
CREATE OR REPLACE FUNCTION app.heads_department_of(subject_emp uuid, caller_emp uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH caller_dept AS (
    SELECT a.department_id AS dept, d.company_id AS company
    FROM assignment a
    JOIN employment e ON e.id = a.employment_id
    JOIN department d ON d.id = a.department_id
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
  -- All departments in the subtree rooted at the caller's department (inclusive), clamped so every hop
  -- stays within the caller's company subtree (mirrors the manager branch's app.is_company_descendant clamp).
  subtree AS (
    WITH RECURSIVE down AS (
      SELECT cd.dept AS id, 0 AS depth FROM caller_dept cd
      UNION ALL
      SELECT d.id, down.depth + 1
      FROM department d
      JOIN down ON d.parent_department_id = down.id
      JOIN caller_dept cd ON true
      -- Audit #35: depth cap (mirrors app.is_admin_report_of's d.depth < 64) so a cyclic or pathologically
      -- deep department chain cannot loop unbounded inside this SECURITY DEFINER fn on every visibility check.
      WHERE app.is_company_descendant(d.company_id, cd.company) AND down.depth < 64
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

-- ── Loan-ledger self-write: retighten WITH CHECK to admin-only (mirror compensation 0060) ──
-- USING stays can_see_employment (subject + administrative manager + admin may READ); WITH CHECK becomes
-- can_admin_employment so only a (company-scoped) admin may INSERT/UPDATE/DELETE.
DROP POLICY employee_loan_rls ON employee_loan;
--> statement-breakpoint
CREATE POLICY employee_loan_rls ON employee_loan FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_employment(employment_id));
--> statement-breakpoint

DROP POLICY loan_repayment_rls ON loan_repayment;
--> statement-breakpoint
CREATE POLICY loan_repayment_rls ON loan_repayment FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_employment(employment_id));
