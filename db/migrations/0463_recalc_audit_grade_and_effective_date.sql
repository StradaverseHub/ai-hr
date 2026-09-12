-- 9e2a89e9 (r269) — leave_entitlement_recalc_audit gains THREE nullable columns: the two grades a
-- change moved between, and the date that change actually took effect.
--
-- ── WHAT WAS MISSING, AND WHAT WAS NOT ────────────────────────────────────────────────────────────────
-- Job grade, employment type and years of service are ALREADY entitlement criteria, and a grade change
-- ALREADY re-evaluates the employee — on save (movement_recorded) and, for a future-dated promotion, on
-- the morning its effective date arrives (movement_applied, sweepDueMovements). The reporter asked for
-- "previous Job Grade, new Job Grade, previous entitlement, new entitlement, effective date, and reason".
-- Three of the six were already recorded. These columns are the other two, plus the date.
--
-- ── WHY `change_effective_on` IS ITS OWN COLUMN AND DOES NOT REPLACE `effective_on` ────────────────────
-- `effective_on` means, and has always meant, THE DATE THE COMPENSATING LEDGER ADJUSTMENT WAS POSTED
-- (= the recalc's `asOf`). Every existing row carries that meaning. Re-pointing it at "the date the
-- change took effect" would leave one column holding two different facts, distinguishable only by row
-- age — the shape this codebase treats as a defect. So the new fact gets a new column:
--
--     effective_on         — when the correction was POSTED to the ledger (unchanged, NOT NULL)
--     change_effective_on  — when the underlying change TOOK EFFECT, when the caller knows it (nullable)
--
-- NULL means "not known here", which is honest and common: a configuration-triggered cohort recalc, an
-- ordinary employment-details edit and a reversal have no effective date of their own. The screen renders
-- `change_effective_on ?? effective_on` under one "Took effect" heading.
--
-- ⚠️ THE LEDGER ROW'S DATE IS DELIBERATELY NOT MOVED. Dating `leave_ledger.effective_on` from a
-- movement's effective date is a money-like change: it interacts with the cycle window guard
-- (core/leave.ts windowStart/windowEnd), with ADR-0069 encashment freezes, and with a backdated change
-- crossing a closed leave year. The approved plan promises the HISTORY row's date and nothing more, and
-- that is exactly what this migration and its writer deliver.
--
-- ── NULLABLE, NO FK ON PURPOSE, NO GRANT ──────────────────────────────────────────────────────────────
-- Every existing row stays valid and nothing already saved changes. The two grade columns carry no
-- foreign key to `job_grade`: a grade may be archived or (once nothing holds it) deleted, and an audit
-- row must survive that — a history that can be erased by tidying the catalogue is not a history. The
-- reader LEFT JOINs for the name and prints the raw absence as an em dash when the grade is gone.
-- Nothing is created, so the table's existing grants and RLS policies carry over untouched.
--
-- Journal entry: idx 463 (see meta/_journal.json).

DO $$
DECLARE total int;
BEGIN
  SELECT count(*) INTO total FROM leave_entitlement_recalc_audit;
  RAISE NOTICE '0463 leave_entitlement_recalc_audit: previous_grade_id / new_grade_id / change_effective_on added (all nullable). % existing rows keep NULLs, i.e. they read exactly as they do today.', total;
END $$;
--> statement-breakpoint
ALTER TABLE "leave_entitlement_recalc_audit" ADD COLUMN "previous_grade_id" uuid;--> statement-breakpoint
ALTER TABLE "leave_entitlement_recalc_audit" ADD COLUMN "new_grade_id" uuid;--> statement-breakpoint
ALTER TABLE "leave_entitlement_recalc_audit" ADD COLUMN "change_effective_on" date;
