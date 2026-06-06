# ADR-0009: Multi-company group model (nested entities, scoped authz, consolidation)

- **Status:** Accepted — *design agreed 2026-06-06; implemented in slices A–D (pending)*
- **Date:** 2026-06-06
- **Deciders:** Founder (solo) + Claude (acting architect)
- **Supersedes part of:** [ADR-0002](0002-multitenancy-rls.md) (company-within-tenant), [ADR-0004](0004-authorization.md) (role scope)

## Context

[ADR-0002](0002-multitenancy-rls.md) established `tenant` (a customer of the SaaS) and
`company` (a legal entity within a tenant). We built `company` as a **flat list**: most
operational data is company-stamped (`departments`, `positions`, `cost_center`, `employment`,
`attendance_policy`, `payroll_batch`), and `role_assignment` carries a `company_id`
("null = group-wide, set = one company").

Reality check (founder, 2026-06-06): target customers are **genuine groups**, they **need
consolidation**, shared-services people are paid **both** "home company recharges" *and* "each
company pays its slice", and structures are **nested** (sub-subsidiaries). The flat model
undersells this, and worse — two real defects surfaced:

1. **🔴 Company-scoped authorization is unenforced.** The session only carries role *names*
   (`app.current_roles()` → `text[]`); `is_admin()` checks the name only. `role_assignment.company_id`
   is dropped on the way into the session, so "hr_admin for Company A" silently grants admin
   over **every** company in the tenant. The scoping column is decorative.
2. **No relationship between companies** — no parent/subsidiary, no group root, no consolidation.
3. **No per-company statutory identity** — each MY entity files under its own KWSP/PERKESO/LHDN
   registration numbers; none are modelled.

## Decision

### 1. Company hierarchy (self-referential tree)
- Add `company.parent_company_id` (nullable self-FK). `parent_company_id IS NULL` = a **group
  root**. A tenant may hold ≥1 tree (usually one). **Arbitrary depth** (nested sub-subsidiaries).
- **Cycle-guarded on write** (same discipline as the reporting DAG, [ADR-0003](0003-organizational-model.md)):
  a company may not be its own ancestor.
- Subtree / ancestry resolved by **recursive-CTE SQL helpers** in the `app` schema:
  `app.company_subtree(root uuid)` (company + all descendants), `app.is_company_descendant(child, ancestor)`.
  A materialized closure table is a **deferred optimization** — recursive CTEs are ample at
  SME-group scale (tens of entities).

### 2. Company-scoped authorization with subtree semantics (fixes defect #1)
- A **grant** = `(role, company_id | null)`. `null` = group-wide (whole tenant). A `company_id`
  scopes the role to **that company *and its descendants*** (so "hr_admin at IntermediateCo"
  covers IntermediateCo + everything under it).
- The session carries **grants**, not flat names: a new GUC `app.grants` holds JSON
  `[{role, companyId}]`. New helpers:
  - `app.has_role_for(role text, company uuid)` — a matching grant that is group-wide, on
    `company`, or on an **ancestor** of `company`.
  - `app.is_admin_for(company uuid)` — `has_role_for('hr_admin'|'super_admin', company)`.
  - `app.is_admin()` is retained only as "admin somewhere" for coarse checks.
- **RLS rewrite:** `WITH CHECK` on structural/payroll writes gates on the **row's** company
  (`app.is_admin_for(NEW.company_id)`); `can_see_employment`'s admin branch becomes
  `app.is_admin_for(employment.company_id)`.
- The **bootstrap** ([ADR-0004] seam) returns grants: `app.principal()` / `app.dev_principals()`
  emit `(role, company_id)` pairs; `getSession()` sets `app.grants`. The WorkOS path is identical.

### 3. Per-company statutory identity
- `company` gains employer-registration fields, surfaced by the country pack
  ([ADR-0008](0008-localization-packs.md)): KWSP employer no., PERKESO employer code, LHDN
  **E**-number, MyInvois TIN, SSM registration no. Payroll and e-invoicing file **per company**
  under its own numbers.

