-- 4fffe638 (r392) — a Fixed Transaction names a CONFIGURED Payroll Cycle, not just a run-type label.
--
-- Until now `employment_pay_component.run_type` (0152) was the only cycle the Fixed Transaction screen
-- stored: one of the four behavioural run types (regular / off_cycle / bonus / adjustment). A company
-- keeps its cycles under Payroll > Settings > Payroll Cycles (`payroll_cycle`, ADR-0069), and most have
-- THREE off_cycle cycles (Off-cycle, Advance Salary, Mid-Month), which the run-type label cannot tell
-- apart. This column links the row to the exact cycle the operator chose; `run_type` stays, set from the
-- cycle by the service (core/pay-components.ts), so every reader of `run_type` sees what it saw before.
--
-- DISPLAY AND RECORD ONLY. The payroll kernel (core/payroll.ts, recurring-component query) selects on
-- employment, the valid_from/valid_to window and superseded_at; it reads neither `run_type` nor this
-- column, and this migration does not change that. Linking a row to a cycle does not change which
-- payroll pays it.
--
-- No ON DELETE: a cycle with fixed transactions linked to it can be made inactive (archived_at) but not
-- deleted. core/payroll-cycle.ts deletePayrollCycle counts these references and refuses with a typed
-- in-use error before Postgres would raise the foreign-key failure.
--
-- NO GRANT STATEMENT, and that is correct rather than an omission: ALTER TABLE ADD COLUMN inherits the
-- table's existing privileges (0071) and RLS policy (0065). A GRANT is owed by CREATE TABLE, which this
-- is not (the 0441 precedent says the same).
--
-- Rollback:
--   DROP INDEX IF EXISTS employment_pay_component_payroll_cycle_idx;
--   ALTER TABLE employment_pay_component DROP COLUMN payroll_cycle_id;

ALTER TABLE "employment_pay_component"
  ADD COLUMN IF NOT EXISTS "payroll_cycle_id" uuid REFERENCES "payroll_cycle"("id");
--> statement-breakpoint

-- Partial: only linked rows are indexed. Read by the delete guard (count by cycle id).
CREATE INDEX IF NOT EXISTS "employment_pay_component_payroll_cycle_idx"
  ON "employment_pay_component" ("payroll_cycle_id")
  WHERE "payroll_cycle_id" IS NOT NULL;
--> statement-breakpoint

-- BACKFILL — the ONE-MATCH RULE, and no guessing.
--
-- A row is linked only when its employment's company has EXACTLY ONE non-archived cycle with the row's
-- run_type. Today that is every `regular` row (a company may hold at most one active regular cycle,
-- core/payroll-cycle.ts), which links to "Monthly". An off_cycle row in a company with two or more
-- off_cycle cycles is AMBIGUOUS and stays unlinked until someone edits it and picks the right cycle; a
-- row with no run_type stays unlinked ("unspecified"). Superseded rows are included so the history and
-- the live row agree.
--
-- Re-runnable: only rows still unlinked are touched, and the one-match test is re-evaluated each time.
-- Measured 2026-10-06 on production: 46 regular rows link; 2 off_cycle rows (Demo Sdn Bhd, two off_cycle
-- cycles) and 37 null rows stay unlinked. Re-measure before release.
UPDATE "employment_pay_component" AS epc
SET "payroll_cycle_id" = m.cycle_id
FROM (
  SELECT e."id" AS employment_id,
         c."run_type",
         (array_agg(c."id"))[1] AS cycle_id
    FROM "employment" AS e
    JOIN "payroll_cycle" AS c
      ON c."company_id" = e."company_id"
     AND c."tenant_id" = e."tenant_id"
     AND c."archived_at" IS NULL
   GROUP BY e."id", c."run_type"
  HAVING count(*) = 1
) AS m
WHERE epc."employment_id" = m.employment_id
  AND epc."run_type" = m."run_type"
  AND epc."run_type" IS NOT NULL
  AND epc."payroll_cycle_id" IS NULL;
