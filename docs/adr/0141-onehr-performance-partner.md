# ADR-0141 — OneHR performance partner: performance administration without compensation

- **Date:** 2026-10-25
- **Status:** Direction accepted by the owner (25 Oct 2026). Implementation on a migration branch; not released (ADR-0140 M12).
- **Refines:** ADR-0049 §3 (for OneHR-native cycles only) and ADR-0140 M04.
- **Related:** ADR-0004, 0009, 0103, 0115, 0135.

## Context

The native OneHR administration predicate `app.assessment_admin_for` (0540) admits `hr_admin`, `super_admin` and `performance_comp_partner`. All three can read compensation:
- the first two as HR;
- the partner by design (ADR-0049 §3, through `can_admin_perfcomp_*` in `compensation_rls`, `employment_rls` and `person_rls`).

OneHR's own access model (24 Oct 2026) lets business-group and business-unit staff administer appraisal without seeing pay. The migration decisions (ADR-0140, ID-D-05) require the same here.

ADR-0049 §3 rejected a performance-only partner because the **generic** schema keeps ratings and merit/bonus on the same `performance_review` row and RLS is row-level. OneHR-native cycles are different:
- assessment state lives in `performance_onehr_*` and `performance_assessment_*` satellites (0529, 0540);
- money is decided only in Rewards, which reads frozen results under its own authority (ADR-0103);
- no OneHR service reads merit, bonus or `merit_budget`.

ADR-0135's configurable capabilities are the intended long-term home, but they are dormant in production until their bindings and upgrades are proven. Waiting would leave salary exposure in place.

## Decision

1. **A new company-scoped role, `performance_partner`.**
   - It is an enum value assigned through the existing `role_assignment` owner: `company_id` null means group-wide, otherwise company and descendants.
   - It administers **OneHR-native cycles only**.
   - It confers no HR, payroll, compensation, Rewards or generic-cycle authority.
   - It is mapped into ADR-0135's catalogue when that ships.

2. **One admission change.** `app.assessment_admin_for` adds `performance_partner`.
   - `onehr_admin`, `onehr_cycle_admin`, calibration access and every OneHR satellite policy follow from it.
   - In TypeScript, a grant-scoped `canAdminOnehrCtx` (resolved against `ctx.grants`, never `ctx.roles`, as ADR-0049 §4 requires) gates OneHR administration pages and services.
   - The generic performance/compensation gates (`requirePerfCompAccess`, `canAdminPerfCtx`, `isAdminOrPerfCompCtx`, `PERFCOMP_ROLES`) are **unchanged**, so the role cannot reach generic cycles, merit actions or compensation.

3. **Kernel data, least privilege.**
   - `employment` and `assignment` gain **SELECT-only** permissive policies for OneHR administration scope. No write policy changes.
   - `person` RLS is **not** widened, because a person row carries date of birth, address, gender and marital status. OneHR administration services read names and employee codes through one SECURITY DEFINER projection, `app.onehr_person_labels`. It returns only label columns for employments in companies the caller administers for OneHR, and all actors use it, so HR administrators see the same labels as before.
   - `performance_review` gains a **SELECT-only** policy for rows of OneHR-native cycles in scope.
   - `review_cycle` gains an UPDATE policy limited to OneHR-native cycles in scope, solely so existing row locks (`FOR UPDATE`) succeed.
   - A BEFORE UPDATE trigger refuses any actual change to `review_cycle` when the actor's only qualifying authority is `performance_partner`. Row locks do not fire it.

4. **Excluded in this version** (these remain with HR administrators):
   - creating, opening, closing or archiving a cycle;
   - participant additions that create kernel reviews;
   - leadership-framework edits (`is_group_admin`);
   - assessment AI settings and the reminder epoch (`is_admin`);
   - every write to `review_cycle`, `performance_review`, `employment`, `assignment` or `person`.

5. **Plumbing and migrations.**
   - The role is assignable and labelled in all six locales.
   - Role allow-lists in existing SQL owners (0312, 0526, 0579) are redefined to include it.
   - Two migrations: the enum value first, then functions, policies and trigger, with explicit GRANT/REVOKE.
   - Migration numbers are allocated centrally at merge time.

## Verification contract

Tests must show each of the following.

**Positive:**
- A company-scoped partner administers a OneHR-native cycle in its company: overview, participants (view and override), panels, catalogue, calibration roster, final bands, rating records, reports and reminders preview.

**Negative:**
- Zero compensation rows readable and no compensation write.
- No access to a generic (non-OneHR) cycle, its merit actions or `pendingComp`.
- No payroll, Rewards or reward source.
- A direct `person` select returns no sensitive columns beyond existing self/relationship visibility.
- No access to another company.
- No `review_cycle` or `performance_review` write (the trigger and policies refuse).
- Cycle create, open and close refused.
- A revoked role stops at the next request.

**Equivalence:**
- HR administrators see the same OneHR labels through the projection as before.

**Gate:** the full gate is required (database and security roots).

## Consequences

- OneHR performance administration no longer requires pay visibility.
- The enum value is irreversible once released, which is accepted with this decision.
- `performance_comp_partner` keeps its ADR-0049 meaning for generic cycles.
- When ADR-0135 ships, the role becomes a binding there rather than a parallel model.
