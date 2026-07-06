-- #42cff598 (ADR-0042): supporting documents for a resignation (e.g. a signed resignation letter).
-- Verbatim reuse of leave_request_attachment (0084) retargeted to resignation_request — a denormalized
-- employment_id lets RLS reuse can_see_employment() with no per-row subquery, the same subject + manager +
-- admin rule as resignation_request. Strictly additive (new table only); existing resignations default to
-- zero attachments and nothing existing breaks.
CREATE TABLE "resignation_request_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"resignation_request_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"content" "bytea" NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "resignation_request_attachment" ADD CONSTRAINT "resignation_request_attachment_resignation_request_id_resignation_request_id_fk" FOREIGN KEY ("resignation_request_id") REFERENCES "public"."resignation_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignation_request_attachment" ADD CONSTRAINT "resignation_request_attachment_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resignation_request_attachment_request_idx" ON "resignation_request_attachment" USING btree ("resignation_request_id");--> statement-breakpoint
ALTER TABLE resignation_request_attachment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON resignation_request_attachment TO ai_hr_app;--> statement-breakpoint
CREATE POLICY resignation_request_attachment_rls ON resignation_request_attachment FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
