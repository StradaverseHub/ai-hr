# ADR-0080 — Packs as the module system: module packs and country packs

- **Status:** Accepted — rung 1 (pack registry + CountryPack interface + both drift guards) landed 2026-07-23;
  rung 2 (Attendance module pack: `packs/attendance` declaration + service facade, registry-mounted
  sidebar node, boundary ratchet seeded with the audited kernel-contract debt) landed 2026-07-23 —
  D11 criteria 1–4 met, criterion 5 (entitlement gate) documented as a hook point pending ADR-0077's
  `tenant_module`/`isModuleEnabled()`; rung 3 (Claims module pack: `packs/claims` declaration +
  service facade, registry-mounted flat nav rows, ratchet seeded) landed 2026-07-23 — and the
  `PayrollInputContributor` kernel contract (D9) LANDED with it: the claims payout prefill was a real
  code path (`app/payroll/actions.ts` → `prefillClaimsForBatch`) and now rides the contract
  (`packs/contracts.ts` + `packs/claims/payroll.ts`), payroll output proven identical by the
  golden payout tests; rung 4 (Performance module pack: `packs/performance` declaration + service
  facade, registry-mounted flat Manage-group nav row, ratchet seeded with one entry) landed
  2026-07-23 — `core/employment-review.ts` audited as employment-spine (NOT the pack), and the
  comp-enactment pay seam (`enactCompAction` → `setCompensation`/`setPayrollInput`) documented as
  debt for the Payroll rung per one-seam-per-rung (no new contract this rung)
- **Date:** 2026-07-23 (revised same day: generalized from country packs to a two-axis pack system, per
  operator discussion — functional modules become packs too, retrofitted one by one)
- **Relates to:** ADR-0008 (localization packs — this ADR restores and hardens its seam), ADR-0077 (module
  entitlements — this ADR extends its catalog), ADR-0020 (statutory pack distribution), ADR-0037
  (per-body statutory versioning), ADR-0009 (multi-company group model), ADR-0079 (tenant provisioning)

## 1. The ask

Two asks, one mechanism.

**Countries.** A multinational client operates companies in several countries under one tenant. Each
company needs its own statutory compliance — Malaysian EPF/SOCSO/PCB for the Malaysian entity,
Singaporean CPF/IRAS for the Singaporean one. Today the product ships exactly one jurisdiction
(Malaysia), and it is not packaged: it is woven into the kernel, the app routes, and shared components.

**Modules.** ADR-0077 sells functional modules (Leave, Payroll, Attendance, Claims, Performance…) the
Odoo way — per-tenant entitlement, catalog, service-boundary refusal. But that gives modules only a
*commercial* identity: behind each entitlement gate the code stays woven through the kernel, the
hardcoded sidebar, and shared components. A "module" you cannot point to in the source tree is a gate,
not a unit. The operator decision (2026-07-23): functional modules become packs too, with the same code
identity this ADR gives country packs — and the existing modules are retrofitted **one by one**, not
big-bang, because seams decay by default (see the 47-file leak below) and every improve-loop round that
runs before a boundary exists adds to the eventual untangling bill.

The result is one pack system with two axes:

| Axis | Pack kind | Examples | What varies |
| --- | --- | --- | --- |
| Capability | **module pack** | `leave`, `payroll`, `attendance`, `claims`, `performance` | what the tenant bought |
| Jurisdiction | **country pack** | `country-my`, `country-sg` | which country's rules a company runs under |

Country packs are not siblings of module packs — they **plug into** them: `country-my` contributes
EPF/SOCSO/PCB calculators to the `payroll` pack's extension points, statutory leave entitlements to
`leave`'s, MyKad identity widgets to the people spine. Buying `payroll` + `country-my` is what makes a
Malaysian payroll run.

The target model, composing ADR-0008 with ADR-0077:

| Concept | Model |
| --- | --- |
| A country's compliance | A **country pack** — code + rule tables + country UI, one directory (`localization/<cc>/`) |
| Selling it | A **billable module** in the ADR-0077 catalog: `country-my`, `country-sg`, … entitled per tenant |
| Applying it | **Per company** via the existing `company.country` (ISO alpha-2) — an MNC tenant activates several |
| Enforcing it | ADR-0077 D3: payroll and statutory operations for a company whose country module is not active are **refused at the service boundary**, never calculated wrongly |

