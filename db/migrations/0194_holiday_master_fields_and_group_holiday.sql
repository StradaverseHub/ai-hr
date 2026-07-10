-- 66b8f5a8 — Holiday Module Enhancement & Centralized Holiday Group Management.
--
-- Splits Attendance > Holiday into a Holiday master tab + a Holiday Group tab. This migration is the
-- data foundation and is fully ADDITIVE + backward compatible:
--
--  (1) Holiday master fields on `holiday` — the reporter's simplified, self-describing holiday record:
--        holiday_code  (optional text)   — an HR-facing short code.
--        holiday_type  (public|company|optional) — DEFAULT 'public' so every existing gazette row is a
--                                          public holiday (byte-identical semantics; the resolver never
--                                          reads this column — it is display/classification metadata only).
--        description   (optional text)
--        active        (boolean, DEFAULT true) — inactive rows still exist but are flagged in the UI.
--      The pre-existing scope columns (state, company_id, holiday_group_id) are DELIBERATELY KEPT so the
--      automatic Malaysian state-holiday resolution + parent-group inheritance (core/holidays.ts) keeps
--      working. Only the Add-Holiday FORM stops collecting scope; stored data is untouched.
--
--  (2) Holiday Group master fields on `holiday_group` — for the dedicated group page's info section:
--        code          (optional text)
--        description   (optional text)
--        active        (boolean, DEFAULT true)
--
--  (3) holiday_group_holiday — the NEW junction that lets HR tick holidays from the centralized master
--      list into a group (the reporter's tick-list model). The resolver UNIONs these explicitly-ticked
--      holidays WITH the existing state/archetype/inheritance result (never replaces it — a replacement
--      would drop MY state auto-resolution). RLS + ai_hr_app grants mirror holiday_group (0100) / holiday
--      (0006): tenant-scoped read for any member (the resolver SELECTs it), admin-only writes.
--
-- Idempotent (IF NOT EXISTS / duplicate_object guards); integration may renumber this file.

ALTER TABLE "holiday" ADD COLUMN IF NOT EXISTS "holiday_code" text;--> statement-breakpoint
ALTER TABLE "holiday" ADD COLUMN IF NOT EXISTS "holiday_type" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "holiday" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "holiday" ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "holiday" ADD CONSTRAINT "holiday_type_check" CHECK ("holiday_type" IN ('public','company','optional'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

ALTER TABLE "holiday_group" ADD COLUMN IF NOT EXISTS "code" text;--> statement-breakpoint
ALTER TABLE "holiday_group" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "holiday_group" ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "holiday_group_holiday" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "holiday_group_id" uuid NOT NULL REFERENCES "holiday_group"("id") ON DELETE CASCADE,
  "holiday_id" uuid NOT NULL REFERENCES "holiday"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- One membership per (group, holiday). Ticking an already-ticked holiday is a no-op (ON CONFLICT in core).
CREATE UNIQUE INDEX IF NOT EXISTS "holiday_group_holiday_uq" ON "holiday_group_holiday" USING btree ("holiday_group_id", "holiday_id");--> statement-breakpoint
-- RLS mirroring holiday_group (0100) / holiday (0006): tenant-scoped read for any member (the resolver
-- SELECTs the junction); admin-only writes. GRANT targets ai_hr_app, not the owner (migrations/seed run as
-- owner and bypass RLS by design).
GRANT SELECT, INSERT, UPDATE, DELETE ON "holiday_group_holiday" TO ai_hr_app;--> statement-breakpoint
ALTER TABLE "holiday_group_holiday" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY tenant_isolation ON "holiday_group_holiday" FOR ALL
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
