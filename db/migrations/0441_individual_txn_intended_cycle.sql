-- c11e81aa — THE PAY CYCLE THE OPERATOR CHOSE, REMEMBERED ON THE ROW; AND THE CYCLE A RUN OPENED UNDER,
-- REMEMBERED ON THE BATCH. Two columns, because ONE of them cannot route money on its own.
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
-- Offering the configured cycles WITHOUT `payroll_individual_txn.intended_cycle_id` would be the
-- pay-affecting half of that story: an entry saved as "Bonus" for a future month would still be paid on
-- the regular run, silently. So the choice is stored, and `generatePayslips` reads it.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY THE BATCH NEEDS A CYCLE ID TOO — RUN TYPE IS NOT AN IDENTITY
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- A payroll_batch has always snapshotted only its `run_type` (plus an off_cycle preset's free-text
-- `remarks` label). That was sufficient while `run_type` was the only thing the kernel gated on. It is
-- NOT sufficient for routing a named cycle, because the DEFAULT catalogue maps THREE cycles onto
-- run_type 'off_cycle' — 'Off-cycle', 'Advance Salary' and 'Mid-Month' (core/payroll-cycle.ts,
-- DEFAULT_PAYROLL_CYCLES). Matching a run to an intent by run type would therefore let an "Advance
-- Salary" run collect and pay a row the operator deliberately saved as "Mid-Month". Only 'regular' is
-- protected from that by construction, and by two separate rules at once: at most one ACTIVE regular
-- cycle per company (app-enforced) and at most one regular BATCH per pay period
-- (payroll_batch_one_regular_uq). bonus / off_cycle / adjustment have neither.
--
-- So the run records the cycle it was opened under, and attach-on-generate matches ID TO ID.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- NULL IS TODAY'S BEHAVIOUR ON BOTH COLUMNS, WHICH IS WHY THERE IS NO BACKFILL
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- Every existing transaction lands with `intended_cycle_id` NULL, and a NULL intent is collected by the
-- month's regular run exactly as it is collected today. Every existing batch lands with
-- `payroll_cycle_id` NULL, and a NULL-cycle run behaves as follows:
--
--   • REGULAR   — collects NULL-intent rows (today's behaviour, unchanged) plus rows naming any
--                 regular-mapped cycle of the company. Safe without an id because a period can hold at
--                 most one regular batch, so no sibling run can compete for those rows.
--   • NON-REGULAR — can name no cycle, so it collects NOTHING period-keyed. Also exactly today's
--                 behaviour: attach-on-generate has never run for a non-regular batch.
--
-- Nothing already keyed changes run, changes month, or changes amount.
--
-- The transaction FK is to `payroll_cycle`, the per-company catalogue — NOT to `payroll_batch`. A run may
-- not exist yet (that is the whole point) and cycle rows are per company, so the app re-validates the
-- company on every write. NO ON DELETE rule on either column: a cycle that is no longer wanted is
-- ARCHIVED (`archived_at`), never deleted, by every path in core/payroll-cycle.ts, and a hard delete is
-- refused outright while any batch references it (PayrollCycleInUseError) — so a dangling reference
-- cannot arise from the product.
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
--> statement-breakpoint

-- The run's own cycle identity. No index: it is read one batch at a time, by primary key, on a row the
-- caller already holds.
ALTER TABLE "payroll_batch"
  ADD COLUMN IF NOT EXISTS "payroll_cycle_id" uuid REFERENCES "payroll_cycle"("id");
