# ADR-0029 — Cross-employer PCB (MTD) for concurrent employments

Status: **Accepted.** (2026) Go-live gate **G2** (product plan v2). Anchor tenant: Chin Hin Group.

> **Go-live posture:** the **designated-paymaster scope-out** is the DEFAULT operating model for the
> first live month (zero payroll-engine risk). The **group-coordinator** below is built **gated and
> byte-identical-by-default** (`pcb_aggregation_mode`), enabled per tenant only after the compat test,
> a golden cross-band case, and an accountant sign-off pass. The default path never changes the existing
> per-employer behaviour for the single-employment majority.

---

## 1. Context

When one person (one IC, one LHDN tax file) holds **two or more concurrent active employments** in
different companies of the same tenant — Chin Hin's shared-services directors/finance staff — each
employment computes its own MTD in isolation. Because MTD is **progressive**
(`localization/my/payroll.ts → pcbMonth`: `MTD = [(P−M)·R + B − (Z+X)]/(n+1)` over annualised net `P`),
N independent computations on slices `Y_a, Y_b …` always deduct **less** than one computation on
`(Y_a+Y_b)` — they each drop the person into lower bands. Result: **systematic annual PCB
under-deduction**. ADR-0009 §4 flagged it; ADR-0014 §4 noted the accumulators inherit it;
`STATUTORY-SOURCES.md` §1 lists it as a known limitation.

**Where it happens (verified in `core/payroll.ts → generatePayslips`):**
- L527–533 — employee query is hard-scoped to one company (`eq(employment.companyId, batch.companyId)`).
- L569–610 — the PCB accumulator replay keys on `payslip.employmentId`; accumulators `∑(Y−K), K, X` are
  per-employment, never per-person.
- L802–811 — `computeMonth` runs one `pcbMonth` per employment over that employment's wage + accumulators.

The tax profile is **already per-person** (`employeeStatutoryMy` unique on `personId`,
`db/schema.ts:475–516`): category, children, residency, IC, TP3 opening balances are shared correctly.
Only the **wage aggregation and accumulator** are split.

**This is a correctness/quality gate, not (strictly) a statutory violation.** The LHDN MTD computerised
method and the Income Tax (Deduction from Remuneration) Rules 1994 define remuneration as that paid by
**"the employer"** (singular) and only let MTD become final tax under **"the same employer"** for the
year. There is **no official LHDN mechanism that aggregates concurrent employers' MTD**; the accepted
default is that each employer deducts on what it pays and the shortfall is reconciled by the employee at
annual assessment (Form BE). So today's per-employment behaviour is the **legally-tolerated default** —
but it pushes a known under-deduction onto the employee (a large April balancing assessment), which a
real group will read as a payroll defect. This ADR makes the combined-month tax correct **as a
product/correctness feature above the statutory floor**, while still filing per-company.

---

## 2. Decision

### 2A. Default (go-live): designated-paymaster scope-out
Route a multi-employment person's taxable remuneration through **one designated "paymaster" employment**
(the home/principal company); other companies pay net-of-recharge via the existing
`employment.cost_allocation` JSONB (ADR-0009 §6). PCB is then automatically correct (functionally one
employer-of-record for tax), and EPF/SOCSO stay clean (one contributor account). Cost: **near-zero** —
add `person.designated_paymaster_employment_id` (nullable FK) + a validation that taxable remuneration
for a multi-employment person is entered on that one employment. **Limit:** covers the "(a) home company
pays + recharges" model, **not** the "(b) each entity cuts a real cheque" case — plausible for Chin Hin's
shared directors, which is why the coordinator below is built in parallel.

### 2B. Built gated: group-MTD coordinator (`pcb_aggregation_mode = 'group_coordinated'`)
For each person with ≥2 active employments in the tenant this month, before payslips are written:
1. **Aggregate accumulators per person** — reduce the existing replay rows (payroll.ts:569–610) by
   `personId` instead of `employmentId`: sum `∑(Y−K), X, Z, ∑LP`; cap `K` (EPF relief) **once**
   cumulatively at RM4,000; apply the single TP3 opening balance once.
2. **Aggregate this month per person** — combined normal wage `ΣY1`, combined additional `ΣYt`,
   combined EPF-on-normal/on-bonus, combined `LP₁`/zakat.
3. **Run `pcbMonth` ONCE** on the combined figures (the pure function is unchanged — this is its whole
   point) → the correct combined monthly MTD.
4. **Allocate back per employment** pro-rata to each employment's taxable share (`Y1−K1` for normal, `Yt`
   for bonus), §E rounding applied to the **person total**, residual pinned to the largest-wage
   employment (mirrors `deltaStat`). Slices sum to the combined total by construction.

**Only `pcb`/`pcbBonus`/`pcbMeta` are overridden.** EPF/SOCSO/EIS/HRDF stay **per-employer by statute**
(separate KWSP/PERKESO accounts and ceilings). Single-employment people are a **no-op** → byte-identical.

**Authorization:** the cross-company read runs under the payroll engine's tenant-scoped service context,
gated by `app.has_role_for` over **every** peer company. If the principal lacks scope on any peer, the
person **fails closed to `per_employer`** for that month with a flagged `DomainEvent` (never silently
mixes). No mutable accumulator table (rejected — drifts on regenerate; the replay-and-reduce gives the
same numbers with zero drift, per ADR-0014).

