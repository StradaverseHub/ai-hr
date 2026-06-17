CREATE TYPE "public"."epf_mode" AS ENUM('auto', 'voluntary_excess', 'exempt');--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN "epf_mode" "epf_mode" DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN "epf_employee_rate" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN "epf_employer_rate" numeric(5, 4);