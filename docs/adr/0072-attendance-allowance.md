# ADR-0072 — Attendance Allowance Management (Monthly, v1)

Status: Accepted
Date: 2026-07-04

## Context

HR wants to reward good attendance automatically: pay a fixed "attendance allowance"
(e.g. RM200) to employees who meet a set of monthly attendance conditions, and push the
reward into the payroll run instead of keying it by hand. This is the first version.

## Decisions

1. **Monthly method only in v1; Daily deferred.** Daily is a genuinely different evaluation
   engine (per-attendance-row iteration, per-day period keys, N-rows-summed transfer) and its
   worked example depends on late-*minutes* which we do not store. Monthly ships first; Daily
   is an immediate follow-up. The `method` column carries a value now (text tag, app-side check
   accepting only `'monthly'`), so adding `'daily'` later needs no enum migration.

2. **The only v1 criteria are pure functions of `MonthSummaryRow`** (core/attendance.ts):
   - `minAttendanceDays` → present + late + halfDay (days actually shown up)
   - `maxAbsentDays` → absent
   - `maxLateCount` → late (a COUNT of late-status days)
   - `maxTotalLeaveDays` → leaveDays
   - `requirePerfectAttendance` → absent == 0 && late == 0

   No new attendance derivation, no touch to the `attendanceMonthSummary` hot path.

3. **Evaluation is a pure read, NOT a persisted award table.** The only persisted output is the
   `payroll_batch_component` row created at transfer time — exactly the claims / OT prefill
   precedent (they persist nothing until prefill onto a draft batch). This removes an RLS
   section, a per-employee "evaluated" event stream (substrate flooding), and the whole
   re-settlement/idempotency-handle machinery.

4. **Payroll transfer reuses `setPayrollBatchComponent`** (no new payroll path). It is gated by
   `TYPED_PAY_COMPONENTS_ENABLED` (like `prefillShiftDifferentialFromRoster`): when the flag is
   off, `transferAllowancesToBatch` returns `{ applied: 0, gated: true }` and writes nothing, so
   the UI can warn that the amount will not reach payslips. It also guards against an
   unsupported (PCB-taxable, non-EPF, non-SOCSO, non-payable) component up front via
   `UnsupportedBatchComponentError`.

5. **Reversal path.** Because evaluation is a live read, the transfer re-derives qualification at
   transfer time. If an employee no longer qualifies (attendance corrected downward after a prior
   transfer), the transfer ZEROES / removes that employee's existing batch component row for this
   pay component (draft batches only). The batch row is the single source of truth — no award
   table to keep in sync.

6. **Manual Evaluate / Transfer buttons, not automatic on finalize.** Every comparable feature we
   already have (overtime, claims) works as an admin button on the draft payroll run, precisely
   because payroll needs a human to review before money moves. This deviates from the request's
   "automatic on finalize" wording — accepted as a deliberate decision pending reporter
   confirmation. Fully-automatic-on-finalize can be a later enhancement.

7. **Scope targets department + business unit + company only.** There is no "employee group"
   master data and no clean "branch/location" org unit (`clocking_location` is a geofence point,
   not an org unit). `scope` is `{ departmentIds?, businessUnitIds?, companyIds? }`; an empty
   object means all-in-scope. Because `MonthSummaryRow` returns only employmentId/name (not
   department/BU), `evaluateAllowancesForPeriod` issues one extra query joining
   employment → current open assignment → department → business_unit and filters in app code.

8. **Monthly evaluation is intended for a closed/finalized month.** The Evaluate screen defaults
   to and recommends completed months. Pro-ration for mid-month hires and final-month handling
   for leavers are inherent to `attendanceMonthSummary` (shared, hot, compliance-sensitive) and
   are NOT modified here; they are recorded as follow-ups. Because evaluation is a live read, an
   early evaluate simply shows current-state numbers with no stale persisted reward to retract.

## Deferred (recorded so nothing reads as a silent miss)

- The Daily attendance-allowance method.
- Late-minutes, early-out-count and early-out-minutes conditions (not stored; `deriveAttendance`
  discards the minute delta and has no early-out classification).
- Per-leave-type caps (medical / annual / emergency / replacement / unpaid) — `leaveDays` is a
  single lumped integer with no leave-type join in the monthly roll-up.
- Attendance-adjustment-request count and OT-rejection-count conditions.
- Variable amount (only a fixed amount in v1).
- "Employee group" and "branch/location" targeting.
- Fully-automatic evaluation/transfer on finalize.
- Hard delete of a policy (archive + an active/inactive status toggle is the reversible
  soft-delete; hard delete added only if asked).

## Substrate

`attendance-allowance-policy.{created,updated,archived,status-changed}` on every write. Evaluation
reads append no events (a pure read). The transfer path appends events through
`setPayrollBatchComponent` (`payroll-batch-component.set`), as the OT/claims prefill already does.
