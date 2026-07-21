# ADR-0064 — Monthly payroll-policy General Settings (config-at-run-time)

Status: Accepted — PARTIALLY SUPERSEDED by ADR-0078 (642ecc55, migration 0290): ownership of Pay Mode,
Payment Term and the non-monthly rate moved from the policy to the employee's own effective-dated
compensation row. The policy's calculation config (proration, OT caps, leave divisors, cut-offs, rounding)
remains exactly as decided here; only the "policy owns the salary structure" part is reversed.
Date: 2026-06-29
Extends: ADR-0035 (rounding), the 2.1 Payroll Policy slice (migrations 0127/0128, `core/payroll-policy.ts`)

## Context

The 2.1 Payroll Policy slice shipped a named, company-scoped policy record and a per-employment FK
(`employment.payroll_policy_id`) — but the record is an **empty shell**. `generatePayslips`
(`core/payroll.ts`) never reads the assigned policy: an employment with a Monthly policy attached produces a
**byte-identical** payslip to one with nothing attached. The slice's own regression test
(`test/payroll-policy.test.ts`) passes *because* the policy is inert (its comment says so). A payroll manager
can name a policy but cannot make it change any number.

This ADR makes a **Monthly** policy genuinely configurable (the "General Settings" group) and — the
load-bearing new work — has those settings **actually apply at run time** via a new
`resolveAssignedPolicy(tx, employmentId)` call site threaded into each payroll primitive.

Scope for this build: **Phase 0 + Phase 1 only.** Bulk-assign / priority UI (Phase 2) and the four-step
editor UI (Phase 3) are explicit follow-ons. Daily / Hourly / Custom stay disabled (Monthly-only).

## Decision

### 1. Config storage — JSONB on the existing row (no new table)

Add two columns to `payroll_policy` (migration **0130**, additive + backfill-safe):

- `config jsonb` — **nullable. NULL = today's behaviour.** Typed `$type<PayrollPolicyConfig | null>()` in
  `db/schema.ts`. Holds the General-Settings blob only (one concern — NOT a versioned discriminated-union
  framework).
- `priority integer NOT NULL DEFAULT 0` — surfaced + consumed only by Phase 2 (bulk-assign tie-break). Added
  now so no later migration is needed; **the run-time kernel never reads it.**

No RLS change: both columns live on `payroll_policy`, which already has tenant-wide-read / admin-write RLS
(0128). The kernel resolves the policy as **raw tenant-scoped SQL inside the run's `Tx`** under the caller's
session (the existing `resolveAssignedPolicy` already does this).

### 2. `core/payroll-policy-config.ts` — typed config + `cleanX` validation

Follows the existing `validatePayRule` / `company_payroll_config` `cleanDay`/`cleanBasis` pattern (coerce +
clamp, never throw on a stray value — a bad value falls back to the safe default). The General-Settings
fields:

- **Rounding (1a):** `rounding.earnings | rounding.deductions | rounding.netPay` ∈ `none | up | down | nearest`.
  Default `none` on all three ⇒ byte-identical (delegates to the kernel's existing `roundAmount`).
- **Proration (1b):** `proration.divisor` ∈ `calendar_month | custom_days`; `proration.customDays` (int,
  1–31); `proration.includeSaturday | includeSunday | includeHoliday` booleans (the working-day basis).
  Default `calendar_month` reproduces today's EA-1955 s.18A `daysInMonth` denominator exactly.
- **Salary-increment proration (1c):** `salaryIncrementProration` boolean. Default `false` ⇒ the kernel reads
  exactly the single open compensation row as today. When `true`, a two-row straddling lookup
  (superseded-old + open-new) splits the month at the increment date.
- **Negative-net handling (1d):** `negativeNet` ∈ `retain | set_zero`. (`carry_forward` is **rejected/floored
  to `retain`** here — it needs cross-cycle persistence that conflicts with batch immutability and is a gated
  follow-up.) Default `retain` ⇒ today's behaviour (the existing s.24 clamp already keeps net ≥ 0, so
  `retain` is a no-op on the no-clamp path).
- **OT caps (1e):** `overtime.maxHoursPerMonth`, `overtime.maxAmount`, `overtime.eligibleDayTypes`
  (subset of `workday | rest_day | holiday`), `overtime.multiplier` (optional). **Configured multipliers are
  floored at the EA s.60A statutory minimum** (`max(EA-floor, policy)` — same pattern leave uses). The
  rest-day half-day threshold and the ORP/26 divisor stay statutory, NOT user-configurable. Defaults (all
  unset) ⇒ no cap, all day types eligible, statutory multipliers ⇒ byte-identical.
- **Leave divisors (1f):** `leave.unpaidLeaveDivisor`, `leave.unpaidTimeOffDivisor`,
  `leave.encashmentDivisor` ∈ `calendar_month | custom_days | cutoff_days | working_days | custom_hours |
  custom_minutes` (+ the custom value). Default `calendar_month` reproduces today's `basicRaw / dim` ORP
  deduction exactly.

Every field has a safe default such that **an all-default (or `null`) config reproduces today's numbers.**

### 3. Run-time application — the new `resolveAssignedPolicy` call site

Inside `generatePayslips`, within the per-employee loop, call `resolveAssignedPolicy(tx, employmentId)` and
thread the resolved `config` into each primitive. This is a **derived read on every compute** — it must
**NOT append a DomainEvent** (per the substrate's "no event for derived caches / recomputation" rule; an
event here would spam the log on every payroll run). Default/null config ⇒ the existing code path is
unchanged (proven by the default-equals-legacy golden matrix).

### 4. OT floor-vs-policy ruling

A configured OT multiplier is **floored**, never trusted blindly: `effectiveMultiplier = max(EA-s.60A-floor,
configuredMultiplier)`. A sub-statutory multiplier is silently raised to the floor (it can never under-pay).
`maxHoursPerMonth` / `maxAmount` cap the *total*; `eligibleDayTypes` filters which classified days qualify.
The cap wrapper runs **post-hoc** around the existing `overtimePay` engine (the engine's per-day rates stay
hardcoded per s.60A) — the configured caps shape the prefilled OT figure, the statutory engine is untouched.

### 5. Deliberately deferred (separate specs)

- **Phase 2 bulk-assign + priority** — the single FK already guarantees one-policy-per-employee; no condition
  table. `priority` column added now, consumed later.
- **Phase 3 four-step editor UI** — General Settings here are exercised via tests, not a new screen.
- **ESS payslip acknowledgement enforcement**, **cut-off promotion (metadata → period-driving)**, and
  **negative-net `carry_forward`** — each a separate spec with its own correctness/compliance risk.

Statutory months stay calendar-bound: the PCB accumulator replay, statutory-ruleset `asOf`, and CP38/HRDF
period bounds are all derived from the calendar month, never from the policy config.
