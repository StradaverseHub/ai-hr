# ADR-0008: Localization via installable country packs

- **Status:** Accepted — *architecture now; the Malaysia pack is built incrementally*
- **Date:** 2026-06-05
- **Deciders:** Founder (solo) + Claude (acting architect)

## Context

A concrete requirements spec (a single-company **Malaysia** HRMS: Employment Act 1955,
EPF/SOCSO/EIS, PCB/MTD) describes statutory payroll, leave, and attendance in detail. We
keep the generic, multi-tenant, bitemporal platform **and** add the jurisdiction-specific
behaviour **without baking it into the core**. This realises the "multi-country *ready*,
MY-first" direction ([ADR-0005](0005-tech-stack.md)) and the "compliance rules are
effective-dated data" stance ([ADR-0007](0007-ai-native-architecture.md), #7). It is purely
additive — nothing already designed or built is removed.

## Decision

1. **The platform core stays jurisdiction-agnostic.** Country-specific behaviour lives in
   **installable localization packs**, selected per company by `company.country` (already in
   the schema).
2. **A pack is a hybrid of data + code:**
   - *rules-as-data* (effective-dated): statutory rate tables, leave-type catalog +
     entitlement rules, public-holiday calendar, statutory-field definitions, default
     thresholds.
   - *registered code*: a `LocalizationRegistry` of calculators / validators where the logic
     is non-trivial — EPF/SOCSO/EIS/PCB, overtime, leave-entitlement resolution,
     statutory-ID validation.
3. **Generic engines delegate** jurisdiction work to the active pack:
   `registry.for(country).payroll.statutory(...)`, `.leave.entitlement(...)`,
   `.validateStatutoryProfile(...)`. The core never references "Malaysia."
4. **Compliance-critical statutory identity fields** get **typed per-jurisdiction extension
   tables** (e.g. `employee_statutory_my`) with real constraints (IC unique, …), owned by the
   pack's migration — not loose JSONB. Softer config (thresholds) stays JSONB.
5. **Money facts are effective-dated** (basic salary, allowances) using the bitemporal
   pattern ([ADR-0001](0001-bitemporal-effective-dating.md)) — comp history — even though the
   MY spec defers retroactive adjustments.
6. **Packs are purely additive.** Installing/removing a pack changes no core code. Because of
   multi-company ([ADR-0003](0003-organizational-model.md)), different companies within one
   tenant can run different country packs.

## Consequences

- (+) Clean multi-country path; the generic foundation (bitemporal, RLS, events,
  multi-company) is exactly what makes packs work — it now earns its keep.
- (+) AI compliance-watch ([ADR-0007](0007-ai-native-architecture.md)) can monitor the
  effective-dated rate tables for drift, with provenance.
- (+) The single-company spec is delivered as the *first pack*, not as a fork of the core.
- (−) Each country pack is real, ongoing work — statutory rules change (often yearly), so
  rate tables are effective-dated and need maintenance.
- (−) Payroll statutory calculation (especially **PCB/MTD** and SOCSO bands) needs
  authoritative LHDN/PERKESO sources + human verification — compliance liability, not a
  best-effort guess.

## Alternatives considered

- **Bake Malaysia into the core.** Rejected — kills the multi-country thesis and forces a
  rewrite for the next jurisdiction.
- **Pure data packs (no code).** Rejected — EPF brackets and the PCB/MTD schedule are not
  expressible as simple data; they need real calculators.
- **Per-tenant forks of the app.** Rejected — unmaintainable; defeats single-codebase SaaS.

> Supersedes the "payroll kernel + per-country rule packs (deferred, no ADR)" note in the ADR
> index — that is now this ADR.