### 2C. Compliance-visibility companion (ships with the gate)
On the Compliance page, surface the **per-person combined-vs-summed MTD delta** even when running
`per_employer`, so payroll sees the exposure (and can issue a CP38 top-up) without enabling coordination.

---

## 3. Schema (additive only — back-compat by default)

- `pcb_aggregation_mode text NOT NULL DEFAULT 'per_employer'` on a tenant-level statutory config row
  (prefer a small `tenant_statutory_my` to match ADR-0009's identity model). `'per_employer'` (status
  quo / statutory floor) | `'group_coordinated'` (this ADR). Default preserves exact current behaviour.
- **No new `payslip` columns** — coordination audit lives in `payslip.statutory` jsonb as
  `pcbMeta.coordination = { mode, personId, runGroupId, combinedNormalWage, combinedAdditional,
  combinedMtd, allocatedShare, peerEmploymentIds }` (ADR-0014 "every payslip stamps its pcbMeta").
- `person.designated_paymaster_employment_id` nullable FK (scope-out).
- Optional `pcb_run_group(id, tenant_id, pay_period, …)` correlation table — deferred to the atomic-run
  slice; the read-peer-slips first slice needs none.

All migrations nullable/defaulted; existing rows untouched; RLS **extends** (a new tenant-scoped read
helper guarded by `app.has_role_for`), it does not relax the per-company policies.

---

## 4. Consequences / risks

- **Statutory confidence MEDIUM-HIGH** that LHDN's default is per-employer + annual reconciliation
  (consistent across the MTD spec's singular-"employer" definition, the "same employer 12 months → final
  tax" rule, EY/CCS operational guidelines). **Before go-live:** confirm with LHDN / a MY tax agent that
  (a) per-employer is acceptable and (b) voluntary combined coordination violates no rule. **(Worksheet §6.)**
- **Over-deduction:** coordination deducts more per month than the per-employer floor — correct toward
  true liability, but employees see a bigger monthly bite. Keep it opt-in per tenant and communicate.
- **RLS scope leak:** the coordinator crosses the per-company boundary ADR-0009 Slice B hardened.
  Mitigation: tenant-scoped context, `has_role_for` on every peer, fail-closed with a `DomainEvent`.
  Heavy isolation tests (same bar as Slice B).
- **Allocation-back:** the pro-rata split is a design choice LHDN does not specify. Golden-test that
  slices sum to the combined total to the sen; §E rounding on the person total, residual pinned
  deterministically. **Accountant sign-off worksheet required.**
- **Operational ordering:** coordination needs all of a person's companies' draft batches together (or
  peer slips already drafted). Lean on closed-batch immutability (ADR-0014); flag coordination computed
  against a closed/stale peer.
- **Byte-identical regression:** this is the live anchor payroll. The `per_employer` default path MUST be
  proven byte-identical (single-employment majority unaffected). Ship the compat test FIRST (ADR-0024/0025
  discipline) before enabling `group_coordinated` for anyone.
- **EPF/SOCSO/EIS must stay per-employer** — the override is surgically limited to `pcb`/`pcbBonus`/
  `pcbMeta`; tests assert the other fields are untouched.

## 5. Alternatives rejected
Per-person mutable accumulator (drifts); post-hoc CP38 reconciliation report (lower correctness — kept as
the §2C visibility companion); atomic group payroll run (cleanest coordinator but changes the run
lifecycle — deferred to a second slice); collapse to one tenant-wide employment (breaks ADR-0009's
multi-entity premise + case (b)).

## 6. Accountant / tax-agent sign-off worksheet
- [ ] Per-employer MTD with annual reconciliation is the accepted default for concurrent employments.
- [ ] Voluntarily coordinating the combined monthly MTD does not violate any LHDN rule.
- [ ] The pro-rata allocation-back method (and §E rounding on the person total) is acceptable for filing.
- [ ] EPF/SOCSO/EIS correctly remain per-employer (separate accounts/ceilings).
- [ ] CP38 top-up is the right instrument when running `per_employer` with a known combined shortfall.
- Reviewer: __________________  Date: __________  Source MTD spec version: __________

## 7a. Implementation status
- **Slice 1 (done):** scope-out field `person.designated_paymaster_employment_id` (migration 0069, app-validated
  soft reference — no DB FK, to avoid a person↔employment cycle that deadlocks the harness TRUNCATE); the pure
  **`allocatePcb(total, additional, shares)`** helper (golden-tested — slices always sum to the combined total).
- **Slice 2 (next):** `pcb_aggregation_mode` flag (tenant statutory config, default `per_employer`); the gated
  in-kernel coordinator in `generatePayslips` (per-person aggregate → one `pcbMonth` → `allocatePcb` back, only
  `pcb`/`pcbBonus`/`pcbMeta` overridden; tenant-scoped cross-company read gated by `has_role_for`, fail-closed to
  per_employer with an event); the compliance-visibility combined-vs-summed delta; compat + cross-band + fail-closed tests.

## 7. Sources
hasil.gov.my — *Spesifikasi Kaedah Pengiraan Berkomputer PCB 2026/2023*; hasil.gov.my employer
responsibilities; EY MY tax alert (Deduction from Remuneration amendment); CCS operational guidelines on
MTD (Deduction from Remuneration Rules 1994).
