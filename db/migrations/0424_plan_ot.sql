-- 1e9145d4 · PLAN OT — overtime agreed BEFORE it is worked.
--
-- WHAT WAS BROKEN. An Overtime Request form already exists (ADR-0069: an attendance_correction row with no
-- proposed punches, carrying requested_ot_minutes). Its own on-screen note promises you may file it before
-- your shift. You can — but nobody can APPROVE it: decideAttendanceCorrection's OT-only branch looks up the
-- day's attendance row and throws "No attendance record exists for this date to attach overtime to." when
-- there is none, which is always true of a future date. Pre-approval was advertised, half built, impossible.
--
-- THE SHAPE OF THE FIX, and why it needs these four columns and nothing else. Approval is SPLIT from
-- application. Approving a future-dated OT-only plan stamps approved_ot_minutes / ot_approval_method on the
-- correction row and leaves attendance alone; the plan LANDS on the attendance day later, when that day is
-- actually worked, resolved against what was really clocked through the company's existing
-- ot_approval_calculation rule. `applied_at` is the stamp that makes landing happen AT MOST ONCE.
--
-- WHY NO PLACEHOLDER ATTENDANCE ROW (the tempting shortcut, and it is a trap). attendanceMonthSummary counts
-- absence, leave days and the 45h/week flag off attendance rows, and prefillOvertimeFromAttendance windows
-- off them too. A phantom row for a day nobody has worked would corrupt both — an employee would show as
-- PRESENT on a day they had not yet lived through.
--
-- WHY NO NEW TABLE. A plan IS an OT-only attendance_correction (ADR-0069's own design), so it inherits the
-- request → decide workflow, the approvals inbox, assertCanDecide routing, RLS, and the audit trail already
-- built for it. A parallel ot_plan table would fork all six. No new table therefore means NO NEW GRANT and
-- no new RLS policy here: attendance_correction's own policy (migration 0038) already covers these columns.

-- ── The plan's own fields ────────────────────────────────────────────────────────────────────────────
-- ALL FOUR NULLABLE, deliberately: every existing row and the WHOLE clock-correction path keep behaving
-- byte-identically, and a plain "how many hours" overtime claim (the after-the-fact path that works today)
-- is still representable with the times left empty.
ALTER TABLE "attendance_correction"
  -- The planned window the employee typed. Hours are DERIVED from these on the form; requested_ot_minutes
  -- stays the authoritative figure the engine reads, so these two are display/audit, never a second source
  -- of truth for pay. `time` (not timestamptz) mirrors proposed_check_in / proposed_check_out beside them.
  ADD COLUMN IF NOT EXISTS "planned_start_time" time,
  ADD COLUMN IF NOT EXISTS "planned_end_time" time,
  -- The reason CATEGORY. text + CHECK rather than a pgEnum: the 0275 widening lesson recorded in db/schema.ts
  -- — adding a category to an enum needs its own migration and cannot be used in the transaction that adds
  -- it, whereas widening a CHECK is one statement. Free text (`reason`) stays mandatory regardless, and is
  -- the only thing 'other' has to say for itself.
  ADD COLUMN IF NOT EXISTS "ot_reason_category" text,
  -- Set the moment an APPROVED plan's hours land on the attendance day. NULL = approved but not yet counted
  -- (a future day, or a day not yet clocked out). This is the idempotency guard: the application step writes
  -- it in the same statement it consumes the plan, so a re-clock-out, a re-import or a later correction of
  -- the same day cannot bank the same plan twice.
  ADD COLUMN IF NOT EXISTS "applied_at" timestamptz;
--> statement-breakpoint

-- Mirrors how the codebase already constrains a small closed vocabulary on a text column (see
-- employment_shift_arrangement_type_ck, migration 0421). NULL is allowed — an OT claim filed before this
-- release, or through any path that does not offer categories, carries none.
ALTER TABLE "attendance_correction"
  DROP CONSTRAINT IF EXISTS "attendance_correction_ot_reason_category_ck";
--> statement-breakpoint
ALTER TABLE "attendance_correction"
  ADD CONSTRAINT "attendance_correction_ot_reason_category_ck"
  CHECK ("ot_reason_category" IS NULL OR "ot_reason_category" IN
    ('project_deadline', 'system_maintenance', 'month_end_closing', 'client_request', 'other'));
--> statement-breakpoint

-- The application step's lookup: "the approved, not-yet-applied plan for this employee on this day".
-- Partial, so it indexes only the handful of live plans rather than every decided correction ever filed.
CREATE INDEX IF NOT EXISTS "attendance_correction_unapplied_plan_idx"
  ON "attendance_correction" ("employment_id", "attendance_date")
  WHERE "status" = 'approved' AND "applied_at" IS NULL AND "requested_ot_minutes" IS NOT NULL;
--> statement-breakpoint

-- ── WITHDRAWN plans need a status the type does not have yet ─────────────────────────────────────────
-- attendance_correction_status is SHARED with travel_request (db/schema.ts). Every consumer was audited
-- before adding this value:
--   • core/approvals-inbox.ts + listAttendanceCorrections/listTravelRequests filter status = 'pending', so a
--     cancelled row drops out of the approver's queue for free;
--   • the REQUEST_STATUS colour map in app/attendance/requests/page.tsx falls back to neutral grey for an
--     unknown key, and gains an explicit entry in this change;
--   • me.leaveStatus.cancelled ALREADY EXISTS in all six locale files (it is the leave vocabulary) — so no
--     new key, and no MISSING_MESSAGE risk, for the label;
--   • attendance_correction_one_pending_uq is partial WHERE status = 'pending', so a withdrawn plan leaves
--     the date free for a replacement without any index change.
-- Nothing writes 'cancelled' to travel_request; the value simply becomes available there too.
--
-- ADD VALUE runs LAST in this file on purpose. Postgres permits it inside a transaction block (drizzle wraps
-- each file in one) but the new label CANNOT BE USED — compared, cast or inserted — until that transaction
-- commits. Nothing above or below references it, so co-locating is safe here; the moment a future migration
-- needs to write 'cancelled', it must live in its own later file (the 0294 → 0295 pattern).
ALTER TYPE "attendance_correction_status" ADD VALUE IF NOT EXISTS 'cancelled';
