-- 1.2.8 Employee loan instalments (ADR-0060) — HR-administered staff loans recovered by a fixed monthly
-- POST-TAX net-pay deduction over an agreed duration. Two-phase reserve→apply (mirrors claims 0048):
-- prefill RESERVES the next instalment; the ledger (outstanding_balance / instalments_paid / status)
-- advances ONLY inside generatePayslips, in the same transaction as the payslip write.
--
-- payroll_input gains loan_deduction — read UNCONDITIONALLY (not behind TYPED_PAY_COMPONENTS_ENABLED) and
-- subtracted after statutory, like tp1_deduction/zakat; it touches NO statutory base (post-tax).
--
-- RLS (mirror claim_request_rls): employment-scoped — USING/WITH CHECK can_see_employment(employment_id),
-- so the subject + administrative manager + admin can read. Admin-only WRITES are enforced in the SERVICE
-- layer (not RLS) — matching claims — so the ESS path must never call a loan write service. The explicit
-- GRANT to ai_hr_app is load-bearing for the test harness (the app role is NOSUPERUSER/NOBYPASSRLS; a
-- missing policy fails CLOSED per ADR-0002, and grants landing in a later file would throw phantom
-- permission-denied in the RLS lifecycle test — MEMORY: ai_hr_test_db_recovery).
--
-- Rollback:
--   DROP TABLE loan_repayment; DROP TABLE employee_loan; DROP TYPE loan_status;
--   ALTER TABLE payroll_input DROP COLUMN loan_deduction;

ALTER TABLE payroll_input ADD COLUMN loan_deduction numeric(12, 2) NOT NULL DEFAULT '0';--> statement-breakpoint

CREATE TYPE loan_status AS ENUM ('active', 'suspended', 'settled', 'cancelled');--> statement-breakpoint

CREATE TABLE employee_loan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  employment_id uuid NOT NULL REFERENCES employment(id),
  loan_type text NOT NULL,
  principal numeric(12, 2) NOT NULL,
  interest_rate numeric(6, 3) NOT NULL DEFAULT '0',
  interest_method text NOT NULL DEFAULT 'none',
  duration_months integer NOT NULL,
  start_date date NOT NULL,
  monthly_instalment numeric(12, 2) NOT NULL,
  total_repayable numeric(12, 2) NOT NULL,
  outstanding_balance numeric(12, 2) NOT NULL,
  instalments_paid integer NOT NULL DEFAULT 0,
  status loan_status NOT NULL DEFAULT 'active',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX employee_loan_employment_idx ON employee_loan (employment_id, status);--> statement-breakpoint

CREATE TABLE loan_repayment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  loan_id uuid NOT NULL REFERENCES employee_loan(id),
  employment_id uuid NOT NULL REFERENCES employment(id),
  sequence_no integer NOT NULL,
  due_amount numeric(12, 2) NOT NULL,
  applied_amount numeric(12, 2) NOT NULL DEFAULT '0',
  reserved_batch_id uuid REFERENCES payroll_batch(id),
  applied_batch_id uuid REFERENCES payroll_batch(id),
  applied_at timestamptz,
  status text NOT NULL DEFAULT 'scheduled',
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX loan_repayment_loan_seq_uq ON loan_repayment (loan_id, sequence_no);--> statement-breakpoint
-- At most one RESERVED instalment per loan at a time — closes the re-prefill double-pick gap at the DB level.
CREATE UNIQUE INDEX loan_repayment_one_reserved_uq ON loan_repayment (loan_id) WHERE (status = 'reserved');--> statement-breakpoint

ALTER TABLE employee_loan ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE loan_repayment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_loan TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON loan_repayment TO ai_hr_app;--> statement-breakpoint

CREATE POLICY employee_loan_rls ON employee_loan FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));--> statement-breakpoint

CREATE POLICY loan_repayment_rls ON loan_repayment FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
