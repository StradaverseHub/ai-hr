-- ADR-0070: Clocking Location Management & Geofencing. All additive.
--
--   • clocking_location — a SEPARATE company-scoped site register from `location` (ADR-0054 explicitly
--     scoped GPS/lat-lng out of that table). RLS: tenant-catalog read (every tenant member, mirrors 0065
--     pay_component), admin-of-company write. Supports hard DELETE (guarded in the service — only when
--     unreferenced) in addition to archive, per the request.
--   • employee_clocking_location — the assignment join (an employee may be authorized at ≥1 sites).
--   • employment.geofencing_enabled / geofence_radius_m — per-employee enforcement toggle + radius.
--   • attendance.check_in_*/check_out_* geo-capture columns — ALL nullable, split per punch so an
--     import-in/web-out row (or a mid-day radius/toggle change) never has one punch's capture overwrite
--     the other's. geofence_status can only be 'pass'/'not_enforced' — a BLOCKED attempt never writes an
--     attendance row; it is the attendance.geofence.blocked domain event instead (core/attendance.ts).
--
-- Journal entry: idx 142 (see meta/_journal.json).

CREATE TYPE "geofence_status" AS ENUM ('pass', 'not_enforced');--> statement-breakpoint
CREATE TYPE "clock_method" AS ENUM ('web', 'import');--> statement-breakpoint

CREATE TABLE "clocking_location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"address" text,
	"remarks" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clocking_location_lat_range" CHECK ("lat" BETWEEN -90 AND 90),
	CONSTRAINT "clocking_location_lng_range" CHECK ("lng" BETWEEN -180 AND 180)
);
--> statement-breakpoint
ALTER TABLE "clocking_location" ADD CONSTRAINT "clocking_location_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clocking_location" ADD CONSTRAINT "clocking_location_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clocking_location_company_idx" ON "clocking_location" USING btree ("tenant_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clocking_location_name_uq" ON "clocking_location" USING btree ("tenant_id","company_id","name");--> statement-breakpoint

CREATE TABLE "employee_clocking_location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"clocking_location_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_clocking_location" ADD CONSTRAINT "employee_clocking_location_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_clocking_location" ADD CONSTRAINT "employee_clocking_location_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_clocking_location" ADD CONSTRAINT "employee_clocking_location_clocking_location_id_clocking_location_id_fk" FOREIGN KEY ("clocking_location_id") REFERENCES "public"."clocking_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_clocking_location_employment_idx" ON "employee_clocking_location" USING btree ("employment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_clocking_location_uq" ON "employee_clocking_location" USING btree ("employment_id","clocking_location_id");--> statement-breakpoint

ALTER TABLE "employment" ADD COLUMN "geofencing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN "geofence_radius_m" integer;--> statement-breakpoint
ALTER TABLE "employment" ADD CONSTRAINT "employment_geofence_radius_required" CHECK (NOT "geofencing_enabled" OR ("geofence_radius_m" IS NOT NULL AND "geofence_radius_m" > 0));--> statement-breakpoint

ALTER TABLE "attendance" ADD COLUMN "check_in_lat" double precision;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_in_lng" double precision;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_in_clocking_location_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_in_distance_m" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_in_geofence_status" "geofence_status";--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_in_radius_m" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_in_method" "clock_method";--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_out_lat" double precision;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_out_lng" double precision;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_out_clocking_location_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_out_distance_m" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_out_geofence_status" "geofence_status";--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_out_radius_m" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_out_method" "clock_method";--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_check_in_clocking_location_id_clocking_location_id_fk" FOREIGN KEY ("check_in_clocking_location_id") REFERENCES "public"."clocking_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_check_out_clocking_location_id_clocking_location_id_fk" FOREIGN KEY ("check_out_clocking_location_id") REFERENCES "public"."clocking_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- RLS: clocking_location mirrors the 0065 pay_component tenant-catalog pattern verbatim — every tenant
-- member SELECTs (name resolution for managers/history after un-assignment; ADR-0070 §2), only an admin
-- of the site's own company writes.
ALTER TABLE "clocking_location" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "clocking_location_rls" ON "clocking_location" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));--> statement-breakpoint

-- employee_clocking_location: SELECT via can_see_employment (same visibility as other employment-scoped
-- rows); INSERT/DELETE via can_admin_employment (mirrors employment_pay_component_rls).
ALTER TABLE "employee_clocking_location" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "employee_clocking_location_rls" ON "employee_clocking_location" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_employment(employment_id));--> statement-breakpoint

-- Explicit grants (a migrate-forward-only DB / clean CI provisioning has no cluster default privileges —
-- see 0071's rationale). employment/attendance already have table-level grants; only the new tables need
-- one here.
GRANT SELECT, INSERT, UPDATE, DELETE ON "clocking_location" TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "employee_clocking_location" TO ai_hr_app;
