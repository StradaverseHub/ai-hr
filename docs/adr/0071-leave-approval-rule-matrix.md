# ADR-0071: Leave-Approval Rule Matrix

Status: Accepted
Date: 2026-07-04
Supersedes routing key of: ADR-0039 (configurable leave approval chain) — extends, does not replace
Reuses unchanged: ADR-0052 (approver delegation via `reporting_line` lineType='delegate')

## Context

ADR-0039 (Wave 2 · 2B-2) shipped a configurable N-level approval chain keyed by
`(company_id, leave_type_id)`: one default chain per company plus optional per-leave-type overrides,
resolved at request submission in `core/leave.ts → generateApprovalSteps → resolveApprovalChain`. HR asked
to target chains more finely — e.g. Finance Executives get "Manager → HR" while Finance Managers-and-above
get "Head of Finance → HR Director" — which the single-chain-per-company model cannot express.

## Decision

Extend the existing `leave_approval_policy` engine into a **scoped rule matrix**. Each row is a RULE.

### (a) Routing key

The routing key grows from `(company_id, leave_type_id)` to
`(company_id, leave_type_id, business_unit_id, department_id, position_id, grade_id, employment_type,
min_days, max_days)`. Every scoping dimension except `company_id` is **nullable / wildcard** (null =
"matches any").

### (b) Resolution — most-specific matching rule wins

`resolveApprovalChain(companyId, leaveTypeId, attrs)` selects all `active` rules for the company, filters to
those whose non-null dimensions all match the request, scores each by the **count of non-null matched
dimensions** (specificity), and picks the highest score. No match falls through to the company default (the
fully-wildcard rule), then to the built-in `[direct_manager, hr_admin]` fallback — preserving ADR-0039's
guarantee that an opted-in company with no matching rule still gets a chain.

### (c) Deterministic tie-break (HR-facing policy, not an implementation footnote)

When two matching rules score identically, resolution must not pick an arbitrary winner:

1. **Narrower day-range wins.** Width = `(max_days ?? +∞) − (min_days ?? −∞)`; a fully-unbounded rule is
   widest and loses to any bounded competitor.
2. **If still tied, most-recently-CREATED wins** (`created_at`, never `updated_at` — an unrelated edit to a
   different field of another rule must never change which rule wins a resolution).

This is a deliberate policy decision surfaced to HR, not silent behaviour.

### (d) Null-grade semantics (easy to get backwards — stated explicitly)

A **null on the EMPLOYEE side is a non-match, not a wildcard.** An employee with no job grade set does NOT
match a grade-scoped rule. (Only a null on the RULE side is a wildcard.) The same rule applies to every
dimension: a request whose department has no business unit simply fails to match a BU-scoped rule.

### (e) Grade vs assignment asymmetry (stated explicitly)

`grade_id` lives on the `employment` record (not effective-dated), while `department_id`, `position_id`,
`employment_type` and `business_unit_id` (via department) come from the **current assignment**
(effective-dated via close+insert). So a grade promotion takes effect immediately with no historical trail,
while a department/position transfer is versioned. Resolution reads the grade off `employment` and the rest
off the current assignment — named here so a grade change and a transfer are not confused as behaving alike.

### (f) Single-employment scope

Resolution is scoped to the requesting `employmentId`'s **own current assignment only** — never a
concurrent employment the same person holds at a different company. Enforced by joining the current
assignment on `employment.id = <this employmentId>`. Covered by an explicit multi-employment isolation test.

### (g) Snapshot immutability

Generated approval steps are snapshotted at request-submission time and **never re-resolved.** Editing or
archiving a rule cannot change the routing of a request already pending — even though the matrix now allows
many more rules per company (more chances for an admin to edit one mid-flight). Regression-tested.

### (h) Hourly / partial-day leave

Day-range matching uses the request's **fractional day-equivalent** — for an hourly request that is
`round(hours / 8, 2)`, the same `days` value already computed by `core/leave.ts`. Hourly requests therefore
participate in day-range matching rather than bypassing it; a 4-hour request counts as 0.5 days for a
`min_days`/`max_days` rule. (Full-day and half-day requests pass their `days` value through unchanged.)

### (i) Approver vocabulary — unchanged

`LEVEL_KINDS` stays `['direct_manager', 'hr_admin']` in this cut. The 9 approver types the request lists
(Matrix Manager, Business Unit Head, HOD as a decider, HR Officer/Manager/Director sub-ranks, C-Level,
Custom Position) require **new authorization primitives**, not just new labels, and are explicitly OUT of
this build:

- **HOD as a decision-capable approver** is a POLICY REVERSAL of ADR-0052 (which keeps "see the department
  head, but they do not decide leave for it"). BLOCKED pending explicit HR sign-off before any code.
- **business_unit_head / matrix_manager / hr_officer / hr_manager / hr_director / c_level** need
  head-of-BU data and a ranked HR/exec hierarchy that do not exist today. BLOCKED pending separate scoping.
- **custom_position**, when built, MUST include a same-company guard (position is company-scoped) verifying
  the decider's employment, the position, and the leave subject are all in the same company — otherwise a
  sibling-company holder of a same-titled position could satisfy the rule, reopening the tenant/company-leak
  class of bug ADR-0009/ADR-0052-D2 hardened against. Named here as a required guard for whenever it is built.

### (j) Delegation — reused unchanged

Approver delegation (ADR-0052, `reporting_line` lineType='delegate', wired into `assertCanDecide` /
`app.can_decide_via_delegation`) is untouched. The matrix only changes which `direct_manager`/`hr_admin`
steps get generated; who may DECIDE a step (including via delegation) is unchanged.

## Also flagged (not silently decided)

- **Grade matching is EXACT** ("Executive" or "Manager"), not tiered ("Manager and above") as the request's
  worked example implies. Tiered/threshold grade matching is a larger schema change and is out of this build.
- **Duplicate-rule guard.** The `CHECK (min_days <= max_days)` constraint does not catch two
  functionally-identical rules. The service rejects a create/update whose full scoping tuple duplicates
  another active rule for the company. The DB additionally keeps a partial-unique index forbidding two
  fully-wildcard rows per `(company, leave-type)` bucket.

## Schema

Migration `0145_leave_approval_rule_matrix.sql` adds to `leave_approval_policy`: `rule_name`,
`business_unit_id`, `department_id`, `position_id`, `grade_id`, `employment_type`, `min_days`, `max_days`,
`active` (default true), the `min<=max` CHECK, and replaces the two old partial-unique indexes with a single
fully-wildcard-per-`(company, leave-type)` guard. RLS is UNCHANGED (tenant-wide read, admin-for-company
write) — mirrors the 0086/0136 precedent exactly.

## Consequences

- HR can build many targeted rules per company; resolution stays deterministic under overlap.
- A currently-live test-isolation gap is fixed alongside: `leave_approval_policy` and `business_unit` were
  missing from `test/harness.ts → ALL_TABLES`, so `resetDb()` never truncated them between test files. Added.
- The remaining 5+ approver types and the HOD policy widening are a fast-follow gated on org-chart data and
  explicit HR sign-off, per (i).
