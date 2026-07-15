-- Enhance Employment Dates Management (feedback 955c7de4).
--
-- The Employment Dates card captured periods as BARE integer month+day pairs (probation_months/days,
-- resignation_notice_months/days, short_notice_months/days — migration 0181) with NO unit shown, so an admin
-- could not tell "3 / 0" meant 3 months or 3 days, and there was no way to express a period in WEEKS. It also
-- lacked the full employee lifecycle: no extended probation, no confirmation-extension date, no resignation
-- TENDER date and no LAST WORKING date.
--
-- This adds, additively and nullable:
--   • a value + unit pair per period for Probation, Extended Probation, Notice Before Confirmation and
--     Notice After Confirmation. unit ∈ ('month','week','day'), validated in core/org.ts::setEmploymentInfo.
--   • lifecycle dates: extended_confirmation_date, final_confirmation_date (derived = extended ?? normal,
--     recomputed + audited on every save), tender_resignation_date, last_working_date.
--
-- Backward-compat decision (chosen: KEEP legacy columns, no destructive migration): the legacy
-- probation_months/days, resignation_notice_months/days and short_notice_months/days columns are LEFT INTACT
-- and still drive the existing offer-letter probation-end computation (core/org.ts resolveProbationMonths /
-- offerLetterProbationEndDate). The new value+unit columns are the redesigned Employment Dates card's
-- master-data capture. For display continuity the read layer falls back legacy→new (e.g. probationValue ??
-- probation_months). Wiring the new period units + resignation/last-working dates into offer-letter
-- confirmation automation, payroll final-pay, attendance cutoff and auto career-movement records is DEFERRED
-- (documented v1 follow-up; behaviour change with pay + compliance impact).
--
-- All columns nullable + additive: an existing employment with every new column NULL behaves exactly as
-- before. IF NOT EXISTS makes a re-run on a partially-migrated DB safe. No RLS change — these scalar columns
-- inherit employment's tenant-scoped policies (same as the 0181 additive columns).
ALTER TABLE employment ADD COLUMN IF NOT EXISTS probation_value integer;--> statement-breakpoint
ALTER TABLE employment ADD COLUMN IF NOT EXISTS probation_unit text;--> statement-breakpoint
ALTER TABLE employment ADD COLUMN IF NOT EXISTS extended_probation_value integer;--> statement-breakpoint
ALTER TABLE employment ADD COLUMN IF NOT EXISTS extended_probation_unit text;--> statement-breakpoint
ALTER TABLE employment ADD COLUMN IF NOT EXISTS notice_before_confirmation_value integer;--> statement-breakpoint
ALTER TABLE employment ADD COLUMN IF NOT EXISTS notice_before_confirmation_unit text;--> statement-breakpoint
ALTER TABLE employment ADD COLUMN IF NOT EXISTS notice_after_confirmation_value integer;--> statement-breakpoint
ALTER TABLE employment ADD COLUMN IF NOT EXISTS notice_after_confirmation_unit text;--> statement-breakpoint
ALTER TABLE employment ADD COLUMN IF NOT EXISTS extended_confirmation_date date;--> statement-breakpoint
ALTER TABLE employment ADD COLUMN IF NOT EXISTS final_confirmation_date date;--> statement-breakpoint
ALTER TABLE employment ADD COLUMN IF NOT EXISTS tender_resignation_date date;--> statement-breakpoint
ALTER TABLE employment ADD COLUMN IF NOT EXISTS last_working_date date;
