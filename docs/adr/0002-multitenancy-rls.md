# ADR-0002: Multi-tenancy via `tenant_id` + Row-Level Security

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** Founder (solo) + Claude (acting architect)

## Context

`ai-hr` is a commercial SaaS product but is being built solo with no paying tenants yet.
Tenant *isolation* is a security-critical, partly-unretrofittable concern; tenant
*lifecycle* (provisioning, billing, region routing) is not, and is premature to build.

A tenant maps to a **WorkOS Organization** ([ADR-0005](0005-tech-stack.md)). We keep a
local `tenant` row keyed by the WorkOS org id rather than trusting the IdP as our system
of record.

## Decision

1. **Every table carries a non-null `tenant_id`** from the first migration.
2. **Isolation is enforced in the database** with PostgreSQL **Row-Level Security**, not
   in application code. Each request opens a transaction that sets
   `SET LOCAL app.tenant_id = '<uuid>'` (and `app.user_id`, `app.roles`) from the
   *authenticated session* — never from client input. RLS policies require
   `tenant_id = current_setting('app.tenant_id')::uuid`. Default-deny.
3. The application connects as a **non-superuser, non-`BYPASSRLS`** role so a missing or
   wrong policy fails closed, not open.
4. **Defer** tenant provisioning UI, billing, per-tenant config, and data-residency /
   region routing. Region routing is noted as a future unretrofittable concern and is
   accommodated by the identity split in [ADR-0003](0003-organizational-model.md), but is
   out of scope for Slice 0 (MY-only).

## Tenant vs. Company — different layers (clarification)

`tenant` and `company` are easily confused but sit at **two different levels**, and the
distinction is load-bearing:

- **Tenant** = the *customer account*. It is the **isolation wall** (this ADR). One tenant
  per customer organization.
- **Company** = a *legal entity* in the org model ([ADR-0003](0003-organizational-model.md)).
  It is *structure*, not a security boundary.

**A single customer routinely owns several companies** — a corporate group with
subsidiaries, possibly across countries. That is the normal case, and it is precisely why
Tenant and Company are modeled separately: **one tenant contains many companies.**

```
TENANT: Bumi Holdings                      ← the customer (hard wall around all of this)
 ├─ COMPANY: Bumi Construction Sdn Bhd      (MY)
 ├─ COMPANY: Bumi Digital Sdn Bhd           (MY)
 └─ COMPANY: Bumi Ventures Pte Ltd          (SG)
```

The governing rule:

> **Cross-tenant access is impossible — ever, for anyone.**
> **Cross-company access *within* a tenant is possible — if explicitly granted.**

Because the group's companies live inside one tenant, employees can be **shared across
companies**, reporting lines can **cross companies**, and headcount can **roll up** for
the whole group — all requirements that a naïve "one company = one tenant" shortcut would
break (it would re-erect the hard wall *between* the customer's own subsidiaries).

**Enforcement of each boundary differs:**

- **Tenant wall** → RLS (this ADR). Absolute, automatic, non-negotiable.
- **Company visibility within a tenant** → authorization
  ([ADR-0004](0004-authorization.md)), via the optional `company_id` on `role_assignment`:
  blank = whole group, set = that one company.

**Deferred edge cases this raises** (named so they aren't forgotten): multi-country data
*residency* for a cross-border group, and *tenant merges* when one customer acquires
another that is already on the platform (M&A).

## Consequences

- (+) A forgotten `WHERE tenant_id = ?` in app code cannot leak cross-tenant data — the
  database refuses it. This is the single highest-leverage security control in the system.
- (+) The SaaS path stays open at near-zero present cost.
- (−) All DB access must go through the session-setting transaction wrapper; ad-hoc
  queries that skip it see nothing. This is a feature, but it is a discipline.
- (−) Connection pooling must be transaction-scoped (so `SET LOCAL` doesn't leak across
  requests). Noted for the pooler config.

## Alternatives considered

- **Schema-per-tenant / database-per-tenant.** Stronger isolation but heavy operational
  cost (migrations × N, pooling, noisy-neighbor management) — wrong for a solo build with
  zero tenants. Revisit only for an enterprise tenant that contractually requires it.
- **App-layer tenant filtering only.** Rejected: one missed filter is a breach; not
  acceptable for PII at SaaS scale.
