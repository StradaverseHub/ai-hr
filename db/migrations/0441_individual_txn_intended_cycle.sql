-- c11e81aa — THE PAY CYCLE THE OPERATOR CHOSE, REMEMBERED ON THE ROW.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY A COLUMN AND NOT JUST A DROPDOWN
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- The Individual Transaction entry form's "Pay cycle" field has never listed the configured Payroll
-- Cycles (Payroll → Settings → Payroll Cycles). It listed the payroll RUNS that already exist for the
-- month, and printed "Awaiting payroll run" when there were none — so an entry keyed for a future month
-- could name no cycle at all. It was then saved period-keyed (batch_id NULL) and stamped onto the
-- month's REGULAR run by attach-on-generate (core/payroll.ts), whatever the operator had in mind.
--
-- Offering the configured cycles WITHOUT this column would be the pay-affecting half of that story: an
-- entry saved as "Bonus" for a future month would still be paid on the regular run, silently. So the
-- choice is stored, and `generatePayslips` reads it — a run collects a period-keyed row only when the
-- row named no cycle (today's rows, all of them) or named a cycle of THAT run's type.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- NULL IS TODAY'S BEHAVIOUR, WHICH IS WHY THERE IS NO BACKFILL
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- Every existing row lands with `intended_cycle_id` NULL, and a NULL intent is collected by the regular
-- run exactly as it is collected today. Nothing already keyed changes run, changes month, or changes
-- amount. A non-regular run, which collects nothing today, still collects nothing from a NULL-intent
-- row — the double-collection guard the current code buys by refusing every non-regular run is kept by
-- narrowing on the intent instead of widening the run.
--
-- The FK is to `payroll_cycle`, the per-company catalogue — NOT to `payroll_batch`. A run may not exist
-- yet (that is the whole point) and cycle rows are per company, so the app re-validates the company on
-- every write. NO ON DELETE rule: a cycle that is no longer wanted is ARCHIVED (`archived_at`), never
-- deleted, by every path in core/payroll-cycle.ts, so a dangling reference cannot arise from the product.
--
-- NO GRANT STATEMENT, and that is correct rather than an omission: ALTER TABLE ADD COLUMN inherits the
-- table's existing privileges. A GRANT is owed by CREATE TABLE (0345 / 0354 / 0357 / 0425 / 0427), which
-- this is not.

ALTER TABLE "payroll_individual_txn"
  ADD COLUMN IF NOT EXISTS "intended_cycle_id" uuid REFERENCES "payroll_cycle"("id");
--> statement-breakpoint

-- Partial, so it is empty on the day it lands and only ever holds rows whose operator named a cycle.
-- Attach-on-generate reads `intended_cycle_id IS NULL OR intended_cycle_id = ANY($cycles)` against the
-- month's unattached rows, which is exactly the key this index serves.
CREATE INDEX IF NOT EXISTS "payroll_individual_txn_intended_cycle_idx"
  ON "payroll_individual_txn" ("intended_cycle_id")
  WHERE "intended_cycle_id" IS NOT NULL;
