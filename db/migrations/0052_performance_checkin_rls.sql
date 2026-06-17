-- Performance Phase B — 1:1 check-ins RLS (ADR-0022, slice 2).
--
-- performance_checkin: employment-scoped on the SUBJECT — visible/writable to the subject employee,
--   their active administrative manager, and admins (the same app.can_see_employment rule as the rest
--   of the module). The service enforces who may schedule vs complete vs cancel (assertCanDecide:
--   manager-or-admin, never self for scheduling); RLS scopes tenancy + visibility.

ALTER TABLE performance_checkin ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON performance_checkin TO ai_hr_app;--> statement-breakpoint

CREATE POLICY performance_checkin_rls ON performance_checkin FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(subject_employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(subject_employment_id));
