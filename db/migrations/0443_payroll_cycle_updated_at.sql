-- 6df24751 — PAYROLL CYCLES GET A "LAST UPDATED", BECAUSE THE COMPANY LISTING PROMISES ONE.
--
-- The redesign turns Payroll Cycles into a company-first listing: one row per company, with a status, what
-- is configured, and WHEN IT WAS LAST CHANGED. `payroll_cycle` carries `created_at` and nothing else, so
-- the last column had no source. This adds it.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY NULLABLE, AND WHY THE DEFAULT IS ADDED IN A SECOND STATEMENT
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- The approved plan says, in the reporter's own words: "The Last Updated column will be blank for cycles
-- nobody has touched since this ships, and will fill in from the first edit onwards. Nothing existing is
-- altered by this." That sentence is the specification for the two statements below.
--
-- `ALTER TABLE ... ADD COLUMN x timestamptz DEFAULT now()` would NOT honour it. Since PG11 a non-volatile
-- ADD COLUMN default is materialised for EVERY EXISTING ROW (as a fast default, but it is still the value
-- readers see) — so every cycle in every tenant would come back from this migration claiming it was edited
-- at deploy time, which is precisely the false history the plan promised not to write.
--
-- So the column lands with NO default (existing rows ⇒ NULL ⇒ the UI's em dash), and the default is
-- attached afterwards, where it applies only to rows inserted from here on. New cycles are therefore
-- stamped by the database and edits are stamped by core/payroll-cycle.ts (`updated_at = now()` on the
-- update, the activate/deactivate toggle included).
--
-- NOT NOT-NULL, and that is the same decision seen from the other side: a NOT NULL column would have
-- needed a backfill, and any backfill value would be a lie about when the row was last edited.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- NO GRANT, AND NO INDEX
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- ALTER TABLE ADD COLUMN inherits the table's existing privileges; a GRANT is owed by CREATE TABLE (0345 /
-- 0354 / 0357 / 0425 / 0427), which this is not. `payroll_cycle`'s RLS policies are column-blind, so the
-- tenant-wide read / can_admin_payroll_for write split already covers it.
--
-- No index: the column is only ever read as `max(updated_at)` grouped by company over one company's small
-- catalog (six default rows), on a table already indexed by company_id.

ALTER TABLE "payroll_cycle"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
--> statement-breakpoint

-- Applies to rows inserted AFTER this migration only — see the note above on why it is not part of the
-- ADD COLUMN.
ALTER TABLE "payroll_cycle"
  ALTER COLUMN "updated_at" SET DEFAULT now();
