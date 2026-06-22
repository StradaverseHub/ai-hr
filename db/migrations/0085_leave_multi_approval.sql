-- ADR-0038 2B-1: multi-level leave approval. company.leave_multi_approval opts a company into a
-- multi-step chain (direct manager → HR). leave_approval_step holds the generated instance steps;
-- decideLeave advances the lowest-index pending step. subject_employment_id is denormalized from the
-- request so RLS reuses can_see_employment (same subject + manager + admin rule as leave_request).
-- All additive; default false keeps every existing company on single-step approval.
ALTER TABLE company ADD COLUMN leave_multi_approval boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE TABLE "leave_approval_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"leave_request_id" uuid NOT NULL,
	"subject_employment_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"approver_kind" text NOT NULL,
	"status" "leave_request_status" DEFAULT 'pending' NOT NULL,
	"decided_by_employment_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "leave_approval_step" ADD CONSTRAINT "leave_approval_step_leave_request_id_leave_request_id_fk" FOREIGN KEY ("leave_request_id") REFERENCES "public"."leave_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_approval_step" ADD CONSTRAINT "leave_approval_step_subject_employment_id_employment_id_fk" FOREIGN KEY ("subject_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_approval_step" ADD CONSTRAINT "leave_approval_step_decided_by_employment_id_employment_id_fk" FOREIGN KEY ("decided_by_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leave_approval_step_request_idx" ON "leave_approval_step" USING btree ("leave_request_id","step_index");--> statement-breakpoint
ALTER TABLE leave_approval_step ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON leave_approval_step TO ai_hr_app;--> statement-breakpoint
CREATE POLICY leave_approval_step_rls ON leave_approval_step FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(subject_employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(subject_employment_id));
