# ADR-0069: Leave Encashment (leave-side only)

Status: Accepted
Feedback: "Leave Encashment Setting under Leave Module" — Leave module calculates + freezes + exposes
encashable days; Payroll module (existing `encashmentDivisor`, untouched) does the money conversion.

## Context

When an employee resigns, unused Annual Leave should later be converted to a cash payout. Before this
change the system approved the resignation and ended the employment, but nothing locked the leave balance
or produced an official "encashable days" figure — the payroll leavers panel (`leaverAdvisory`,
`core/payroll.ts`) read a **live** balance that could still drift after the resignation was approved (further
leave requests, accruals, corrections).

### Scope boundary (the request's own boundary — restated so it isn't missed later)

The Leave module is responsible for:
- checking resignation status,
- freezing the leave balance on resignation approval,
- calculating the remaining eligible (Annual-only) leave balance,
- exposing the encashable-days figure to Payroll,
- keeping an audit history of every calculation/override.

The Leave module must **NOT**: do salary math, RM/monetary conversion, payroll logic, basic-salary
handling, or monthly-vs-daily wage logic. Payroll's existing `encashmentDivisor`
(`db/schema.ts`, `core/payroll-policy-config.ts`) is deliberately left untouched — it is Payroll's future
money-conversion knob, not this module's concern.

### "API design for Payroll integration"

This product has **no external/HTTP interface between modules** — every module boundary here is an
in-process exported function (e.g. `core/payroll.ts` already reads `leave_ledger` directly for
`leaverAdvisory`). `encashableDaysForEmployment` in `core/leave-encashment.ts` **is** the API-design
deliverable: Payroll calls it in-process and gets back day-counts only, never money.

## Decision

### 1. Company-scoped policy (`leave_encashment_policy`)

One row per company (0086 `leave_approval_policy` / `toil_policy` pattern): `enabled` (master on/off),
`autoFreeze` (freeze automatically on resignation approval — the only two toggles the request's UX section
asks for, "General toggle" + "Freeze control"). No eligible-leave-types column: Annual is resolved by
`leaveType.code = 'ANNUAL'`, identically to the existing `leaverAdvisory`. No rounding-rule column: the rule
is a fixed code constant (`computeEncashableDays`), matching the request's own fixed rounding example. Both
are rendered as **static descriptive text** in the admin UI, not dead controls — the request explicitly
listed "Leave types" and "Rules" as UX sections without asking them to be configurable per company.

Extension path when a second eligible type is eventually requested: add a nullable `leave_type_id` column,
exactly how `leave_approval_policy` grew from "one default row" to "optionally per leave type" in 0086.

RLS: tenant-scoped read, `app.is_admin_for(company_id)` write — company-scoped HR admins manage their own
company's policy, matching who is authorised to decide a resignation for that company.

### 2. Freeze snapshot (`leave_encashment_snapshot`)

One row per `(resignation_request_id, leave_type_id)`. Captures: the raw signed balance at approval
(`balanceDays`), the auto-computed encashable figure (`encashableDays`, whole days, clamped ≥ 0), the date
it was computed as-of, a `status` (`frozen` | `unfrozen`), and an optional HR override
(`overrideDays`/`overrideReason`). The **effective** figure anywhere downstream (people-page card, payroll
leavers panel) is `overrideDays ?? encashableDays`.

A partial unique index — `(employment_id, leave_type_id) WHERE status = 'frozen'` — enforces "at most one
ACTIVE frozen snapshot per employment+type" at the database level. This is the exact predicate the freeze
trigger (below) reads, so the invariant and its enforcement point are the same object.

RLS mirrors 0117 `employee_cp38`: `USING can_see_employment(employment_id)` (subject **self-read**),
`WITH CHECK is_admin()` (writes admin/system-only). Self-read is not speculative here — it is functional: the
freeze trigger and the `requestLeave` pre-check both evaluate `EXISTS (SELECT ... leave_encashment_snapshot
...)` under the acting user's OWN session (trigger functions in this product are never `SECURITY DEFINER`,
per the 0011 payroll-immutability precedent), so an admin-only-read table would blind exactly the session
that needs to see the freeze — the employee's own `requestLeave` call. The 0117 split (self-read / admin-write)
resolves this while keeping writes admin-only.

### 3. Freeze enforcement: one DB trigger, not per-call-site guards

