-- Claims RLS (ADR-0021).
--
-- claim_type / claim_policy: tenant-isolated CATALOG — every member reads (USING tenant), only an admin
--   writes (WITH CHECK adds app.is_admin()). Mirrors leave_type / leave_policy.
-- claim_request / claim_attachment: employment-scoped — visible/writable to the subject employee, their
--   active administrative manager, and admins (the same app.can_see_employment rule as leave_request /
--   attendance_correction). The SERVICE layer additionally enforces the state machine and the self-approval
--   ban on the decide path (core/claims.ts, via assertCanDecide) — RLS scopes tenancy + visibility, the
--   service scopes the transition rules. claim_attachment carries a denormalized employment_id so the policy
--   is a direct can_see_employment() with no per-row subquery.

ALTER TABLE claim_type ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claim_policy ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claim_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claim_attachment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON claim_type TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON claim_policy TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON claim_request TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON claim_attachment TO ai_hr_app;--> statement-breakpoint

CREATE POLICY tenant_isolation ON claim_type FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

CREATE POLICY tenant_isolation ON claim_policy FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

CREATE POLICY claim_request_rls ON claim_request FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));--> statement-breakpoint

CREATE POLICY claim_attachment_rls ON claim_attachment FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
