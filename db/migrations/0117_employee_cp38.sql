-- 1.2.3 CP38 Deduction (ADR-0057) — a per-employment, effective-dated LHDN/court instalment deducted
-- each month IN ADDITION to monthly MTD/PCB. Modelled exactly like `compensation` (0004): supersede-on-
-- write (close the open row, insert a new one) + a gist EXCLUDE that makes overlapping CURRENT rows
-- structurally impossible, so a silent duplicate garnishment (a compliance hazard) cannot occur even
-- under a concurrent write. Dates are month-aligned by the service (YYYY-MM-01).
--
-- RLS (decision, not copy-paste): mirror `compensation_rls` — USING can_see_employment, WITH CHECK
-- is_admin. `can_see_employment` already grants the employee SELF-READ of their OWN record, which is
-- correct here: the CP38 amount appears on the employee's own payslip anyway, so self-read discloses
-- nothing new. (Cleartext amounts still stay OUT of DomainEvent payloads per ADR-0030, because the event
-- log has a broader read surface than this row.) Writes remain admin-only.
--
-- The table-level GRANT to ai_hr_app is explicit (new tables don't inherit prior GRANTs); the app role is
-- NOSUPERUSER/NOBYPASSRLS so the policy is enforced and a missing one fails CLOSED (ADR-0002). btree_gist
-- (needed by the daterange EXCLUDE) is already enabled in 0001.
--
-- Rollback:
--   DROP TABLE employee_cp38;
CREATE TABLE employee_cp38 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  employment_id uuid NOT NULL REFERENCES employment(id),
  cp38_ref text NOT NULL,
  amount numeric(12, 2) NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  remarks text,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX employee_cp38_employment_idx ON employee_cp38 (employment_id, valid_from);--> statement-breakpoint

ALTER TABLE employee_cp38 ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_cp38 TO ai_hr_app;--> statement-breakpoint
CREATE POLICY employee_cp38_rls ON employee_cp38 FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

-- No two *current* CP38 records overlap for one employment (mirrors compensation_no_overlap).
ALTER TABLE employee_cp38 ADD CONSTRAINT employee_cp38_no_overlap
  EXCLUDE USING gist (
    employment_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL);