`app.guard_frozen_leave_balance()` — `BEFORE INSERT ON leave_ledger` (0011 shape) — raises
`ERRCODE = check_violation` with message prefix `LEAVE_BALANCE_FROZEN` when an active frozen snapshot exists
for the row's `(employment_id, leave_type_id)`. `leave_ledger` is **append-only**, so an INSERT-only trigger
is the complete invariant — there is no UPDATE/DELETE path on that table to also guard. This single
unforgeable trigger automatically covers every present AND future ledger-insert call site
(`finalizeLeaveApproval` ~1411, cancellation credits ~2014/2085, `openLeaveYear` ~2293/2303,
`accrueEarnedLeave` ~2663/2686, `expireCarriedLeave` ~2907, `grantAdHocLeave` ~3030, the hire grant in
`org.ts`) without ten scattered `if (frozen) throw` guards scattered through `core/leave.ts`/`core/toil.ts`.

One friendly **UX pre-check** additionally lives in `requestLeave`: it calls `frozenSnapshotFor` and throws
`LeaveBalanceFrozenError` *before* the request is even created, so the employee gets an immediate, readable
error instead of only discovering the freeze at approval time when the trigger fires. This is deliberately
just a nicer error message — the trigger is the real enforcement, defense-in-depth.

The four sweep functions (`openLeaveYear`, `accrueEarnedLeave`, `expireCarriedLeave`, `grantAdHocLeave`)
additionally **skip** any employment with an active frozen snapshot for the type being written, so a batch
run does not abort mid-sweep on the trigger — they report the skip in their return payload instead.

`toil.ts` (lines ~325/~649) writes only the `REPLACEMENT` leave type via `ensureReplacementLeaveType`, never
`ANNUAL` — so it can never collide with an encashment freeze. No guard needed there; documented, not coded.
The hire grant (`org.ts:261`) similarly cannot collide: a brand-new hire cannot have a resignation, let alone
an approved one.

### 4. Figure semantics — encashable days

```
computeEncashableDays(raw) = max(0, floor(round2(raw) + 0.5))
```

Inputs are arbitrary `round2`-precision values — hourly leave debits produce fractions like `0.13`
(`db/schema.ts` `leaveRequest.hours` comment), so "0.5-step inputs only" is false; the rounding rule itself
is the request's own half-up-to-whole-day rule (`< 0.5 → 0`, `≥ 0.5 → 1`), applied to whatever the ledger
balance actually is. Negative balances clamp to 0 (Validation Rule ii). This is the AUTO figure; HR's manual
`adjustEncashment` override supports 2-decimal precision (so a half-day like `8.5` is representable),
satisfying the request's "must support 0.5-day increments" line for the override path while the automatic
figure stays whole-day as the request's own worked example shows (`8.4 → 8`, `8.5 → 9`).

**Business decision flagged for confirmation, not decided silently:** the balance is captured **as of the
resignation approval date**, exactly as the request states ("Encashable Leave Days = Remaining approved
Annual Leave balance as of resignation approval date"). This means leave that would have accrued during a
long notice period (approve in March, last working day in June) is **not** included — HR's `unfreeze` +
`adjust` override is the correction path if the intended rule turns out to be "balance as at the last
working day" instead. Tested explicitly (`accrueEarnedLeave` during the notice period is skipped for a
frozen employment; the snapshot does not silently grow).

### 5. Freeze trigger point + auto-reject of pending Annual Leave

Wired into `core/offboarding.ts` `decideResignation`'s `accepted` branch, in the SAME transaction as
`terminateEmploymentTx`, via `freezeOnResignationApprovalTx(tx, ctx, ...)`. If the company's policy is
off/absent, or `autoFreeze` is false, or the tenant has no `ANNUAL` leave type — **silent no-op**: the
resignation approval must never fail because of this feature (failure isolation, below).

Any still-**pending** Annual Leave requests for the employment are auto-rejected (with a system note
referencing the freeze) immediately after the snapshot is taken, so an approver is never left with an
un-actionable item in their inbox once the balance is locked. Rejection writes no ledger row, so this can
safely run after the snapshot without disturbing the frozen figure.

### 6. HR override powers — exactly two, matching the request's "Freeze control" section

- `unfreezeEncashment(ctx, { snapshotId, reason })` — admin-only, reason **mandatory**. Flips
  `status → 'unfrozen'`, which re-opens ledger writes for that employment+type (the trigger's `EXISTS`
  predicate no longer matches). Used e.g. to cancel a leave request that was booked for dates after the
  employee's last working day (see edge case below).
