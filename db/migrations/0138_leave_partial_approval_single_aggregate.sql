-- Partial Leave Approval — single-request model (ADR-0068, supersedes ADR-0131 / migration 0131).
--
-- 0131 shipped partial leave approval by SPLITTING a multi-day request into one per-date child row at
-- submission (each sharing a parent_group_id, the Emergency-Leave shape). The reporter rejected this: a
-- 3-day request then appeared as 3 separate rows / 3 approval tasks in the approvals inbox. This migration
-- rebuilds the feature the reporter asked for: ONE request stays ONE inbox row, and per-date approve/reject
-- happens in the request DETAIL view.
--
-- The child-row split was correct for one reason: because every leave "span consumer" (attendance daily +
-- monthly, roster onLeave, plannedAbsences, unpaid-leave payroll) reads a whole leave_request row filtered
-- status='approved' and expands [start,end] with ZERO per-date awareness, a per-date child that is rejected
-- simply has no approved row and drops out of every consumer for free. Collapsing to one spanning approved
-- row would silently regress all 5. The fix (ADR-0068 §4A) is a NEW per-date child table that the span
-- consumers now read (see core/leave.ts approvedLeaveDates + the rewired consumers). Non-contiguous approvals
-- (approve day1+day3, reject day2) cannot be expressed by a single start/end envelope, so per-date rows are
-- load-bearing for reads.
--
-- New table leave_request_date: per requested WORKING date of a per-date-approval request. status defaults
-- pending; the approver flips each to approved/rejected in the detail view. subject_employment_id is
-- denormalized from the parent so RLS reuses the leave_approval_step policy VERBATIM (tenant + can_see OR
-- can_decide_via_delegation) — a tenant-only policy would let a manager see rows they cannot decide or hide
-- rows they can. reject_reason/decided_by/decided_at mirror the parent decision columns.
--
-- Already-split (deployed-0131) data — CHECK FIRST (ADR-0068 §3). The 0131 split only creates child rows at
-- run time and per_date_approval defaults false with no production seed setting it true, so the deployed
-- instance has (verified) ZERO split groups. Rather than ship a destructive guarded collapse for data that
-- does not exist, this migration ships ONLY the additive DDL. If a future instance is found to hold real
-- split groups, a follow-up migration performs the single-transaction guarded collapse per ADR-0068 §3.3.
-- The demo was verified empty before merge (ADR-0068 §3.1/§10).
--
-- Rollback:
--   DROP TABLE leave_request_date;
CREATE TABLE "leave_request_date" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"leave_request_id" uuid NOT NULL,
	"subject_employment_id" uuid NOT NULL,
	"leave_date" date NOT NULL,
	"days" numeric(6, 2) NOT NULL,
	"status" "leave_request_status" DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"decided_by_employment_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "leave_request_date" ADD CONSTRAINT "leave_request_date_leave_request_id_leave_request_id_fk" FOREIGN KEY ("leave_request_id") REFERENCES "public"."leave_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_date" ADD CONSTRAINT "leave_request_date_subject_employment_id_employment_id_fk" FOREIGN KEY ("subject_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_date" ADD CONSTRAINT "leave_request_date_decided_by_employment_id_employment_id_fk" FOREIGN KEY ("decided_by_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leave_request_date_request_date_uq" ON "leave_request_date" USING btree ("leave_request_id","leave_date");--> statement-breakpoint
CREATE INDEX "leave_request_date_request_idx" ON "leave_request_date" USING btree ("leave_request_id");--> statement-breakpoint
CREATE INDEX "leave_request_date_subject_date_idx" ON "leave_request_date" USING btree ("subject_employment_id","leave_date");--> statement-breakpoint
ALTER TABLE leave_request_date ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON leave_request_date TO ai_hr_app;--> statement-breakpoint
-- RLS: copy the leave_approval_step policy VERBATIM, keyed on subject_employment_id. This guarantees the
-- correlated per-date sub-selects in the span consumers return rows for exactly the managers who can see (or
-- decide-via-delegation on) the parent request — no stricter (hides the breakdown) and no looser (leaks).
CREATE POLICY leave_request_date_rls ON leave_request_date FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(subject_employment_id) OR app.can_decide_via_delegation(subject_employment_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.can_see_employment(subject_employment_id) OR app.can_decide_via_delegation(subject_employment_id))
  );
