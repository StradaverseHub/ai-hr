-- Job-function partner roles (ADR-0049): additive specialist roles BESIDE hr_admin.
--
-- Two partners this slice — payroll_partner, performance_comp_partner. Each is company-scopable
-- exactly like hr_admin, and administers only its function's data within its company subtree.
-- Recruiting Partner is deliberately deferred to the ATS PR (an inert enum value is irreversible,
-- and its real permission surface is unknown until an ATS exists). Compensation + Performance are
-- MERGED into one role because the app connects as a single DB role (ai_hr_app) and RLS grants
-- row-not-column access — a per-column comp/performance split is undeliverable on the current
-- schema (performance_review holds both the rating AND the merit/bonus recommendation). See ADR.
--
-- Single file (per the 0076/0094 precedent — drizzle wraps each migration file in one transaction).
-- The newly-added enum values are referenced ONLY as text literals (through app.has_role_for,
-- which takes text), never cast to ::role, so co-locating the policy DDL below in the same
-- transaction is safe (the in-txn enum-literal-cast trap is avoided entirely).

ALTER TYPE "role" ADD VALUE IF NOT EXISTS 'payroll_partner';--> statement-breakpoint
ALTER TYPE "role" ADD VALUE IF NOT EXISTS 'performance_comp_partner';--> statement-breakpoint

-- ── Capability helpers (additive OR-branches over the existing shared helpers) ──
-- Each wrapper's volatility / SECURITY / search_path DELIBERATELY mirrors the helper it extends,
-- per migration 0016's warning that row-visibility under RLS recursion is sensitive to these flags.

-- Company-scoped: admin-for-company OR payroll partner for that company. Plain STABLE, matching
-- app.is_admin_for (0016).
CREATE OR REPLACE FUNCTION app.can_admin_payroll_for(p_company uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT app.is_admin_for(p_company) OR app.has_role_for('payroll_partner', p_company);
$$;
--> statement-breakpoint
-- Company-scoped: admin-for-company OR perf-comp partner for that company. Plain STABLE.
CREATE OR REPLACE FUNCTION app.can_admin_perfcomp_for(p_company uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT app.is_admin_for(p_company) OR app.has_role_for('performance_comp_partner', p_company);
$$;
--> statement-breakpoint
-- Employment-scoped variants (compensation / payslip / attendance gate via can_admin_employment,
-- not a bare company_id). Declared SECURITY DEFINER SET search_path = public — matching
-- app.can_admin_employment EXACTLY (verified in 0016).
CREATE OR REPLACE FUNCTION app.can_admin_payroll_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM employment e WHERE e.id = emp_id AND app.can_admin_payroll_for(e.company_id));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_admin_perfcomp_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM employment e WHERE e.id = emp_id AND app.can_admin_perfcomp_for(e.company_id));
$$;
--> statement-breakpoint

-- ── Payroll Partner: rewrite only the policies whose expression changes ──

-- payroll_batch (latest def: 0013/0016). Read OR-branch (visible payslip) stays; the admin read
-- branch and the write branch widen to the payroll capability.
DROP POLICY payroll_batch_rls ON payroll_batch;--> statement-breakpoint
CREATE POLICY payroll_batch_rls ON payroll_batch FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.can_admin_payroll_for(company_id)
      OR EXISTS (SELECT 1 FROM payslip ps WHERE ps.batch_id = payroll_batch.id AND app.can_see_employment(ps.employment_id))
    )
  )
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_payroll_for(company_id));
--> statement-breakpoint

-- payslip (latest def: 0016, employment-scoped). USING keeps can_see_employment but ALSO ORs the
-- payroll-employment capability (is_admin_for inside can_see_employment does NOT include partners,
-- so a payroll partner would otherwise read zero payslips). CHECK widens to the payroll capability.
DROP POLICY payslip_rls ON payslip;--> statement-breakpoint
CREATE POLICY payslip_rls ON payslip FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_admin_payroll_employment(employment_id))
  )
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_payroll_employment(employment_id));
--> statement-breakpoint

-- payroll_input (latest def: 0022, EXISTS payroll_batch b WHERE b.id=batch_id AND is_admin_for).
DROP POLICY payroll_input_rls ON payroll_input;--> statement-breakpoint
CREATE POLICY payroll_input_rls ON payroll_input FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM payroll_batch b WHERE b.id = batch_id AND app.can_admin_payroll_for(b.company_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM payroll_batch b WHERE b.id = batch_id AND app.can_admin_payroll_for(b.company_id))
  );
--> statement-breakpoint