- `adjustEncashment(ctx, { snapshotId, overrideDays, reason })` — admin-only, reason mandatory,
  `overrideDays >= 0`. Sets the override AND flips `status → 'frozen'` again — **adjust re-locks**. There is
  no separate "recalculate" verb: unfreeze + adjust are the two powers the request grants ("HR Admin can
  unfreeze and adjust manually if needed... record audit log for any override action"), nothing more.

Every write in the service (`setEncashmentPolicy`, `freezeOnResignationApprovalTx`, `unfreezeEncashment`,
`adjustEncashment`, plus the auto-rejections) appends a `DomainEvent` in the same transaction
(`appendEvent`, ADR-0006) — this satisfies the request's "audit history of calculation" requirement without
inventing a separate audit table; overrides surface in `/admin/audit` like every other event.

### 7. Failure isolation

`freezeOnResignationApprovalTx` pre-validates (policy on? `autoFreeze` on? `ANNUAL` type exists?) and
no-ops rather than throwing when any precondition is unmet — a resignation approval must never fail because
of this feature. The insert itself uses `onConflictDoNothing` against the unique index as a retry safety
net, and an existing snapshot for the same `resignationRequestId` is returned unchanged (idempotent — see
"once-only" below). Anything past that point that is a genuinely unexpected DB error is allowed to abort the
whole transaction: a **silent partial freeze** (snapshot written but ledger not actually locked, or vice
versa) is worse in an audit-sensitive feature than a hard failure the admin can retry.

### 8. Edge cases handled (validated by the test suite)

- **Pending Annual Leave at freeze time** → auto-rejected with a system note + event (§5); approvals inbox
  is never left jammed with an un-actionable item.
- **Leave already approved for dates past the last working day** (booked before resignation, employee no
  longer coming in) → the frozen snapshot is UNCHANGED at freeze time (the request only asks for the balance
  "as of resignation approval date"); a read helper `approvedLeaveDaysAfter` surfaces a hint on the people
  page ("N approved Annual Leave day(s) fall after the last working day") so HR can act — the correction
  path is unfreeze → cancel the request (the ledger credit now passes the trigger) → adjust (re-locks).
- **Notice-period accrual excluded** — flagged as a business decision (§4), not silently assumed; the four
  sweep functions explicitly skip a frozen employment rather than silently growing the locked balance.
- **Termination typed in directly, bypassing the resignation flow** (`app/people/[employmentId]/actions.ts`
  `terminateEmployment`) → creates no `resignation_request`, so `freezeOnResignationApprovalTx` never runs
  and no snapshot exists. `leaverAdvisory` visibly badges this case `encashmentSource: 'live_balance'` rather
  than silently presenting an unfrozen number as if it were authoritative. Extending the freeze to direct
  terminations is an explicit follow-up decision (not built — the request ties eligibility strictly to an
  APPROVED resignation).
- **Once-only, unless the resignation itself changes** — an accepted resignation cannot be un-accepted
  (`withdrawResignation` only operates on `status = 'pending'`, `core/offboarding.ts`), so there is no
  "resignation changed after freeze" case to handle: the unique key
  `(resignation_request_id, leave_type_id)` is a retry-idempotency guard (a second call to
  `freezeOnResignationApprovalTx` for the same resignation is a no-op returning the existing snapshot), not
  a reversal mechanism.
- **No `ANNUAL` type in the tenant** → resignation approval still succeeds; no snapshot is created
  (documented skip, §5).

### 9. Payroll exposure (the "API" the request asks for)

`core/payroll.ts` `leaverAdvisory()` now calls `encashableDaysForEmployment` per leaver. When a frozen
snapshot exists, its **effective** day-count (`overrideDays ?? encashableDays`) replaces the live
`annualBalance` used in the existing suggested-payout formula
`suggested = round2((basic / 26) * annualBalance)` — the formula itself and the ORP/26 divisor are
untouched; only the day-count input changes source. `LeaverAdvisoryRow` gains
`{ encashmentSource: 'frozen_snapshot' | 'live_balance', frozenAsOf?, overridden? }` so the payroll leavers
panel can badge which source produced the number. This is a visible, intended consequence of the feature
(the frozen/adjusted figure should win over a live balance that could have drifted) — asserted explicitly by
tests, not an accidental side effect.

## Deliberately NOT done (flagged, not silently invented)

RM/salary conversion of any kind, EPF/PCB treatment of the payout, payslip lines, any external/HTTP API
(there is none in this product — see "API design" above), non-Annual leave types, an employee-facing (`/me`)
encashment display (the subject self-read RLS exists so the DB trigger + pre-check can evaluate correctly
under the employee's own session — it is not exposed as a UI), freezing on a directly-typed termination, a
"recalculate from ledger" admin action (superseded by unfreeze+adjust), and any change to the existing
payroll-side `encashmentDivisor`.
