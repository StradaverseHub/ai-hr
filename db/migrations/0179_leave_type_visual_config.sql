-- Leave Type Visual Configuration Enhancement (feedback 639fdf77).
--
-- Adds two nullable, additive, DISPLAY-ONLY columns to leave_type so an HR admin can attach an icon + a
-- colour theme to each leave type. They surface only on the employee self-service My Profile → Leave tab
-- (icon beside the name + colour chip on the row). They are NEVER read for entitlement / eligibility /
-- workflow / calculation — purely cosmetic.
--
--   color — one of the fixed 7-token palette {blue,green,orange,purple,red,teal,grey}. The service validates
--     against lib/leave-visual.ts LEAVE_COLOR_TOKENS; the optional CHECK below is a defence-in-depth guard
--     (mirrors the expiry_unit check on this table). NULL = no theme ⇒ system default styling (unchanged).
--   icon — a curated icon-registry key (lib/leave-visual.ts LEAVE_ICON_KEYS). No DB CHECK (the registry can
--     grow without a migration; the service validates on write). NULL = no icon ⇒ the default leave icon.
--
-- Backward compatible: every existing row has both columns NULL ⇒ today's exact ESS appearance. No backfill.
-- No RLS change: leave_type already has tenant-read + admin-write policies; the new columns inherit them
-- (same as the 0178 ess_view_config and 0147 custom_messages migrations).
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS color text;
--> statement-breakpoint
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS icon text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_color_token_ck'
  ) THEN
    ALTER TABLE leave_type ADD CONSTRAINT leave_type_color_token_ck
      CHECK (color IS NULL OR color IN ('blue', 'green', 'orange', 'purple', 'red', 'teal', 'grey'));
  END IF;
END $$;
