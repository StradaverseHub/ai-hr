-- Item 5a461b99 — SOCSO & EIS statutory controls on employee_statutory_my (additive, backward-compatible).
-- subject_to_* gate whether a scheme is contributed at all; employer_bears_* keep the scheme computed and
-- reported in full but fund the EMPLOYEE share from employer cost instead of deducting it from net pay.
-- eis_eligible (already present) is reused as "Subject to EIS" — no duplicate column.
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "subject_to_socso" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "subject_to_skbbk" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "employer_bears_socso" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "employer_bears_eis" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "employer_bears_skbbk" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- SKBBK (Lindung 24 Jam) is already mandatory-on today: DEFAULT_MY_STATUTORY.socso uses the SKBBK-inclusive
-- bands, so every current payslip already deducts the SKBBK leg. The column default (false) is the
-- reporter-approved default for employees created AFTER this migration; to preserve the CURRENT behaviour of
-- pre-existing rows we backfill them to subject-to-on. (On a clean-room migrate-from-empty this touches 0 rows.)
UPDATE "employee_statutory_my" SET "subject_to_skbbk" = true;