-- company_bank_profile (latest def: 0072, bare is_admin_for(company_id) for BOTH read & write).
-- The disbursement/bank surface is part of the payroll function; a company-scoped payroll partner
-- gets bank-profile read+write within its company (default YES, documented in ADR-0049).
DROP POLICY "company_bank_profile_rls" ON company_bank_profile;--> statement-breakpoint
CREATE POLICY "company_bank_profile_rls" ON company_bank_profile FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_admin_payroll_for(company_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_payroll_for(company_id));
--> statement-breakpoint

-- attendance (latest def: 0008, can_see_employment) — payroll partner needs read+write of its
-- company's attendance (payroll consumes attendance). OR the payroll-employment capability in.
DROP POLICY attendance_rls ON attendance;--> statement-breakpoint
CREATE POLICY attendance_rls ON attendance FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_admin_payroll_employment(employment_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_admin_payroll_employment(employment_id))
  );
--> statement-breakpoint

-- attendance_policy (latest def: 0016, company-scoped is_admin_for(company_id)) — payroll partner
-- administers its company's attendance policy.
DROP POLICY attendance_policy_rls ON attendance_policy;--> statement-breakpoint
CREATE POLICY attendance_policy_rls ON attendance_policy FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_payroll_for(company_id));
--> statement-breakpoint

-- pay_period (latest def: 0067, write is_admin()). createBatch find-or-creates the statutory-month
-- parent, so a payroll partner must be able to write the period for its company. Widen the write to
-- can_admin_payroll_for(company_id); keep the self-service read OR-branch. (The closed-period
-- immutability trigger still applies to everyone.)
DROP POLICY pay_period_rls ON pay_period;--> statement-breakpoint
CREATE POLICY pay_period_rls ON pay_period FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.can_admin_payroll_for(company_id)
      OR EXISTS (
        SELECT 1
        FROM payroll_batch b
        JOIN payslip ps ON ps.batch_id = b.id
        WHERE b.pay_period_id = pay_period.id
          AND app.can_see_employment(ps.employment_id)
      )
    )
  )
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_payroll_for(company_id));
--> statement-breakpoint

-- employment (latest def: 0016, USING can_see_employment(id), CHECK is_admin_for(company_id)).
-- Both partners need to READ their company's employments to function (payslip/attendance joins for
-- payroll; the cycle-open snapshot + review/comp joins for perf-comp). Widen USING to OR in the two
-- company-scoped partner capabilities. WRITE (CHECK) stays is_admin_for — partners do NOT create or
-- modify employment records; they only read them and act on the function-specific child tables.
DROP POLICY employment_rls ON employment;--> statement-breakpoint
CREATE POLICY employment_rls ON employment FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.can_see_employment(id)
      OR app.can_admin_payroll_for(company_id)
      OR app.can_admin_perfcomp_for(company_id)
    )
  )
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint

-- person (latest def: 0029, USING can_see_person(id), CHECK is_admin() OR is_self_person(id)).
-- payslip generation + the cycle snapshot inner-join person, so both partners need READ of their
-- company's person rows. Widen USING to OR in a partner-of-the-person's-company branch (the person's
-- company is reached through any of its employments). WRITE (CHECK) is unchanged — partners do not
-- edit person rows. The branch deliberately does NOT touch can_see_person/can_see_employment (per the
-- 0016 warning about broadening shared helpers); it gates the person table policy directly.
DROP POLICY person_rls ON person;--> statement-breakpoint
CREATE POLICY person_rls ON person FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.can_see_person(id)
      OR EXISTS (
        SELECT 1 FROM employment e
        WHERE e.person_id = person.id
          AND e.tenant_id = app.current_tenant_id()
          AND (app.can_admin_payroll_for(e.company_id) OR app.can_admin_perfcomp_for(e.company_id))
      )
    )
  )
  WITH CHECK (tenant_id = app.current_tenant_id() AND (app.is_admin() OR app.is_self_person(id)));
--> statement-breakpoint

-- ── Performance & Comp Partner: rewrite only the policies whose expression changes ──

-- compensation (latest def: 0060, USING can_admin_employment OR is_self; CHECK can_admin_employment).
-- READ widens for BOTH partners: a perf-comp partner must read salary to do merit work (the 0060
-- READ tighten otherwise leaves it reading zero rows), and a payroll partner must read base comp to
-- generate payslips (generatePayslips inner-joins compensation). WRITE widens only for the perf-comp
-- partner (it enacts merit → base pay); the payroll partner does NOT mutate base comp.
DROP POLICY compensation_rls ON compensation;--> statement-breakpoint
CREATE POLICY compensation_rls ON compensation FOR ALL
  USING (
    tenant_id = app.current_tenant_id() AND (
      app.can_admin_employment(employment_id)
      OR app.can_admin_perfcomp_employment(employment_id)
      OR app.can_admin_payroll_employment(employment_id)
      OR EXISTS (
        SELECT 1 FROM employment e
        WHERE e.id = compensation.employment_id AND app.is_self_person(e.person_id)
      )
    )
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.can_admin_employment(employment_id) OR app.can_admin_perfcomp_employment(employment_id))
  );
