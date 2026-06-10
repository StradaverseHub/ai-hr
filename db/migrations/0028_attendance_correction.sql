CREATE TYPE "public"."attendance_correction_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "attendance_correction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"attendance_date" date NOT NULL,
	"proposed_check_in" time NOT NULL,
	"proposed_check_out" time,
	"reason" text,
	"status" "attendance_correction_status" DEFAULT 'pending' NOT NULL,
	"decided_by_employment_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_correction" ADD CONSTRAINT "attendance_correction_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_correction" ADD CONSTRAINT "attendance_correction_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_correction" ADD CONSTRAINT "attendance_correction_decided_by_employment_id_employment_id_fk" FOREIGN KEY ("decided_by_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_correction_employment_idx" ON "attendance_correction" USING btree ("employment_id","attendance_date");--> statement-breakpoint
-- RLS (ADR-0011 Phase B): visible/writable to the subject employee, their administrative
-- manager, and admins (same can_see_employment rule as leave_request). The service layer
-- additionally bans self-approval on the decide path.
ALTER TABLE attendance_correction ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON attendance_correction TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY attendance_correction_rls ON attendance_correction FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
