-- r336 · cbfa8b0b — THE LEAVE CREDIT REQUEST SCREEN: one modal, two kinds of claim, one claim LINE table.
--
-- ── THE STORAGE DECISION, AND WHY IT IS AN ALTER RATHER THAN A NEW TABLE ────────────────────────────────
-- The ticket lists per row: source_type, date, day_type, shift_end, actual_clock_out, claim_start,
-- claim_end, eligible_minutes, credit_days, status, approver, approved_at. Eight of those already exist
-- and are already owned:
--   · date          → replacement_leave_request_date.worked_date
--   · claim_start/end → .from_time / .to_time   (0381 added them for the Hour unit)
--   · credit_days   → .days
--   · status        → replacement_leave_request.status
--   · approver      → replacement_leave_request.decided_by_user_id
--   · approved_at   → replacement_leave_request.decided_at
-- The last three belong on the HEADER, not the line, and that is not a compromise: a replacement-leave
-- request is approved AS A UNIT (core/replacement-request.ts decideReplacementLeaveRequest — "a refusal
-- here rolls the WHOLE approval back"), so a per-line status column would be a second, always-redundant
-- copy of the header's, and the first bug would be the two disagreeing about a half-approved request that
-- cannot exist.
--
-- A SEPARATE claim-line table would therefore have duplicated the grain (one request × one worked date),
-- the unique index (rl_request_date_request_date_uq), the RLS policy, the accrual back-pointer and the
-- approval unit — and would have given "what did this employee claim for this date" TWO owners, which the
-- double-bank guard and the new overlap predicate would both then have to consult twice. So the five
-- genuinely new facts are added to the line table that already holds the other eight.
--
-- ⚠️ MONEY · eligible_minutes IS NOT A CASH INPUT AND MUST NOT BECOME ONE. The expiry sweep's
-- `convertAmountFor` (core/toil.ts) prices a credit as exact statutory cash ONLY when toil_accrual.day_type
-- is non-null, and every extended-hours credit is banked with day_type NULL (r334's extendedWorkdayCreditTx
-- and r299's accrueSelfDeclaredToilTx both do this, for the same reason: the tier ROUNDS DOWN from the
-- measured minutes, so pricing the minutes would pay out time the credit never banked). This column records
-- what the tier was decided from so a human can reconcile it; nothing values it.
--
-- ALTER, not CREATE: replacement_leave_request_date already carries its grants (0381) and its RLS policy,
-- so CLAUDE.md §6's "a migration that CREATEs a table must GRANT on it" does not apply and a GRANT here
-- would be noise. Every column is NULLABLE with no default, so every row already in production reads back
-- exactly as it did before this migration — a legacy line has source_type NULL and is treated as a
-- non-working-day claim by the readers, which is what it was.
ALTER TABLE "replacement_leave_request_date" ADD COLUMN IF NOT EXISTS "source_type" text;
ALTER TABLE "replacement_leave_request_date" ADD COLUMN IF NOT EXISTS "worked_day_kind" text;
ALTER TABLE "replacement_leave_request_date" ADD COLUMN IF NOT EXISTS "shift_end" time;
ALTER TABLE "replacement_leave_request_date" ADD COLUMN IF NOT EXISTS "actual_clock_out" time;
ALTER TABLE "replacement_leave_request_date" ADD COLUMN IF NOT EXISTS "eligible_minutes" integer;

-- text + CHECK rather than a pgEnum, following the lesson migration 0275 recorded and
-- attendance_correction.ot_reason_category already follows: a future third source type is an ALTER of one
-- constraint rather than an enum widening that cannot be run inside a transaction with its own users.
--
-- NOT VALID is deliberate and CLAUDE.md §6 is the reason to be explicit about it: a NOT VALID check still
-- fires on every UPDATE, so it is a live constraint for every writer from this moment. What it skips is the
-- full-table scan over rows that are all NULL, and NULL passes the predicate anyway. The writers of this
-- table are exactly two (core/replacement-request.ts's insert and its accrual_id back-fill update), both
-- listed before this constraint was written.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rl_request_date_source_type_ck') THEN
    ALTER TABLE "replacement_leave_request_date"
      ADD CONSTRAINT "rl_request_date_source_type_ck"
      CHECK ("source_type" IS NULL OR "source_type" IN ('non_working_day', 'extended_hours')) NOT VALID;
  END IF;
END $$;
