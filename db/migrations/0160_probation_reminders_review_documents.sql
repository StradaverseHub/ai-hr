-- 6522d26a — Probation Management enhancements (Fn 2 reminders + Fn 5/6 letter documents).
-- Strictly additive; nothing existing changes behavior with the column/tables absent-of-data.
--
-- 1. company_payroll_config.review_reminder_days — configurable reminder cadence (days BEFORE the review
--    end date at which the sweep nudges the manager + HR). Null/empty ⇒ default [30,14,7], resolved at
--    sweep time. Config table is already admin-gated; no RLS change.
-- 2. employment_review_reminder — per-(review, offset) dedup ledger making the daily reminder sweep
--    idempotent. The unique index is the hard gate against a re-notify; the service pre-checks.
-- 3. review_document — probation letter store: the persisted system letter + HR-uploaded signed copy,
--    linked to the completed employment_review. bytea side-table mirroring claim_attachment /
--    resignation_request_attachment (employment_id denormalized for direct RLS).
--
-- RLS: both new tables READ with can_see_employment(employment_id) (subject + admin-line manager +
-- admins — the subject download path is what powers ESS visibility, Fn 6) and WRITE with app.is_admin()
-- only (HR uploads the letters; the SYSTEM reminder sweep runs with a group-wide hr_admin grant).

ALTER TABLE "company_payroll_config" ADD COLUMN IF NOT EXISTS "review_reminder_days" integer[];--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "employment_review_reminder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"offset_days" integer NOT NULL,
	"sent_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "employment_review_reminder" ADD CONSTRAINT "employment_review_reminder_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."employment_review"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_review_reminder" ADD CONSTRAINT "employment_review_reminder_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employment_review_reminder_uq" ON "employment_review_reminder" USING btree ("review_id","offset_days");--> statement-breakpoint
ALTER TABLE employment_review_reminder ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON employment_review_reminder TO ai_hr_app;--> statement-breakpoint
CREATE POLICY employment_review_reminder_rls ON employment_review_reminder FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

CREATE TYPE "review_document_kind" AS ENUM('system_letter', 'signed_letter');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"kind" "review_document_kind" NOT NULL,
	"content" "bytea" NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "review_document" ADD CONSTRAINT "review_document_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."employment_review"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_document" ADD CONSTRAINT "review_document_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_document_review_idx" ON "review_document" USING btree ("review_id");--> statement-breakpoint
ALTER TABLE review_document ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON review_document TO ai_hr_app;--> statement-breakpoint
CREATE POLICY review_document_rls ON review_document FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
