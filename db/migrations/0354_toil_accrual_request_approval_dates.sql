-- 0354 · 00307068 — the two dates a replacement-leave credit has never recorded, and the expiry anchor.
--
-- WHAT THE REPORTER ASKED FOR. An employee opening Replacement Leave should see one line per BANKED CREDIT
-- carrying Request Date, Number, Unit, Approval Date and Expired Date. `toil_accrual` (the credit register)
-- already carries the worked date, the amount, the unit's raw minutes and its own expiry — but it has never
-- recorded WHEN the credit was asked for or WHEN a line manager approved it. Two of the five columns cannot
-- be built from what is stored, which is why this is a migration and not a screen change.
--
-- BOTH COLUMNS ARE NULLABLE, ON PURPOSE. A legacy row genuinely does not know its request date; a backfilled
-- guess dressed up as a fact is worse than an honest blank. The backfill below writes the ONE value each
-- column can be derived from without inventing anything, and the read path renders a dash for anything left
-- null rather than a fabricated date.

-- ── The request date ──────────────────────────────────────────────────────────────────────────────────
--
-- DATE, not timestamptz: this is the day an employee (or a manager on the roster) asked for the credit, and
-- it is displayed as a day. There is no path today that needs the time of day.
ALTER TABLE "toil_accrual"
	ADD COLUMN IF NOT EXISTS "requested_on" date;--> statement-breakpoint

-- ── The approval date ─────────────────────────────────────────────────────────────────────────────────
--
-- timestamptz, NOT date, and the asymmetry is deliberate. This column is not only displayed: it is the
-- ANCHOR the expiry date is now counted from (`expires_on = approved_on::date + expiry_days`). An instant is
-- the honest record of when the decision happened; the ::date cast at the point of use is where the
-- timezone question gets answered once, rather than being baked into storage where it cannot be revisited.
ALTER TABLE "toil_accrual"
	ADD COLUMN IF NOT EXISTS "approved_on" timestamptz;--> statement-breakpoint

-- ── Backfill, and the one thing it is allowed to assume ───────────────────────────────────────────────
--
-- `created_at` is the instant the accrual row was written, and on BOTH existing accrual paths the row is
-- written by the act of approving:
--   • the manual roster election (accrueToilTx with requireDecideAuth=true) runs assertCanDecide first — the
--     manager's decision IS the insert;
--   • the auto path (maybeAutoAccrueOnApprovalTx) runs inside decideAttendanceCorrection's transaction — the
--     approval of the correction IS the insert.
-- So approved_on = created_at is not an approximation, it is the same event observed from the row.
--
-- requested_on = worked_date is the weaker of the two and is stated as such: the roster path has no employee
-- request at all (a manager elects the day), so the day worked is the only date in evidence. The auto path
-- DOES have a truer answer (attendance_correction.created_at), but matching correction → accrual after the
-- fact means guessing which of several corrections for the same day produced the credit, and a wrong
-- attribution written into a column an employee reads is worse than the conservative one. Forward from this
-- release the application code writes the real correction date; history keeps the honest fallback.
UPDATE "toil_accrual"
SET "approved_on" = "created_at",
    "requested_on" = "worked_date"
WHERE "approved_on" IS NULL OR "requested_on" IS NULL;--> statement-breakpoint

-- ── The expiry re-anchor, FORWARD ONLY ────────────────────────────────────────────────────────────────
--
-- New accruals now expire at approval + expiry_days instead of worked date + expiry_days. Existing rows are
-- brought onto the same rule ONLY where doing so cannot take a day away from anyone:
--
--   • GREATEST(...) is the whole guarantee. Approval never precedes the day worked, so the re-anchored date
--     is always on or after the stored one and GREATEST can only move a date LATER or leave it alone. No
--     employee loses a day of leave, and nothing needs a "was it already extended" flag.
--   • status = 'active' only. A 'lapsed', 'taken' or 'converted_to_pay' row has been SETTLED — its expiry
--     date is now a historical fact that the expiry sweep, the year-end close and (for converted rows) a
--     payslip have all already acted on. Moving it would rewrite the reason a settled outcome happened.
--   • policy_id IS NOT NULL only. Without the policy row there is no expiry_days to re-anchor against, and
--     guessing one would be inventing the number this whole clause exists to source honestly.
--
-- Amounts (days_credited, days_taken), statuses and the leave_ledger credits behind the balance are NOT
-- touched by anything in this file. The balance an employee sees today is the balance they see after it.
--
-- EXPECTED ROW COUNT: zero on every deployment known at time of writing. Replacement leave is a billable
-- non-core module (packs/catalog.ts) that is in no parity set, and no tracked environment enables it — so no
-- tenant should hold a single toil_accrual row. That is an expectation, not a measurement: COUNT THE ROWS ON
-- PRODUCTION BEFORE RELEASE and put the figure in the release note.
--   SELECT count(*) FROM toil_accrual;
--   SELECT count(*) FROM toil_accrual WHERE status = 'active' AND policy_id IS NOT NULL;
UPDATE "toil_accrual" a
SET "expires_on" = GREATEST(a."expires_on", (a."created_at" AT TIME ZONE 'UTC')::date + p."expiry_days")
FROM "toil_policy" p
WHERE p."id" = a."policy_id"
  AND a."status" = 'active';--> statement-breakpoint

-- No RLS change: toil_accrual keeps the policies it already carries, and additive nullable columns need no
-- policy change. The grant is re-stated per the migration standard — a no-op on an existing table, and the
-- guarantee that the new columns are reachable by the app role that reads them.
GRANT SELECT, INSERT, UPDATE, DELETE ON "toil_accrual" TO ai_hr_app;
