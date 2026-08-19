-- 0447 · Advance Notice — calendar days or working days (feedback 7daac043)
--
-- WHY THIS EXISTS. `leave_type.min_advance_days` (migration 0159) already refuses an application that
-- arrives with too little notice. It has always counted PLAIN CALENDAR DAYS: set 7 and it means seven days
-- on the wall calendar, weekends, rest days and public holidays included. There is no way to say "seven
-- WORKING days" — which reads oddly next to Maximum Consecutive Leave (migration 0343), two cards further
-- down the very same admin screen, which has offered exactly that choice since r82b.
--
-- This column is the missing half: the UNIT the notice requirement is read in.
--
--   NULL           ⇒ calendar days. THE DEFAULT, AND WHY THERE IS NO BACKFILL. Every leave_type row in
--                    every existing database is NULL after this migration, and the engine reads NULL as
--                    'calendar_days', so every configured requirement reproduces today's behaviour byte
--                    for byte. Nothing an administrator has not deliberately changed behaves differently.
--   'calendar_days' ⇒ the same reading, stated explicitly (what the admin screen posts when the select
--                    sits on its default).
--   'working_days' ⇒ only the days the employee is actually rostered to work, resolved from the SAME
--                    attendance_policy.working_days roster and the SAME holiday resolution the rest of
--                    leave uses. A 7 then stretches roughly two days further out once a weekend falls
--                    inside it, which is the whole point of asking for working days.
--
-- TEXT + CHECK, deliberately NOT a pgEnum: a new enum value cannot be used in the same transaction that
-- adds it (the 0338 lesson). `max_consecutive_unit` (0343) and `leave_unit` (0182) on this same table are
-- the precedents, and this column copies the first of them exactly.
--
-- NO GRANT STATEMENT IS NEEDED. This is ALTER TABLE ... ADD COLUMN on an existing table: a new column
-- inherits the table's existing privileges, and leave_type already carries its tenant-read / admin-write
-- RLS policies and the ai_hr_app grants. (A CREATE TABLE migration is the case that must re-state them.)
ALTER TABLE "leave_type"
	ADD COLUMN IF NOT EXISTS "min_advance_day_type" text;--> statement-breakpoint

-- The vocabulary, constrained here so a hand-edited row cannot invent a third reading that the engine would
-- then have to guess at. NULL is admitted and MEANS calendar days — see the header. The write-time validator
-- in core/admin.ts (updateLeaveType) restates the same closed set; this is the defence in depth behind it.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_min_advance_day_type_check'
	) THEN
		ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_min_advance_day_type_check"
			CHECK (
				"min_advance_day_type" IS NULL
				OR "min_advance_day_type" IN ('calendar_days', 'working_days')
			);
	END IF;
END $$;
