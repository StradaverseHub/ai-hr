-- d9e41725 — Future Leave Year Opening Rule. A per-(tenant, leave year) advance-opening POLICY layered on
-- the managed leave_year_config record (9aa894a4). HR Admin defines an advance window ("open the year N
-- Days/Weeks/Months before its start"); the system computes open_leave_year_date = 1-Jan-of-year minus that
-- window (UTC-correct calendar math) and stamps it on the same row. Purely ADDITIVE: with these columns NULL
-- / false the row behaves exactly as it did after 0190 (no rule, open_leave_year_date set manually).
--
-- v1 is COMPUTE-ONLY: enabling the rule sets open_leave_year_date on the record; an automatic cron that opens
-- the year once today >= open_leave_year_date is DEFERRED (a documented product decision — see core/leave.ts
-- saveFutureOpeningRule). The three columns live on the existing table, so no new RLS/grants are needed —
-- leave_year_config already carries tenant-read + admin-write (0190).

ALTER TABLE "leave_year_config"
  ADD COLUMN IF NOT EXISTS "opening_rule_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_year_config"
  ADD COLUMN IF NOT EXISTS "open_before_amount" integer;--> statement-breakpoint
ALTER TABLE "leave_year_config"
  ADD COLUMN IF NOT EXISTS "open_before_unit" text;--> statement-breakpoint

-- Guard the unit to the three supported calendar units. NULL is allowed (no rule configured). Named + guarded
-- with a DO block so the migration is idempotent (re-run safe — ADD CONSTRAINT has no IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leave_year_config_open_before_unit_check'
  ) THEN
    ALTER TABLE "leave_year_config"
      ADD CONSTRAINT "leave_year_config_open_before_unit_check"
      CHECK ("open_before_unit" IS NULL OR "open_before_unit" IN ('days', 'weeks', 'months'));
  END IF;
END $$;
