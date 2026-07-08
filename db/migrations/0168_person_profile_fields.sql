-- b4682879 — Personnel: Employee Profile Information Redesign.
-- Purely ADDITIVE. Extends `person` with the personal / contact / structured-address / extended-emergency
-- fields the redesigned Profile tab maintains, plus a bytea SIDE TABLE `person_photo` for the profile
-- photograph (mirrors company_logo). Every new column is NULLABLE and every existing row is untouched
-- (the reporter's "existing employee data shall remain available" + "business rules unchanged" bar).
--
-- person RLS is DELIBERATELY UNCHANGED: person_rls (0001_rls_grants_constraints.sql:127-131) already gives
--   read  = tenant AND app.can_see_person(id)         → self / admin / administrative-manager subtree
--           (+ payroll & perfcomp partner read branches, 0099_job_function_partner_roles.sql)
--   write = tenant AND app.is_admin()
-- so the new scalar columns inherit exactly that posture with no policy edit. PDPA note (stated once):
-- payroll / perfcomp partners can already read the whole person row (DOB / gender / marital here, IC / bank
-- on statutory), so religion / race / nationality being row-visible to them is consistent with the existing
-- posture. The escape hatch if the DPO ever objects is a `person_sensitive` side table — NOT built now.
--
-- fullName stays the canonical "Full name (as per IC/Passport)" (notNull, drives payslips / bank files /
-- statutory docs) — this migration only relabels it in the UI and adds INDEPENDENT first/last/preferred
-- name columns beside it; it never derives or backfills them from fullName. primaryEmail stays the login /
-- work email; personal_email is a separate new column.

ALTER TABLE "person"
  ADD COLUMN "first_name" text,
  ADD COLUMN "last_name" text,
  ADD COLUMN "preferred_name" text,
  ADD COLUMN "religion" text,
  ADD COLUMN "race" text,
  ADD COLUMN "nationality" text,
  ADD COLUMN "personal_email" text,
  ADD COLUMN "address_line1" text,
  ADD COLUMN "address_line2" text,
  ADD COLUMN "address_line3" text,
  ADD COLUMN "postcode" text,
  ADD COLUMN "city" text,
  ADD COLUMN "state" text,
  ADD COLUMN "country" text,
  ADD COLUMN "emergency_contact_relationship" text,
  ADD COLUMN "emergency_contact_phone2" text,
  ADD COLUMN "emergency_contact_address" text;
--> statement-breakpoint

-- One-time backfill: the legacy free-text `address` becomes structured line 1 (idempotent — only fills a
-- still-NULL address_line1). The legacy column is RETAINED for rollback / PDPA history but is no longer
-- rendered or written by the UI, so there are never two writable address truths.
UPDATE "person" SET "address_line1" = "address"
  WHERE "address" IS NOT NULL AND "address_line1" IS NULL;
--> statement-breakpoint

-- person_photo = 1:1 profile photograph per person, bytea SIDE TABLE (mirrors company_logo). PNG/JPEG only
-- (mime re-derived from magic bytes at upload; SVG excluded — scriptable). RLS posture:
--   read  = tenant AND app.can_see_person(person_id)  → the photo is visible EXACTLY where the employee's
--           name already is (self / admin / administrative-manager). Narrower than company_logo's tenant-
--           wide read on purpose: a face photo is personal data, not branding.
--   write = tenant AND app.is_admin()                 → admins upload / replace / remove (reporter §1.5).
-- unique(person_id) enforces the 1:1 so setPersonPhoto upserts. Rollback = DROP TABLE person_photo; +
-- ALTER TABLE person DROP COLUMN … the 17 columns above.
CREATE TABLE "person_photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"content" bytea NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_photo_person_id_unique" UNIQUE("person_id")
);
--> statement-breakpoint
ALTER TABLE "person_photo" ADD CONSTRAINT "person_photo_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_photo" ADD CONSTRAINT "person_photo_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_photo" ADD CONSTRAINT "person_photo_uploaded_by_user_id_app_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_photo_person_idx" ON "person_photo" USING btree ("tenant_id","person_id");--> statement-breakpoint

-- New tables never inherit grants (ADR-0002) — grant the app role explicitly.
GRANT SELECT, INSERT, UPDATE, DELETE ON "person_photo" TO ai_hr_app;--> statement-breakpoint
ALTER TABLE "person_photo" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "person_photo_rls" ON "person_photo" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_person(person_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
