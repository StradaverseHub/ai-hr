# Wave 2 — payroll flexibility: design brief & decision register

Covers consultant items **#7 HRDF levy**, **#2 EPF contribution modes**, **#1 multiple payroll cycles per month**.
Statutory facts below were sourced from official `.gov.my` pages and independently re-verified (each figure
re-fetched from its cited URL). Vendor blogs and accounting-firm summaries were rejected as sources. Anything
unverifiable is flagged, not guessed. As-of date: **2026-06-17**.

Status: **owner decisions recorded (2026-06-17) — building 2A HRDF.** Build order: **2A HRDF → 2B EPF modes
→ 2C multi-cycle**. Period model: **Option B (first-class `pay_period` parent)**. EPF scope: **statutory-aligned only**.

---

## #7 — HRDF (HRD Corp) levy  ·  *fully sourced, lowest risk, ready to build*

| Fact | Value | Official source |
|------|-------|-----------------|
| Mandatory levy rate | **1%** of monthly wages (employers with **10+ Malaysian employees**) — PSMB Act 2001 s.14 | hrdcorp.gov.my/registered-employers · supportcentre.hrdcorp.gov.my/portal/en/kb/articles/hrd-levy |
| Optional levy rate | **0.5%** of monthly wages (employers with **5–9 Malaysian employees** who opt in) — PSMB Act 2001 s.15 | same |
| Eligibility | Mandatory ≥10 Malaysian employees; optional 5–9; **not covered below 5**. Headcount counts **Malaysian** employees only and fixes the rate. | hrdcorp.gov.my/registered-employers |
| Industry coverage | **All industries** since **1 March 2021** (First Schedule expanded). Treat coverage as universal; gate only by headcount band. | hrdcorp.gov.my/expansion-of-psmb-act-2001 |
| **Wage base** | **Basic salary + fixed allowances only** (incl. leave pay, arrears). **Excludes** bonus, commission, gratuity, overtime, travel/transport & non-fixed allowances. Formula: `LEVY = [(BASIC − UNPAID LEAVE) + FIXED ALLOWANCE] × rate`. **NOT the EPF wage base** — model a distinct HRDF base. | supportcentre.hrdcorp.gov.my/portal/en/kb/articles/hrd-levy |
| Who pays | **Employer only** — deducting from employee wages is prohibited. **No wage cap.** | hrdcorp.gov.my/faq |
| Cadence | **Monthly**, due by the **15th of the following month**. Late: 10%/yr interest (min RM5); penalty up to RM20,000 / 2 yrs. | hrdcorp.gov.my/faq |

**Key implementation consequences**
- The rate is an **employer-level** attribute (per company, set at registration by headcount band), **not** per-employee.
- The HRDF wage base ≠ EPF wage base. Do **not** reuse the EPF `wages` field. Sum **basic + fixed allowances** only.
- Employer-only line; never appears as an employee deduction on the payslip.

**Open (non-blocking):** the exact First Schedule sub-sector enumeration lives in gazetted PDFs, not the HTML.
For a 17-employee services firm, "all industries, gated by headcount" is the correct operational model.

**Landing points** (from the architecture map):
- `payroll_input` is per-employee/per-batch; but HRDF base is `basic + fixed allowance`, which the kernel already
  knows per employee — compute it in the payslip loop, no new input row needed.
- New employer-side line on `payslip.statutory` (e.g. `hrdf`) + a batch total in `payroll_batch.totals`.
- Company-level config: `hrdfRegistered: boolean` + `hrdfRate: 0.01 | 0.005` (or derive the rate from a stored
  registration band). Belongs with the company/statutory-identity config, not the ruleset (it's employer-specific,
  not a national figure).

---

## #2 — EPF contribution modes  ·  *mostly sourced; the consultant's mode list must be reconciled with statute*

The official above-statutory mechanism is **i-Topup** (formerly "Voluntary Excess"), elected via **Form KWSP
17A/18A (AHL)** for the employee share (employer share needs no form — done in i-Akaun). Verified from
kwsp.gov.my (captured via byte-faithful Wayback raw snapshots; the live site returns 403 to non-browser clients).

