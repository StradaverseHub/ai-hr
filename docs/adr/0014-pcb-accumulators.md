# ADR-0014 — PCB accumulators: derived from payslip history, seeded by TP3 opening balances

Status: **Accepted** (implemented) · Date: 2026-06-11

## Context

PCB/MTD originally used the steady-state model (annual tax ÷ 12) — correct only for constant
income with no year-to-date history, and disclosed as a simplification on every batch page. The
official LHDN computerised method is accumulative: each month's MTD depends on the year's
accumulated net remuneration ∑(Y−K), EPF claimed toward the RM4,000 relief cap (K), and MTD
already paid (X), spread over the remaining months (n+1). Implementing it raises one architectural
question: **where does the accumulator state live?**

## Decision

1. **No mutable accumulator table.** The accumulators are **derived by replaying the tax year's
   prior payslips** (per employment, in pay-period order, applying the cumulative EPF relief cap)
   inside `generatePayslips`. The payslip history *is* the ledger — consistent with the
   event-sourced posture (ADR-0006): no second copy of state to drift, and a re-run derives the
   same figures.
2. **TP3 / opening balances seed the replay.** Per the spec (§E.10), a mid-year joiner's
   previous-employment figures (Form TP3) enter the formula as (Y−K), X, Z — and never appear on
   payslips or the EA. Four nullable fields on `employee_statutory_my` (`tp3_year`,
   `tp3_net_remuneration`, `tp3_epf_claimed`, `tp3_pcb_paid`, + zakat), applied **only when
   `tp3_year` matches the pay-period year**. The same fields solve **mid-year system adoption**
   (months run on a previous payroll system before migrating here).
3. **Every payslip stamps its `pcbMeta` snapshot** (∑(Y−K), K, X, n, P₁/P₂) into the statutory
   jsonb — any historical PCB figure is explainable from the row alone.
4. **Scope: per employment, not per person.** An employee concurrently employed across group
   companies (ADR-0009) accumulates separately per employment. Cross-employer PCB correctness is
   the gap ADR-0010 already flags; this ADR records that the accumulators inherit it.

The calculator (`pcbMonth`, MY pack) implements the spec verbatim — including the K₂ projection
(`min((cap − K − K₁ [− Kₜ])/n, K₁)`, truncated), additional-remuneration Steps 1–5, and the §E
rounding rules (truncate 2 dp; round MTD up to 5 sen; RM10 floor) — and is golden-tested against
the spec's Exhibit 5 worked example to the sen (Jan/Feb RM110.00, Mar RM108.20, Apr RM833.70).

## Consequences

- A first-ever batch in month *m* now means "income starts in month *m*" — correct per the spec,
  but different from the old steady-state for late-year first runs. Real onboarding mid-year must
  enter TP3/opening balances, or early-month PCB will be understated; the readable TP3 section on
  the statutory card is therefore part of payroll correctness, not an optional nicety.
- Deleting/regenerating a historical batch changes later months' derived accumulators — already
  prevented by closed-batch immutability; draft re-runs of the *current* month are safe (prior
  months only are replayed).
- TP1 optional deductions (LP₁) and zakat are captured per employee per batch (payroll inputs),
  offset per spec §E.5, stamped on each payslip, and replayed into ∑LP / Z (STATUTORY-SOURCES §1).

## Alternatives rejected

- **A mutable per-employee accumulator table** updated on each run: a second source of truth that
  drifts on regenerate/amend and needs its own repair tooling. Rejected.
- **Steady-state retained with a "variable pay" warning**: leaves bonuses, raises and mid-year
  joiners mis-deducted against the law we claim to implement. Rejected.
