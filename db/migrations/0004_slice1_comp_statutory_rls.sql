-- Slice 1: RLS + temporal integrity for compensation, employee_statutory_my, tenant_counter.
-- Reuses the app.* helpers from 0001. Compensation is ABAC-gated like assignment (salary is
-- sensitive); statutory profile like person; tenant_counter is admin-managed structural data.

-- Grants (explicit; default privileges also cover these).
GRANT SELECT, INSERT, UPDATE, DELETE ON compensation, employee_statutory_my, tenant_counter TO ai_hr_app;
--> statement-breakpoint

-- ── compensation: ABAC (can_see_employment), admin writes ──────────
ALTER TABLE compensation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY compensation_rls ON compensation FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint
-- No two *current* compensation records overlap for one employment.
ALTER TABLE compensation ADD CONSTRAINT compensation_no_overlap
  EXCLUDE USING gist (
    employment_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL);
--> statement-breakpoint

-- ── employee_statutory_my: ABAC (can_see_person), admin writes ─────
ALTER TABLE employee_statutory_my ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY employee_statutory_my_rls ON employee_statutory_my FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_person(person_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint

-- ── tenant_counter: tenant-scoped, admin writes ────────────────────
ALTER TABLE tenant_counter ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_counter_rls ON tenant_counter FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
