# ADR-0071 — Attendance Request Management (overtime requests, OT-approval calculation, travel marker)

Status: Accepted · 2026-07-04

> Note on numbering: the approved plan referenced this as "ADR-0069", but 0069 (leave-encashment) and 0070
> (clocking-locations-geofencing) were already merged by the time this shipped, so it takes the next free
> number, 0071. The feature name is unchanged.

## Context

Employees need one place to submit three kinds of requests that today happen over email/Slack:

1. **Attendance Adjustment / Overtime** — fix a missed clock-in/out AND/OR request overtime hours.
2. **Replacement Leave** — a day off for working a rest day / public holiday.
3. **Travel** — working off-site for a date range.

A pre-build audit of the existing code changed the scope materially (see the approved plan). The decisions
below record what we built and, crucially, the two correctness questions the plan required us to pin down.

## Decisions

### A. attendance_correction is EXTENDED, not forked (highest-risk change)

`attendance_correction.proposed_check_in` was `NOT NULL`. An "OT only" request (no punches) cannot exist under
that constraint, so migration `0145` **relaxes it to nullable** and replaces the implicit NOT-NULL with an
explicit CHECK requiring **at least one of** `(proposed_check_in, proposed_check_out, requested_ot_minutes)`.
Every existing row (which always has `proposed_check_in`) satisfies the CHECK — no backfill. This is the
single highest-risk change in the ticket (a live, RLS-governed table with in-flight rows), so it is called out
here explicitly and covered by tests for every submission shape.

`reason` stays **nullable at the DB layer** (it always was). "Mandatory" is enforced only in
`requestAttendanceCorrection` application validation — the lower-risk choice the plan preferred over a
retroactive DB `NOT NULL` with a backfill.

New nullable columns: `requested_ot_minutes`, `approved_ot_minutes`, `ot_approval_method`. We deliberately do
**not** persist a "system-calculated" snapshot column — the comparison figure is computed **live** at review
time via `deriveAttendance`/`scheduleFor` and shown to the approver, never stored.

Data-integrity: a **partial unique index** enforces one pending request per `(employment_id, attendance_date)`
so a clock-fix and a separate OT-only request for the same date cannot both approve and clobber each other on
the attendance upsert.

### B. OT-approval calculation setting (company-level)

`attendance_policy.ot_approval_calculation` — enum `requested | system_calculated | smaller_of`, default
`system_calculated`. On approval, `resolveApprovedOt(requested, systemLive, method)` produces
`approved_ot_minutes`, which is written to `attendance.ot_minutes`.

### C. THE pinned decision — what TOIL auto-accrual reads (raw vs policy-adjusted OT)

`decideAttendanceCorrection` writes the **policy-adjusted** `approved_ot_minutes` to `attendance.ot_minutes`
**before** calling `maybeAutoAccrueOnApprovalTx`. `accrueToilTx` reads `attendance.ot_minutes`. Therefore:

> **TOIL auto-accrual consumes the POLICY-ADJUSTED approved OT, not the raw engine figure.**

`attendance.ot_minutes` is the single source of truth for BOTH the payroll OT prefill AND the TOIL day-credit
math — so there is no double-counting or under-crediting. This is asserted by an explicit test
(`test/attendance-adjustment-ot.test.ts` → "TOIL auto-accrual reads the POLICY-ADJUSTED approved OT"): a
`requested`-method rest-day approval where the employee claims less than the engine derives credits Replacement
Leave off the *approved* figure.

An **OT-only** request updates only `attendance.ot_minutes` on the existing attendance row (punches left
intact); it errors if no attendance row exists for that date (you cannot bank OT against a day with no
recorded work). A **clock correction** derives punches as before, and when OT was also requested the approved
figure overrides the derived one.

### D. Replacement Leave — no new engine (superseded scope)

Confirmed by reading the code: the **"spend"** side is already shipped via an ordinary `REPLACEMENT`-type leave
request through `requestLeaveAction` → `decideLeave` → `consumeReplacementLeaveTx`. The **"earn"** side is
already automatic (`maybeAutoAccrueOnApprovalTx` when `autoAccrueOnApproval` is on) or manager-elected. We
therefore built **zero** new replacement-leave tables or services. The employee "please credit me" affordance
is satisfied by the SAME `attendance_correction` OT-request flow above: an OT-only/combined request against a
rest-day/holiday date auto-accrues on approval (when the company opted in). No `replacement_leave_request`
table, no `core/replacement-leave-request.ts`.

### E. Travel Request — audit marker only

`travel_request` (migration `0145`): `travel_from`, `travel_to` (CHECK `to >= from`), `remarks NOT NULL`,
status reuses `attendance_correction_status`, decided-by/decided-at, RLS mirroring `attendance_correction`
verbatim, plus the explicit `GRANT … TO ai_hr_app` (a new table does not inherit prior grants — ADR-0002 fails
closed). On approval it is only a marker, surfaced as a detail-view badge via `activeTravelRequestFor`.

Even though geofencing now exists (ADR-0070), travel is **not** wired into that enforcement path, nor into
`DayContext`/`attendanceForDate`. **A travelling employee who does not clock in still counts as absent** in
month-end summaries — travel is not leave. This is stated explicitly (plan §3) and asserted by a test. Real
location enforcement for travel remains a separate, larger future project.

### F. Approvals inbox — one inbox, correct self-exclusion

`core/approvals-inbox.ts` and `/approvals` gain a travel-request list. Unlike a correction (self-filing is
blocked upstream), an employee CAN self-file a travel request, so both the bell-count and the page
**self-exclude** the viewer's own pending travel by `personId` — matching the leave/cancellation pattern.

## Consequences

- `tsc`, the two new test files (`attendance-adjustment-ot`, `travel-request`), and `next build` are green.
- No change to `core/toil.ts` accrual/consumption math, eligibility, or First-Schedule consent flow.
- No change to how overtime, leave balances, or payroll are calculated under the hood — only a
  request-and-approve wrapper and one new HR setting.
