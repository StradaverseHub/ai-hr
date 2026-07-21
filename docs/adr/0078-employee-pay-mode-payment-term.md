# ADR-0078 — Employee-specific Pay Mode, Payment Term and Rate on the Basic Salary record

Status: accepted (feedback 642ecc55, migration 0290)
Supersedes: the "policy owns pay mode / surface, do not duplicate" decisions of ADR-0064 and R46 79eb7151

## Context

Pay Mode (monthly / daily / hourly / custom_period) lived on `payroll_policy.policy_type` and Payment Term
on `PayrollPolicyConfig.frequency`. Every employee sharing a policy was therefore forced into the same
salary structure: an organisation with monthly, daily-rated and hourly staff had to create a separate
policy per group even when the calculation rules were identical. The R46 79eb7151 decision deliberately
rendered both read-only on the employee's Payroll tab, rejecting per-employee columns because they would
have SHADOWED the policy (two disagreeing sources of truth + a precedence rule in the kernel).

A panel proposal to express pay mode as `employment_pay_component.rule.kind` was checked and rejected: the
`rule` jsonb lives on `pay_component` — the TENANT-WIDE catalog (unique on tenantId+code) — not on the
per-employment row, so `BASIC.rule.kind = per_day` would flip EVERY employee in the tenant to daily.

## Decision

1. **Compensation owns the salary structure.** `compensation` (the effective-dated salary history) gains
   `pay_mode` (reusing the `payroll_policy_type` enum — no second enum), `payment_term` (text validated
   against the `PayrollFrequency` TS union; a parallel pg enum would need a migration per new term) and
   `rate_amount numeric(12,2)` (nullable — NULL is the correct state for a monthly employee). Older salary
   records keep the settings they had at the time; payroll reads the same open row it always read.

2. **`basic_salary` KEEPS its monthly-equivalent semantics; `rate_amount` is a SEPARATE field.** Verified
   consumers that must keep reading a MONTHLY figure: the ORP hourly basis `(basic + allowance) / 26 / 8`
   for percent shift differentials, the statutory OT `monthlyWages` basis, the EA First-Schedule TOIL
   eligibility ceiling, the `basicFallback` payout, the BASIC recurring-component mirror, and the salary
   columns in analytics/reporting. Turning the basic box into a daily rate would have mis-based statutory
   overtime and flipped statutory categories — a wage error, not a display quirk. The admin enters both
   figures; auto-deriving one from the other needs a divisor convention owned by the policy — an explicit
   follow-up, not this item.

3. **Both new columns are BACKFILLED and NOT NULL — no policy fallback.** `payroll_policy` is mutable, so
   a NULL row resolving through the policy would resolve it AS IT IS NOW, not as it was then, breaking
   "historical calculations use the configuration effective at that time". Backfill (0290): `pay_mode`
   from the employment's resolved policy (resolveAssignedPolicy semantics), `payment_term` from the
   COMPANY DEFAULT policy's config frequency (what the engine's `runFrequency` actually read),
   `rate_amount` from the resolved policy's pay-rule rate for daily/hourly types. Day one is therefore
   byte-identical: the daily branch's rate source moves from `policy.payRule.rate` to
   `compensation.rate_amount` holding the same number. There is no "inherit from policy" UI state because
   there is no inherit path.

4. **Pay-mode changes are restricted to a period boundary** (the 1st of a month). The engine reads ONE
   open compensation row for the whole period, and the salary-increment-proration path day-weight-blends
   two straddling rows — a blend across two different pay modes is meaningless. Service-level validation
   (`PayModePeriodBoundaryError`); amount-only changes keep today's mid-period behaviour untouched. An
   in-place pay-mode edit is additionally refused on a row whose window a processed/closed run relied on.

5. **Payment Term is storage, service read and display only.** It does NOT drive run scheduling in this
   change. `runFrequency`/`runSchedule` are batch-level scalars resolved ONCE from the company default and
   then structure the entire run: the per-cycle OT/unpaid-day arrays are indexed by one shared
   `runSchedule.periods`, `paymentSchedule` is stamped on every payslip, and the processed event records
   one cutOffSchedule for the batch. Per-employee frequency means either all of those become per-employee
   (including the payslip snapshot and the audit event) or batches split by frequency — which changes
   payroll_batch identity, `payslip_batch_employment_uq` semantics, the PERIOD_ALREADY_PROCESSED guard and
   rollback/close semantics. That is a run-architecture rework and belongs to its own item. (Noted for
   that item, not fixed here: frequency is read from the company default policy, so an employee assigned
   to a non-default weekly policy is already bucketed on the company default today — 0290 backfills
   `payment_term` from the company default precisely so this change does not silently alter it.)
   Payment Term "Daily" is likewise out of scope (a run per day belongs with the same rework).

6. **Hourly becomes usable; custom_period (Period Rate) is selectable but blocked at pre-run checks.**
   With a per-employee rate, hourly basic pay = rate × attendance hours (the hours machinery already
   existed). custom_period has NO calculation behind it: rather than quietly pay the monthly-equivalent
   basic (or zero), the pre-flight check (`preProcessChecksTx.unpayablePayMode`, counted into
   `PreProcessBlockedError`; surfaced with employee NAMES by the `payModes` readiness check) blocks the
   run before anything is written. Nothing is half-paid and nothing crashes mid-run.

7. **The policy keeps its fields as template defaults.** `policy_type` / config frequency remain on the
   policy screen with a hint that they no longer control an existing employee's pay mode.

## Consequences

- One payroll policy can serve a mixed monthly/daily/hourly workforce; converting an employee is a normal
  dated salary revision on a period boundary.
- Every writer of compensation carries the structure: the Basic Salary form, the salary-record edit flow,
  bulk CSV hire (`pay_mode` / `payment_term` / `rate_amount` columns), single hire, seed and the
  component backfill. Merit enact applies its percentage to `basicSalary` only and CARRIES the structure
  forward — it never silently scales `rate_amount`.
- `rate_amount` is money: masked in the audit UI alongside basicSalary (lib/audit-format.ts).
- Migration equivalence is pinned by test/employee-pay-structure.test.ts: the first payroll after the
  backfill matches the last one before it, for a monthly AND a daily employee.
