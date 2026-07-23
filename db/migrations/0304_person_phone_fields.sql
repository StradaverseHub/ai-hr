-- Item bf953339 — Contact & Address: Mobile + Home phone pair for both the main contact block and the
-- Correspondence Address block. The existing person.phone column IS the mobile number (rename is
-- label-only — no data movement, existing numbers keep displaying untouched under the new label).
-- Purely ADDITIVE: three nullable text columns, existing rows untouched (no backfill; person keeps its
-- existing tenant RLS policies — additive columns need no policy change).
ALTER TABLE "person" ADD COLUMN IF NOT EXISTS "home_phone" text;
ALTER TABLE "person" ADD COLUMN IF NOT EXISTS "correspondence_mobile_phone" text;
ALTER TABLE "person" ADD COLUMN IF NOT EXISTS "correspondence_home_phone" text;
