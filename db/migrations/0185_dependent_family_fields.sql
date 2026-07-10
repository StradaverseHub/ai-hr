-- 4535b733 — Family Information enhancement. Widens employee_dependent with the additional family-member
-- fields requested by the reporter, grouped for Spouse / Children / Other Dependants sections. Purely
-- ADDITIVE and BACKWARD COMPATIBLE: every column is NULLABLE (or has a byte-identical default), so an
-- existing dependent row is unaffected and an all-NULL/legacy row behaves exactly as before. No new table
-- → the existing RLS on employee_dependent (app.can_see_person read / app.is_admin() write) already
-- covers these columns. Validation (relationship-gated spouse/child fields, allowed marriage-status set)
-- lives in core/dependents.ts; the DB stays permissive so legacy rows and imports never trip a CHECK.
-- IF NOT EXISTS keeps it idempotent.

-- General (all member types)
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "passport_number" text;--> statement-breakpoint
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "residential_address" text;--> statement-breakpoint
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "is_deceased" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "deceased_on" date;--> statement-breakpoint
-- Spouse-specific
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "marriage_date" date;--> statement-breakpoint
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "marriage_status" text;--> statement-breakpoint
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "spouse_working" boolean;--> statement-breakpoint
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "occupation" text;--> statement-breakpoint
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "company_name" text;--> statement-breakpoint
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "employer_address" text;--> statement-breakpoint
-- Children-specific
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "is_student" boolean;--> statement-breakpoint
ALTER TABLE "employee_dependent" ADD COLUMN IF NOT EXISTS "school_name" text;
