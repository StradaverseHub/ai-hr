-- Feedback 5249d43f: Employee Clock in/out web portal — device registration + per-company enforcement.
--
-- 1 · employee_device: the browsers/devices an employee has registered for web clocking. The token is a
--     server-minted random UUID handed back once at registration, stored client-side (localStorage) and
--     presented with every web punch; the server matches an UNREVOKED row for the SAME employment.
--     Registration is self-service (an employee can register a replacement phone without a ticket);
--     administrators revoke from the Attendance policy screen. Both actions append audit events
--     (attendance.device.registered / attendance.device.revoked). Revocation is a soft mark (revoked_at)
--     so the device history stays readable next to its events.
-- 2 · attendance_policy.require_registered_device: the per-company enforcement switch. Default FALSE so
--     nobody is locked out the moment this ships; once teams have registered their devices, flip it ON and
--     web clocking from an unregistered device is blocked (typed DeviceNotRegisteredError in
--     core/attendance-device.ts). Terminal imports (method='import') are exempt — they never pass through
--     checkIn/checkOut — the same disclosed bypass as the geofence exemption (ADR-0070).
--
-- Journal entry: idx 301 (see meta/_journal.json).

CREATE TABLE "employee_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"label" text NOT NULL,
	"device_token" uuid NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "employee_device" ADD CONSTRAINT "employee_device_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_device" ADD CONSTRAINT "employee_device_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_device_employment_idx" ON "employee_device" USING btree ("employment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_device_token_uq" ON "employee_device" USING btree ("device_token");--> statement-breakpoint

-- RLS mirrors attendance_punch's per-person pattern (0265, minus the payroll-partner branch — a clocking
-- device is not payroll data): subject employee / their manager chain / admins via can_see_employment.
-- Self-service registration is the point — the subject employee INSERTs their own row (WITH CHECK passes
-- via the self branch of can_see_employment); admins revoke (UPDATE) any row in their scope. A new table
-- does NOT inherit prior GRANTs (a NOSUPERUSER/NOBYPASSRLS app role fails CLOSED — ADR-0002), so the GRANT
-- is required in this same migration.
ALTER TABLE "employee_device" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "employee_device" TO ai_hr_app;--> statement-breakpoint
CREATE POLICY "employee_device_rls" ON "employee_device" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));--> statement-breakpoint

ALTER TABLE "attendance_policy" ADD COLUMN "require_registered_device" boolean DEFAULT false NOT NULL;
