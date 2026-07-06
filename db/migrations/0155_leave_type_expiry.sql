-- Leave Type Expiry Field (feedback: fec49317 "Leave Type Expiry Field").
--
-- Adds ONE optional age-from-earning expiry setting per leave type: leave that is not used within
-- `expiry_value` `expiry_unit` (months | days) of the date each portion was EARNED (its ledger
-- effective_on) lapses and drops out of the balance. Because leaveBalance() is a plain signed sum of
-- leave_ledger, a negative `adjustment` row posted by the expireAgedLeave sweep (core/leave.ts) removes the
-- lapsed days from the balance automatically, and therefore from the manual encashment advisory (which reads
-- the live balance). Forfeit rows remain real ledger rows, so expired days still show in leave reports
-- (leaveEntitlementBreakdown / transactions) — matching the reporter's ruling.
--
-- Reuses the TOIL expires-on / oldest-first sweep pattern (toil_accrual.expires_on aged from the worked
-- date), NOT the carry-forward reconstruction engine.
--
--   expiry_value = null AND expiry_unit = null  ⇒  no expiry (existing behaviour; nothing breaks for
--     current types). Both are set together or both null (enforced by the check below + updateLeaveType).
--   expiry_unit is constrained to 'months' | 'days'.  expiry_value must be >= 1 (validated in the service).
--
-- SCOPE (important): the sweep deliberately EXCLUDES the ANNUAL leave code, which already has per-policy
-- carry-forward expiry (expireCarriedLeave). Layering a second age-based forfeit onto ANNUAL would
-- double-forfeit the same days against the carry-expiry / cap / boundary writers, so expireAgedLeave filters
-- ANNUAL out. The column may still be stored on an ANNUAL type without effect (the sweep ignores it).
--
-- No RLS change: leave_type already has tenant-read + admin-write policies; new columns inherit the table's
-- row-level policies (same as the 0133 backdating_limit_days and 0147 custom_messages migrations).
--
-- Journal entry: idx 155 (see meta/_journal.json). PLACEHOLDER NUMBER — the integration step may renumber
-- this migration; it is self-contained and idempotent (IF NOT EXISTS guards), so the exact index is not
-- load-bearing.
ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "expiry_value" integer;--> statement-breakpoint
ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "expiry_unit" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_expiry_unit_ck"
    CHECK ("expiry_unit" IS NULL OR "expiry_unit" IN ('months', 'days'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_expiry_pair_ck"
    CHECK (("expiry_value" IS NULL) = ("expiry_unit" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_expiry_value_pos_ck"
    CHECK ("expiry_value" IS NULL OR "expiry_value" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
