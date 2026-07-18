-- R45 92bdf77a: Attendance Multiple Clocking & Overtime (Stage 1 — capture + first-in/last-out summation).
--
-- The day still keeps exactly ONE `attendance` aggregate row: the existing one-row-per-day unique index
-- (attendance_employment_date_uq) is DELIBERATELY untouched. Multiple clock-in/out is captured in a NEW child
-- table `attendance_punch`; the aggregate row's check_in_at / check_out_at / worked_minutes / ot_minutes are
-- re-derived from the punches on every punch (first-in / last-out) by core/attendance.ts. Purely additive —
-- legacy attendance rows (no punch children) keep working; the first web check-out backfills their punches.
--
-- Journal entry: idx 265 (see meta/_journal.json).

CREATE TYPE "attendance_punch_direction" AS ENUM ('in', 'out');--> statement-breakpoint

CREATE TABLE "attendance_punch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"attendance_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"attendance_date" date NOT NULL,
	"punch_at" time NOT NULL,
	"direction" "attendance_punch_direction" NOT NULL,
	"method" "clock_method" DEFAULT 'web' NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"clocking_location_id" uuid,
	"distance_m" integer,
	"geofence_status" "geofence_status",
	"radius_m" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_punch" ADD CONSTRAINT "attendance_punch_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_punch" ADD CONSTRAINT "attendance_punch_attendance_id_attendance_id_fk" FOREIGN KEY ("attendance_id") REFERENCES "public"."attendance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_punch" ADD CONSTRAINT "attendance_punch_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_punch" ADD CONSTRAINT "attendance_punch_clocking_location_id_clocking_location_id_fk" FOREIGN KEY ("clocking_location_id") REFERENCES "public"."clocking_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_punch_attendance_idx" ON "attendance_punch" USING btree ("attendance_id","punch_at");--> statement-breakpoint

-- RLS mirrors attendance (latest def: 0099 — subject employee / their manager / admins via can_see_employment,
-- OR the payroll partner via can_admin_payroll_employment). A new table does NOT inherit prior GRANTs (a
-- NOSUPERUSER/NOBYPASSRLS app role fails CLOSED — ADR-0002), so the GRANT is required in this same migration.
ALTER TABLE "attendance_punch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "attendance_punch" TO ai_hr_app;--> statement-breakpoint
CREATE POLICY "attendance_punch_rls" ON "attendance_punch" FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_admin_payroll_employment(employment_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(employment_id) OR app.can_admin_payroll_employment(employment_id))
  );