**Decisive statutory facts**
1. **i-Topup is a RATE election, not a fixed RM amount.** Every official worked example is "contribute X% more".
   There is **no** official mechanism to elect a flat RM/month figure for either side.
2. **Statutory floor (EPF Act 1991 s.43(1), s.43(1A)):** mandatory employees cannot contribute **below** the
   Third Schedule rate. i-Topup is strictly **additive above** statutory.
3. **Rounding:** total contribution (including the voluntary excess) is **rounded UP to the next ringgit**.
4. **Legitimately reduced/zero EPF is by rule, not election:** e.g. 60+ employees (employee 0% / employer 4% —
   illustrative on the i-Topup page; authoritative per-band rates still gated on the Third Schedule PDF, task #95);
   non-Malaysian citizens are **mandatory 2%/2%** from the Oct-2025 wage and may elect up to 11%/i-Topup.
5. The "**RM5 flat employer**" figure seen in vendor summaries is **UNVERIFIED / superseded** by the 2%/2% regime.
   Do **not** encode it.

**Reconciling the consultant's 5 requested modes against statute**

| Consultant mode | Statutory basis | How we model it |
|-----------------|-----------------|-----------------|
| **Auto** | Third Schedule statutory rate | default; unchanged |
| **Manual-%** | ✅ i-Topup rate election (KWSP 17A/18A) — **at or above** statutory | per-employment elected rate ≥ statutory; round-up preserved |
| **Semi-auto** | ✅ same i-Topup mechanism (e.g. employer tops up, employee statutory) | per-side elected rate |
| **Manual-fixed-amount** | ❌ **no statutory basis** as a KWSP election | only as a clearly-labelled **non-statutory convenience**, still ≥ statutory floor, or omit |
| **No-contribution** | ⚠️ valid **only** for legitimately exempt categories (not a way to drop a mandatory employee below statutory) | gate to exempt categories; never zero a mandatory employee |

**Push-back for the owner:** the consultant's "Manual-fixed-amount" and a free "No-contribution" mode do not map
to KWSP elections. Exposing them as-is would let an admin produce a non-compliant payslip. The statutory-aligned
design is: **Auto** + **above-statutory rate election** (covers Manual-% and Semi-auto) + **exempt-category zero**,
with any fixed-amount option (if wanted at all) clearly marked non-statutory and floored at statutory.

**Landing points:** add `epfMode` + `epfElectedValue` to `payroll_input` (per employment/batch); the kernel's
`epf()` reads them and applies the elected rate above statutory; snapshot mode+value onto `payslip.statutory`.

---

## #1 — Multiple payroll cycles per month  ·  *the architectural one; needs the period-model decision + sign-off*

**Current model.** Exactly one batch per `(company, 'YYYY-MM')` — unique index `payroll_batch_period_uq`
(`db/schema.ts:667`) + an app guard (`core/payroll.ts:97-102`). PCB/MTD accumulators are **derived by replaying
the tax year's prior payslips** with a **strict** `pay_period < current` filter (`core/payroll.ts:454-461`).
**This strict filter is why a second same-month batch can't just be unblocked** — the first run would be invisible
to the replay and PCB would be wrong.

**Statutory constraints (verified):**
- **PCB (LHDN 2026 computerised spec, hasil.gov.my):** all payments in one calendar month are **one** MTD
  computation. The month's normal pay is `Y1`; each extra same-month payment is **additional remuneration**
  (Steps 1–5), and `X` (MTD already deducted) must include **earlier same-month runs**. §E#8: if a bonus run is
  paid before salary, `Y1` still references the full intended monthly normal pay.
- **SOCSO/EIS (Act 4 s.6(7), s.6(9); Act 800):** the **month is the unit**; two contributions in the same month
  are counted as a **single** monthly contribution. The band/ceiling (RM6,000, eff. 1 Oct 2024) is found on the
  **aggregate** of the month's wage periods. A second run is a **top-up to the monthly band**, not an independent
  re-computation. Independent per-run SOCSO would over-contribute.
- **EPF:** no monthly ceiling, so percentage EPF is additive per run — but (a) decide round-per-run vs
  round-combined (can differ ~RM1), (b) freeze the employer 13%/12% boundary by the **normal** monthly wage so a
  bonus run can't flip it, (c) keep the RM4,000 annual relief cap accumulating across same-month runs.

**Period-model options**

- **Option A — `run_seq` + `run_type` on the shared `'YYYY-MM'`** *(recommended)*. Two columns on `payroll_batch`;
  swap the unique index to `(company, pay_period, run_seq)`. `'YYYY-MM'` stays the logical month, so CP39/EA/EPF/
  SOCSO/EIS monthly returns roll up by `GROUP BY pay_period`. Smallest correct delta for a 17-employee product.
  Must rework the replay filter and add a monthly SOCSO/EIS top-up step.
- **Option B — first-class `pay_period` parent with child runs.** Cleanest domain model (the parent is the unit the
  statute defines), but a new table, FK rewires, and re-expressing the immutability triggers + RLS — over-built for
  occasional off-cycle runs. Defer to Wave 3 if multi-run volume grows.
- **Option C — supplementary run linked to a closed primary batch.** Lowest blast radius on existing flows, but an
  asymmetric two-code-path model that's awkward for a standalone bonus with no regular run, and converges back to A
  if 3+ runs are needed.

**Recommendation:** Option A, adopting Option C's computation semantics. **OWNER DECISION (2026-06-17): Option B**
— a first-class `pay_period` parent entity owning the month, with child runs. The owner chose the cleaner long-term
domain model over the smaller-delta A. Computation semantics still apply: every run after the first is computed
strictly as additional remuneration, seeded from the same month's earlier runs; the parent is the home for the
single monthly SOCSO/EIS contribution, the single monthly MTD computation, and the month-level statutory snapshot.
Build the parent table + FK rewire + re-express immutability triggers (migration 0011) and RLS for the two-level
model. Gate behind golden tests and **accountant sign-off** of a worked two-run example before enabling real payroll.

---

## Decision register (owner forks — do not auto-decide)

| # | Decision | Recommendation |
|---|----------|----------------|
| D1 | **Wave 2 build order / scope** | ✅ **CHOSEN: 2A HRDF → 2B EPF modes → 2C multi-cycle.** HRDF builds now. |
| D2 | **#1 period model** | ✅ **CHOSEN: Option B (first-class `pay_period` parent)** with additional-remuneration computation semantics. |
| D3 | **#2 EPF mode scope** | ✅ **CHOSEN: statutory-aligned only** — Auto + above-statutory rate election (covers Manual-% / Semi-auto) + exempt-category zero. No fixed-RM election. |
| D4 | Run-type taxonomy (2C) | `{regular, off_cycle, bonus, adjustment}` — regular = normal/Y1; the rest = additional remuneration. |
| D5 | SOCSO/EIS top-up clamp (2C) | Recompute full monthly band at the last run; clamp per-run contribution ≥ 0. **Needs accountant sign-off.** |
| D6 | EPF rounding across runs (2C) | Default round-combined (single monthly rounding) for return consistency; confirm with accountant. |
| D7 | Statutory snapshot scope (2C) | Month-level consistency: all runs in a month share one ruleset version. |
| D8 | Voids/reversals (2C) | Decide whether a month closes at run level or at an explicit month-close; interacts with immutability triggers (migration 0011). |

**Blockers carried:** EPF Third Schedule exact RM20-band figures remain unverified (KWSP PDF returns 403 — task #95);
matters for 2C because rounding compounds across runs. Professional payroll sign-off required before 2C goes live.

**Sources:** HRD Corp (hrdcorp.gov.my, supportcentre.hrdcorp.gov.my, PSMB Act 2001); KWSP (kwsp.gov.my i-Topup &
non-Malaysian pages); LHDN MTD 2026 computerised spec (hasil.gov.my); PERKESO Act 4 / Act 800 (perkeso.gov.my).
