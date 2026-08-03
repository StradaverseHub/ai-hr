-- r123 — two leave-type application rules, both ADDITIVE and both NULL-means-today.
--
--   ad9cb5c5  max_days_period      — the PERIOD the max_days_per_leave_year ceiling is measured over.
--   bc512dc3  max_negative_balance — a FLOOR under allow_negative_balance, which today has none.
--
-- Neither column has a default beyond NULL, and NULL is exactly the behaviour every existing row has now.
-- That is deliberate and it is the r82 lesson restated: a silently-defaulted limit begins refusing real
-- leave applications the moment it deploys (scheme_leave_combined_limit.max_days_per_application did
-- exactly that). A rule nobody configured must never bind.

-- ── ad9cb5c5: the period the application ceiling is counted over ──────────────────────────────────────
--
-- max_days_per_leave_year (0335) counts days applied for inside the employee's LEAVE YEAR — a window
-- resolved from the company's leave cycle and the employee's hire date. That fits "two per year" and
-- nothing else the reporter listed. Marriage Leave "once per employment" cannot be expressed at all, and
-- a calendar-year limit is only the same as a leave-year limit when the leave year starts in January.
--
-- The column NAME keeps saying leave_year while the period becomes configurable, which is ugly but is the
-- honest trade: renaming an applied column means a second migration, a rewrite of every reader, and a
-- window where the two names disagree. The period lives beside it instead.
--
-- 'employment' is scoped to the EMPLOYMENT, not the person: a rehire is a new employment and legitimately
-- starts fresh. Making it person-scoped is a different policy about the human being rather than the job,
-- and it was not asked for — it must be requested explicitly rather than assumed here.
ALTER TABLE leave_type
  ADD COLUMN IF NOT EXISTS max_days_period text;
--> statement-breakpoint

-- NULL ⇒ 'leave_year', so every row written before this migration keeps counting exactly as it does today.
-- The CHECK admits NULL for that reason; it is a vocabulary guard, not a NOT NULL in disguise.
ALTER TABLE leave_type
  DROP CONSTRAINT IF EXISTS leave_type_max_days_period_check;
--> statement-breakpoint
ALTER TABLE leave_type
  ADD CONSTRAINT leave_type_max_days_period_check
  CHECK (max_days_period IS NULL OR max_days_period IN ('leave_year', 'calendar_year', 'employment'));
--> statement-breakpoint

-- A period with no ceiling beside it is meaningless — it would configure the window of a limit that does
-- not exist. Refused in the database rather than only in the form, because the form is not the only writer.
ALTER TABLE leave_type
  DROP CONSTRAINT IF EXISTS leave_type_max_days_period_needs_limit_check;
--> statement-breakpoint
ALTER TABLE leave_type
  ADD CONSTRAINT leave_type_max_days_period_needs_limit_check
  CHECK (max_days_period IS NULL OR max_days_per_leave_year IS NOT NULL);
--> statement-breakpoint

-- ── bc512dc3: a floor under the negative balance ──────────────────────────────────────────────────────
--
-- allow_negative_balance is a yes/no. YES skips the submit-time balance gate entirely, so one application
-- can take an employee arbitrarily far into deficit. This column is how far is too far, stored POSITIVE
-- (2.5 means "no further than -2.5 days") because a business user types a magnitude, not a signed number,
-- and a column that sometimes holds -2.5 and sometimes 2.5 is how a sign error becomes a silent doubling.
--
-- NULL ⇒ today's unbounded behaviour, so no existing type changes.
ALTER TABLE leave_type
  ADD COLUMN IF NOT EXISTS max_negative_balance numeric(6, 2);
--> statement-breakpoint

-- Zero is NOT a valid floor: "may go negative, but not by any amount" is what allow_negative_balance=false
-- already says, and admitting both spellings gives the same policy two representations that engines can
-- disagree about. A negative figure is refused for the same reason the column stores a magnitude.
ALTER TABLE leave_type
  DROP CONSTRAINT IF EXISTS leave_type_max_negative_balance_check;
--> statement-breakpoint
ALTER TABLE leave_type
  ADD CONSTRAINT leave_type_max_negative_balance_check
  CHECK (max_negative_balance IS NULL OR max_negative_balance > 0);
--> statement-breakpoint

-- A floor is only meaningful when going negative is permitted at all. With allow_negative_balance = false
-- the submit gate already refuses any negative, so a floor beside it would be dead configuration that
-- reads as an active rule on the screen.
ALTER TABLE leave_type
  DROP CONSTRAINT IF EXISTS leave_type_max_negative_needs_allow_check;
--> statement-breakpoint
ALTER TABLE leave_type
  ADD CONSTRAINT leave_type_max_negative_needs_allow_check
  CHECK (max_negative_balance IS NULL OR allow_negative_balance = true);
