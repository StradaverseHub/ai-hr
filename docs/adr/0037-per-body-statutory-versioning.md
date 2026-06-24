# ADR-0037 — Per-body statutory versioning (overlay model)

Status: Accepted · 2026-06-24 · Consultant feedback #6 (High)

## Context

#6: *"Each statutory body should be able to version independently."* Today a single bundled
`StatutoryRuleset` JSONB carries **all** of EPF + SOCSO + EIS + PCB + OT under **one** `version`
string, distributed three ways (code `DEFAULT_MY_STATUTORY` → tenant `statutory_ruleset` override →
national signed `statutory_pack`), resolved by `resolveActiveRulesetMY(tx, asOf)` (ADR-0019/0020).
HRDF isn't even in the bundle — its rates are hardcoded in `hrdfLevy` (`MY_HRDF = 1% / 0.5%`).

The problem is real and recurrent: when **one** body changes mid-year — e.g. the **1 Jun 2026 SOCSO
Lindung 24 Jam / SKBBK** revision — the whole bundle must be re-versioned, re-validated, and (for the
signed channel) re-issued, even though EPF/PCB/EIS are untouched. That couples unrelated legal
timelines and inflates the audit surface of every change.

## Decision

**Add a per-body *overlay*, do not split the bundle.** The bundled baseline stays exactly as-is and
keeps resolving as today; a new **tenant-scoped, effective-dated `statutory_component_override`** table
holds **one body's slice per row**, and the resolver overlays the newest-effective component per body
*after* the baseline resolves.

```
effective ruleset(asOf)
  = baseline(asOf)                              // pack ∪ tenant-override ∪ code default (ADR-0020 total order)
    then for each body b ∈ {epf,socso,eis,pcb,ot,hrdf}:
       if ∃ component(b) with effective_from ≤ asOf  (newest by effective_from, then created_at)
          ruleset[b] := component(b).data        // overlay wins for that body only
```

- **`statutory_component_override`** (`tenant_id`, `country`, `body`, `version`, `effective_from`,
  `data` jsonb = just that body's slice, `notes`, `created_by_user_id`, `archived_at`). RLS **mirrors
  `statutory_ruleset`**: tenant-wide read (the config surface is a transparency view), admin-only
  write; rows are appended, never mutated (archive = soft-delete). `body` is constrained to the six
  recognized bodies.
- **Resolver** (`resolveActiveRulesetMY`): after picking the winning baseline, query the tenant's
  active components, keep the newest per body, and shallow-clone-then-overlay the baseline ruleset
  (clone is essential — the baseline may be the shared `DEFAULT_MY_STATUTORY` singleton). It now also
  returns a **`components: Record<body, { version, source, effectiveFrom }>`** map (`source` ∈
  `default | override | pack | component`) so callers can see each body's independent provenance.
- **HRDF becomes a first-class body.** `hrdf?: { mandatoryRate, optionalRate }` is added to
  `StatutoryRuleset` and `hrdf: MY_HRDF` to `DEFAULT_MY_STATUTORY`; the kernel passes `rules.hrdf` to
  `hrdfLevy` (which already defaults to `MY_HRDF`). So HRDF can be overridden + effective-dated like
  any other body, with **zero** change to computed levies until someone overrides it.
- **Payslip provenance.** Each payslip's `statutory` snapshot gains `componentVersions` (the per-body
  version map at run time) **only when a component override is actually in effect** — so a tenant with
  no overrides produces byte-identical snapshots (the `version` field is unchanged), and a tenant that
  overrode SOCSO can prove *which* SOCSO version computed that slip.

## Why overlay, not physical split

A physical split (per-body tables / per-body JSONB columns replacing the bundle) would rewrite the
**cryptographically-signed pack distribution** (ADR-0020: ed25519 over the payload bytes, trust
bundle, rollback guard), invalidate the bundled signed packs, and touch every calculator read site and
golden test at once — high risk on the most compliance-sensitive code in the system, for no extra
capability. The overlay achieves the actual goal (independent effective dates + independent versions +
change-one-without-the-others) while being **additive** and **backward-compatible by construction**:
zero components ⇒ the resolver returns the baseline untouched ⇒ every exact-figure golden test stays
green with no edits.

## Scope

- **In:** the override table + RLS + migration; the resolver overlay + `components` provenance;
  per-body validation + `set`/`archive`/`list` services (audited via `DomainEvent`
  `statutory.component.{updated,archived}`); HRDF under versioning; the `componentVersions` payslip
  stamp; the `/payroll/configuration` per-body panel (active version + source per body) and an admin
  override form for the **scalar-shaped** bodies (EPF rates, OT ceiling, HRDF rates); tests +
  i18n ×6.
- **Out (future):** an admin band-table editor for SOCSO/EIS/PCB component overrides (64-row tables —
  these stay pack/whole-ruleset managed for now; the table itself already accepts a band-shaped `data`
  via the service, only the *UI* form is scalar-only); **per-body signed packs** (the signed channel
  still ships the bundle — a tenant override is the per-body path today); cross-country generalization.

## Consequences

- A single body can be corrected on its own legal timeline (the SOCSO-only mid-year case) without
  re-issuing or re-validating the others; the change is one audited row.
- HRDF stops being a hardcoded blind spot — it versions and audits like the rest.
- Provenance is now per-body end-to-end: the config surface and each payslip can answer "which version
  of *this* body applied, and where did it come from".
- Precedence is unambiguous: a per-body component is a *fine-grained correction* and always wins over
  the coarse baseline for its body; among components, newest-effective (then newest-created) wins.
