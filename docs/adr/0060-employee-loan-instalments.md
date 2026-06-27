# ADR-0060 — Employee loan instalments (1.2.8)

**Status:** Accepted
**Date:** 2026-06-27
**Supersedes:** —
**Related:** ADR-0021 (claims, the prefill→pay precedent), ADR-0024 (multi-cycle / regular-run gating), ADR-0030 (PDPA Layer-0 — no cleartext amounts in events), 9-3 / #148 (byte-identical-compat discipline).

## Context

HR administers staff loans (advances, personal, housing) that are recovered by a fixed monthly deduction from net pay over an agreed duration. The feature needs: total loan amount, optional interest, repayment duration (months), start date; an auto-calculated monthly instalment; auto-application of the instalment each payroll cycle; outstanding-balance tracking; a persisted repayment schedule; auto-stop when fully repaid; and an amend / suspend / resume / settle / cancel lifecycle.

## Decision

### Interest convention (the money formula — sourced)

`interestRate` is an **annual flat percentage**. Flat interest is charged on the **original principal** for the full term:

```
totalInterest  = principal × (annualRate / 100) × (durationMonths / 12)
totalRepayable = principal + totalInterest
instalment     = round(totalRepayable / durationMonths)     (working in integer cents)
```

This is the **flat-rate (add-on) method on the original principal**, the convention used for employer staff loans and hire-purchase add-on financing in Malaysia. Source: Bank Negara Malaysia, *Guidelines on the Imposition of Fees and Charges on Financial Products and Services* and the long-standing MY hire-purchase "flat rate" add-on convention (Hire-Purchase Act 1967, term-charges computed on the original cash price), under which add-on interest = principal × annual flat rate × years. The alternative "reducing-balance / effective-rate" amortisation is **explicitly out of scope** for v1 (see below). `interestMethod = 'none'` (no interest; `instalment = principal / durationMonths`) is always available and is the default for an interest-free advance.

We persist `monthlyInstalment` and `totalRepayable` on the loan row (audit) and materialise the full per-month `loan_repayment` schedule at creation. Working in **integer cents** with the existing `round2`/`round2Cents` helpers (no loan-local rounding helper). The schedule reconciles byte-exact: `durationMonths − 1` equal instalments plus a final instalment of `totalRepayableCents − instalment × (durationMonths − 1)`, so the schedule **sums to `totalRepayable` exactly**.

### Two-phase reserve → apply ledger (the most important correctness rule)

Recovery mirrors the claims payout **two-phase** model, NOT a one-phase prefill-time mutation. Verified in `core/payroll.ts` and `core/claims.ts`:

- `prefillClaimsForBatch` only **RESERVES** (sums into `payroll_input`, stamps a reservation), and the **irreversible** state change happens later, inside `generatePayslips`, after the payslip row is written. There is no discard/reopen/reverse path in `core/` — a draft batch can simply be abandoned.

Therefore loans are two-phase:

- **`prefillLoansForBatch` = reserve only.** Writes `payroll_input.loan_deduction` and stamps the next `scheduled` `loan_repayment` row as `reserved` with `reserved_batch_id`. It does **NOT** touch `outstanding_balance` / `instalments_paid` / loan `status`.
- **`applyLoansForBatch` advances the ledger ONLY inside `generatePayslips`,** in a block beside the existing claim-paid block, after the payslip insert loop: for each repayment reserved to this batch, set `status='applied'`, set `applied_amount` / `applied_batch_id` / `applied_at`, decrement `outstanding_balance`, increment `instalments_paid`, and auto-`settle` the loan when fully repaid. Every irreversible mutation is thus tied to a finalised payslip; abandoning a draft after prefill leaves the ledger untouched.

`outstanding_balance` stays the authoritative mutable field (matching how the repo persists `instalments_paid`-style counters). Because the only mutation site is inside `generatePayslips` — the same transaction as the repayment-ledger write — the counter and the ledger advance atomically, so the persisted balance cannot drift from the ledger. Persisting it keeps list queries cheap (no per-row `sum(applied_amount)`).

