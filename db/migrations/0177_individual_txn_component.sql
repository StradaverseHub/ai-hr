-- f1564110 Phase 3 (amends ADR-0056) — individual-transaction kernel consumption substrate.
--
-- Adds the picked Payroll Item Master component to the one-off ledger. The wizard's named-item pick was
-- previously flattened to kind + label-in-notes; it is now persisted as a real FK so the payroll kernel
-- (behind INDIVIDUAL_TXN_PAY_ENABLED, default OFF) can fold an earning/deduction row through the
-- typed-pay-component fold with the catalog's statutory flags (EPF/SOCSO/PCB/HRDF), rounding and
-- non-payable treatment. Componentless legacy rows fold with conservative defaults (earning =
-- EPF/SOCSO/PCB-liable; deduction = post-statutory net deduction); NEW payable rows require a component
-- when the flag is on (service-enforced — no DB constraint, so legacy rows and flag-off writes stay valid).
--
-- NULLABLE by design: overtime/unpaid/leave kinds never carry a component (app-enforced), and every
-- pre-Phase-3 row is componentless. No RLS change — the 0175 policy fences by batch/company, not by column.
--
-- Rollback:
--   ALTER TABLE payroll_individual_txn DROP COLUMN component_id;
ALTER TABLE payroll_individual_txn ADD COLUMN IF NOT EXISTS component_id uuid REFERENCES pay_component(id);--> statement-breakpoint

-- Kernel fold lookup (batch ledger rows join pay_component at generate time); partial — only rows that
-- actually carry a component are indexed.
CREATE INDEX IF NOT EXISTS payroll_individual_txn_component_idx
  ON payroll_individual_txn (component_id) WHERE component_id IS NOT NULL;