--> statement-breakpoint

-- review_cycle (latest def: 0035, write CASE NULL→is_group_admin ELSE is_admin_for(company_id)).
-- The perf-comp partner owns the cycle surface for its company. Group-wide (company_id NULL) cycles
-- still require a group admin (a company-scoped partner can't manage a group-wide cycle).
DROP POLICY review_cycle_write ON review_cycle;--> statement-breakpoint
CREATE POLICY review_cycle_write ON review_cycle FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND CASE WHEN company_id IS NULL THEN app.is_group_admin() ELSE app.can_admin_perfcomp_for(company_id) END
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND CASE WHEN company_id IS NULL THEN app.is_group_admin() ELSE app.can_admin_perfcomp_for(company_id) END
  );
--> statement-breakpoint

-- performance_review (latest def: 0035, can_see_employment). OR the perfcomp-employment capability
-- into BOTH USING and CHECK so the partner can read and finalize reviews for its company.
DROP POLICY performance_review_rls ON performance_review;--> statement-breakpoint
CREATE POLICY performance_review_rls ON performance_review FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_admin_perfcomp_employment(employment_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_admin_perfcomp_employment(employment_id))
  );
--> statement-breakpoint

-- performance_goal (latest def: 0050, can_see_employment).
DROP POLICY performance_goal_rls ON performance_goal;--> statement-breakpoint
CREATE POLICY performance_goal_rls ON performance_goal FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_admin_perfcomp_employment(employment_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_admin_perfcomp_employment(employment_id))
  );
--> statement-breakpoint

-- performance_attachment (latest def: 0096, can_see_employment).
DROP POLICY performance_attachment_rls ON performance_attachment;--> statement-breakpoint
CREATE POLICY performance_attachment_rls ON performance_attachment FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_admin_perfcomp_employment(employment_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_admin_perfcomp_employment(employment_id))
  );
--> statement-breakpoint

-- calibration_session / calibration_entry (latest def: 0057, coarse is_admin()). Widen so a
-- perf-comp partner (any grant) can run calibration. Company-grain isn't enforced here (these are
-- cycle-grained), matching the existing is_admin() coarseness.
DROP POLICY calibration_session_rls ON calibration_session;--> statement-breakpoint
CREATE POLICY calibration_session_rls ON calibration_session FOR ALL
  USING (tenant_id = app.current_tenant_id() AND (app.is_admin() OR EXISTS (SELECT 1 FROM app.current_grants() g WHERE g.role = 'performance_comp_partner')))
  WITH CHECK (tenant_id = app.current_tenant_id() AND (app.is_admin() OR EXISTS (SELECT 1 FROM app.current_grants() g WHERE g.role = 'performance_comp_partner')));
--> statement-breakpoint
DROP POLICY calibration_entry_rls ON calibration_entry;--> statement-breakpoint
CREATE POLICY calibration_entry_rls ON calibration_entry FOR ALL
  USING (tenant_id = app.current_tenant_id() AND (app.is_admin() OR EXISTS (SELECT 1 FROM app.current_grants() g WHERE g.role = 'performance_comp_partner')))
  WITH CHECK (tenant_id = app.current_tenant_id() AND (app.is_admin() OR EXISTS (SELECT 1 FROM app.current_grants() g WHERE g.role = 'performance_comp_partner')));
--> statement-breakpoint

-- ── Tighten 0023 sub-delegation (prevent silent escalation), NOT widen ──
-- Step 4's SCOPABLE_ROLES makes partner grants persist a non-null company_id. Without this, 0023's
-- delegated branch (role <> super_admin AND company_id NOT NULL AND is_admin_for) would let any
-- delegated company-admin mint partners in their subtree. Decision (default, documented in ADR):
-- ONLY GROUP ADMINS grant partners. The delegated branch is restricted to role = 'hr_admin' — exactly
-- the pre-existing invariant (a delegated admin keeps minting only subtree hr_admin). The group-admin
-- branch (is_group_admin) continues to grant any role including partners. This is a TIGHTENING.
DROP POLICY role_assignment_write ON role_assignment;--> statement-breakpoint
CREATE POLICY role_assignment_write ON role_assignment FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_group_admin()
      OR (role = 'hr_admin' AND company_id IS NOT NULL AND app.is_admin_for(company_id))
    )
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_group_admin()
      OR (role = 'hr_admin' AND company_id IS NOT NULL AND app.is_admin_for(company_id))
    )
  );
