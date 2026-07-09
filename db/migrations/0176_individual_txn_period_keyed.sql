-- f1564110 Phase 2 (amends ADR-0056) — decouple one-off Individual Transactions from batch existence.
--
-- The ledger previously required an existing DRAFT payroll_batch (batch_id NOT NULL): an admin could not
-- record a mid-month one-off item until a run was created, and deleting a draft run destroyed the keyed-in
-- rows. This migration makes the row's true home the (company, pay month) pair:
--   • company_id + pay_period ('YYYY-MM') are added and backfilled from the owning batch, and every write
--     path now stamps them (attached or not);
--   • batch_id becomes NULLABLE — a row with batch_id NULL is "unattached": keyed in before any run exists,
--     picked up automatically (attach-on-generate) when the month's REGULAR run is generated;
--   • the CHECK guarantees a row is always addressable: either it references a batch, or it carries the
--     (company_id, pay_period) pair. pay_period is format-checked to the same 'YYYY-MM' axis payroll_batch
--     uses. "No carry-forward" is now keyed by pay_period instead of by the batch FK (ADR-0056 amendment):
--     a row belongs to exactly one month and nothing copies it forward.
--   • draft-batch teardown DETACHES rows (batch_id := NULL) instead of deleting them — app-side change,
--     enabled by the nullable FK here.
--
-- RLS: the old policy authorised exclusively THROUGH the batch join, so an unattached row would be invisible
-- and unwritable. Recreated with two branches: attached rows keep the batch-derived company check verbatim
-- (0116); unattached rows authorise on their own company_id via the same app.can_admin_payroll_for(). Both
-- USING and WITH CHECK carry both branches so attach (NULL→batch) and detach (batch→NULL) updates pass on
-- old AND new row images. Fails closed: batch_id NULL + company_id NULL matches no branch (and the CHECK
-- rejects such a row anyway).
--
-- This table is deliberately NOT under the 0011 batch_immutable_when_closed trigger; draft-only editing is
-- app-enforced (unchanged).
--
-- Rollback:
--   DELETE FROM payroll_individual_txn WHERE batch_id IS NULL;
--   ALTER TABLE payroll_individual_txn ALTER COLUMN batch_id SET NOT NULL;
--   ALTER TABLE payroll_individual_txn DROP CONSTRAINT payroll_individual_txn_target_check;
--   ALTER TABLE payroll_individual_txn DROP CONSTRAINT payroll_individual_txn_pay_period_format_check;
--   DROP INDEX payroll_individual_txn_unattached_idx;
--   ALTER TABLE payroll_individual_txn DROP COLUMN company_id, DROP COLUMN pay_period;
--   (then recreate the 0116 policy)
ALTER TABLE payroll_individual_txn ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES company(id);--> statement-breakpoint
ALTER TABLE payroll_individual_txn ADD COLUMN IF NOT EXISTS pay_period text;--> statement-breakpoint

-- Backfill the new pair from the owning batch (idempotent: only rows still missing either value).
UPDATE payroll_individual_txn t
SET company_id = b.company_id, pay_period = b.pay_period
FROM payroll_batch b
WHERE t.batch_id = b.id AND (t.company_id IS NULL OR t.pay_period IS NULL);--> statement-breakpoint

ALTER TABLE payroll_individual_txn ALTER COLUMN batch_id DROP NOT NULL;--> statement-breakpoint

ALTER TABLE payroll_individual_txn DROP CONSTRAINT IF EXISTS payroll_individual_txn_target_check;--> statement-breakpoint
ALTER TABLE payroll_individual_txn ADD CONSTRAINT payroll_individual_txn_target_check
  CHECK (batch_id IS NOT NULL OR (company_id IS NOT NULL AND pay_period IS NOT NULL));--> statement-breakpoint
ALTER TABLE payroll_individual_txn DROP CONSTRAINT IF EXISTS payroll_individual_txn_pay_period_format_check;--> statement-breakpoint
ALTER TABLE payroll_individual_txn ADD CONSTRAINT payroll_individual_txn_pay_period_format_check
  CHECK (pay_period IS NULL OR pay_period ~ '^[0-9]{4}-[0-9]{2}$');--> statement-breakpoint

-- Attach-on-generate lookup: unattached rows for a (tenant, company, month). Partial — attached rows are
-- served by the existing batch indexes.
CREATE INDEX IF NOT EXISTS payroll_individual_txn_unattached_idx
  ON payroll_individual_txn (tenant_id, company_id, pay_period) WHERE batch_id IS NULL;--> statement-breakpoint

DROP POLICY IF EXISTS payroll_individual_txn_rls ON payroll_individual_txn;--> statement-breakpoint
CREATE POLICY payroll_individual_txn_rls ON payroll_individual_txn FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      (batch_id IS NOT NULL AND EXISTS (SELECT 1 FROM payroll_batch b WHERE b.id = batch_id AND app.can_admin_payroll_for(b.company_id)))
      OR (batch_id IS NULL AND company_id IS NOT NULL AND app.can_admin_payroll_for(company_id))
    )
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (
      (batch_id IS NOT NULL AND EXISTS (SELECT 1 FROM payroll_batch b WHERE b.id = batch_id AND app.can_admin_payroll_for(b.company_id)))
      OR (batch_id IS NULL AND company_id IS NOT NULL AND app.can_admin_payroll_for(company_id))
    )
  );
