-- 8590615a — Contract Employment Information on the Personnel (Admin) Employment tab.
--
-- MEASURED ON PRODUCTION BEFORE WRITING THIS: `employment.contract_end_date` ALREADY EXISTS
-- (0110_employment_review.sql). Only the START date and the REMARK are missing, so this migration adds
-- exactly those two. The contract END date is deliberately NOT re-created or renamed — the employment
-- review workflow (core/employment-review.ts) already reads it, and the new Employment-tab block writes
-- the SAME column, which is the whole point: one fact, one home.
--
-- ADDITIVE AND NULLABLE, WITH NO BACKFILL. There are 2 live contract employments on production and both
-- lack an end date. contract_start_date is NOT backfilled from hired_on: the screen shows the Group Join
-- Date as a pre-filled DISPLAY default and only writes it when HR actually saves, so a NULL here means
-- "HR has not confirmed this yet" rather than "the system guessed". Nothing is deleted, reset or
-- recomputed; no leave, payroll or entitlement figure reads either column.
--
-- No GRANT is needed: these are columns on the pre-existing `employment` table, already covered by its
-- grants and its RLS policy. (Stated rather than assumed — a CREATE TABLE migration without a GRANT has
-- cost this repo a round before.)
ALTER TABLE "employment" ADD COLUMN "contract_start_date" date;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN "contract_remark" text;