## 2. Current state — audited 2026-07-23, not assumed

### What already matches the target

- **`company.country` exists** (`db/schema.ts:166`, ISO alpha-2, default 'MY') and ADR-0008's comment
  discipline around it is intact ("the holiday/statutory driver").
- **The registry exists and part of the core honours it.** `localization/registry.ts` exposes
  `packFor(country)`; `core/leave.ts` (5 call sites) and `core/reporting.ts` (4 call sites) resolve the
  pack per employee/company country. Leave entitlement and report definitions are already
  jurisdiction-dispatched.
- **The MY pack has a real surface.** `localization/my/index.ts` exports a structured `myPack`:
  `statutory` profile setters/validators, `companyStatutory`, leave entitlement, payroll calculators
  (EPF/SOCSO/EIS/PCB/HRDF/OT), statutory-config CRUD, and `MY_REPORTS`/`eaStatement`.
- **Rule-table distribution is solved** (ADR-0020): versioned, signed statutory packs
  (`localization/statutory-pack/`, `scripts/statutory-pack-build-my.ts`, owner-role `statutory:sync`).
  "Update Malaysian rates" is already a data operation. A second country reuses this machinery unchanged.

### The leak — 47 files import `localization/my` directly (excluding tests)

| Layer | Files | Character |
| --- | --- | --- |
| `core/` | 12 (`payroll.ts`, `pay-components.ts`, `ea-override.ts`, `tax-relief.ts`, `leave-compute.ts`, `import.ts`, `payroll-history-import.ts`, `dependents.ts`, `admin.ts`, `location.ts`, `profile-options.ts`, `reporting.ts`) | **Kernel leak — the one that kills the thesis.** The payroll kernel imports MY tables/codes by name (e.g. `MY_PCB_EXEMPTION_CODES` in `core/payroll.ts:58`, added by the R55 PCB work) |
| `app/payroll/configuration/*` | 9 routes (epf, socso, eis, pcb, hrdf, skbbk, zakat, shared, actions) | **Country admin UI hardcoded as global routes** — legitimate MY screens, wrong mounting |
| `components/` | 6 (`personnel-identity`, `ic-dob-autofill`, `bank-info-card`, `statutory-config-form`, `holiday-group-form`, `leave-rule-preview`) | **MY widgets embedded in generic screens** (MyKad validation, MY banks, MY holiday groups) |
| `lib/` | 3 (`my-banks`, `epf-mode-map`, `ea-pdf`) | MY helpers presented as generic |
| `db/` + `scripts/` | 4 (`schema.ts`, `seed.ts`, `provision.ts`, `statutory-pack-build-my.ts`) | Schema/seed references (see D5) |

Each statutory feedback item shipped through the improve-loop tends to add another direct import — the
leak grows by default. Without a mechanical guard, "multi-country ready" quietly becomes false.

## 3. Decisions

### D1 — A country pack is a typed interface; the kernel is jurisdiction-agnostic

Extract the implicit shape of `myPack` into an explicit `CountryPack` interface owned by
`localization/registry.ts` (today the registry derives the type *from* `myPack` — backwards: Malaysia
defines the contract). The interface covers: statutory profile handlers, company statutory config,
payroll calculators + pre-check contributions, leave entitlement hooks, holiday seed data, report
definitions + generators, statutory-config CRUD, pack-file identity, and (new — D4) UI extension
descriptors and (new — D6) engine vocabulary such as exemption-code sets.

The kernel rule, stated once and enforced mechanically (D7): **`core/`, `lib/`, `app/` and shared
`components/` never import `localization/<cc>/` directly. They import the registry.** The only files
allowed to import `localization/my/` are the MY pack itself, its build script, and MY-specific tests.

### D2 — Country packs are billable modules, entitled per tenant, applied per company

- Module codes `country-<cc>` join the ADR-0077 `module` catalog (billable; `depends_on: ["payroll"]`
  for the payroll surface — leave/holiday parts of a pack function without the Payroll module).
