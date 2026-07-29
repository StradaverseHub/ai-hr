-- r82a · 1ef1cf95 — "Shared Leave Group": the PER-APPLICATION day cap.
--
-- ── WHAT THIS ADDS, AND WHAT ALREADY EXISTED ───────────────────────────────────────────────────────
-- The reporter's rule has TWO halves. The first — seven leave types (CGL, CPL, NDL, EXM, GD, MRL, STD)
-- sharing ONE combined 10-day annual entitlement — has shipped since migration 0220
-- (scheme_leave_combined_limit + _member): a named group per benefit scheme, a shared total_limit_days,
-- and enforcement that sums usage across every member type at apply time and again at approval. Nothing
-- about that half is touched here.
--
-- The second half did not exist anywhere in the system: "each application is capped at 3 consecutive days
-- regardless of which type is chosen". There was no per-application day limit on any leave type, group or
-- scheme. This migration adds the one column that carries it.
--
-- ── WHY IT LIVES ON THE GROUP, AND WHY IT IS NULLABLE ──────────────────────────────────────────────
-- The cap belongs to the SAME group that already owns the shared pool, not to a new mechanism: both are
-- statements about one set of leave types, and two mechanisms that each decide how much leave a person may
-- take will eventually disagree (test/shared-leave-group-single-mechanism.test.ts is the ratchet on that).
-- A leave type joins at most one group per scheme, so "which cap applies to this application" stays a
-- question with exactly one answer.
--
-- NULL means "no per-application cap", which is what EVERY group in every existing database means today —
-- so this release changes nobody's leave. A group only starts refusing long applications once an admin
-- deliberately types a number into the new field. There is deliberately no default: a silently-defaulted
-- cap would begin rejecting real leave applications the moment it deployed.
--
-- The column caps what is TAKEN in one application. It has nothing to say about what is GRANTED — service
-- bands and the entitlement arithmetic (core/leave-compute.ts) never read it, exactly as they never read
-- total_limit_days.
--
-- ── UNITS: CALENDAR DAYS ───────────────────────────────────────────────────────────────────────────
-- The reporter wrote "3 consecutive days" and the approved plan states we read that as CALENDAR days
-- spanned by the application (start..end inclusive), with an explicit invitation to reject the plan if
-- working days were meant. The interpretation is NOT encoded in this column — the column stores a plain
-- day figure; the single place the span is measured is applicationSpanDays() in core/leave.ts. Changing
-- calendar → working days is a change to that one function and needs no migration.
--
-- ── NO ENUM IS TOUCHED ─────────────────────────────────────────────────────────────────────────────
-- One numeric column and one named CHECK. Nothing here adds or compares a Postgres enum value, so the
-- "a newly-added enum value cannot be used in the transaction that added it" trap — which passes on a live
-- server and breaks a fresh install, because a fresh chain replays every migration in ONE transaction —
-- does not apply. There is no `col = 'newvalue'` comparison below.
--
-- ── IDEMPOTENCE ────────────────────────────────────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS; the CHECK is guarded on pg_constraint (ADD CONSTRAINT has no IF NOT EXISTS);
-- the GRANT is a no-op re-grant. No data is written, so a replay cannot move an admin's configured value.

ALTER TABLE "scheme_leave_combined_limit"
	ADD COLUMN IF NOT EXISTS "max_days_per_application" numeric(6, 2);--> statement-breakpoint

-- Bounds mirror cleanMaxDaysPerApplication() in core/benefit-scheme.ts: NULL (no cap) or a positive figure
-- no larger than the pool total's own ceiling. A zero or negative cap would refuse every application of
-- every member type, which is a configuration mistake, not a policy — so the database refuses to store it.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'scheme_leave_combined_limit_max_days_check'
	) THEN
		ALTER TABLE "scheme_leave_combined_limit" ADD CONSTRAINT "scheme_leave_combined_limit_max_days_check"
			CHECK (
				"max_days_per_application" IS NULL
				OR ("max_days_per_application" > 0 AND "max_days_per_application" <= 999)
			);
	END IF;
END $$;--> statement-breakpoint

-- No RLS change: scheme_leave_combined_limit keeps the tenant-read / admin-write policies migration 0220
-- gave it, and an additive column needs no policy change. The grant is re-stated explicitly per the
-- migration standard — a no-op on an existing table, and the guarantee that the new column is reachable by
-- the app role that reads it at apply/approval time.
GRANT SELECT, INSERT, UPDATE, DELETE ON "scheme_leave_combined_limit" TO ai_hr_app;
