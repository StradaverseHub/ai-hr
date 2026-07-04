-- ADR-0069: Attendance Request Management. Extends attendance_correction (OT requests), adds a company-level
-- OT-approval-calculation setting, and a new travel_request audit-marker table. All additive/backward-safe.
--
-- HIGHEST-RISK SINGLE CHANGE (flagged in the plan): attendance_correction.proposed_check_in was NOT NULL on a
-- live, RLS-governed table with in-flight rows. Relaxing it to NULLABLE is what lets an "OT only" request (no
-- clock-in/out) exist. We replace the implicit NOT-NULL with an explicit CHECK requiring at least one of
-- (proposed_check_in, proposed_check_out, requested_ot_minutes) — so a totally-empty request is still rejected,
-- and every existing row (which always has proposed_check_in) satisfies it. No backfill needed.
--
-- reason stays NULLABLE at the DB layer (it always was) — "mandatory" is enforced only in requestAttendanceCorrection
-- application validation, per the plan's lower-risk decision (no retroactive NOT NULL on a live table without a backfill).
--
-- Journal entry: idx 145 (see meta/_journal.json).

CREATE TYPE "ot_approval_calculation" AS ENUM ('requested', 'system_calculated', 'smaller_of');--> statement-breakpoint

-- attendance_policy: company-level OT approval calculation setting (default system_calculated = today's behaviour).
ALTER TABLE "attendance_policy" ADD COLUMN "ot_approval_calculation" "ot_approval_calculation" NOT NULL DEFAULT 'system_calculated';--> statement-breakpoint

-- attendance_correction: relax proposed_check_in to NULLABLE, add OT-request columns, add the "at least one of"
-- CHECK and the one-pending-per-date partial unique index.
ALTER TABLE "attendance_correction" ALTER COLUMN "proposed_check_in" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_correction" ADD COLUMN "requested_ot_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance_correction" ADD COLUMN "approved_ot_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance_correction" ADD COLUMN "ot_approval_method" "ot_approval_calculation";--> statement-breakpoint
ALTER TABLE "attendance_correction" ADD CONSTRAINT "attendance_correction_at_least_one" CHECK (
  "proposed_check_in" IS NOT NULL OR "proposed_check_out" IS NOT NULL OR "requested_ot_minutes" IS NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_correction_one_pending_uq" ON "attendance_correction" USING btree ("employment_id","attendance_date") WHERE "status" = 'pending';--> statement-breakpoint

-- travel_request: a new employment-scoped table. RLS mirrors attendance_correction verbatim (subject employee,
-- their administrative manager, admins can SELECT/write; the service layer bans self-approval on the decide path).
CREATE TABLE "travel_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"travel_from" date NOT NULL,
	"travel_to" date NOT NULL,
	"remarks" text NOT NULL,
	"status" "attendance_correction_status" DEFAULT 'pending' NOT NULL,
	"decided_by_employment_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "travel_request_range_ck" CHECK ("travel_to" >= "travel_from")
);
--> statement-breakpoint
ALTER TABLE "travel_request" ADD CONSTRAINT "travel_request_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_request" ADD CONSTRAINT "travel_request_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_request" ADD CONSTRAINT "travel_request_decided_by_employment_id_employment_id_fk" FOREIGN KEY ("decided_by_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "travel_request_employment_idx" ON "travel_request" USING btree ("employment_id","travel_from");--> statement-breakpoint

-- RLS (mirrors attendance_correction_rls, 0028): visible/writable to the subject employee, their administrative
-- manager, and admins (same can_see_employment rule). The service bans self-approval on the decide path.
ALTER TABLE "travel_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Explicit grant: a new table does NOT inherit prior GRANTs (a NOSUPERUSER/NOBYPASSRLS app role fails CLOSED —
-- ADR-0002), so this statement is required in the same migration (see 0137/0144 rationale).
GRANT SELECT, INSERT, UPDATE, DELETE ON "travel_request" TO ai_hr_app;--> statement-breakpoint
CREATE POLICY "travel_request_rls" ON "travel_request" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
