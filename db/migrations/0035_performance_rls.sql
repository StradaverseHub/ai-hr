-- Performance & talent RLS (ADR-0013). Config-driven, statute-free module.
--
-- review_cycle: cycle metadata (name, dates, rating scale) is not sensitive — anyone in the
--   tenant may READ it (needed to render a review). WRITES are admin-only: company-scoped cycles
--   require admin of that company's subtree; group-wide cycles (company_id NULL) require a
--   group admin.
-- performance_review: row access mirrors leave_request — app.can_see_employment(employment_id),
--   i.e. admin (of the subject's company) + the subject employee (self) + the admin-line manager.
--   Column scope (employee writes self_*, manager writes manager_*) and the release gate are
--   enforced in the service + read layer, exactly as leave_request / profile_change.

ALTER TABLE review_cycle ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON review_cycle TO ai_hr_app;--> statement-breakpoint
CREATE POLICY review_cycle_read ON review_cycle FOR SELECT
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY review_cycle_write ON review_cycle FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND CASE WHEN company_id IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(company_id) END
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND CASE WHEN company_id IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(company_id) END
  );--> statement-breakpoint

ALTER TABLE performance_review ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON performance_review TO ai_hr_app;--> statement-breakpoint
CREATE POLICY performance_review_rls ON performance_review FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
