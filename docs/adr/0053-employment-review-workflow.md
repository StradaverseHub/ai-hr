# ADR-0053 — Automated Probation / Contract / Internship Review Workflow

Status: Accepted
Date: 2026-06-27
Migration: 0110

## Context

Builds on the Hiring Enhancement (0107, `employment.provisional_end_on`). Managers and HR need a
structured, automated way to review an employee approaching the end of a provisional period
(full-time probation, fixed-term contract, internship) and record a confirm / extend / terminate
outcome, with the direct manager and HR notified ahead of the due date.

## Decision

A two-stage workflow on a new `employment_review` aggregate (RLS modelled verbatim on
`resignation_request`):

1. **Manager evaluation** (`pending_manager` → `pending_hr`) — the assigned direct manager records a
   recommendation + comments.
2. **HR decision** (`pending_hr` → `completed`) — admin-only, never self (super_admin escape), records
   confirm / extend / terminate.

The trigger window is computed at runtime from the employee's **current open assignment**
`employment_type` (full_time→`probation_end_date`, contract→`contract_end_date`,
intern→`internship_end_date`; part_time → no review). A daily cron (`scripts/review-sweep.ts`, gate
`review:sweep`) opens reviews where `due_date <= today` and dispatches manager + HR notifications.

### Recorded decisions / flags

- **(a) Trigger offset = 1 month.** The feature title says "3 weeks"; the explicit spec rule is
  `IF current_date = end_date − 1 month`. We implement `due_date = end_date − 1 month` (single constant
  `REVIEW_LEAD`). The 3-week wording is a known mismatch, resolved in favour of the explicit IF rule.
- **(b) All decisions are advisory.** confirm / extend / terminate record a decision + a domain event +
  a deep-link; none mutate employment state. confirm does NOT flip the assignment to active; extend
  stores `extend_to_date` on the review row ONLY and does NOT write back to `*_end_date` or re-trigger;
  terminate deep-links to the existing offboarding flow rather than auto-terminating. This removes the
  sweep/idempotency self-contradiction in the original plan.
- **(c) Notification fan-out via the reporting graph.** First use of the `notifications.recipients`
  extension point for reporting-graph fan-out: `employment-review.started` notifies the resolved direct
  manager + all HR admins in the company (`hrAdminsForCompany`). The manager recommendation is kept OUT
  of the subject-visible event payload (subject-scoping makes the event visible to the subject); it
  lives on the row behind manager/admin RLS.
- **(d) Only-HR-admin-on-probation escape.** `decideReview` is admin-only-never-self. If the only HR
  admin is themselves under review, a `super_admin` is the escape hatch. Documented limitation.
- **(e) PDF letter is Latin-only.** `lib/review-letter-pdf.ts` reuses the documented `safe()` filter
  from `lib/ea-pdf.ts` (Helvetica/WinAnsi). Non-Latin names degrade to `?`. Embedding a Unicode font is
  the deferred ADR-0036 follow-up.

### Day-one inertness

Because no Hiring form yet owns the three end-date columns and nulls never trigger, the feature is inert
for the existing workforce until end-dates are set. The `setReviewEndDate` admin control on the profile
(`§1.8`) is the minimal stopgap; if a future Hiring PR owns the columns, §1.1 + the set-date control
collapse to "consume existing columns".

### Deadlocks

- No manager → the review still opens; HR advances stage 1 via the admin fallback; notifications route to
  HR only.
- Manager == subject (org head on probation) → same admin fallback.

## Consequences

- Reviews participate in the domain-event substrate (`employment-review.started` /
  `.manager-evaluated` / `.decided` / `.end-date-set`), so they are visible to audit and the bell badge
  (`pendingApprovalsCount` now counts a direct manager's review queue even without the `manager`
  platform role).
- `employment_review` is in the test harness `ALL_TABLES` truncation list to prevent the partial-unique
  index throwing spuriously across tests.
