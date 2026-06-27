-- 1.2.6 EA Data Overwrite (ADR-0059) — an EA-ONLY amendment layer. Per (employment, year, field) HR
-- records an amended amount that the EA (C.P.8A) read overlays onto the payroll-derived figure at render
-- time. Payroll records (payslip, payroll_input) are NEVER mutated, so amendments affect ONLY the
-- generated EA form — not payroll, not CP8D/Form E, not any other surface. Modelled on
-- statutory_component_override: a plain `field` text discriminator (validated in TS against EA_FIELDS),
-- NOT a pgEnum.
--
-- No original_amount snapshot column: the derived baseline is recomputed live on every read, so the
-- "original" is always available at render time; the audit "before" lives in the DomainEvent payload. No
-- soft-delete / supersede lifecycle: a plain upsert keyed on (tenant, employment, year, field); clear is a
-- hard DELETE; the immutable event log is the audit trail.
--
-- RLS (decision, not copy-paste): USING can_see_employment so the SUBJECT can read their own amended EA
-- (the amended figures land on the employee's own EA anyway, so self-read discloses nothing new);
-- WITH CHECK can_admin_employment so only HR admins of the employment's company may write. This matches
-- every employment-keyed write-gate in the codebase (0016 def; used by 0060/0065/0075/0076/0117). The
-- service layer (core/ea-override.ts) is the primary isAdmin/canManagePayroll guard; this is the SQL
-- backstop. The app role is NOSUPERUSER/NOBYPASSRLS so a missing policy fails CLOSED (ADR-0002).
--
-- The table-level GRANT to ai_hr_app is explicit (new tables don't inherit prior GRANTs; the live cluster's
-- default privileges auto-grant arwd to ai_hr_app, so SELECT-only-by-omission does NOT work — writes must
-- be gated by RLS, which they are). Cleartext amounts stay OUT of DomainEvent payloads only where the event
-- log has a broader read surface; here the EA figures are already visible to the subject, so the before/
-- after in the payload is fine (subject-scoped via subjectEmploymentId).
--
-- Rollback:
--   DROP TABLE ea_override;
CREATE TABLE ea_override (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  employment_id uuid NOT NULL REFERENCES employment(id),
  year text NOT NULL,
  field text NOT NULL,
  amount numeric(14, 2) NOT NULL,
  reason text NOT NULL,
  created_by_user_id uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- One override per (employment, year, field) — the upsert conflict target.
CREATE UNIQUE INDEX ea_override_field_uq ON ea_override (tenant_id, employment_id, year, field);--> statement-breakpoint
CREATE INDEX ea_override_lookup_idx ON ea_override (tenant_id, employment_id, year);--> statement-breakpoint

ALTER TABLE ea_override ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ea_override TO ai_hr_app;--> statement-breakpoint
CREATE POLICY ea_override_rls ON ea_override FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_employment(employment_id));
