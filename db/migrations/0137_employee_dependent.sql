-- Personnel Information — Family / Dependents (phase 1). A per-PERSON register of a person's family
-- members / dependents (spouse, child, parent, sibling, other) for BENEFITS / INSURANCE records only.
--
-- KEYING: person_id, NOT employment_id. Dependents are a PERSON fact — this codebase supports concurrent
-- employments (employment.person_id is non-unique; person.designated_paymaster_employment_id / ADR-0029),
-- so employment-keying would orphan the record when that employment terminates, hide it from the other
-- company's admin, and break for a not-yet-employed person. Precedent: tp1_relief (0102),
-- employee_statutory_my (0004) both key on person_id and gate with app.can_see_person.
--
-- BENEFITS-ONLY — does NOT feed tax. This register is deliberately SEPARATE from the approval-gated
-- employee_statutory_my.num_children figure that drives PCB. is_beneficiary is a simple insurance flag,
-- NOT a fractional allocation and NOT a tax-dependent flag (both explicitly out of scope).
--
-- RLS (decision, not copy-paste): mirror employee_statutory_my_rls (0004) — the person-keyed admin-write
-- precedent. USING app.can_see_person(person_id) already grants SELF + ADMIN read (0001), so an employee
-- can READ their own dependents; WITH CHECK app.is_admin() keeps WRITES admin-only (HR maintains; employees
-- do NOT self-edit in this version). (app.can_admin_employment is for EMPLOYMENT-keyed writable tables per
-- 0016; this table is person-keyed, so is_admin() is the correct write predicate.)
--
-- The table-level GRANT to ai_hr_app is explicit (new tables don't inherit prior GRANTs); the app role is
-- NOSUPERUSER/NOBYPASSRLS, so a missing policy fails CLOSED (ADR-0002).
--
-- Rollback:
--   DROP TABLE employee_dependent;
CREATE TABLE employee_dependent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  person_id uuid NOT NULL REFERENCES person(id),
  full_name text NOT NULL,
  relationship text NOT NULL,
  date_of_birth date,
  gender text,
  ic_or_passport text,
  is_beneficiary boolean NOT NULL DEFAULT false,
  phone text,
  remarks text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX employee_dependent_person_idx ON employee_dependent (tenant_id, person_id);--> statement-breakpoint

ALTER TABLE employee_dependent ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_dependent TO ai_hr_app;--> statement-breakpoint
CREATE POLICY employee_dependent_rls ON employee_dependent FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_person(person_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
