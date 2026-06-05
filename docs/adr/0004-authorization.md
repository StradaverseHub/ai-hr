# ADR-0004: Authorization — RBAC + ABAC enforced in the database

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** Founder (solo) + Claude (acting architect)

## Context

HR access rules are relationship-dependent, not just role-dependent. "A manager may see
their direct reports' leave, but not their salary, and may not see anyone else" is not
expressible with roles alone — it depends on the *manager-of* relationship and the
*sensitivity of the field*. Authorization is the highest-risk surface in an HRMS handling
PII for many tenants.

## Decision

Combine **RBAC** (coarse capabilities) with **ABAC** (row/field scoping by relationship),
and enforce the row-level part **in PostgreSQL via RLS** ([ADR-0002](0002-multitenancy-rls.md))
so it cannot be bypassed by an application bug.

- **Roles (RBAC):** `employee`, `manager`, `hr_admin`, `super_admin`. Roles grant
  capabilities (e.g. `leave.approve`, `employee.read`). Roles are assigned per tenant, and
  may be scoped to a Company (`role_assignment` carries an optional `company_id`).
- **Attributes (ABAC):** visibility predicates evaluated in RLS policies using the session
  context (`app.user_id`, `app.roles`, `app.tenant_id`) and graph relationships, e.g.:
  - an `employee` sees only their own Person/Employment rows;
  - a `manager` additionally sees Employments where an `administrative` `reporting_line`
    edge links them as manager (as-of today);
  - an `hr_admin` sees all Employments **within companies they are scoped to**;
  - sensitive fields (future: compensation) are gated by capability, not just row access.
- **Default-deny.** No policy ⇒ no access. New tables are inaccessible until a policy is
  written — a deliberate forcing function.
- WorkOS provides authentication and group/role *source data* (via Organizations and,
  later, SCIM directory sync); the **authorization decision is ours**, in the database.

## Consequences

- (+) A broken API handler cannot over-share rows; the database is the backstop.
- (+) Authorization logic lives in one place (policies + a small policy module), not
  scattered across controllers.
- (−) RLS policies are harder to write and test than `if (user.role === …)`. We mitigate
  with a dedicated integration-test suite asserting both *allow* and *deny* paths
  ([slice-0 spec](../architecture/slice-0-spec.md)).
- (−) Some cross-cutting reads (admin dashboards) need carefully-scoped views.

## Alternatives considered

- **App-layer authorization only (e.g. CASL).** Good DX, but a single missed check is a
  PII breach. Acceptable as a *second* layer for UX (hiding buttons), not as the only one.
- **External policy engine (OPA / Cedar).** Powerful, but adds a moving part and a network
  hop per decision; premature for solo + Slice 0. The role/attribute model is designed so
  we *could* lift policies into Cedar later without reshaping the data.