- **Entitlement is per tenant** (you buy the pack); **application is per company** via
  `company.country`. No new join table: a company in country X uses pack X iff the tenant's
  `country-x` module is active.
- Creating or re-countrying a company into a country whose module is not entitled is refused at the
  service boundary with a clear message — the failure happens at configuration time, not on payroll day.

### D3 — Enforcement follows ADR-0077 D3, with one addition: fail-closed calculators

Three layers (nav/page cosmetic, service authoritative) apply unchanged. The addition: the payroll
kernel treats an **unresolvable pack as a blocker**, not a fallback. `generatePayslips` for a company
whose `packFor(country)` returns undefined — or whose country module is inactive — emits a pre-check
blocker (`countryPackInactive`), exactly like the existing fail-closed discipline
(`UnsupportedPayComponentError`, ADR-0025 §5). Money is never computed under a wrong or missing
jurisdiction.

### D4 — Country UI mounts through the registry, not through hardcoded routes

The `app/payroll/configuration/*` MY screens stay MY screens — but their *mounting* becomes
registry-driven:

- The pack contributes **UI descriptors**: configuration sections (label, href, component ref),
  personnel-profile cards (identity/IC vs passport, bank info), and report entries.
- Generic pages (`payroll/configuration`, the personnel profile tabs) render the sections the active
  company's pack declares. A company in SG simply gets SG sections.
- Country components live under the pack (`localization/my/ui/…` as they migrate); shared screens keep
  a stable slot API. Route paths may keep their current URLs for MY (no user-visible churn) — the
  gating moves from "route exists" to "route resolves the company's pack or 404s".

### D5 — Schema: shared spine, per-country satellite tables — no jsonb dumping ground

The pattern already exists: MY statutory profile data lives in MY-shaped tables written by MY setters.
Codify it:

- **Shared spine** (all countries): employment, compensation, payslip, leave, attendance — untouched.
- **Per-country satellites**: `<cc>_`-prefixed (or pack-schema'd) tables for statutory profiles,
  company statutory config, and country accumulators. A new country adds tables; it never adds nullable
  country-specific columns to shared tables.
- Migrations for satellite tables ship with the pack's code (normal drizzle migrations — one deploy
  still carries all packs' schemas; what varies per tenant is *activation*, not DDL).

### D6 — The R55 precedent is the template for kernel vocabulary

R55's PCB work imported `MY_PCB_EXEMPTION_CODES` into `core/payroll.ts` because the kernel needed a
vocabulary the pack owns. The corrected shape: the pack *exports* vocabulary through the interface
(`pack.payroll.exemptionCodes`, `pack.payroll.remunerationTypes`), and the kernel consumes whatever the
active pack supplies. Pay-component validation (`core/pay-components.ts`) resolves the acting company's
pack for allowlists. This is the worked example the seam-restoration slice starts with.

### D7 — A drift guard makes the seam self-defending

A source-static test (house convention) fails the suite when any file outside
`localization/my/**`, `scripts/statutory-pack-build-my.ts`, or MY tests imports `localization/my`.
Seeded with the audited 47-file allowlist that must only ever shrink (ratchet test: the allowlist is
checked in; removing entries is free, adding one fails). This runs from slice 1 — the leak stops
growing the day the ADR is accepted, before any refactoring lands.

### D8 — One registry, two pack kinds; module packs get the same code identity

The registry (D1) becomes the single pack registry with `kind: 'module' | 'country'`. A **module pack**
is a directory (`packs/<module>/` as files migrate; boundary-first before that) exposing a typed
interface: its service surface, UI descriptors (nav entries, dashboard cards, profile tabs), satellite
tables, and **extension points** that country packs fill (e.g. `payroll` declares
`statutoryCalculators`, `leave` declares `statutoryEntitlementHooks`). ADR-0077's catalog rows stop
being bare flags — each module row corresponds to a pack the registry can enumerate.

Navigation mounts from the registry: the sidebar renders the nav descriptors of the packs the tenant is
entitled to (per company where the country axis applies). This closes ADR-0077's gap #6 (hardcoded
`components/sidebar.tsx`) as a by-product rather than a bespoke fix.

