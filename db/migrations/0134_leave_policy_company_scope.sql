-- Configurable Earned Leave Entitlement Rules — per-company entitlement scope (feedback: "Configurable
-- Earned Leave Entitlement Rules"; ADR-0066).
--
-- Makes the existing accrual/grade entitlement engine (ADR-0040/0041) configurable PER COMPANY. A leave_policy
-- may now be scoped to a specific company (company_id) or left group-wide (company_id NULL = the group
-- default, the existing behaviour). The resolver (core/leave.ts resolveGradePolicy) is changed so that an
-- explicit company-scoped policy ALWAYS wins for employees of that company — even when it grants FEWER days
-- than the group default — by short-circuiting onto the company subset and never falling back to the group.
-- Companies with no override keep the group default unchanged (back-compat). Existing rows are company_id
-- NULL, so nothing changes for tenants that have not set an override.
--
-- (1) Column: nullable company_id FK. Existing rows null = group default.
ALTER TABLE leave_policy ADD COLUMN company_id uuid REFERENCES company(id);--> statement-breakpoint
-- (1b) Festive / one-off grant provenance (ADR-0066, Model 3): a human reason (e.g. "CNY 2026") stamped on
-- each festive `adjustment` ledger row. nullable = no change for every existing ledger row. Also the
-- idempotency key for re-running a grant: (leave_type_id, effective_on, reason) per employment.
ALTER TABLE leave_ledger ADD COLUMN reason text;--> statement-breakpoint
-- (2) Lookup index for the per-(company, type) resolution path (keeps the existing type index).
CREATE INDEX leave_policy_company_idx ON leave_policy (company_id, leave_type_id);--> statement-breakpoint
-- (3) Uniqueness (Phase 0(h)): DELIBERATELY NO unique constraint — the existing engine intentionally allows
-- multiple active policies for the same (company, leave_type, grade, valid_from) and resolves the
-- most-generous one within the scope tier (task #86 floor-vs-policy max; verified by grade-based-leave.test).
-- Adding a partial unique index would break that established, tested behaviour. Stay with the current state.
-- (4) RLS tightening (Phase 0(d)): keep READ tenant-wide (the accrual kernel resolves policies under
-- possibly non-admin sessions; a FOR ALL USING(is_admin_for) would silently zero-out reads). Tighten WRITE
-- to be company-aware using the proven nullable pattern (0035_performance_rls): a company-scoped admin may
-- only write a policy for their own company; the group default (company_id NULL) needs a group admin.
DROP POLICY tenant_isolation ON leave_policy;--> statement-breakpoint
CREATE POLICY tenant_isolation ON leave_policy FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND CASE WHEN company_id IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(company_id) END
  );
