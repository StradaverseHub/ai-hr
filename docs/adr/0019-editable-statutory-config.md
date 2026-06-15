# ADR-0019 — Editable statutory / payroll configuration

Status: **Accepted** · Date: 2026-06-15

## Context

The Malaysian statutory rules (EPF/SOCSO/EIS/PCB rates, bands, reliefs; OT multipliers) were sourced,
versioned **TypeScript constants** in `localization/my/statutory-tables.ts`, consumed by the pure
calculators in `payroll.ts` (ADR-0008). They were correct and auditable but **invisible and immutable in
the product** — no admin could see what the system applies, and no value could be changed without a code
release. We want a configuration surface: view every figure, and edit it.

Editing legal figures in a UI is risky (a wrong EPF rate produces wrong, non-compliant payslips), so the
design has to make editability **safe by construction**.

## Decision

### 1. `StatutoryRuleset` — the figures become injectable data, with the verified set as the default

All figures are aggregated into a `StatutoryRuleset` (version, EPF, SOCSO cat-1/cat-2 bands + rates +
ceiling, EIS bands + rates, PCB bands + reliefs, OT ceiling). The existing constants become
`DEFAULT_MY_STATUTORY` — **the canonical, verified fallback that ships in code and is never lost**.

The calculators (`epf`/`socso`/`eis`/`pcbMonth`/`statutory`/`overtimePay`) take the ruleset (or the
relevant slice) as a parameter that **defaults to `DEFAULT_MY_STATUTORY`**. So:
- they stay **pure and synchronous** (no DB reads inside the per-payslip loop → still fully testable);
- every existing call site and test that passes no ruleset behaves **identically** to before (this is the
  equivalence guarantee — proven by the unchanged test suite).

### 2. The DB is an *override*, resolved once per run; code default is the floor

A `statutory_ruleset` table (tenant-scoped, RLS) stores effective-dated rulesets as JSONB. A loader
resolves the **active** ruleset for a company/period: the latest row with `effective_from ≤ asOf`, else
`DEFAULT_MY_STATUTORY`. `core/payroll.ts` loads it **once** at the top of payslip generation and threads
it into the calculators. An empty table ⇒ exactly today's behaviour.

> Statutory figures are national, not per-company. We store rulesets tenant-scoped (consistent with the
> RLS model and single-org deployments) but treat the built-in `DEFAULT_MY_STATUTORY` as authoritative;
> an override is a deliberate, audited act, not the norm.

### 3. Past payslips are immutable; editing only affects future runs

Generated payslips already **snapshot** their computed amounts and the `statutory_version` string
(ADR-0006/0014). Reads never recompute. So changing the ruleset can never alter historical payroll — it
only changes the *next* generation. This is the core safety property that makes editing acceptable.

### 4. Edits are validated, versioned, and audited

The service validates every edit (rates in [0,1], thresholds/ceilings ≥ 0, bands monotonic by `upTo`,
PCB `M`/`R`/`B` well-formed), requires a bumped `version` + `effective_from`, appends a `DomainEvent`
(`statutory-config.updated`) with a before/after diff, and is **admin-only** (RLS + role gate). A ruleset
already consumed by a closed payroll batch is not mutated in place — a new effective-dated version is
created — so provenance stays intact.

### 5. UI — view first, edit deliberately

`/payroll/configuration` (admin) renders the active ruleset as cards (EPF, SOCSO, EIS, PCB, OT), each with
its **effective date, official source link, and verified flag** — a transparency/audit surface (valuable
for consultants verifying compliance). Editing is an explicit mode that writes a new version through the
validated service. The page makes clear which values are statutory (sourced) vs locally overridden.

## Consequences

- Admins can see exactly what the engine applies, and change it when the law changes (or to model a
  scenario) — without a code release — while the verified defaults remain the safety net.
- The calculators are unchanged in behaviour and remain unit-tested against the default; a new test layer
  asserts a DB ruleset equal to the default yields **byte-identical** payroll.
- Editing carries real compliance weight; the UI surfaces sources + verified flags and the service blocks
  malformed values, but **it does not absolve the operator** — wrong inputs still produce wrong payslips.
  The default stays authoritative and any override is fully audited.

## Implementation notes (Slices 2–4)

- **JSONB round-trip is calculation-safe.** The PCB top band ships as `upTo: Infinity`, which Postgres
  `jsonb` stores as `null`. Both `bandFor`/`annualTaxFor` resolve "no band matched" to the *last* band,
  so an open-ended top bound of `Infinity`, `null`, or any value is the same catch-all. `test/statutory-config.test.ts`
  proves a stored-then-reloaded default (through real Postgres jsonb) yields **byte-identical** payroll
  across a wage/profile/bonus/OT/residency sweep — the equivalence guarantee, including the top band.
- **UI edit scope.** `/payroll/configuration` makes the figures that realistically change directly editable
  (EPF rates + threshold, contribution & OT ceilings, PCB reliefs, the 10 PCB tax bands). The SOCSO and EIS
  64-row agency schedules are shown read-only and **carried through unchanged** on save: they are exact
  transcriptions maintained as sourced data (a published PERKESO schedule change is a data update, not a
  hand-edit of 128 cells). The substrate still stores the *full* ruleset, so those tables remain overridable
  via the service if ever needed — only the form intentionally scopes them out. This keeps "safe by
  construction": the dangerous bulk tables can't be fat-fingered in a form.
- **Rates edited as percentages.** The form takes EPF/PCB rates as percentages (11, 13, 6 …) and converts to
  fractions on assemble (rounded to kill FP noise); amounts/thresholds are plain ringgit. The open-ended top
  PCB band's bound is entered as blank (= "and above") and serialised as `null`.

## Alternatives considered

- **Keep it read-only** (recommended originally) — safest, but the owner wants true configurability.
- **Hardcode-only with a code release per change** — status quo; not configurable.
- **Per-company statutory overrides as first-class** — rejected: statutory rules are national; modelling
  them per-company invites incorrect divergence. Tenant-scoped override + authoritative default is the
  pragmatic middle.
