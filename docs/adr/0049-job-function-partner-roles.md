# ADR-0049 — Job-function partner roles

Status: Accepted
Date: 2026-06-26
References: ADR-0004 (capability layer was aspirational), ADR-0009 (company-scoped authz),
migrations 0016 (company-scoped helpers/policies), 0023 (sub-delegation), 0060 (compensation
read tighten), 0099 (this slice).

## Context

`role` is a Postgres enum (`employee, manager, hr_admin, super_admin`) woven through the RLS
helpers in 0016 (`is_admin`, `is_admin_for`, `has_role_for`, `can_admin_employment`,
`can_see_employment`) and resolved company-scoped via session `app.grants` (ADR-0009). A solo HR
person uses `hr_admin`. Larger customers want to delegate a *function* (payroll, or
performance+comp) to a specialist without granting full HR admin.

## Decision

1. **Additive specialist roles beside `hr_admin`.** We do NOT reduce or rename the existing four
   roles (that would be a breaking, separate ADR). We add two enum values:
   `payroll_partner` and `performance_comp_partner`. A solo HR person keeps using `hr_admin`.

2. **Two partners this slice. Recruiting Partner is deferred to the ATS PR.** No ATS/candidate/
   pipeline/offer table, service, or page exists. An inert Postgres enum value is irreversible
   (`DROP VALUE` is unsupported) and its real permission needs are unknown until an ATS exists, so
   it ships in the same PR as the ATS module.

3. **Compensation + Performance are MERGED into one `performance_comp_partner` for v1.** A
   per-column split (Comp owns merit→pay, Performance owns lifecycle) is undeliverable on the
   current schema: `performance_review` rows hold *both* the rating and the merit/bonus
   recommendation, RLS grants row-not-column access, and the app connects as a single DB role
   (`ai_hr_app`) so per-column `GRANT` cannot distinguish two partners. Two overlapping partner
   roles would be security theater. One partner owns the whole performance+comp surface cleanly. A
   future two-specialist split is a separate ADR with a schema change.

4. **Gating is widened in the DB helpers/policies (the authoritative backstop) AND mirrored in the
   service/UI layer against `s.grants` (a UX gate).** The DB is authoritative for subtree-descendant
   scope; the service guard resolves against `s.grants` (which carries `companyId`), never the
   flattened `s.roles` (which drops it). Gating a company-scoped decision on `s.roles` would grant
   cross-company access — the single highest-risk item, addressed by `hasGrantFor` /
   `canManagePayroll` / `canManagePerfComp` in `lib/authz.ts` and `canAdminPerfCtx` in
   `core/performance.ts`.

5. **Partners are company-scopable exactly like `hr_admin`.** `SCOPABLE_ROLES =
   {hr_admin, payroll_partner, performance_comp_partner}` in `assignRole` persists a non-null
   `companyId`; every other role is normalized to null.

6. **Sub-delegation policy 0023 is TIGHTENED, not widened.** Because partner grants now persist a
   non-null `companyId`, 0023's delegated branch (`role <> super_admin AND company_id NOT NULL AND
   is_admin_for`) would otherwise let any delegated company-admin mint partners in their subtree.
   Decision (default, documented): **only group admins grant partners.** The delegated branch is
   restricted to `role = 'hr_admin'` — exactly the pre-existing invariant (a delegated admin keeps
   minting only subtree `hr_admin`). The group-admin branch continues to grant any role.

## Capability surface (migration 0099)

New helpers, each mirroring the volatility / `SECURITY` / `search_path` flags of the helper it
extends (per 0016's warning that row-visibility under RLS recursion is sensitive to these flags):

- `app.can_admin_payroll_for(company)` := `is_admin_for(company) OR has_role_for('payroll_partner', company)` — plain `STABLE`.
- `app.can_admin_perfcomp_for(company)` := `is_admin_for(company) OR has_role_for('performance_comp_partner', company)` — plain `STABLE`.
- `app.can_admin_payroll_employment(emp)` / `app.can_admin_perfcomp_employment(emp)` — employment-scoped variants, `STABLE SECURITY DEFINER SET search_path = public` (matching `can_admin_employment`).

**Payroll Partner** writes/reads: `payroll_batch`, `pay_period`, `payslip`, `payroll_input`,
`company_bank_profile` (the disbursement/bank surface is part of the payroll function — partner gets
it within its company, by default), `attendance`, `attendance_policy` for its company subtree. It also
gets READ-ONLY visibility of `employment`, `person` and `compensation` for its company (payroll
generation and the cycle snapshot inner-join these) — but cannot mutate base comp, employment or
person rows (those WRITE/CHECK clauses are unchanged). The perf-comp partner shares the `employment`
and `person` READ widen for the same reason.

**Performance & Comp Partner** writes/reads: `compensation` (BOTH read and write widen — the 0060
read tighten otherwise leaves a partner reading zero salary rows, so it couldn't do merit work),
`review_cycle`, `performance_review`, `performance_goal`, `performance_attachment`,
`calibration_session`, `calibration_entry`.

## The one clean pay-seam boundary

`enactCompAction` enacts a finalized recommendation. **Merit → `compensation`** is perf-comp
territory: a perf-comp partner may enact a merit increase. **Bonus → `payroll_input`** is payroll
territory: enacting a bonus requires payroll access (admin OR payroll partner). A perf-comp partner
records the bonus *recommendation* on the review row but cannot push bonus-to-pay. This replaces the
untenable column-grain split with a real, table-aligned one.

## Consequences

- A module without partner coverage stays admin-only; partners get access to exactly the tables
  listed above and nothing structural (departments, positions, role assignment).
- The DB fails closed: a missing policy branch denies (ADR-0002). The service guards are UX gates.
- Per-capability nav *filtering* is deferred polish — a partner sees the admin nav group and the
  per-page route guard (`requirePayrollAccess` / `requirePerfCompAccess`) redirects pages it can't
  enter. The cap passed to `<Sidebar>` ORs `isAdmin` into every partner capability (union rule), so a
  user who is both `hr_admin` and a partner is never narrower than a plain admin.

## Alternatives rejected

- **A general capability framework (ADR-0004's aspiration).** We touch the minimum policy
  expressions — widening in place where a shared helper exists, adding a new helper only where a
  table names a different one. No parallel `can_admin_*` framework is bootstrapped.
- **Two distinct comp/performance specialists.** Undeliverable at row grain on a single DB role
  (see decision 3).
