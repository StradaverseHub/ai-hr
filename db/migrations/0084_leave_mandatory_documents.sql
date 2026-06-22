-- ADR-0038 2A-2: mandatory documents for leave. leave_type.requires_document gates requestLeave (e.g. an
-- MC for sick leave). leave_request_attachment stores the file (bytea), mirroring claim_attachment — a
-- denormalized employment_id lets RLS reuse can_see_employment() with no per-row subquery, the same
-- subject + manager + admin rule as leave_request. All additive; existing rows default to no document.
ALTER TABLE leave_type ADD COLUMN requires_document boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE TABLE "leave_request_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"leave_request_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"content" "bytea" NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "leave_request_attachment" ADD CONSTRAINT "leave_request_attachment_leave_request_id_leave_request_id_fk" FOREIGN KEY ("leave_request_id") REFERENCES "public"."leave_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_attachment" ADD CONSTRAINT "leave_request_attachment_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leave_request_attachment_request_idx" ON "leave_request_attachment" USING btree ("leave_request_id");--> statement-breakpoint
ALTER TABLE leave_request_attachment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON leave_request_attachment TO ai_hr_app;--> statement-breakpoint
CREATE POLICY leave_request_attachment_rls ON leave_request_attachment FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
