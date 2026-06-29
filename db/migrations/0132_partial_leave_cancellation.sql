-- Partial Leave Cancellation (feedback: "Partial Leave Cancellation after Approval"; ADR-0065).
--
-- After a leave request is approved, the employee can cancel a SUBSET of the approved dates. A new
-- leave_cancellation_request row captures the employee-initiated request; the manager approves/rejects it
-- in a single step. On approval the service (core/leave.ts decideLeaveCancellation) splits the approved
-- span into contiguous sibling leave_request rows sharing a fresh parent_group_id — exactly the
-- Emergency-Leave decomposition — gives each segment its own ledger debit, then flips the cancelled
-- segment(s) to status='cancelled' and reverses their debit. Because every span consumer (payroll
-- unpaidDaysByEmployment, attendance onLeave, plannedAbsences) filters status='approved', a cancelled
-- segment drops out of the balance, the calendar, and payroll for free — no read-layer span math.
--
-- This needs NO new leave_request column and NO new enum: the 'cancelled' value already exists in
-- leave_request_status (0xxx) and sibling segment rows reuse it. We only add the cancellation-request table.
--
--   leave_cancellation_request
--     leave_request_id  FK → leave_request.id (the approved leave being partially cancelled)
--     employment_id     denormalized from the leave_request for RLS (same pattern as
--                       leave_request_attachment / attendance_correction — can_see_employment(employment_id))
--     cancel_dates      jsonb array of ISO yyyy-mm-dd strings (the date(s) the employee wants to give back)
--     requested_days    numeric — the working-day count of cancel_dates (the balance to be restored)
--     reason            optional employee note
--     status            'pending' | 'approved' | 'rejected' (text + CHECK; reuses the
--                       attendance_correction_status 3-value space without a new enum)
--
-- RLS (ADR-0065): SYMMETRIC can_see_employment in USING + WITH CHECK, so the subject, their administrative
-- manager, and admins can SEE and the manager/admin can DECIDE (UPDATE). The "employee-initiated" rule
-- (only the subject may INSERT) and the self-approval ban are NOT expressible here — can_see_employment is
-- symmetric and a manager can see a subordinate — so both are enforced in the SERVICE layer
-- (requestLeaveCancellation asserts ctx.personId === the subject; decideLeaveCancellation calls
-- assertCanDecide which bans self-approval). This mirrors attendance_correction's RLS exactly.
--
-- Rollback:
--   DROP TABLE leave_cancellation_request;
CREATE TABLE "leave_cancellation_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"leave_request_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"cancel_dates" jsonb NOT NULL,
	"requested_days" numeric(6, 2) NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_employment_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_cancellation_request_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "leave_cancellation_request" ADD CONSTRAINT "leave_cancellation_request_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_cancellation_request" ADD CONSTRAINT "leave_cancellation_request_leave_request_id_leave_request_id_fk" FOREIGN KEY ("leave_request_id") REFERENCES "public"."leave_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_cancellation_request" ADD CONSTRAINT "leave_cancellation_request_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_cancellation_request" ADD CONSTRAINT "leave_cancellation_request_decided_by_employment_id_employment_id_fk" FOREIGN KEY ("decided_by_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leave_cancellation_request_request_idx" ON "leave_cancellation_request" USING btree ("leave_request_id");--> statement-breakpoint
-- RLS (ADR-0065): symmetric can_see_employment; subject-only INSERT + self-approval ban are service-enforced.
ALTER TABLE leave_cancellation_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON leave_cancellation_request TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY leave_cancellation_request_rls ON leave_cancellation_request FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