### 4. Concurrent multi-company employment
- A **Person** may hold multiple active **Employments** across companies in the group — already
  structural in [ADR-0003](0003-organizational-model.md) (Person ≠ Employment). One login
  (`app_user.person_id`) sees all of their employments; `/me` and reads handle the set.
- **⚠️ Cross-employer Malaysian PCB is a flagged hard problem.** One Person = one IC = one EPF
  account, but multiple employers each run MTD on the income *they* pay. Correct annual tax needs
  per-person reconciliation or a **primary-employer** designation. We do **not** auto-solve this;
  each employment computes its own MTD and the gap is documented (per STATUTORY-SOURCES.md).

### 5. Consolidation (group vs per-company)
- Reads + UI gain a **scope**: a single company, or a company **subtree** (group/consolidated).
  Aggregations (headcount, cost, payroll, leave) compute over the subtree the principal can see.
  A scope/company switcher drives the dashboard and reports.

### 6. Inter-company cost allocation ("both ways")
- **(b) Each company pays its slice** → native: separate employments, each in its own company's
  payroll. Supported by #4 with no extra model.
- **(a) Home company pays + recharges** → a `cost_allocation` extension (JSONB on employment:
  `[{companyId, pct|amount}]`) feeding **consolidation/management reporting**, not cash payroll.
  Recharge/finance mechanics are a **later slice**; the data model reserves for it now.

## Consequences

**Positive**
- Closes the unenforced-scope authorization defect (a real security bug).
- Genuine nested-group support with consolidation, matching the stated customer reality.
- Reuses existing bones: Person/Employment split, the bootstrap seam, the event substrate, the
  country-pack delegation — additive, not a rewrite.

**Negative / risks**
- Authz gets more complex (grants vs names, subtree ancestry). Mitigation: fully encapsulated in
  `app.*` SQL functions; the app calls `getSession()` unchanged.
- The RLS rewrite touches many policies → **regression risk**. Mitigation: heavy isolation tests
  (admin-for-subtree, denied cross-company, manager-in-company) before merge.
- Recursive CTEs on every visibility check have a cost; acceptable at SME-group scale, revisit
  with a closure table if trees grow large.
- Cross-employer PCB remains a documented compliance gap, not solved.

## Scoring (proposed design)

| Dimension | Score | Note |
|---|---|---|
| Scalability | 8 | CTE fine for SME groups; closure table if needed |
| Maintainability | 7 | authz complexity, but encapsulated |
| Security | 8 | closes the scope bug; correctness hinges on ancestry tests |
| Auditability | 8 | events gain company context |
| Data integrity | 8 | tree cycle guard + FK |
| Regulatory compliance | 7 | per-company identity ✓; cross-employer PCB flagged |
| Enterprise readiness | 8 | the lift from ~4 → 8 on multi-company |

## Implementation slices

- **Slice A — Hierarchy + statutory identity:** `parent_company_id` + cycle guard + subtree/ancestor
  helpers + per-company statutory fields + admin UI to build/view the tree. *(No authz change — safe.)*
- **Slice B — Company-scoped authorization:** grants in the session, `has_role_for`/`is_admin_for`
  with subtree semantics, RLS rewrite, principal bootstrap returns grants, dev switcher shows scope.
  *(Fixes the bug; heaviest testing.)*
- **Slice C — Consolidation views:** scope switcher (company ↔ group), subtree aggregations on the
  dashboard + reads.
- **Slice D — Concurrent employment + cost allocation foundation:** `/me` multi-employment,
  `cost_allocation` extension point, flagged cross-employer PCB handling.

## Alternatives rejected

- **Keep companies flat.** Rejected: customers are genuine nested groups; retrofitting a tree after
  payroll/statutory data references companies is a painful migration.
- **Company = its own tenant.** Rejected: breaks consolidation, shared-services people, and the
  single login; tenants are the isolation boundary for *customers*, not legal entities.
- **Duplicate a Person per company for multi-employment.** Rejected: breaks single identity (one
  IC, one EPF account) and the audit trail. Person/Employment split already solves it.
- **Materialized closure table now.** Deferred: premature optimization at SME-group scale.