### D9 — Inter-pack contracts go through the kernel; no pack imports another pack

The real entanglements are legitimate — unpaid leave reduces payroll pay; attendance-derived OT feeds
payroll input; claims pay out through payroll. The rule: packs never import each other. Cross-module
effects ride **kernel contracts** — narrow interfaces owned by the shared spine (e.g. a
`PayrollInputContributor` the payroll pack consumes and the leave/attendance/claims packs implement,
registered through the registry). The kernel owns: person/employment/org, approvals substrate, domain
events, RLS/tenancy, i18n plumbing, the contracts. Everything else is a candidate to live in a pack.

The same drift-guard convention as D7 enforces this per retrofitted pack: once module X is extracted,
a ratchet test seeds the audited allowlist of outside-the-pack imports, and the list only shrinks.

### D10 — Pack discipline is law for new modules, a ladder for existing ones

Any **new** module (recruitment, training, and the other "future module" references already appearing
in feedback items) starts life as a pack — interface, descriptors, satellite tables, drift guard from
its first slice. **Existing** modules are retrofitted one at a time, easiest → hardest, each retrofit a
round-sized slice shipping through the normal clean-room gate (§5 ladder). No big-bang: between slices
the improve-loop keeps running normally, and a half-retrofitted codebase is always releasable.

### D11 — What a module retrofit means (definition of done)

A module counts as "a pack" when: (1) its nav/UI mounts via registry descriptors; (2) its satellite
tables are documented as pack-owned; (3) its service surface is reachable only through its interface;
(4) the drift-guard ratchet for its boundary is checked in and seeded; (5) ADR-0077's entitlement gate
resolves the pack through the registry (fail-closed like D3). Physical file migration under `packs/` is
encouraged but NOT part of the definition — mounting and import discipline are the boundary; moving
files is opportunistic cleanup (same stance as open decision 2 for country UI).

## 4. What a second country actually costs (scope honesty)

ADR-0008's warning stands: a pack is real, ongoing work. For a Singapore pack, roughly: CPF tables +
calculators, IRAS (IR8A) reporting, SDL, leave/holiday defaults, NRIC validation, bank formats, plus
translations. The point of this ADR is not to make that free — it is to make it **additive**: a new
directory implementing a known interface, zero kernel edits, zero shared-schema edits, sellable as a
module row.

## 5. Build sequence — the retrofit ladder

Ordered easiest → hardest so the pattern is settled on cheap modules before it touches money. Each rung
is a round-sized slice (or a few) through the normal clean-room gate; the codebase is releasable
between every rung.

| # | Rung | Notes |
| --- | --- | --- |
| 1 | Pack registry + interfaces (`kind: module\|country`) + BOTH drift guards (country ratchet seeded with the 47-file audit; module-guard convention ready for each retrofit) | No behaviour change; the MY leak stops growing the day this lands |
| 2 | **Attendance** retrofit | Newest module, most self-contained (5 `core/attendance*` services, clock UI just rebuilt in R63–R65), near-zero kernel entanglement — the pattern-prover |
| 3 | **Claims** retrofit | Similar leaf shape; its payroll payout becomes the first `PayrollInputContributor` kernel contract (D9) |
| 4 | **Performance** retrofit | Mostly leaf; reporting-line reads already go through the spine |
| 5 | **Country seam** — the original country-pack slices, in order: kernel seam restoration (12 `core/` files, D6 vocabulary, golden byte-identical tests) → `lib/`+`components/` widgets via descriptors → country admin UI mounting → `country-my` module row + D2/D3 enforcement → satellite/provisioning codification (D5, ADR-0079) | Sits before leave/payroll retrofits because both need the country extension-point pattern settled |
| 6 | **Leave** retrofit | Large but the entitlement engine is already service-shaped (benefit schemes, recalc, approval policies); its country hooks were just defined in rung 5 |
| 7 | **Payroll** retrofit | The money path, deepest entanglement, goes last — by now it inherits settled patterns: contracts from rung 3, country calculators from rung 5, and golden-test discipline throughout |
| 8 | Second country pack (validates the whole system) | Pick by first real MNC prospect (SEA research doc informs SG-first) |

