-- 3c88d593 — Employee Entity Transfer, stage one: the legal entity becomes an effective-dated fact.
--
-- THE ROOT CAUSE WAS ONE MISSING COLUMN, and this is it. `employment.company_id` is a single mutable
-- value. An Entity Transfer overwrites it and keeps no record of what it held before, so nothing
-- downstream can answer "which entity did this person belong to on 8 August?". Payroll was not ignoring
-- the transfer date — it had nothing to look up. Employee 100814 transferred out of Fiamma into ISEDECOR
-- BINA effective 11 August 2026 and the whole of August was paid under ISEDECOR, with nothing at all
-- under Fiamma for 1–10 August. Reproduced on production (read-only) 2026-08-13 before this was written.
--
-- `assignment` IS ALREADY THE EFFECTIVE-DATED SPINE and already carries exactly the right shape:
-- position, department, cost centre, business unit, location, employment type, valid_from, valid_to,
-- recorded_at, superseded_at. Employment aa899123 already has two rows either side of its transfer. The
-- entity was the ONE placement dimension missing from it. So this is not a new bitemporal table, a new
-- pattern, or a new concept — it is the column that should have been on the spine from the start.
--
-- NULLABLE, DELIBERATELY, AND THE NULL MEANS SOMETHING. Every row that exists today gets NULL, and
-- core/employment-company.ts reads NULL as "this range carries no entity history — fall back to
-- employment.company_id", which is precisely today's behaviour. Consequences that matter to whoever
-- deploys this:
--   • the migration needs no data step and cannot fail on a row;
--   • payroll is byte-identical for every tenant until the backfill has run;
--   • THE BACKFILL IS A SEPARATE SCRIPT (scripts/backfill-assignment-company.ts), NOT part of deploy.
--     deploy.sh runs migrations, not scripts. The round is NOT finished when deploy.sh returns.
--
-- NO NOT-NULL, NO CHECK against the employment's current company. This column records what WAS true over
-- a past range; a constraint tying it to today's `employment.company_id` would be false the moment
-- anyone transfers, which is the only situation the column exists for.
--
-- NO RLS CHANGE AND NO NEW TABLE, so no GRANT is owed for the column: `assignment_rls` (migration 0001,
-- rewritten company-scoped in 0016) is FOR ALL over the whole table and already covers every column on
-- it. The GRANT is re-stated per the migration standard — a no-op on an existing table.
--
-- The exclusion constraint `assignment_no_overlap` (migration 0001) is untouched and stays the guarantee
-- that two CURRENT rows cannot cover one day: the entity resolver therefore reads a partition, not an
-- overlap, and needs no tie-break rule.

ALTER TABLE "assignment"
  ADD COLUMN IF NOT EXISTS "company_id" uuid REFERENCES "company"("id");
--> statement-breakpoint

-- The resolver's access path. Two shapes read this column: "what was employment E's entity on date D"
-- (served by the existing assignment_employment_idx) and "which employments belonged to company C over
-- range R" — the payroll batch's employee selection, which is this index.
CREATE INDEX IF NOT EXISTS "assignment_company_idx" ON "assignment" ("company_id", "valid_from");
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "assignment" TO ai_hr_app;
