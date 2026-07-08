-- Claim Limit management by Job Grade (feedback ccbd0508 — "Claim Module Simplification & Claim Limit
-- Management"). Separates entitlement rules (claim_policy) from master data (claim_type), and adds the
-- Job-Grade dimension + the extra limit kinds the reporter asked for. Purely ADDITIVE: every existing
-- claim_policy row keeps grade_id = NULL ("all grades") and NULL new-limits ("not enforced"), so upgrade day
-- is byte-identical to today's behaviour — a null-grade policy resolves for every employee exactly as before.
--
-- No RLS change: claim_policy / claim_type already carry tenant-read + admin-write policies from
-- 0048_claims_rls.sql; new columns inherit the table's row policies (same note pattern as
-- 0159_leave_type_min_advance_days.sql). grade_id reuses the existing job_grade master (Leave module).
--
-- Idempotent (IF NOT EXISTS) — integration may renumber this file.

ALTER TABLE "claim_policy" ADD COLUMN IF NOT EXISTS "grade_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "claim_policy" ADD CONSTRAINT "claim_policy_grade_id_job_grade_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."job_grade"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "claim_policy" ADD COLUMN IF NOT EXISTS "monthly_limit" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "claim_policy" ADD COLUMN IF NOT EXISTS "lifetime_limit" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "claim_policy" ADD COLUMN IF NOT EXISTS "max_claims_per_year" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_policy_type_grade_idx" ON "claim_policy" ("claim_type_id", "grade_id", "valid_from");--> statement-breakpoint

ALTER TABLE "claim_type" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "claim_type" ADD COLUMN IF NOT EXISTS "max_receipt_age_days" integer;
