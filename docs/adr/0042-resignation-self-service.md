# ADR-0042 — Submit Resignation self-service (#29)

Status: Accepted · 2026-06-23 · Consultant feedback #29 (High)

## Context

#29: *"The system should provide a dedicated 'Submit Resignation' function within the My Workspace tab."*
Today an admin can terminate an employee (`terminateEmployment`, Wave 4A, with a turnover classification),
and `leaverAdvisory` produces the final-pay guidance — but there is no **employee-initiated** path. A
resignation is a request the employee raises and HR accepts; it should not be a silent self-write that
ends employment.

## Decision

A `resignation_request` on the same request → approve rails as leave / profile-change / claims, that on
acceptance triggers the existing termination service.

- **`resignation_request`** (`employment_id`, `person_id`, `last_working_day`, `reason`, `status`
  pending|accepted|rejected|withdrawn, `decided_by_employment_id`, `decided_at`). RLS mirrors
  `profile_change_request`: `app.can_see_employment(employment_id)` for read+write — so an employee acts
  on their own and an admin/manager sees their scope; the *decide* authorization is enforced in the
  service (admin-only, never self), exactly like `decideProfileChange`.
- **Services (`core/offboarding.ts`):**
  - `submitResignation(ctx, { employmentId, lastWorkingDay, reason })` — the employee raises it; one
    open request at a time (re-submitting while pending is rejected). `last_working_day` must be today
    or later.
  - `withdrawResignation(ctx, { requestId })` — the employee cancels their own *pending* request.
  - `decideResignation(ctx, { requestId, decision, deciderEmploymentId })` — admin-only (`assertCanDecide`
    bans self + a role check). **On `accepted`** it calls `terminateEmployment` with
    `terminationType: 'voluntary'`, `terminationDate = last_working_day`, and the reason — so the single
    source of truth for ending employment stays `terminateEmployment` (and `leaverAdvisory` / final pay
    flow on unchanged). `rejected` just closes the request.
  - `listResignationRequests` (admin inbox, RLS-scoped) + `myResignation` (the employee's own status).
- Every state change appends a `DomainEvent` (`resignation.submitted` / `.withdrawn` / `.accepted` /
  `.rejected`), actor threaded through. The termination itself still emits its own event.

`'resignation'` is **not** a new `termination_type` — a resignation is a `'voluntary'` termination, which
already exists; the resignation_request is the workflow wrapper, the termination is the outcome.

## UI

- `/me` gains a **Submit Resignation** card: last-working-day + reason, the current pending request's
  status, and a withdraw button.
- `/approvals` lists pending resignations with accept / reject (the shared `DecideButtons`, self-disabled);
  `pendingApprovalsCount` includes them so the bell + inbox badge are correct.

## Consequences

- Offboarding becomes a closed loop: employee submits → HR accepts → `terminateEmployment` (voluntary) →
  the existing leaver advisory + final-pay guidance. No new termination path, no duplicate "end
  employment" logic.
- Out of scope (later): exit-interview checklist, asset-return / clearance, notice-period auto-calc from
  contract terms, and notifying the manager by email (needs ADR-0034 channels).
