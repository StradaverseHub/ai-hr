-- Half-Day & Hourly Leave (ADR-0048). Additive columns only — no new tables, no new RLS (they inherit
-- the existing leave_type / leave_request policies).
--   leave_type.durations: jsonb allow-list of duration types this type supports, e.g.
--     ["full_day","half_day_am","half_day_pm","hourly"]. NULL ⇒ full-day-only (preserves every existing
--     type with no backfill). Mirrors the eligibility / requires_document additive style.
--   leave_request.duration_type: which duration the applicant chose. NOT NULL DEFAULT 'full_day' backfills
--     existing rows to the current full-day behaviour. `days` stays the deduction source of truth.
--   leave_request.hours: numeric(4,2) — the original hours for an 'hourly' request (nullable; set only for
--     hourly). Kept because 0.25 day reads ambiguously and round(hours/8,2) can be lossy, so the displayed
--     "2h" must be recoverable from the stored value, not back-computed from `days`.
ALTER TABLE leave_type ADD COLUMN durations jsonb;--> statement-breakpoint
ALTER TABLE leave_request ADD COLUMN duration_type text NOT NULL DEFAULT 'full_day';--> statement-breakpoint
ALTER TABLE leave_request ADD COLUMN hours numeric(4, 2);
