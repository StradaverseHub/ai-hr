-- 1.2.2 Individual Transaction (ADR-0056) — a pure dated one-off payroll transaction ledger.
--
-- One-time (non-recurring) per-employee transactions: earnings / deductions / overtime / unpaid / leave
-- kinds, each tied to a transaction date, belonging to exactly one month+cycle batch (payroll_batch).
-- "Process only for the selected period / no carry-forward" is satisfied BY CONSTRUCTION by the batch_id
-- FK: a row belongs to a single batch and nothing copies it forward. This slice records / views / edits /
-- deletes rows (admin, before finalize) — kernel consumption is a separately-ADR'd deferred slice.
--
-- Every kind stores uniformly: kind + amount + quantity + unit. No component_id routing fork (the kernel
-- fold is out of scope), so no per-kind columns.
--
-- RLS: copied verbatim in FORM from payroll_input_rls (0099) — tenant + EXISTS(payroll_batch WHERE
-- can_admin_payroll_for(company_id)). The WITH CHECK re-derives company from batch_id so a row can never be
-- inserted referencing a batch outside the actor's payroll-admin scope. The table-level GRANT to ai_hr_app
-- is explicit here (new tables don't inherit prior GRANTs); the app role is NOSUPERUSER/NOBYPASSRLS so the
-- policy is enforced and a missing one fails closed (ADR-0002).
--
-- Rollback:
--   DROP TABLE payroll_individual_txn; DROP TYPE payroll_txn_kind;
CREATE TYPE payroll_txn_kind AS ENUM ('earning', 'deduction', 'overtime', 'unpaid', 'leave');--> statement-breakpoint

CREATE TABLE payroll_individual_txn (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  batch_id uuid NOT NULL REFERENCES payroll_batch(id),
  employment_id uuid NOT NULL REFERENCES employment(id),
  kind payroll_txn_kind NOT NULL,
  txn_date date NOT NULL,
  amount numeric(12, 2) NOT NULL DEFAULT '0',
  quantity numeric(12, 2),
  unit text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX payroll_individual_txn_batch_emp_idx ON payroll_individual_txn (batch_id, employment_id);--> statement-breakpoint
CREATE INDEX payroll_individual_txn_tenant_batch_idx ON payroll_individual_txn (tenant_id, batch_id);--> statement-breakpoint

ALTER TABLE payroll_individual_txn ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_individual_txn TO ai_hr_app;--> statement-breakpoint
CREATE POLICY payroll_individual_txn_rls ON payroll_individual_txn FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM payroll_batch b WHERE b.id = batch_id AND app.can_admin_payroll_for(b.company_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM payroll_batch b WHERE b.id = batch_id AND app.can_admin_payroll_for(b.company_id))
  );