### Post-tax placement (no statutory-base impact)

A loan instalment is a **post-tax** net-pay deduction. It must NOT touch any statutory base (EPF/SOCSO/EIS/PCB/HRDF). The correct structural analogues are the existing post-tax input columns `tp1_deduction` / `zakat` — subtracted after statutory — NOT the claim-allowance path (which folds into the taxable base). We reuse only the **un-gated `payroll_input` column + reservation mechanism**, not the taxable wiring. A new `payroll_input.loan_deduction` column is read **unconditionally** (not behind `TYPED_PAY_COMPONENTS_ENABLED`, which zeroes typed deductions when off), so the instalment is always recovered. The zero-loans path is **byte-identical** to pre-loan code (proven by a captured golden, per the #148 / 9-3 precedent).

### One terminal repaid status

`loan_status = ('active','suspended','settled','cancelled')`. **One** terminal repaid state: `'settled'` covers both manual early payoff and auto-stop-at-full-repayment (`outstanding_balance` + `instalments_paid` distinguish the two paths). A second near-synonym (`completed`) would burden every status badge, the ×6 i18n status-label set, and every test assertion for no information gain. `'cancelled'` = voided before any instalment was applied.

### Negative-net guard

Statutory deductions have priority over voluntary loan recovery. `prefillLoansForBatch` clamps the reserved deduction so it cannot exceed the employee's estimated net-before-loan for the cycle; if the full instalment can't be taken it reserves `min(instalment, availableNet)` and leaves the residual on the schedule (a partial `applied_amount < due_amount` is representable). Loans never drive net pay negative (`net = grossPay − totalDeductions` has no floor in `core/payroll.ts`).

### Suspend-skew rule

A suspended loan is simply excluded from `prefillLoansForBatch` — no instalment is reserved/applied while suspended. `sequenceNo`/calendar drift is irrelevant because auto-stop keys off `instalments_paid >= durationMonths` (count) **and** `outstanding_balance <= 0` (amount), whichever fires first, and the last-instalment reconciliation guarantees the **sum** is exact regardless of calendar gaps. A sub-cent residual on the final apply is swept to 0 by the `outstanding_balance <= 0` branch.

### Authorization

All loan **writes** are **admin-only**, asserted in the service layer. RLS does NOT enforce admin-only writes (intentional, matching claims): `can_see_employment(employment_id)` is true for the subject employee, so RLS `WITH CHECK` would permit a subject to write their own loan rows. The service-layer admin assertion is the only write guard. Consequence: **the ESS (`/me`) path must never import or call any loan write service** — ESS gets read helpers only.

### PDPA Layer-0 (ADR-0030)

Loan events reference the aggregate id only; **no cleartext amounts in event payloads**. Amounts live on the `employee_loan` / `loan_repayment` rows.

### Leaver handling

A terminated employee with an outstanding loan is excluded from future prefill by the active-employee filter. The loan stays `active` with a non-zero `outstanding_balance`. This is surfaced as an advisory only (consistent with #101's no-auto-pay posture for leavers); we do **not** auto-settle or auto-deduct on termination.

## Out of scope (flagged, not built)

- Reducing-balance / amortised (effective-rate) interest — flat + none only.
- Loan approval workflow / employee self-application (HR-maintained; ESS read-only).
- CSV bulk import of loans.
- Off-cycle / additional-run loan deduction (prefill rejects non-regular batches; the slip also zeroes via `isAdditionalRun`).
- Auto-settle / auto-recover on termination (advisory only).

## Consequences

- A net-pay-affecting calculation now ships with a cited source (above), satisfying the `STATUTORY-SOURCES.md` discipline.
- The `payroll_input` input query and the `otherDeductions`/`totalDeductions` sums gain one term for ALL batches — guarded by the zero-loans byte-identical golden test.
- `loan_repayment` is retained (not derived-on-read) as the idempotency anchor (a partial-unique index on `reserved` guarantees ≤1 reserved instalment per loan) and the only clean representation of partial/skipped per-cycle history produced by the negative-net clamp and suspend.
