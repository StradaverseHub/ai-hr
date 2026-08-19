# ADR-0024 — Multiple payroll cycles in one month (Option B: `pay_period` parent)

Status: **Accepted — ENABLED (owner-authorised §7 sign-off, 2026-06-20).** `MULTI_CYCLE_PAYROLL_ENABLED` +
`TYPED_PAY_COMPONENTS_ENABLED` set on for the Chin Hin deployment. (2026-06-17)
Consultant item #1 (Wave 2C). Owner decision: Option B (see `docs/wave2-payroll-design.md`).

> **This change does not run for real payroll until a payroll professional signs off the worksheet in
> §7 and the feature flag is switched on.** Until then the system behaves exactly as today: exactly one
> batch per `(company, month)`. The schema and computation are built and tested behind the flag so the
> behaviour can be reviewed before it is ever enabled.

---

## 1. Context

Today AI-HR enforces **exactly one payroll batch per company per calendar month** — a unique index
`payroll_batch_period_uq` on `(company_id, pay_period 'YYYY-MM')` plus an application guard in
`createBatch`. PCB (MTD) accumulators are derived by replaying the tax year's prior payslips with a
**strict** `pay_period < current` filter. The consultant (Yi Wei) asked for **multiple cycles in the
same month** — an off-cycle run, a separate bonus run, or a mid-month adjustment.

This is **not** a matter of dropping the unique index. Three statutory facts make a second same-month
run a correctness problem, each sourced and re-verified (see `docs/wave2-payroll-design.md`):

1. **PCB / MTD is computed once per month.** Per LHDN's *Specification for MTD Calculations Using
   Computerised Calculation for 2026* (hasil.gov.my, updated 01 Jan 2026), all payments in one calendar
   month form **one** monthly tax computation: the month's normal pay is `Y1`; each additional same-month
   payment is **additional remuneration** run through the §D.b.2 Steps 1–5 formula, and the
   already-deducted MTD `X` must include the **earlier same-month runs**. §E#8: if a bonus run is paid
   *before* the salary run, `Y1` still refers to the **full intended monthly normal pay**. The current
   strict `pay_period < current` replay would make run 1 invisible to run 2 and mis-deduct tax.
2. **SOCSO/EIS are a single monthly contribution.** Employees' Social Security Act 1969 (Act 4)
   **s.6(7)** — "A month shall be the unit in respect of which all contributions shall be payable" — and
   **s.6(9)** — "Where two or more contributions are paid … for the same month, they shall be counted as
   a single monthly contribution." The Third Schedule §1A(a) finds the band on **monthly wages = all wage
   periods ending in the month**. So a second run is a **top-up to the monthly band**, never an
   independent re-computation. EIS (Act 800) shares the same monthly unit and RM6,000 ceiling.
