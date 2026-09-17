-- 3fb1a611 (r299) "Leave Credit" — the replacement-leave CREDIT REGISTER learns four things it could not
-- say: that HR added a credit by hand, that a credit was REVERSED (without being deleted), which kind of day
-- earned it (including an OFF day), and which ledger rows reversed or settled it.
--
-- ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────────────────────────────
-- NOT a second ledger. `leave_ledger` stays the balance authority (core/leave.ts leaveBalance) and
-- `toil_accrual` stays the per-credit register linked to it by `ledger_entry_id`. The Leave Credit screen's
-- history is DERIVED from replacement-type `leave_ledger` rows joined to this register; the two link
-- columns below are what let a reversal line and an expiry line name the credit they belong to.
--
-- ── EVERY WRITER OF toil_accrual, listed before touching its types (CLAUDE.md §6) ────────────────────
--   core/toil.ts          bankToilCreditTx (INSERT — roster, auto-approval, employee request, HR grant),
--                         consumeReplacementLeaveTx (UPDATE days_taken/status/taken_by_request_id),
--                         restoreReplacementLeaveTx (UPDATE, new this round),
--                         reverseLeaveCredit (UPDATE status → reversed, new this round),
--                         expireAccrualsTx (UPDATE status → converted_to_pay/lapsed, + settled link).
--   migrations            0354 (one-off UPDATE of expires_on on active rows; already applied).
--   scripts/reset-*.ts    READ-only guards counting references into leave_ledger (updated for the two new
--                         foreign keys below).
-- Nothing else INSERTs, UPDATEs or DELETEs this table (grep 'toilAccrual' / 'toil_accrual').
--
-- ── 1 · toil_accrual_source GAINS 'hr_manual_grant' ─────────────────────────────────────────────────
-- ⚠️ A TYPE SWAP, NOT `ALTER TYPE … ADD VALUE` (0448's header): drizzle's migrate() runs every pending
-- migration inside ONE transaction, and a label added by ADD VALUE cannot be used in that transaction
-- (55P04). The column has no default and no policy references it.
--
-- ── 2 · toil_accrual_status GAINS 'reversed' ────────────────────────────────────────────────────────
-- A reversal NEVER deletes the register row (the reporter: "the original line stays, marked Reversed").
-- Same swap; the column's DEFAULT 'active' has to come off and go back on around the type change. No RLS
-- policy references `status` (0076 / 0314 key on tenant_id + employment_id only), so the ALTER is allowed.
--
-- MONEY: core/payroll.ts EXCLUDE_TOIL_BANKED_DAYS must treat a 'reversed' credit as never banked, so the
-- worked day's overtime becomes payable again. That is a code change in the same round, pinned by
-- test/r299-leave-credit-money.test.ts.
--
-- ── 3 · ONE CREDIT PER WORKED DAY, NOW "PER UNREVERSED CREDIT" ───────────────────────────────────────
-- `toil_accrual_emp_date_uq` becomes PARTIAL (`WHERE status <> 'reversed'`). Without this a credit entered
-- with the wrong amount could be reversed but never re-entered for the same day, because the reversed row
-- still occupies the unique key. The double-bank guard is unchanged for every live credit: two unreversed
-- credits for one (employee, worked date) remain impossible.
-- core/reporting.ts left-joins this table on (employment, worked date) on the strength of the old index;
-- that join gains `status <> 'reversed'` in the same round so it still cannot multiply rows.
--
-- ── 4 · worked_day_kind ─────────────────────────────────────────────────────────────────────────────
-- The day that EARNED the credit: workday / rest_day / off_day / holiday, resolved from the employee's
-- schedule (core/attendance.ts workedDayKindForTx). A NEW enum, deliberately NOT a widening of
-- `attendance_day_type` (3 values, shared with plan_ot and payroll's OT math — core/attendance.ts b8aa3466).
-- `day_type` keeps its meaning (the attendance vocabulary the expiry sweep values from); an OFF day is
-- recorded here with `day_type` NULL, so its convert-to-pay stays on the existing ORP fallback.
-- NULLABLE, no backfill: a legacy row genuinely does not know.
--
-- ── 5 · note, remarks ───────────────────────────────────────────────────────────────────────────────
-- HR's stated reason (required by the service) and optional remarks on a hand-added credit. NULL on every
-- earned credit (its reason is the request's) and every legacy row.
--
-- ── 6 · reversed_at, reversal_reason, reversal_ledger_entry_id, settled_ledger_entry_id ─────────────
-- The offsetting `leave_ledger` debit a reversal writes, and the debit the expiry sweep writes when it
-- expires or pays out a credit. Both NULLABLE; nothing is back-filled (a legacy expiry debit has no
-- recorded link and the screen lists it as an unlinked movement rather than guessing which credit it was).
-- Two new foreign keys into leave_ledger: scripts/reset-entitlement-configuration.ts and
-- scripts/reset-medical-hospitalization-ledger.ts count references before deleting ledger rows, and are
-- updated to count these as well.
--
-- ── 7 · toil_accrual_rls WITH CHECK: a line manager may write the register ──────────────────────────
-- FACT (measured on this branch before the change): a non-admin line manager approving an employee's
-- credit request failed with "new row violates row-level security policy" on the toil_accrual INSERT,
-- because 0076's WITH CHECK is `app.can_admin_employment` (admin-for-company only), while every approval
-- path that writes this table — approving a credit request, approving Replacement Leave (consumption),
-- approving a cancellation (give-back) — is authorised in the SERVICE by `assertCanDecide`, which admits the
-- line manager. `leave_ledger`, the balance authority those same approvals write, checks
-- `app.can_see_employment` (0001). The register now checks the same, MINUS the subject themself: an
-- employee has no path that writes their own register row, so their own session may not. USING (read) is
-- unchanged; 0314's RESTRICTIVE admin-only DELETE is unchanged (and no code deletes from this table).
--
-- No CREATE TABLE here, so no GRANT is owed; the columns inherit toil_accrual's grants (0076, 0354).
--
-- Journal entry: idx 469.

DO $$
DECLARE total int; active_rows int;
BEGIN
  SELECT count(*) INTO total FROM toil_accrual;
  SELECT count(*) INTO active_rows FROM toil_accrual WHERE status::text = 'active';
  RAISE NOTICE '0469 toil_accrual: % register rows (% active) keep status and source verbatim; worked_day_kind, note, remarks and the reversal/settlement links start NULL on all of them.', total, active_rows;
END $$;
--> statement-breakpoint

ALTER TYPE "toil_accrual_source" RENAME TO "toil_accrual_source_pre_0469";
--> statement-breakpoint
CREATE TYPE "toil_accrual_source" AS ENUM('roster', 'auto_approval', 'employee_request', 'hr_manual_grant');
--> statement-breakpoint
ALTER TABLE "toil_accrual"
  ALTER COLUMN "source" TYPE "toil_accrual_source" USING "source"::text::"toil_accrual_source";
--> statement-breakpoint
DROP TYPE "toil_accrual_source_pre_0469";
--> statement-breakpoint

DROP INDEX IF EXISTS "toil_accrual_emp_date_uq";
--> statement-breakpoint
ALTER TYPE "toil_accrual_status" RENAME TO "toil_accrual_status_pre_0469";
--> statement-breakpoint
CREATE TYPE "toil_accrual_status" AS ENUM('active', 'taken', 'converted_to_pay', 'lapsed', 'reversed');
--> statement-breakpoint
ALTER TABLE "toil_accrual" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "toil_accrual"
  ALTER COLUMN "status" TYPE "toil_accrual_status" USING "status"::text::"toil_accrual_status";
--> statement-breakpoint
ALTER TABLE "toil_accrual" ALTER COLUMN "status" SET DEFAULT 'active';
--> statement-breakpoint
DROP TYPE "toil_accrual_status_pre_0469";
--> statement-breakpoint
CREATE UNIQUE INDEX "toil_accrual_emp_date_uq" ON "toil_accrual" USING btree ("tenant_id", "employment_id", "worked_date")
  WHERE "status" <> 'reversed';
--> statement-breakpoint

CREATE TYPE "toil_worked_day_kind" AS ENUM('workday', 'rest_day', 'off_day', 'holiday');
--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD COLUMN "worked_day_kind" "toil_worked_day_kind";
--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD COLUMN "note" text;
--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD COLUMN "remarks" text;
--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD COLUMN "reversed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD COLUMN "reversal_reason" text;
--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD COLUMN "reversal_ledger_entry_id" uuid;
--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD COLUMN "settled_ledger_entry_id" uuid;
--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD CONSTRAINT "toil_accrual_reversal_ledger_entry_id_leave_ledger_id_fk"
  FOREIGN KEY ("reversal_ledger_entry_id") REFERENCES "public"."leave_ledger"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD CONSTRAINT "toil_accrual_settled_ledger_entry_id_leave_ledger_id_fk"
  FOREIGN KEY ("settled_ledger_entry_id") REFERENCES "public"."leave_ledger"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

DROP POLICY IF EXISTS "toil_accrual_rls" ON "toil_accrual";
--> statement-breakpoint
CREATE POLICY "toil_accrual_rls" ON "toil_accrual" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (
      app.can_admin_employment(employment_id)
      OR (
        app.can_see_employment(employment_id)
        AND NOT app.is_self_person((SELECT e.person_id FROM employment e WHERE e.id = employment_id))
      )
    )
  );
