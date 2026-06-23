-- ADR-0041 2E: grade-based leave. A tenant grade catalog (seniority bands) + a nullable grade scope on
-- employees and leave policies. All additive + nullable, so a tenant with no grades behaves exactly as
-- before: ungraded employees + null-grade policies resolve to today's most-generous default.
CREATE TABLE "job_grade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_grade_code_uq" ON "job_grade" USING btree ("tenant_id","code") WHERE "archived_at" is null;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN "grade_id" uuid;--> statement-breakpoint
ALTER TABLE "employment" ADD CONSTRAINT "employment_grade_id_job_grade_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."job_grade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_policy" ADD COLUMN "grade_id" uuid;--> statement-breakpoint
ALTER TABLE "leave_policy" ADD CONSTRAINT "leave_policy_grade_id_job_grade_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."job_grade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE job_grade ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON job_grade TO ai_hr_app;--> statement-breakpoint
CREATE POLICY job_grade_rls ON job_grade FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
