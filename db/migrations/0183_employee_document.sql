-- f018ce8d — Personnel (Admin) Documents tab redesign → general employee document store.
-- Strictly additive: a NEW side-table only. Nothing existing changes behavior with the table empty.
--
-- employee_document — the centralized employee document repository. HR uploads categorized supporting
-- documents (PDF / Word / Excel / PowerPoint / images / text) against an employment. bytea content lives
-- inline mirroring claim_attachment / review_document; employment_id is denormalized so RLS resolves via
-- app.can_see_employment(employment_id) directly (no join).
--
-- RLS: READ with app.can_see_employment(employment_id) — subject + administrative-line manager + admins
-- (the subject-read path keeps parity with review_document, and lets a future ESS surface reuse the same
-- store). WRITE (INSERT/UPDATE/DELETE) with app.is_admin() only — HR manages the employee's file cabinet;
-- the subject can see their documents but never mutate them.

CREATE TABLE IF NOT EXISTS "employee_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text,
	"description" text,
	"content" "bytea" NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "employee_document" ADD CONSTRAINT "employee_document_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_document" ADD CONSTRAINT "employee_document_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_document_employment_idx" ON "employee_document" USING btree ("tenant_id","employment_id");--> statement-breakpoint
ALTER TABLE employee_document ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_document TO ai_hr_app;--> statement-breakpoint
CREATE POLICY employee_document_rls ON employee_document FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