Rungs 1–4 are pure refactoring with mechanical safety nets and can proceed **independently of
ADR-0077**. The `country-my` module row inside rung 5 — and each module pack's entitlement wiring — is
the ADR-0077 join point (needs `tenant_module` + `isModuleEnabled()`). New modules (recruitment,
training…) may start as packs at any time after rung 1; they do not wait for the ladder.

## 6. Open decisions

1. **Second country** — SG is the likely first ask regionally; VN/TH/ID candidates. Decide by prospect,
   not speculation. Affects nothing before slice 7.
2. **Pack UI code location** — migrate MY screens under `localization/my/ui/` (clean, bigger diff) vs
   leave files in place and only route mounting through descriptors (smaller diff, weaker boundary).
   Recommendation: descriptors first (slice 4), physical migration opportunistically.
3. **Holiday calendars** — `MY_HOLIDAYS_2026` seeds are pack data; the editable holiday system
   (ADR-0055/0063/0067) is shared spine. Boundary: packs provide *seed* calendars; tenants own them
   after provisioning. Confirm during slice 6.
4. **i18n ownership** — do pack-specific strings (EPF, PCB, MyKad…) move into pack-owned message
   bundles merged at build time, or stay in the global 6-locale files? Recommendation: stay global until
   a second pack makes the cost real.
5. **Statutory pack signing per country** — one trust bundle for all countries or per-country keys?
   ADR-0020's machinery supports either; decide at the second-country rung.
6. **Kernel vs pack line for borderline surfaces** — approvals inbox, analytics, custom reports, and
   employee documents read across modules. Working position: cross-module readers stay kernel (they
   consume pack descriptors/contracts); revisit per rung rather than deciding all now.
7. **Module pack file home** — `packs/<module>/` vs leaving `core/<module>*.ts` in place with
   boundary-only enforcement (D11 makes the latter sufficient). Recommendation: boundary first;
   migrate files opportunistically, exactly as open decision 2 treats country UI.
8. **Bundling** — is `attendance` sellable without `leave` (shared calendars), `claims` without
   `payroll` (payout path degrades to export)? The catalog's `depends_on` (ADR-0077) encodes the
   answer per module; fill it in at each rung's entitlement wiring.

## 7. Consequences and risks

**Positive.** The multi-country thesis becomes true again and stays true mechanically (ratchet). An MNC
tenant is a configuration, not a project. Country compliance becomes a sellable SKU riding ADR-0077's
rails. Statutory feedback items get a rule that tells builders exactly where jurisdiction code belongs.
On the module axis: every retrofitted pack shrinks the improve-loop blast radius (build agents
physically cannot smear a feature across module boundaries once the ratchet exists), the sidebar/nav
becomes registry-driven for free, and what ADR-0077 sells finally corresponds to something you can
point at in the source tree.

**Risks.**
- **The ladder is long and interest fades.** Mitigation: every rung is independently valuable and the
  system is releasable between rungs — stopping after rung 4 still leaves three clean packs, a live
  registry, and the country ratchet holding.
- **Kernel contracts (D9) can bloat into a plugin framework.** Same discipline as descriptors: flat,
  narrow, named interfaces added only when a second consumer exists — resist speculative generality.
- **Slice 2 touches the payroll kernel with no behaviour change intended.** The mitigation is the
  golden-test discipline plus MY being the only pack (any diff in output is a bug by definition).
- **Interface churn while MY is the only implementation.** The `CountryPack` type will be wrong in
  places until a second pack stress-tests it; keep it internal (not exported to tenants) so revisions
  stay cheap.
- **Descriptor-driven UI can become a framework.** Keep descriptors to flat lists of
  (label, href/component); resist a plugin system.
- **Ratchet fatigue** — 47 files is a long tail. The ratchet permits shipping features while shrinking
  the list opportunistically; only *growth* is blocked.

**Non-goals.** Building any second country pack now; per-tenant custom statutory logic; runtime plugin
loading (all packs — module and country — compile into the one deployment); billing (ADR-0077 owns it);
big-bang extraction of leave or payroll ahead of their ladder rungs; third-party/marketplace packs.
