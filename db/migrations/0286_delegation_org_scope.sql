-- R51 (baf56348) — delegation ORG COVERAGE (company → business unit → department) + same-level delegation.
--
-- 1. Org coverage columns live ON reporting_line (NOT the reporting_line_scope child table 0230 chose):
--    org coverage is a single 0..1 selection per delegation, not 0..N task rows, so the null-wildcard
--    column trio (mirroring leave_approval_policy.business_unit_id/department_id) is the honest shape.
--    All three NULL = unrestricted — the behaviour of every existing row (0230's zero-scope-rows convention).
-- 2. The 3-arg app.can_decide_via_delegation is REPLACED: p_module/p_task_type become NULL-tolerant
--    (NULL = no module filter, identical to today's scope-blind 1-arg decide behaviour) and the org gate is
--    added, so EVERY decide path that honours delegation (travel, profile, performance, offboarding,
--    employment review, leave, attendance, claims) picks up org enforcement through the one chokepoint
--    (core/approvals.ts assertCanDecide). The 1-arg VISIBILITY form (0109, RLS policies) stays untouched.
-- 3. app.approver_level ranks an employment by its HIGHEST duty (business_unit_head > department_head >
--    manager > none) — the write-time same-level guard's ladder. SECURITY DEFINER because the guard must
--    read the RECIPIENT's headship/reporting lines, which the caller's RLS session cannot see.
-- 4. app.eligible_delegates returns the same-level stand-in candidates with a deliberately NARROW projection.
--    SECURITY DEFINER is required, not optional: employment_rls (0099) / can_see_employment (0109) hide
--    sibling approvers from a self-service head, so a plain RLS-scoped query would return a near-empty list
--    (the exact trap app.self_delegations in 0196 exists to solve). In-function guard: the caller must OWN
--    the delegator employment or be an admin (prevents directory enumeration).
-- 5. app.can_decide_via_delegation_from — the 3-arg checks with an EXPLICIT delegator instead of "the
--    subject's current administrative manager". Used for head-step handover (core/leave.ts): a department/BU
--    head step may be cleared by the head's active delegate, which is what actually transfers head-level
--    authority.
-- Additive + idempotent (IF NOT EXISTS / OR REPLACE); a re-run is safe.

ALTER TABLE reporting_line ADD COLUMN IF NOT EXISTS scope_company_id uuid REFERENCES company(id);--> statement-breakpoint
ALTER TABLE reporting_line ADD COLUMN IF NOT EXISTS scope_business_unit_id uuid REFERENCES business_unit(id);--> statement-breakpoint
ALTER TABLE reporting_line ADD COLUMN IF NOT EXISTS scope_department_id uuid REFERENCES department(id);--> statement-breakpoint

-- Scope-aware decision helper, now NULL-tolerant on module/task and org-gated. Matching rules:
--   • module gate: NULL p_module = no module filter (whole-scope decide, the 1-arg behaviour); otherwise a
--     delegation with NO scope rows covers everything, and one with rows needs a matching (module, task).
--   • org gate: all three scope columns NULL = unrestricted. Company matches on employment.company_id (so a
--     company-only scope covers employees with NO assignment row — hence the LEFT JOINs). Subject BU is
--     COALESCE(assignment.business_unit_id, department.business_unit_id): assignment.business_unit_id
--     (added 0219) is NULL on virtually all legacy rows while the department implies the BU; the assignment
--     value wins when both are set; the two are not cross-validated here (out of scope). A non-null BU or
--     department scope does NOT match a subject with no current assignment.
CREATE OR REPLACE FUNCTION app.can_decide_via_delegation(subject_emp uuid, p_module text, p_task_type text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM reporting_line del
    JOIN reporting_line adm
      ON adm.subordinate_employment_id = subject_emp
     AND adm.line_type = 'administrative'
     AND adm.manager_employment_id = del.subordinate_employment_id
     AND adm.valid_from <= current_date AND (adm.valid_to IS NULL OR adm.valid_to > current_date)
     AND adm.superseded_at IS NULL
    JOIN employment adm_mgr ON adm_mgr.id = adm.manager_employment_id AND adm_mgr.terminated_on IS NULL
    JOIN employment del_emp ON del_emp.id = del.manager_employment_id
    JOIN app_user u ON u.person_id = del_emp.person_id
    WHERE del.line_type::text = 'delegate'
      AND del.tenant_id = app.current_tenant_id()
      AND del.valid_from <= current_date AND (del.valid_to IS NULL OR del.valid_to > current_date)
      AND del.superseded_at IS NULL
      AND u.id = app.current_user_id()
      AND (
        p_module IS NULL
        OR NOT EXISTS (SELECT 1 FROM reporting_line_scope s WHERE s.reporting_line_id = del.id)
        OR EXISTS (
          SELECT 1 FROM reporting_line_scope s
          WHERE s.reporting_line_id = del.id
            AND s.module = p_module
            AND (s.task_type IS NULL OR s.task_type = p_task_type)
        )
      )
      AND (
        (del.scope_company_id IS NULL AND del.scope_business_unit_id IS NULL AND del.scope_department_id IS NULL)
        OR EXISTS (
          SELECT 1
          FROM employment subj
          LEFT JOIN assignment sa ON sa.employment_id = subj.id AND sa.valid_to IS NULL AND sa.superseded_at IS NULL
          LEFT JOIN department sd ON sd.id = sa.department_id
          WHERE subj.id = subject_emp
            AND (del.scope_company_id IS NULL OR subj.company_id = del.scope_company_id)
            AND (del.scope_business_unit_id IS NULL
                 OR COALESCE(sa.business_unit_id, sd.business_unit_id) = del.scope_business_unit_id)
            AND (del.scope_department_id IS NULL OR sa.department_id = del.scope_department_id)
        )
      )
  );
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.can_decide_via_delegation(uuid, text, text) TO ai_hr_app;--> statement-breakpoint

-- Highest approval level held by an employment as of a date: business_unit_head > department_head >
-- manager (an active administrative downline — hasDownlineTx in SQL) > none. Archived org units don't count.
CREATE OR REPLACE FUNCTION app.approver_level(p_employment uuid, p_as_of date) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM business_unit bu
      WHERE bu.head_employment_id = p_employment AND bu.archived_at IS NULL
    ) THEN 'business_unit_head'
    WHEN EXISTS (
      SELECT 1 FROM department d
      WHERE d.head_employment_id = p_employment AND d.archived_at IS NULL
    ) THEN 'department_head'
    WHEN EXISTS (
      SELECT 1 FROM reporting_line rl
      WHERE rl.manager_employment_id = p_employment
        AND rl.line_type = 'administrative'
        AND rl.superseded_at IS NULL
        AND rl.valid_from <= p_as_of
        AND (rl.valid_to IS NULL OR rl.valid_to > p_as_of)
    ) THEN 'manager'
    ELSE 'none'
  END;
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.approver_level(uuid, date) TO ai_hr_app;--> statement-breakpoint

-- Same-level stand-in candidates for a delegator. Narrow projection ONLY (id, name, org ids, level).
-- Guard: the caller must own the delegator employment or hold an admin role — otherwise EMPTY, never an
-- error, so the function cannot be used to enumerate the directory.
CREATE OR REPLACE FUNCTION app.eligible_delegates(p_delegator uuid)
  RETURNS TABLE(employment_id uuid, full_name text, company_id uuid, business_unit_id uuid, department_id uuid, approver_level text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_person uuid;
  v_level text;
BEGIN
  SELECT e.person_id INTO v_person FROM employment e WHERE e.id = p_delegator AND e.tenant_id = v_tenant;
  IF v_person IS NULL THEN RETURN; END IF;
  IF NOT app.is_admin() AND NOT EXISTS (
    SELECT 1 FROM app_user u WHERE u.id = app.current_user_id() AND u.person_id = v_person
  ) THEN
    RETURN;
  END IF;
  v_level := app.approver_level(p_delegator, current_date);
  IF v_level = 'none' THEN RETURN; END IF;
  RETURN QUERY
    SELECT e.id, p.full_name, e.company_id,
           COALESCE(sa.business_unit_id, sd.business_unit_id),
           sa.department_id,
           v_level
    FROM employment e
    JOIN person p ON p.id = e.person_id
    LEFT JOIN assignment sa ON sa.employment_id = e.id AND sa.valid_to IS NULL AND sa.superseded_at IS NULL
    LEFT JOIN department sd ON sd.id = sa.department_id
    WHERE e.tenant_id = v_tenant
      AND e.terminated_on IS NULL
      AND e.person_id <> v_person
      AND app.approver_level(e.id, current_date) = v_level
    ORDER BY p.full_name;
END;
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.eligible_delegates(uuid) TO ai_hr_app;--> statement-breakpoint

-- Resolve the subject's current department/BU head (the employment a head step routes to). SECURITY DEFINER
-- because the head-step HANDOVER check runs under the DELEGATE's session, and RLS hides the subject's
-- assignment/department from a delegate (no visibility inheritance) — the same trap eligible_delegates
-- documents. Mirrors core/leave.ts resolveSubjectHead: current assignment (valid_to/superseded_at NULL),
-- BU via department.business_unit_id. Returns NULL when unset/no assignment.
CREATE OR REPLACE FUNCTION app.subject_head(subject_emp uuid, p_kind text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_kind = 'business_unit_head' THEN bu.head_employment_id ELSE d.head_employment_id END
  FROM assignment sa
  JOIN department d ON d.id = sa.department_id
  LEFT JOIN business_unit bu ON bu.id = d.business_unit_id
  WHERE sa.employment_id = subject_emp AND sa.valid_to IS NULL AND sa.superseded_at IS NULL
  LIMIT 1;
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.subject_head(uuid, text) TO ai_hr_app;--> statement-breakpoint

-- The 3-arg checks with an EXPLICIT delegator (head-step handover): active delegate edge FROM p_delegator to
-- the caller, window covering today, delegator employment still live, module scope + org scope both matching
-- the subject. No administrative-manager join — the delegator here is the resolved department/BU head.
CREATE OR REPLACE FUNCTION app.can_decide_via_delegation_from(p_delegator uuid, subject_emp uuid, p_module text, p_task_type text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM reporting_line del
    JOIN employment deleg ON deleg.id = del.subordinate_employment_id AND deleg.terminated_on IS NULL
    JOIN employment del_emp ON del_emp.id = del.manager_employment_id
    JOIN app_user u ON u.person_id = del_emp.person_id
    WHERE del.line_type::text = 'delegate'
      AND del.subordinate_employment_id = p_delegator
      AND del.tenant_id = app.current_tenant_id()
      AND del.valid_from <= current_date AND (del.valid_to IS NULL OR del.valid_to > current_date)
      AND del.superseded_at IS NULL
      AND u.id = app.current_user_id()
      AND (
        p_module IS NULL
        OR NOT EXISTS (SELECT 1 FROM reporting_line_scope s WHERE s.reporting_line_id = del.id)
        OR EXISTS (
          SELECT 1 FROM reporting_line_scope s
          WHERE s.reporting_line_id = del.id
            AND s.module = p_module
            AND (s.task_type IS NULL OR s.task_type = p_task_type)
        )
      )
      AND (
        (del.scope_company_id IS NULL AND del.scope_business_unit_id IS NULL AND del.scope_department_id IS NULL)
        OR EXISTS (
          SELECT 1
          FROM employment subj
          LEFT JOIN assignment sa ON sa.employment_id = subj.id AND sa.valid_to IS NULL AND sa.superseded_at IS NULL
          LEFT JOIN department sd ON sd.id = sa.department_id
          WHERE subj.id = subject_emp
            AND (del.scope_company_id IS NULL OR subj.company_id = del.scope_company_id)
            AND (del.scope_business_unit_id IS NULL
                 OR COALESCE(sa.business_unit_id, sd.business_unit_id) = del.scope_business_unit_id)
            AND (del.scope_department_id IS NULL OR sa.department_id = del.scope_department_id)
        )
      )
  );
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.can_decide_via_delegation_from(uuid, uuid, text, text) TO ai_hr_app;
