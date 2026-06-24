-- In-product feedback → AI-plan → review → build loop (ADR-0043).
--
-- A user logs feedback; an AI planning agent writes a `plan`; the reporter reviews it (approve or
-- contest → re-plan); on approval an out-of-app build agent produces a human-reviewed PR. RLS mirrors
-- claims: can_see_employment(reporter_employment_id) for read+write (reporter + their manager-chain +
-- admin); the REVIEW authority (only the reporter may approve/contest) is enforced in the service.
CREATE TYPE "feedback_category" AS ENUM('issue', 'enhancement', 'new_function');--> statement-breakpoint
CREATE TYPE "feedback_status" AS ENUM('open', 'planned', 'approved', 'contested', 'building', 'done', 'rejected', 'cancelled');--> statement-breakpoint

CREATE TABLE "feedback_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reporter_employment_id" uuid NOT NULL,
	"reporter_user_id" uuid,
	"category" "feedback_category" NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"expected_behavior" text,
	"expected_function" text,
	"status" "feedback_status" DEFAULT 'open' NOT NULL,
	"plan" text,
	"plan_revision" integer DEFAULT 0 NOT NULL,
	"plan_model" text,
	"contest_reason" text,
	"build_ref" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"feedback_request_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"content" "bytea" NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback_request" ADD CONSTRAINT "feedback_request_reporter_employment_id_fk" FOREIGN KEY ("reporter_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_request" ADD CONSTRAINT "feedback_request_reporter_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_attachment" ADD CONSTRAINT "feedback_attachment_feedback_request_id_fk" FOREIGN KEY ("feedback_request_id") REFERENCES "public"."feedback_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_attachment" ADD CONSTRAINT "feedback_attachment_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_attachment" ADD CONSTRAINT "feedback_attachment_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_request_reporter_idx" ON "feedback_request" USING btree ("tenant_id","reporter_employment_id","status");--> statement-breakpoint
CREATE INDEX "feedback_attachment_feedback_idx" ON "feedback_attachment" USING btree ("feedback_request_id");--> statement-breakpoint

ALTER TABLE feedback_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON feedback_request TO ai_hr_app;--> statement-breakpoint
CREATE POLICY feedback_request_rls ON feedback_request FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(reporter_employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(reporter_employment_id));--> statement-breakpoint

ALTER TABLE feedback_attachment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON feedback_attachment TO ai_hr_app;--> statement-breakpoint
CREATE POLICY feedback_attachment_rls ON feedback_attachment FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
