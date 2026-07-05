-- Company logo (feedback: Redesign Organization Management Screen) — a 1:1 branding logo per company,
-- stored as a bytea SIDE TABLE (mirrors claim_attachment / leave_request_attachment) so a company SELECT
-- can never accidentally pull the blob. PNG/JPEG only (mime re-derived from magic bytes at upload; SVG is
-- excluded because its scriptable payload survives sniffing). Purely additive: existing company rows are
-- untouched and every company simply starts with no logo.
--
-- RLS posture (stated explicitly — this table's read is DELIBERATELY tenant-wide, NOT admin-only):
--   USING (tenant_id = app.current_tenant_id())               → any same-tenant member can READ a logo.
--       A logo is low-sensitivity branding shown on the org screen to any signed-in user in the org — the
--       same visibility company rows already have (the company policy's USING is tenant-only too).
--   WITH CHECK (tenant_id = ... AND app.is_admin_for(company_id)) → only an admin OF THAT COMPANY may
--       INSERT / UPDATE / DELETE a logo (mirrors the location / department / cost_center write gate).
--
-- Journal entry: idx 151 (see meta/_journal.json).

CREATE TABLE "company_logo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"content" bytea NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_logo_company_id_unique" UNIQUE("company_id")
);--> statement-breakpoint
ALTER TABLE "company_logo" ADD CONSTRAINT "company_logo_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_logo" ADD CONSTRAINT "company_logo_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_logo" ADD CONSTRAINT "company_logo_uploaded_by_user_id_app_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_logo_company_idx" ON "company_logo" USING btree ("company_id");--> statement-breakpoint

-- RLS: read = tenant-wide (branding, matches company-row visibility); write = admin-of-the-company only.
ALTER TABLE "company_logo" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "company_logo_rls" ON "company_logo" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "company_logo" TO ai_hr_app;
