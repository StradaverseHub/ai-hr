-- Automated Probation / Contract / Internship Review Workflow.
-- Builds on the Hiring Enhancement (0107 employment.provisional_end_on). This migration adds the three
-- explicit end-date source columns (the trigger inputs) and the employment_review aggregate.
--
-- Which end-date column is meaningful is decided at RUNTIME by the employee's CURRENT open assignment row
-- (assignment.employment_type), never hard-coded: full_time → probation_end_date, contract →
-- contract_end_date, intern → internship_end_date. part_time gets no review (deliberate).
--
-- RLS mirrors resignation_request verbatim (FOR ALL, can_see_employment): the subject + their
-- administrative manager + admins read+write; stage authorization (manager-only stage 1, admin-only
-- stage 2, never-self) lives in the service. The SYSTEM cron runs with a group-wide hr_admin grant, so
-- app.is_admin() inside can_see_employment is true and the sweep sees every tenant employment.

-- 1.1 End-date source columns on employment (nullable; trigger inputs — runtime-selected by employment_type).
ALTER TABLE "employment" ADD COLUMN "probation_end_date" date;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN "contract_end_date" date;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN "internship_end_date" date;--> statement-breakpoint

-- 1.2–1.4 Enums.
CREATE TYPE "review_type" AS ENUM('probation', 'contract', 'internship');--> statement-breakpoint
CREATE TYPE "review_status" AS ENUM('pending_manager', 'pending_hr', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "review_decision" AS ENUM('confirm', 'extend', 'terminate');--> statement-breakpoint

-- 1.5 employment_review (shape/RLS modelled on resignation_request).
CREATE TABLE "employment_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"review_type" "review_type" NOT NULL,
	"status" "review_status" DEFAULT 'pending_manager' NOT NULL,
	"end_date" date NOT NULL,
	"due_date" date NOT NULL,
	-- manager stage (stage 1)
	"manager_employment_id" uuid,
	"manager_recommendation" text,
	"manager_comments" text,
	"manager_submitted_at" timestamp with time zone,
	-- HR stage (stage 2)
	"decision" "review_decision",
	"extend_to_date" date,
	"hr_comments" text,
	"decided_by_employment_id" uuid,
	"decided_at" timestamp with time zone,
	"auto_triggered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employment_review" ADD CONSTRAINT "employment_review_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_review" ADD CONSTRAINT "employment_review_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_review" ADD CONSTRAINT "employment_review_manager_fk" FOREIGN KEY ("manager_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_review" ADD CONSTRAINT "employment_review_decided_by_fk" FOREIGN KEY ("decided_by_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employment_review_employment_idx" ON "employment_review" USING btree ("employment_id","status");--> statement-breakpoint
-- Partial unique index: at most one OPEN review per (employment, review_type). NEW construct (not a copy of
-- resignation, which guards in-service) — backstops the cron+button race. The service does a pre-insert
-- SELECT first; this index catches two callers racing past that SELECT.
CREATE UNIQUE INDEX "employment_review_open_uq" ON "employment_review" USING btree ("employment_id","review_type") WHERE status IN ('pending_manager','pending_hr');--> statement-breakpoint

-- 1.6 RLS — copied verbatim from resignation_request.
ALTER TABLE employment_review ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON employment_review TO ai_hr_app;--> statement-breakpoint
CREATE POLICY employment_review_rls ON employment_review FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
