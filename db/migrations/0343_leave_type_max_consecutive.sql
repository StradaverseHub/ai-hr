-- 0343 · Maximum Consecutive Leave, per leave type (feedback c6ffa725, revision 2)
--
-- WHY THIS EXISTS AT ALL. c6ffa725 asked for TWO limits and r86a shipped one. The one that shipped is
-- `leave_type.max_days_per_leave_year` (migration 0335) — "how much of this type in a YEAR". The one that
-- did not is this one — "how much in ONE GO": Unlimited / Limited, and when Limited a Maximum and a Unit of
-- Calendar Days or Working Days. They answer different questions and neither replaces the other.
--
-- THE SECOND PER-APPLICATION CAP, AND WHY IT IS NOT A CONTRADICTION. `leave_shared_group.
-- max_days_per_application` (migration 0342, rule from 1ef1cf95) already caps ONE application, for every
-- leave type in a shared group. Two independent caps on the same application can disagree, and a silent
-- disagreement is unanswerable for the employee who is refused. So they are not independent: they are ONE
-- COMPOSITION, resolved in a single place (resolveApplicationLengthLimit in core/leave.ts), the STRICTER
-- one binds, and the refusal NAMES which limit bound and what it is. That is the same shape entitledDays
-- has carried for three entitlement sources since 4c48fd1f, and test/shared-leave-group-single-mechanism
-- .test.ts was widened DELIBERATELY, in the open, to say so.
--
-- NULL ⇒ UNLIMITED, which is the state of every leave_type row in every existing database. There is no
-- backfill and no default: a silently-defaulted cap would start refusing real leave applications the moment
-- it deployed. Nothing an administrator has not typed in changes behaviour.

-- The cap itself. numeric(6,2) rather than an integer because half-day leave exists and a "maximum 2.5
-- days" application rule is expressible in the units below — the same precision max_days_per_leave_year
-- carries, for the same reason.
ALTER TABLE "leave_type"
	ADD COLUMN IF NOT EXISTS "max_consecutive_days" numeric(6, 2);--> statement-breakpoint

-- The UNIT the cap is read in. TEXT + CHECK, deliberately NOT a pgEnum: a new enum value cannot be used in
-- the same transaction that adds it (the 0338 lesson), and this column is written by the very next
-- statement-set in the same deploy. `expiry_unit` on this same table is the precedent.
--
-- 'calendar_days' — every day the application SPANS, weekends and public holidays counted.
-- 'working_days'  — only the days the application actually CHARGES as leave.
-- A Friday→Monday application is 4 calendar days but 2 working days. Same number, different rule, which is
-- exactly why the reporter asked to choose.
ALTER TABLE "leave_type"
	ADD COLUMN IF NOT EXISTS "max_consecutive_unit" text;--> statement-breakpoint

-- Bounds mirror the write-time validator in core/admin.ts. A zero or negative cap would refuse EVERY
-- application of the type, which is a configuration mistake rather than a policy — archive or hide the
-- leave type instead. The database refuses to store it either way.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_max_consecutive_days_check'
	) THEN
		ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_max_consecutive_days_check"
			CHECK (
				"max_consecutive_days" IS NULL
				OR ("max_consecutive_days" > 0 AND "max_consecutive_days" <= 9999)
			);
	END IF;
END $$;--> statement-breakpoint

-- The unit vocabulary. Constrained here so a hand-edited row cannot invent a third reading that the engine
-- would then have to guess at.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_max_consecutive_unit_check'
	) THEN
		ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_max_consecutive_unit_check"
			CHECK (
				"max_consecutive_unit" IS NULL
				OR "max_consecutive_unit" IN ('calendar_days', 'working_days')
			);
	END IF;
END $$;--> statement-breakpoint

-- THE PAIR IS ALL-OR-NOTHING. A cap with no unit is unreadable ("maximum 3" of what?) and a unit with no
-- cap is inert configuration that looks set. Half-configured state is how two readers of the same row draw
-- different conclusions, so the database refuses to hold it: Unlimited is (NULL, NULL) and Limited is
-- (figure, unit).
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_max_consecutive_pair_check'
	) THEN
		ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_max_consecutive_pair_check"
			CHECK (
				("max_consecutive_days" IS NULL) = ("max_consecutive_unit" IS NULL)
			);
	END IF;
END $$;--> statement-breakpoint

-- No RLS change: leave_type keeps the tenant-read / admin-write policies it already carries, and an
-- additive column needs no policy change. The grant is re-stated per the migration standard — a no-op on an
-- existing table, and the guarantee that the new columns are reachable by the app role that reads them.
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_type" TO ai_hr_app;
