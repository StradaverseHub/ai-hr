-- 2166ef79 · MY ATTENDANCE, stage one — what an employee's own attendance request has to carry.
--
-- The request RECORD is not new and deliberately is not: an attendance request already IS an
-- attendance_correction (ADR-0069), which is why it already has the request → approve route, the
-- approvals inbox, assertCanDecide routing, RLS, the four statuses and the audit trail. Creating a
-- second request type would fork all six. Three things it does NOT have, and stage one needs:
--
--   1. `remark`  — the optional note the reporter asks for beside the (already mandatory) reason.
--                  Nullable text: every existing row keeps behaving byte-identically.
--
--   2. `request_kind` — WHICH of the four sections the request was filed from. Stored rather than
--                  derived, and that is the whole reason this column exists: the moment a missing
--                  clock-out is approved the day stops being an Incomplete Entry, so a request list
--                  that re-derived its own type would silently relabel history the day it was fixed.
--                  text + CHECK, NOT a pgEnum — the 0275 widening lesson recorded in db/schema.ts, and
--                  the same shape 0424 used for ot_reason_category beside it. NULL on every row filed
--                  before this release; the screen falls back to "Attendance request" for those.
--
--   3. attendance_correction_attachment — one optional supporting file per request. A bytea SIDE
--                  table, verbatim reuse of leave_request_attachment (0084) and
--                  resignation_request_attachment (0156) retargeted: a DENORMALISED employment_id so
--                  RLS reuses app.can_see_employment() with no per-row subquery, which gives the file
--                  exactly the subject + manager + admin visibility the request itself has.
--
-- No RLS/GRANT is added for 1 and 2 — attendance_correction's own policy (migration 0028) already
-- covers every column on the table. The new TABLE needs both, and the GRANT is not optional: on
-- production ALTER DEFAULT PRIVILEGES would mask its absence, so "permission denied for table
-- attendance_correction_attachment" would first appear on a dev cluster restored from a dump, on the
-- first render of My Attendance after the deploy. Same reasoning as 0345 / 0354 / 0357 / 0425 / 0427.

-- ── 1 + 2 · the two new columns on the request row ──────────────────────────────────────────────────
ALTER TABLE "attendance_correction"
  ADD COLUMN IF NOT EXISTS "remark" text,
  ADD COLUMN IF NOT EXISTS "request_kind" text;
--> statement-breakpoint

ALTER TABLE "attendance_correction"
  DROP CONSTRAINT IF EXISTS "attendance_correction_request_kind_ck";
--> statement-breakpoint
ALTER TABLE "attendance_correction"
  ADD CONSTRAINT "attendance_correction_request_kind_ck"
  CHECK ("request_kind" IS NULL OR "request_kind" IN
    ('self_overtime', 'short_hours', 'incomplete_entry', 'absent', 'other'));
--> statement-breakpoint

-- ── 3 · the attachment side table ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "attendance_correction_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"attendance_correction_id" uuid NOT NULL,
	-- Denormalised from the parent request purely so the RLS policy below can be a single
	-- can_see_employment() call rather than a correlated sub-select on every row read.
	"employment_id" uuid NOT NULL,
	"content" "bytea" NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_correction_attachment"
  ADD CONSTRAINT "attendance_correction_attachment_attendance_correction_id_fk"
  FOREIGN KEY ("attendance_correction_id") REFERENCES "public"."attendance_correction"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attendance_correction_attachment"
  ADD CONSTRAINT "attendance_correction_attachment_employment_id_employment_id_fk"
  FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attendance_correction_attachment_request_idx"
  ON "attendance_correction_attachment" USING btree ("attendance_correction_id");
--> statement-breakpoint

-- ── GRANT (required — see the header) ───────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "attendance_correction_attachment" TO ai_hr_app;
--> statement-breakpoint

-- ── RLS · leave_request_attachment's policy verbatim, retargeted ────────────────────────────────────
ALTER TABLE "attendance_correction_attachment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "attendance_correction_attachment_rls" ON "attendance_correction_attachment";
--> statement-breakpoint
CREATE POLICY "attendance_correction_attachment_rls" ON "attendance_correction_attachment" FOR ALL
  USING ("tenant_id" = app.current_tenant_id() AND app.can_see_employment("employment_id"))
  WITH CHECK ("tenant_id" = app.current_tenant_id() AND app.can_see_employment("employment_id"));
