-- R17 3e8350db — Shift Configuration & Employee Shift Assignment enhancement.
--
-- (a) Per-shift grace windows. late_grace_minutes / early_leave_grace_minutes are the shift-level override
--     of the company-policy grace: when NULL the engine keeps its legacy behaviour (late = policy
--     late-after minus work-start applied to the shift start; early-leave = the shift midpoint), so
--     existing shifts are byte-identical. When set, lateness is measured from shift-start + grace and
--     early-leave from shift-end − grace. CHECK ≥ 0. No RLS change (columns on the already-policed shift row).
--
-- (b) employment.shift_type — the reporter's "Shift Type" field. 'fixed' = the person follows their profile
--     Default shift every working day; 'roster' = no permanent shift on the profile, scheduled entirely from
--     the Roster screen. The default_shift_id FK stays the engine's source of truth (roster row → default
--     shift → company policy); shift_type drives the profile UX + the write-time invariant (fixed ⇒ a default
--     shift is required, roster ⇒ default_shift_id is cleared). Backfilled from default_shift_id so any
--     employee who already has a default shift is classified 'fixed'; everyone else defaults to 'roster'
--     (== today's "no default shift" behaviour). CHECK-constrained to the two values.
--
-- Idempotent (IF NOT EXISTS / duplicate_object guards): integration may renumber this file.
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "late_grace_minutes" integer;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "early_leave_grace_minutes" integer;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shift" ADD CONSTRAINT "shift_late_grace_nonneg" CHECK ("late_grace_minutes" IS NULL OR "late_grace_minutes" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shift" ADD CONSTRAINT "shift_early_leave_grace_nonneg" CHECK ("early_leave_grace_minutes" IS NULL OR "early_leave_grace_minutes" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "shift_type" text DEFAULT 'roster' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "employment" ADD CONSTRAINT "employment_shift_type_check" CHECK ("shift_type" IN ('fixed','roster'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
UPDATE "employment" SET "shift_type" = 'fixed' WHERE "default_shift_id" IS NOT NULL AND "shift_type" <> 'fixed';
