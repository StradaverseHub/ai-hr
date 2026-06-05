-- Slice 2: RLS for the holiday calendar. Tenant-scoped read; admin writes.
GRANT SELECT, INSERT, UPDATE, DELETE ON holiday TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE holiday ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON holiday FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
