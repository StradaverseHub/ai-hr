# ADR-0065 — Partial Leave Cancellation after Approval

Status: Accepted
Date: 2026-06-29
Feedback: "Partial Leave Cancellation after Approval"

## Context

After a multi-day leave is approved, an employee may need to give back **some** of the approved dates (not
the whole request). Before this change there was **no** leave-cancellation capability of any kind — not even
whole-request cancellation. The `'cancelled'` value in `leave_request_status` existed but was unused for
leave. There is also **no** prior "partial leave approval as a copyable lifecycle" feature: the closest
reusable building block is the **Emergency-Leave parent-group split** (`core/leave.ts`), which represents one
multi-day submission as several independent day-block `leave_request` rows under a shared `parent_group_id`,
each with its own ledger debit, status, and audit events. This feature does **not** depend on any
partial-approval feature.

## Decision

**Sibling-row split model (chosen) over a `cancelled_dates` jsonb hole (rejected).** Every span consumer reads
an approved leave as a contiguous `startDate→endDate` range filtered by `status='approved'`:

- `unpaidDaysByEmployment` (payroll) — `eq(status,'approved')` + period filter, sums `leave_request.days`.
- attendance `onLeave` — `eq(status,'approved')` + `startDate<=d<=endDate`.
- `plannedAbsences` (dashboard/calendar) — renders the bar from the row's span + `status`.

A `cancelled_dates` jsonb column on the live row would restore the **ledger balance** but leave the cancelled
day **still on-leave in attendance, still drawn on the calendar, and still deducted in payroll** — the exact
headline scenario, broken. None of those consumers reads such a column.

Instead, on **approval** of a cancellation request, `decideLeaveCancellation` splits the approved span into
contiguous sibling `leave_request` rows sharing a fresh `parent_group_id` (the EL model): one segment per
maximal contiguous run of working days such that each cancelled day is its own single-date segment. We:

1. **Reverse the original whole-span debit** (the single debit `finalizeLeaveApproval` wrote).
2. **Reuse the original row id** for the first segment (preserving its attachments / approval-step FKs) and
   create new rows for the rest, each `status='approved'` for survivors or `status='cancelled'` for a
   cancelled day.
3. Give **each surviving segment its own debit** sourced to its own row id (`days = -segDays`,
   `effectiveOn = segStartDate`). Cancelled segments get **no** new debit — their days stay restored by the
   whole-span reversal in (1).

Net effect: balance **up** and `taken` **down** by exactly the cancelled days; survivors unchanged. Because
every span consumer filters `status='approved'`, the cancelled segment **disappears from payroll, attendance,
and the calendar for free** — no read-layer span math.

**Carry-window consistency.** `read.ts` computes `taken` both as a simple `-sum(debit)` and via a carry-window
`debitsInWindow` bounded by `[cycleStart, min(carryExpiry, asOf)]`. The reversing debit is dated at the
original debit's `effectiveOn` (the request start, same cycle window), so the inversion is window-consistent
by construction. A test asserts `carryForwardRemaining` is unchanged net-of-cancellation across the
carry-expiry boundary.

**Cancel-all == cancel request.** If every working date is cancelled, every segment ends `'cancelled'` — this
falls out of the model with no special path.

## Hard code gates (service layer)

`requestLeaveCancellation` hard-rejects (typed errors) when:

- `status !== 'approved'`, or `durationType !== 'full_day'` (half/hourly out of scope; only full-day
  suppresses attendance per ADR-0048), or `parentGroupId != null` (blocks EL / per-date children). The UI
  also **hides** the affordance when `parentGroupId != null`, so the button never renders-then-throws.
- `leaveType.code === 'REPLACEMENT'` — approval consumes the `toil_accrual` register
  (`consumeReplacementLeaveTx`) and there is **no inverse**; restoring via the ledger alone would reintroduce
  the ghost-credit / negative-balance bug. Excluded.
- A `cancelDate` is on/before "today" (tenant working-day frame) — gated **per date**, not by the whole
  request's `startDate` (on 10 Aug you may still cancel 12 Aug).
- A `cancelDate` is not a working day inside `[startDate,endDate]`.
- A `cancelDate`'s payroll period has a **closed** batch for the employee's company — the deduction was
  already finalised and there is no reversal path, so a finalised payslip is never retroactively altered.
- A `cancelDate` overlaps **another pending** cancellation request on the same leave (double-restore guard);
  the row-status backstop (a `'cancelled'` segment can't be re-targeted) is the second line of defence.

## RLS & authorization

`leave_cancellation_request` RLS is **intentionally symmetric**: `tenant_id = current_tenant_id() AND
can_see_employment(employment_id)` in both `USING` and `WITH CHECK` (the `attendance_correction` precedent).
RLS can express neither "only the subject may INSERT" nor "no self-approval", because `can_see_employment` is
symmetric (a manager can see a subordinate). Both rules are therefore **service-enforced**:

- `requestLeaveCancellation` asserts `ctx.personId` === the person behind the leave's employment (subject-only).
- `decideLeaveCancellation` calls `assertCanDecide` (manager/admin + self-approval ban), exactly as
  `decideLeave` does.

## Workflow & substrate

Single-step manager decision (the feedback says "the manager approves/rejects" — singular). Events:

- `leave-cancellation.requested` on the cancellation aggregate (actor = employee).
- `leave-cancellation.rejected` (no row/ledger change).
- On approval: `leave-cancellation.approved` on the cancellation aggregate **and**, on the `leave-request`
  aggregate, `leave-request.split` for each newly-created sibling and `leave-request.cancelled` on each
  cancelled segment — so the leave-request audit chain stays truthful about the reduction.

## Consequences

- No new enum, no new `leave_request` column, no `days`-recompute on a live row.
- Cross-references: ADR-0048 (durations — only full-day suppresses attendance), ADR-0061 (Emergency-Leave
  `parent_group_id` split — the model reused here).
- v1 scope: Planned-Absences surface only (no `/me` duplicate). EL day-blocks and REPLACEMENT/TOIL leave are
  excluded by code gate.
