-- Role-gate writes on structural / admin tables: reads stay tenant-scoped, but only an
-- admin (hr_admin | super_admin) may create or modify them. Closes the hardening note in
-- ADR-0004. Recreates the FOR ALL policies with app.is_admin() in WITH CHECK.

DROP POLICY tenant_isolation ON company;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON company FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint
DROP POLICY tenant_isolation ON position;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON position FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint
DROP POLICY tenant_isolation ON department;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON department FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint
DROP POLICY tenant_isolation ON cost_center;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON cost_center FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint
DROP POLICY tenant_isolation ON leave_type;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON leave_type FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint
DROP POLICY tenant_isolation ON leave_policy;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON leave_policy FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint
DROP POLICY tenant_isolation ON app_user;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app_user FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint
DROP POLICY tenant_isolation ON role_assignment;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON role_assignment FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
