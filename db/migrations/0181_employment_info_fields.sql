-- 2323f671 — Employment Information enhancement. Adds employment master-data columns backing the new
-- "Employment Information" card on the Personnel (Admin) Employment tab. Purely ADDITIVE and BACKWARD
-- COMPATIBLE: every column is NULLABLE with no default, so an existing employment row is unaffected and
-- an all-NULL row behaves exactly as it did before (field-capture only — business rules follow in a later
-- CR). Date-relationship and non-negative-period validation lives in core/org.ts::setEmploymentInfo; the
-- DB stays permissive so legacy rows, imports and backfills never trip a CHECK. IF NOT EXISTS keeps it
-- idempotent. No RLS change — employment already has can_see/can_admin policies these columns inherit.
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "probation_months" integer;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "probation_days" integer;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "confirmation_date" date;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "resignation_notice_months" integer;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "resignation_notice_days" integer;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "resignation_date" date;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "short_notice_months" integer;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "short_notice_days" integer;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "org_branch" text;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "org_division" text;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "org_region" text;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "org_line" text;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "org_section" text;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "org_team" text;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "org_base" text;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "employment_category" text;
