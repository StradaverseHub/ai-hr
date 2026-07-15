-- Employee Status redesign (R43 c26c3ce5) — System-Controlled Lifecycle Management.
--
-- Employee Status stops being a manual dropdown and becomes SYSTEM-DERIVED read-time from the employment
-- lifecycle dates (probation / confirmation / resignation / last-working / termination) — see
-- core/employment-status.ts::deriveEmploymentStatus. No stored status column is needed for the derived buckets
-- (Probation / Active / Active–Serving Notice / Resigned); they are pure functions of dates + today, so there
-- is no clock-dependent staleness to persist.
--
-- Blacklist is the ONE exception status that is genuinely a stored, event-driven override (not date-driven):
-- an audited HR-admin action. This migration adds the two columns backing it. Both are NULLABLE with no
-- default, so every existing employment row is unaffected (blacklisted_at NULL ⇒ never blacklisted ⇒ the
-- deriver falls through to the date-based buckets exactly as before). Backfill-safe for demo rows: no data
-- change. IF NOT EXISTS keeps a re-run on a partially-migrated DB idempotent. No RLS change — `employment`
-- already carries can_see/can_admin policies these scalar columns inherit (same as every other employment
-- master-data column, e.g. migration 0184).
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "blacklisted_at" date;--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "blacklist_reason" text;
