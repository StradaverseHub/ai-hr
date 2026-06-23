# ADR-0041 — Grade-based leave categories (Leave 2.0 · 2E)

Status: Accepted · 2026-06-23 · Sub-ADR of [ADR-0038](0038-leave-2.0.md) §2E

## Context

Entitlement today is `max(EA-floor(code, years), policy.annualDays)`, where the policy is the
most-generous active `leave_policy` for the company + type. There is no way to give different
**grades** (seniority bands — Executive vs Non-Executive, G1…Gn) different leave. The consultant
(#18) wants grade-varying entitlements (e.g. executives get 18 annual days, others the 12-day default),
on top of — never below — the statutory floor.

## Decision

A tenant-level **grade catalog** plus a nullable **grade scope on leave policies**, resolved per
employee. All additive and default-off, so a tenant that defines no grades behaves exactly as today.

- **`job_grade`** (tenant catalog: `code`, `name`, `rank`) — the seniority bands. RLS is tenant-read +
  `app.is_admin()`-write, mirroring `leave_type`. `rank` orders them (1 = most senior) for display.
- **`employment.grade_id`** (nullable FK) — the employee's grade. Null = ungraded.
- **`leave_policy.grade_id`** (nullable FK) — the grade a policy applies to. **Null = applies to all
  grades** (the company default, i.e. today's policy).

### Resolution (the one rule, used by every grant path)

For an employee with grade `G` and leave type `T`, among the active policies for `T`:

1. the most-generous policy with `grade_id = G` (grade-specific), else
2. the most-generous policy with `grade_id IS NULL` (company default), else
3. none → the EA floor alone.

Then, as always, `entitlement = max(EA-floor, resolvedPolicy.annualDays)` — a grade policy below the
floor is still clamped up. This `resolveGradePolicy` helper replaces the inline "most-generous policy"
pick in all three grant paths: the **hire grant** (`core/org.ts`), **`openLeaveYear`**, and
**`accrueEarnedLeave`**. Each now selects `leave_policy.grade_id` and each employee's
`employment.grade_id`, and resolves per employee.

**Backward compatibility is automatic:** with no grades assigned, every employee is ungraded (`G` null)
and every existing policy is null-grade, so resolution falls straight to rule 2 — the most-generous
null-grade policy — which is exactly the pre-2E behavior. Existing tests are untouched.

## Admin surface

- `/admin/leave` gains a **Grades** card (create / rename / archive job grades).
- The leave-policy editor (create + edit, in `leave-type-panel`) gains a **grade** selector ("All
  grades" = null, or a specific grade) and shows the grade on each policy row.
- The employee detail page gains a **grade** selector (mirrors the 2C work-state field).

## Consequences

- Grade policies layer cleanly on the existing effective-dated `leave_policy` table — no new policy
  engine, and the floor invariant (ADR-0038 §5) is preserved by the unchanged `max(floor, …)` clamp.
- Grades are a tenant catalog, so the same band is reusable across companies; a future payroll-grade or
  approval-by-grade feature can reuse `job_grade` rather than inventing its own.
- Out of scope: grade-driven *approval chains* and grade as a payroll input — separable, and not asked
  for in #18.
