-- 0db616f3 — THE CONSUMED MARKER. The one change that closes the double-pay class rather than tidying
-- up one month of it.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED, AND WHY A COLUMN IS THE ANSWER
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- Measured read-only on production 2026-08-13. `payroll_individual_txn` carries
--   id, tenant_id, batch_id, employment_id, kind, txn_date, amount, quantity, unit, notes, created_at,
--   company_id, pay_period, component_id, updated_at, source, source_ref
-- and NOT ONE of them says whether a row has already been paid. The kernel's one-off fold
-- (core/payroll.ts, `generatePayslips`) selects
--   .from(payroll_individual_txn).leftJoin(pay_component ...).where(batch_id = $1)
-- — batch id and nothing else. So every row hanging off a run is folded on EVERY generation of that run,
-- and a row that moves to a second run is folded there too, with nothing anywhere recording that its
-- money already reached somebody.
--
-- January 2026 is the proof: 24 imported bonus rows worth RM106,073.31 sit on the REGULAR run
-- (368c67fc) while the BONUS run (fc9e5309) shows nineteen zero payslips, and only 13 rows /
-- RM62,524.51 are genuinely owed. The import-time duplicate refusal shipped alongside this migration
-- stops that file landing twice again; it does NOT stop an already-paid line being paid a second time by
-- a different run. Only a marker on the row does.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- THE SEMANTICS, WHICH ARE "PAID BY WHICH RUN", NOT "PAID"
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- `consumed_batch_id` names the run whose payslips included this line; `consumed_at` is when they were
-- written. A BOOLEAN would have been wrong and would have broken three flows this codebase relies on:
--
--   * RE-GENERATING THE SAME RUN. `resetProcessedBatch` deletes the run's payslips and returns it to
--     draft precisely so a correction can be re-run. A boolean would make every one-off row vanish from
--     the re-run. Keyed on the batch, the fold reads "consumed by nobody OR consumed by me" and the
--     re-run pays exactly what the first run paid.
--   * SELECTIVE REPROCESS. Same run, same rows, payslips deleted and rewritten for a subset of
--     employees — again "consumed by me".
--   * A SECOND RUN IN THE SAME MONTH. A bonus / off-cycle / adjustment run folds by its own batch_id, so
--     a line already paid by the regular run must never fold there. That is the case that has no
--     defence today, and it is the one January was one `generatePayslips` call away from.
--
-- The marker is CLEARED where the payslips that justified it are destroyed — `resetProcessedBatch`
-- (payslips deleted, run back to draft) and `teardownDraftChildren` (draft delete: payslips deleted and
-- the rows detached to survive as keyed-in business records). A line whose payslip no longer exists has
-- not been paid, and saying otherwise would strand real money.
--
-- ON DELETE SET NULL is not decoration. `teardownDraftChildren` detaches the rows and its caller then
-- DELETEs the payroll_batch row; a dangling `consumed_batch_id` would raise a foreign-key violation and
-- leak raw SQL into the UI (the exact failure ec3873a6 fixed for the other batch-keyed children). The
-- explicit clear above runs first and the FK rule is the backstop for any row the clear cannot see —
-- one whose batch_id was re-pointed by hand, which is precisely what the January repair script does.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- NO BACKFILL, AND THAT IS DELIBERATE
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- Every existing row lands with `consumed_batch_id` NULL, i.e. "not yet paid", which is the SAFE
-- direction: it can only cause a line to be paid that would have been paid anyway, never to be silently
-- skipped. Backfilling from "the row is on a processed run" would be wrong for January itself — those
-- 24 rows arrived at 15:27 and 15:30, THIRTY-FOUR MINUTES AFTER the run's payslips were written at
-- 14:53, so they are on a processed run and have never been in a payslip. Marking them consumed would
-- permanently strand RM62,524.51 that thirteen people are owed.
--
-- NO GRANT STATEMENT, and that is correct rather than an omission: ALTER TABLE ADD COLUMN inherits the
-- table's existing privileges. A GRANT is owed by CREATE TABLE (0345 / 0354 / 0357 / 0425 / 0427), which
-- this is not.

ALTER TABLE "payroll_individual_txn"
  ADD COLUMN IF NOT EXISTS "consumed_batch_id" uuid REFERENCES "payroll_batch"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "payroll_individual_txn" ADD COLUMN IF NOT EXISTS "consumed_at" timestamptz;
--> statement-breakpoint

-- Partial: empty on the day it lands and only ever holds rows that have actually been paid. The fold
-- reads `consumed_batch_id IS NULL OR consumed_batch_id = $batch`, and the reset/teardown clears read
-- `consumed_batch_id = $batch`, so this is the index both directions want.
CREATE INDEX IF NOT EXISTS "payroll_individual_txn_consumed_idx"
  ON "payroll_individual_txn" ("consumed_batch_id")
  WHERE "consumed_batch_id" IS NOT NULL;
