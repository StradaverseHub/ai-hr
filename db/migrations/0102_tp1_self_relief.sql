-- ADR-0050 (#1.1.3): yearly self-service TP1 personal tax relief.
-- A new per-(person, assessment_year) table the employee maintains; the latest submitted row feeds
-- monthly PCB through prefillTp1FromSelfRelief. RLS scopes to app.can_see_person (self + admin) for
-- read AND write — an employee can neither read nor write another person's TP1 (the WITH CHECK clause).
-- Plus a provenance flag on payroll_input (ADR-0050 §0.4) so a TP1 prefill refreshes only rows it set,
-- never an admin's manual override.
CREATE TYPE "tp1_status" AS ENUM('draft', 'submitted');--> statement-breakpoint
CREATE TABLE "tp1_relief" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"assessment_year" integer NOT NULL,
	"status" "tp1_status" DEFAULT 'draft' NOT NULL,
	"tp1_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tp1_relief" ADD CONSTRAINT "tp1_relief_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tp1_relief_person_year_idx" ON "tp1_relief" USING btree ("tenant_id","person_id","assessment_year","created_at");--> statement-breakpoint
ALTER TABLE tp1_relief ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON tp1_relief TO ai_hr_app;--> statement-breakpoint
CREATE POLICY tp1_relief_rls ON tp1_relief FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_person(person_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_person(person_id));--> statement-breakpoint
-- ADR-0050 §0.4: provenance marker so prefillTp1FromSelfRelief refreshes only rows a prior TP1 prefill
-- set ('tp1_self'), never an admin's manual tp1_deduction (null). No backfill needed: existing rows are
-- admin-keyed and correctly become sticky (null).
ALTER TABLE payroll_input ADD COLUMN "tp1_source" text;
