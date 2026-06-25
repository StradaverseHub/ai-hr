# ADR-0048 — Half-Day & Hourly Leave Application

Status: Accepted · 2026-06-25

## Context

Leave was full-day only. `leave_request.days` and `leave_ledger.days` are already `numeric(6,2)`,
`requestLeave` already writes `days.toFixed(2)`, `finalizeLeaveApproval` debits `Number(req.days)` through
a balance gate (`balance - need < 0`) that is correct for a fractional `need`, and payroll's
`unpaidDaysByEmployment` sums `leaveRequest.days`. So fractional debits already flow through balances, the
ledger, and payroll proration. The remaining work is to (a) capture the chosen duration, (b) compute the
fractional day count correctly (including a working-day guard), (c) add admin config + UI, and (d) fix the
two integrations where fractional days did **not** flow for free: attendance and the planned-absences grid.

The accrual / year-open / earned-cycle engines grant whole-day entitlements and are intentionally out of
scope — they are unchanged.

## Decision

### Duration types

`leave_request.duration_type` (text, `NOT NULL DEFAULT 'full_day'`) takes one of:

- `full_day` — the original behaviour; always available, no config needed.
- `half_day_am`, `half_day_pm` — half a day, morning or afternoon.
- `hourly` — a number of hours.

`leave_type.durations` (jsonb, nullable) is the per-type allow-list of the **non-full-day** durations the
type supports, e.g. `["half_day_am","half_day_pm","hourly"]`. `null` ⇒ full-day-only (the clean default;
no backfill needed). `requestLeave` rejects a chosen non-full-day duration that is not in the list with
`LeaveDurationNotAllowedError`. The admin stores only the non-full-day slots; full-day is implicit.

### Deduction math

- `full_day` → the existing count (working-days or calendar-days over the range).
- `half_day_am` / `half_day_pm` → `0.5`.
- `hourly` → `round(hours / DEFAULT_STANDARD_HOURS, 2)`, where `DEFAULT_STANDARD_HOURS = 8`.

The denominator "hours in a workday" is a company-wide constant, not a per-leave-type column. `core/toil.ts`
already canonicalises the same fraction-of-a-day math against the same ledger with `STD_DAY_MINUTES = 480`
(8h); we reuse that convention. If a non-8h customer appears, add a single setting then — the
`hours / denominator` formula is unchanged.

**Lossy rounding is intentional and the ledger debit is the source of truth.** `1h / 8h = 0.125 → 0.13`.
The `days` value (0.13) is what the ledger debits and the balance gate reads; the displayed "1h" is taken
from the stored `leave_request.hours`, **not** back-computed from `days`. They may legitimately disagree;
that is by design. `hours = 8 → days = 1.00`, still recorded as `duration_type = 'hourly'`, and the
history label still reads "8h" from the stored hours.

`leave_request.hours` (numeric(4,2), nullable) is set only for `hourly` requests so the original hours are
recoverable for display + audit. `days` remains the **only** value `finalizeLeaveApproval` reads — there is
no second deduction path.

### Working-day requirement (correctness fix)

For `working_days`-counted types a half/hourly request must land on an actual working day. The existing
holiday query runs for the single day; if `workingDays(start, end, holidays) === 0` (a weekend or gazetted
holiday) the request is **rejected** with the existing `'No leave days in range'` error — it is **not**
silently deducted at 0.5. `calendar_days` types have no such restriction (consistent with full-day calendar
leave).

### Single-day enforcement

Half/hourly requests must be a single day (`start === end`); a half/hourly request spanning a range is out
of scope and throws a clear error.

### Same-date conflict (scoped overlap)

There is no general range-overlap guard today, and the headline AM+PM use case depends on its absence — a
complementary AM + PM on the same date is allowed. The only overlap logic introduced is scoped to the same
single date: when a non-rejected request already covers that date, a new non-full-day request conflicts
unless it is the complementary half-day slot. Concretely, a same-slot duplicate, a `full_day`, or any
`hourly` on that date conflicts; `half_day_am` + `half_day_pm` is the one allowed pair. General range-overlap
detection remains deliberately out of scope.

### Attendance interaction

`core/attendance.ts` detected "on leave" purely by date-range overlap, with no `days`/`duration_type`
awareness, so a half-day-AM leave suppressed the **whole** day's attendance signal. Decision: **a half-day
or hourly leave does NOT mark the employee as wholly on leave.** Both on-leave selects now filter
`duration_type = 'full_day'`; for fractional leave the day still requires (and can record) attendance for
the worked portion, and it does **not** increment `leaveDays` in the monthly summary (it counts as a worked
/ partial day). Attendance's own `half_day`-from-checkout-time status is unrelated and unchanged.

### Planned-absences grid

The dashboard grid rendered every leave as a full-width chip regardless of `days`. Non-full-day leave now
carries a duration badge ("½ AM", "½ PM", "2h") and a visually distinct partial pill (hatched, inset) so a
0.5/0.25-day leave does not draw as a full day. This is a rendering tweak, not a grid-engine rewrite.

### TOIL types

TOIL-backed leave types MAY be enabled for hourly/half durations — the arithmetic is sound (`core/toil.ts`
already credits arbitrary fractions to the same ledger). No special handling is required.

### Backfill safety

The migration is additive. `duration_type` is `NOT NULL DEFAULT 'full_day'`, so existing rows backfill to
`full_day` and preserve current behaviour. `leave_type.durations` is nullable (full-day-only) so no existing
type changes. No new tables and no new RLS — the columns inherit the existing `leave_type` / `leave_request`
policies.

### Known gap (accepted)

`LeaveDurationNotAllowedError` (and the other half/hourly validation errors) surface via `?error=` as plain
English, so a non-English employee can see an English message. This is the same pre-existing flaw as
`LeaveIneligibleError` and the other leave errors, which are not i18n'd today. Accepted for consistency;
not introduced by this change.

## Consequences

- Fractional leave flows through balance, ledger, and payroll proration unchanged (verified).
- Attendance and the dashboard no longer over-state fractional leave as full days.
- Admins gain a per-leave-type allow-list; employees pick a duration on the apply form with disallowed
  options disabled (the service-layer guard remains the authority).
