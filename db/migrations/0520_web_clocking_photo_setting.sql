-- r430 (board item b8ca6efe) — Web Clocking controls: the Switch link is removed, Clock In/Out are both
-- always allowed in any order, device registration is removed from the Web Clocking page, and a new
-- per-employee Attendance Photo setting (Required / Optional / Not Required) decides whether a photo is
-- needed. See docs/mockups/r430-b8ca6efe-plan.txt.
--
-- ── EACH STEP ────────────────────────────────────────────────────────────────────────────────────────
-- 1. CREATE TYPE attendance_photo_setting — required | optional | not_required.
-- 2. ALTER employment ADD COLUMN attendance_photo_setting, NOT NULL DEFAULT 'not_required'. Every
--    employee starts Not Required; HR sets it per person on the Attendance tab. No backfill needed beyond
--    the default (today's behaviour — a photo was always mandatory — is unaffected until HR changes it).
-- 3. ALTER attendance_clock_capture: DROP NOT NULL on device_id and the six photo columns
--    (photo_captured_at, photo_mime_type, photo_size, decoded_width, decoded_height, photo_digest). Web
--    Clocking no longer registers a device (device_id stays null going forward; existing rows untouched),
--    and a photo is no longer always captured (Optional skipped, or Not Required). ADD a CHECK that the
--    six photo columns are null together — device_id is independent of it (always null going forward
--    regardless of whether a photo was taken).
--
-- No new table, so no new GRANT is needed. No RLS change: both tables are already tenant-scoped under
-- their existing policies, and this migration adds no new column that widens what either policy reaches.
CREATE TYPE "public"."attendance_photo_setting" AS ENUM('required', 'optional', 'not_required');--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN "attendance_photo_setting" "attendance_photo_setting" DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_clock_capture" ALTER COLUMN "photo_captured_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_clock_capture" ALTER COLUMN "photo_mime_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_clock_capture" ALTER COLUMN "photo_size" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_clock_capture" ALTER COLUMN "decoded_width" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_clock_capture" ALTER COLUMN "decoded_height" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_clock_capture" ALTER COLUMN "device_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_clock_capture" ALTER COLUMN "photo_digest" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_clock_capture" ADD CONSTRAINT "attendance_clock_capture_photo_together" CHECK (
  num_nonnulls("photo_captured_at", "photo_mime_type", "photo_size", "decoded_width", "decoded_height", "photo_digest") IN (0, 6)
);