3. **EPF** has no monthly ceiling, so percentage EPF is additive per run — but the per-ringgit round-up,
   the employer 13%/12% boundary (fixed by the **normal** monthly wage so a bonus run can't flip it), and
   the RM4,000 annual relief cap must all behave correctly across same-month runs.

## 2. Decision

Adopt **Option B**: a first-class **`pay_period`** entity that owns the calendar month, with one or more
child **runs** (`payroll_batch` rows). The parent is the unit the statutes actually define (Act 4
s.6(7)); the single monthly SOCSO/EIS contribution, the single monthly MTD computation, and the
month-level statutory snapshot live at the parent boundary rather than being inferred from sibling scans.

Computation semantics (ported from Option C's insight): **every run after the first is computed strictly
as additional remuneration, seeded from the same month's earlier runs.**

## 3. Data model

```
pay_period                         (NEW — owns the month)
  id, tenant_id, company_id, period 'YYYY-MM', status, statutory_version (snapshot), created_at
  UNIQUE (company_id, period)

payroll_batch  (= a "run" within a period)
  + pay_period_id  FK → pay_period.id
  + run_seq        int    (1..n, ordering within the month)
  + run_type       enum   ('regular' | 'off_cycle' | 'bonus' | 'adjustment')
  DROP UNIQUE (company_id, pay_period)
  ADD  UNIQUE (pay_period_id, run_seq)
```

`payslip` and `payroll_input` keep `batch_id` (the child run). Monthly aggregation is computed through
the parent. Run-type → statutory treatment: `regular` = normal remuneration (`Y1`); `off_cycle`,
`bonus`, `adjustment` = additional remuneration (Steps 1–5).

## 4. Statutory computation rules (the heart — what the accountant signs off)

For a month with runs `r1 … rk` (ordered by `run_seq`), processed one at a time:

**PCB (MTD).**
- `r1` (regular): normal-remuneration MTD with `Y1` = the full intended monthly normal pay and the
  prior-**month** accumulators (∑(Y−K), K, X, Z) exactly as today.
- `rᵢ` (i>1, additional): the §D.b.2 **Steps 1–5** additional-remuneration formula. `X` (MTD already
  deducted this year) = prior-month MTD **plus the MTD of r1…rᵢ₋₁ in this same month**, so the Step-4
  year-total difference nets against tax already withheld this month. Per §E#8, `Y1` always references
  the full intended monthly normal pay, even when a bonus run precedes the salary run.
- Result: the sum of all runs' MTD for the month equals the single monthly MTD the current
  one-batch-per-month path would compute for the same total remuneration.

**SOCSO / EIS (single monthly contribution).**
- The **regular** run carries the full monthly normal wage (basic + OT), so it carries the month's single
  SOCSO/EIS contribution = `band(monthly wage)`. Every **additional** run (off_cycle/bonus/adjustment) is
  additional remuneration **excluded from the SOCSO/EIS base** (s.2(24) excludes annual bonus; v1 treats
  all non-regular runs as bonus-like), so its incremental SOCSO/EIS = **RM0**. The month is charged
  exactly one band (Act 4 s.6(7)/6(9)).
- Mechanically this falls out of the increment method: re-running the cumulative month and taking the
  delta yields RM0 for a run that adds no SOCSO-wage. The general top-up `band(combined) − already-charged`
  is the same formula; in v1 the additional runs add nothing, so it is always 0 for them.

**EPF.**
- Per-run percentage EPF on each run's EPF-wage (bonus included, OT excluded), employer rate fixed by
  the **normal monthly wage** (a ≤RM5,000 earner stays 13% even if a bonus run pushes the month over).
- **Rounding: round the combined monthly contribution once** (decision D6) — the monthly EPF is
  `round(Σ run EPF-wages × rate)`, not the sum of per-run round-ups, for return consistency.
- The RM4,000 annual EPF relief cap (for PCB) accumulates across same-month runs.

**Month-level statutory snapshot.** All runs in a month share **one** ruleset version (decision D7),
snapshotted on the `pay_period` parent, so a mid-month ruleset/pack change can't make two runs in the
same month use different figures.

## 5. Gating (how it stays off until sign-off)

- A feature flag **`MULTI_CYCLE_PAYROLL_ENABLED`** (env, default **false**).
- The schema (parent + `run_seq` + `run_type`) is created and existing batches are backfilled to
  `run_seq = 1, run_type = 'regular'` with one parent per existing `(company, month)` — a **behaviour-
  preserving** migration (every existing batch is an unchanged single regular run).
- With the flag **off**, `createBatch` still rejects a second run for a month exactly as today. The
  additional-remuneration computation path is dormant.
- With the flag **on** (dev only, post-sign-off), a supplementary run can be created and is computed per
  §4. No customer can produce a same-month second run until the flag is switched on.

## 6. Out of scope for v1 (explicit)

- **Reversals / clawbacks** (negative SOCSO/EIS top-up, voiding a closed run). The single-monthly-
  contribution principle (s.6(9)) doesn't specify the mechanics of a negative delta; v1 clamps to ≥ 0
  and forbids voiding a closed run. A later ADR will handle reversals.
- **Standalone off-cycle with no regular run** (a pure mid-month bonus when no salary run exists yet):
  v1 requires `run_seq = 1` to be `regular`. If a bonus is the first payment, the regular run is created
  first (it may be zero). Revisit if the workflow demands otherwise.
- **Salary installments / arrears-of-wages runs that must enter the SOCSO/EIS monthly base.** v1 treats
  every non-regular run as additional remuneration excluded from SOCSO/EIS (the off-cycle *bonus* case the
  consultant asked for). A run that pays part of the **ordinary wage** (a salary installment, or arrears of
  wages that are SOCSO-liable under s.2(24)) would need to top up the SOCSO/EIS monthly band; that
  classification (wage-component vs additional per run) is deferred to a later ADR.

## 7. Accountant sign-off worksheet (REQUIRED before enabling)

A qualified payroll officer / accountant must validate the following worked example before
`MULTI_CYCLE_PAYROLL_ENABLED` is switched on. The **system figures** column is produced by the golden
test `test/multicycle-compute.test.ts` (run `pnpm test multicycle`); the reviewer fills the **manual
figures** column from their own computation and confirms they match.

**Scenario.** Resident employee, PCB Category 1, no children, **basic RM5,000/month**, no fixed
allowance, no prior-year TP3. Pay month = **May 2026 (month 5)**; assume Jan–Apr were each a single
RM5,000 normal month already processed (so the May prior-month accumulators are four months of normal
pay). Two May runs:

| Run | run_seq | run_type | Payment | Statutory treatment |
|-----|---------|----------|---------|---------------------|
| 1 | 1 | regular | Salary RM5,000 | Normal remuneration (`Y1 = 5,000`), prior-month accumulators |
| 2 | 2 | bonus | Bonus RM10,000 | Additional remuneration (Steps 1–5); `X` includes run 1's May MTD |

**What to verify (tick each):**

System figures below are produced by `test/multicycle-compute.test.ts` (2026.1 ruleset). Re-run
`pnpm test multicycle` after any statutory-table change to refresh them.

| # | Statutory assertion | Authority | Manual figure | System figure | ✓ |
|---|---------------------|-----------|---------------|---------------|---|
| 1 | EPF employee for the month (combined, round-up once) = `ceil((5,000 + 10,000) × 11%)` = **RM1,650** | EPF Act, Third Schedule | | **RM1,650.00** (run1 550.00 + run2 1,100.00) | ☐ |
| 2 | EPF employer fixed at **13%** (normal wage RM5,000 ≤ threshold), not 12% → RM1,950 | KWSP rate table | | **RM1,950.00** (run1 650.00 + run2 1,300.00) | ☐ |
| 3 | **One** SOCSO contribution for May, on RM5,000 (bonus excluded); run 2 adds **RM0** | Act 4 s.6(7)/6(9), s.2(24) | | run1 **RM24.75**, run2 **RM0.00** (employee) | ☐ |
| 4 | **One** EIS contribution for May, on RM5,000; run 2 adds **RM0** | Act 800, Second Schedule | | run1 **RM9.90**, run2 **RM0.00** (employee) | ☐ |
| 5 | Run 1 MTD = normal-remuneration MTD on `Y1 = 5,000` with the Jan–Apr accumulators | LHDN spec §D.1 | | **RM110.00** | ☐ |
| 6 | Run 2 MTD = additional-remuneration (Steps 1–5) with `X` = prior-month MTD **+ run 1 May MTD** | LHDN spec §D.b.2, §E#8 | | **RM950.00** | ☐ |
| 7 | **Sum of run 1 + run 2 MTD** equals the single monthly MTD for RM5,000 normal + RM10,000 bonus computed the one-batch way | LHDN spec (month = one computation) | | **RM1,060.00** = RM110.00 + RM950.00 (== one-batch RM1,060.00) | ☐ |
| 8 | Both runs carry the **same** statutory ruleset version (month-level snapshot) | ADR-0024 §4 | n/a | **yes** (version `2026.1`) | ☐ |

### §7 over REAL history — Payroll ▸ Reports ▸ Multi-Cycle Statutory Worksheet (r209, bdf7d248)

The scenario above cannot distinguish the two readings of the statute, and that is not a small caveat:
`ceil((5,000 + 10,000) × 11%)` and `ceil(5,000 × 11%) + ceil(10,000 × 11%)` are **both RM1,650**, so
assertion #1 has stayed green whichever way the kernel computed. The smallest pair that separates them is
**RM5,001 + RM1,001** — each run alone gives `561 + 113 = 674`, the month as one gives `672` — and
SOCSO/EIS separate at every wage, because the per-run reading charges the band twice.

`/payroll/multi-cycle-worksheet` (read-only; `localization/my/multicycle-worksheet.ts`) therefore runs the
§7 comparison over the customer's OWN payroll history instead of one invented employee. For every
(company, month, employee) with more than one run it reports what was PAID (the figures stored on the
payslips), what each reading gives, the ringgit movement per statutory item, and — deliberately — the
months it refuses to compare: a month containing a reversal or a negative delta is EXCLUDED rather than
clamped (§6 would otherwise understate the difference), and a month whose inputs cannot be reconstructed
is FLAGGED with its reason. It writes nothing.

Measured through that screen on a kernel-produced month, an additional run is **already** computed as the
increment of the cumulative month (`core/payroll.ts` `deltaStat`, seeded by the earlier runs' additional
remuneration) — so the worksheet's verdict for such a month is "already computed as one month" and its
movement is zero. `computeMonthlyRuns` remains unwired; §5's gate is unchanged.

**Sign-off**

**✅ Owner-authorised to enable — 2026-06-20.** Basis: YiWei Law's "Malaysia Payroll Statutory
Requirements" deck (the consultant/accountant source) + the golden test `test/multicycle-kernel.test.ts`,
which verifies assertions #1–7 above against the real kernel (run 1 PCB 110, run 2 950, sum 1,060;
SOCSO/EIS charged once; EPF 1,650 / 1,950). **Still recommended before the first real pay run** (employer
carries the statutory liability): a formal licensed-accountant counter-signature below + a parallel run
reconciled to the current system.

```
Reviewer name:  ____________________________   Role/qualification:  ____________________
Date:  ____________   Result:  ☐ Approved to enable    ☐ Changes required (notes below)
Notes:
```

Until this is signed and `MULTI_CYCLE_PAYROLL_ENABLED=true` is set, multi-cycle stays off.

## 8. Consequences

- **Positive:** the statutory month becomes a first-class entity; CP39/EA/EPF/SOCSO/EIS monthly returns
  roll up by parent period; off-cycle bonus/adjustment runs become possible without breaking MTD or
  double-charging SOCSO/EIS; the design is reviewable and signed off before it can affect real payroll.
- **Cost / risk:** the largest schema change in the codebase (new parent, FK rewire, immutability
  triggers `0011` + RLS `0010`/`0013` re-expressed for two levels, every monthly read path audited). Built
  in gated slices (2C-2 compute core → 2C-3 schema → 2C-4 kernel/read/UI), each tested, behind the flag.
- **Blocked-until:** the §7 sign-off + the KWSP EPF Third Schedule PDF (#95) for exact low-wage banding
  (rounding compounds across runs).
