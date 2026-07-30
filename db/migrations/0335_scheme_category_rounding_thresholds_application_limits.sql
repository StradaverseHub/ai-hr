-- r86a — THREE additive settings that land on the leave configuration screens, in ONE migration because
-- one migration number was allocated for this round. They are independent of each other; nothing below
-- reads or writes another item's column.
--
--   1. benefit_scheme.scheme_category      — 0890a555, grouping label for Benefit Schemes
--   2. leave_type.rounding_threshold       — 9f5164d8, the custom decimal threshold for "nearest 0.5 day"
--      (+ the rounding_method CHECK widened to admit 'nearest_half')
--   3. leave_type.max_days_per_leave_year  — c6ffa725, the Application Limit for types with no balance
--
-- ── EVERY COLUMN IS NULLABLE WITH NO DEFAULT, AND THAT IS THE WHOLE SAFETY ARGUMENT ────────────────
-- Each of the three means "not configured" when NULL, and NULL is what every existing row gets. A
-- defaulted scheme category would file schemes under a heading the tenant never chose; a defaulted
-- rounding threshold would move credited leave days on deploy day; a defaulted application limit would
-- start REFUSING real leave applications on deploy day. The r82 precedent (0327's
-- max_days_per_application) made exactly this call for exactly this reason.
--
-- No backfill. No UPDATE runs below, so a replay cannot move a value an administrator has configured.
--
-- ── NO ENUM IS TOUCHED ─────────────────────────────────────────────────────────────────────────────
-- Three columns and two named CHECKs. Nothing adds or compares a Postgres enum value, so the "a newly
-- added enum value cannot be used in the transaction that added it" trap — which passes on a live server
-- and breaks a fresh install, because a fresh chain replays every migration in ONE transaction — does not
-- apply here. There is no `col = 'newvalue'` comparison below.
--
-- ── IDEMPOTENCE ────────────────────────────────────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS; every CHECK is guarded on pg_constraint (ADD CONSTRAINT has no IF NOT
-- EXISTS); the rounding_method CHECK is DROPped by name before being re-added, which is itself safe to
-- replay. The GRANTs are no-op re-grants.

-- ── 1 · Scheme Category (0890a555) ─────────────────────────────────────────────────────────────────
-- A pure grouping label on the benefit scheme: it decides how schemes are BUNCHED in pickers, and nothing
-- else. Deliberately NOT read by scheme_leave_entitlement, resolveGradePolicy, resolveSchemeForEmployment
-- or any entitlement arithmetic — a scheme resolves for an employee exactly as it does today whether its
-- category is set, changed or cleared. Free text rather than a catalogue table: the reporter's own examples
-- ("Permanent", "Contract (Special)", "Contract (Retiree)", "Part Time") are their wording for their own
-- population, and a closed list would need maintaining before it could be used.
ALTER TABLE "benefit_scheme"
	ADD COLUMN IF NOT EXISTS "scheme_category" text;--> statement-breakpoint

-- Bounds mirror cleanSchemeCategory() in core/benefit-scheme.ts: NULL (ungrouped) or non-blank text. A
-- whitespace-only category would render as an unnamed group heading nobody can select or clear.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'benefit_scheme_category_check'
	) THEN
		ALTER TABLE "benefit_scheme" ADD CONSTRAINT "benefit_scheme_category_check"
			CHECK ("scheme_category" IS NULL OR btrim("scheme_category") <> '');
	END IF;
END $$;--> statement-breakpoint

-- ── 2 · Rounding threshold (9f5164d8) ──────────────────────────────────────────────────────────────
-- 0325 wrote the CHECK as rounding_method IN ('none','up','down'). 'nearest_half' is a FOURTH method, so
-- the constraint has to admit it or every save of the new option fails with an opaque 23514. Dropped by
-- name and re-added rather than edited in place — Postgres has no ALTER CONSTRAINT for a CHECK.
--
-- THE EXISTING THREE VALUES ARE UNTOUCHED AND KEEP THEIR EXACT MEANING. applyRounding still reads 'up' as
-- ceil, 'down' as floor and everything else (NULL included) as no rounding; test/leave-entitlement-
-- rounding-thresholds.test.ts runs the old three through the new evaluator and asserts identical figures.
ALTER TABLE "leave_type" DROP CONSTRAINT IF EXISTS "leave_type_rounding_method_check";--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_rounding_method_check'
	) THEN
		ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_rounding_method_check"
			CHECK ("rounding_method" IS NULL OR "rounding_method" IN ('none', 'up', 'down', 'nearest_half'));
	END IF;
END $$;--> statement-breakpoint

-- The decimal threshold at which the fractional part of a calculated entitlement rounds UP to the next
-- 0.5 rather than DOWN to the previous one. NULL ⇒ the standard rule the reporter documented as the
-- default (0.000–0.499 down, 0.500–1.000 up), i.e. 0.500. Stored as numeric(4,3) because the reporter
-- specified thresholds to three decimal places.
--
-- The reporter described TWO ranges (a down range and an up range) whose validation requires them to
-- cover 0.000–1.000 with no gap and no overlap. Two complementary ranges over a fixed interval carry
-- exactly ONE degree of freedom — the boundary between them — so ONE column stores the whole
-- configuration and the two-range shape can never drift into an unrepresentable state.
ALTER TABLE "leave_type"
	ADD COLUMN IF NOT EXISTS "rounding_threshold" numeric(4, 3);--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_rounding_threshold_check'
	) THEN
		ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_rounding_threshold_check"
			CHECK (
				"rounding_threshold" IS NULL
				OR ("rounding_threshold" > 0 AND "rounding_threshold" <= 1)
			);
	END IF;
END $$;--> statement-breakpoint

-- ── 3 · Maximum Application Per Leave Year (c6ffa725) ──────────────────────────────────────────────
-- The total days an employee may APPLY for, of this leave type, within one leave year — regardless of
-- whether any entitlement balance exists. It is the home for the reporter's Unpaid Leave case: entitlement
-- 0, Leave Summary correctly showing 0 available, and applications still permitted up to a company figure.
--
-- IT IS AN APPLICATION RULE, NOT AN ENTITLEMENT. Nothing in the granting, accrual, carry-forward, rounding
-- or balance-display path reads this column; test/leave-application-limit.test.ts pins that the ledger and
-- the summary figures are unchanged when it is set. It is checked in exactly two places — at submission
-- and again at approval — because either alone is bypassable (a stale pending request survives a
-- submit-only check; an already-pending application survives an approval-only one).
ALTER TABLE "leave_type"
	ADD COLUMN IF NOT EXISTS "max_days_per_leave_year" numeric(6, 2);--> statement-breakpoint

-- Bounds mirror the write-time validator: NULL (unlimited) or a positive figure. A zero or negative limit
-- would refuse every application of the type, which is a configuration mistake and not a policy — archive
-- or hide the leave type instead. The database refuses to store it either way.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_max_days_per_leave_year_check'
	) THEN
		ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_max_days_per_leave_year_check"
			CHECK (
				"max_days_per_leave_year" IS NULL
				OR ("max_days_per_leave_year" > 0 AND "max_days_per_leave_year" <= 9999)
			);
	END IF;
END $$;--> statement-breakpoint

-- No RLS change: both tables keep the tenant-read / admin-write policies they already carry, and an
-- additive column needs no policy change. The grants are re-stated per the migration standard — a no-op on
-- an existing table, and the guarantee that the new columns are reachable by the app role that reads them.
GRANT SELECT, INSERT, UPDATE, DELETE ON "benefit_scheme" TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_type" TO ai_hr_app;
