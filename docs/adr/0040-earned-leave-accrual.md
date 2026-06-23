# ADR-0040 — Earned leave accrual (Leave 2.0 · 2D)

Status: Accepted · 2026-06-23 · Sub-ADR of [ADR-0038](0038-leave-2.0.md) §2D · phased

## Context

Leave is granted today as a **lump sum** at the start of the leave year: `openLeaveYear` writes one
accrual ledger entry per employee/type on 1 Jan for `max(EA-floor, policy.annualDays)`. The consultant
(#18) wants **earned accrual** too — the entitlement accruing through the year (monthly/quarterly),
pro-rated for mid-year joiners — and a configurable **leave cycle** (calendar vs join-date anniversary).

## Decision

The accrual *method* lives in the existing `leave_policy.accrual` JSONB (an extension point — no
migration): `{ annualDays, carryForwardMax, method?: 'lump_sum' | 'earned_monthly' | 'earned_quarterly' }`.
Default / absent = `lump_sum` (today's behavior, untouched).

- **lump_sum** — `openLeaveYear` grants the full year's entitlement on the cycle start, as now.
- **earned_monthly / earned_quarterly** — `openLeaveYear` SKIPS these (no lump grant); instead a new
  idempotent `accrueEarnedLeave(ctx, { asOf })` grants the **earned-to-date** amount: it tops the
  ledger up to `entitlement × (periods_elapsed / periods_in_cycle)`, where `entitlement = max(EA-floor,
  policy.annualDays)`. Re-running with the same `asOf` grants nothing (it only writes the shortfall);
  periods are counted from the later of the cycle start and the employee's join month, so joiners are
  pro-rated automatically. Triggered by an admin action now; a monthly cron in 2D-2.

### The floor invariant (ADR-0038 §5, NON-NEGOTIABLE)

The per-period grant is `entitlement / periods`, so over a full cycle a full-year employee earns exactly
`entitlement = max(EA-floor, policy.annualDays) ≥ floor`. Earned accrual therefore reaches the statutory
floor by year-end **by construction**. For a mid-year joiner the earned total is pro-rated — which
matches the EA's own pro-ration of a partial year, so the floor is still met for the period worked. A
test pins this: full-cycle earned total == `entitlement` and `entitlement ≥ floor`.

## Phasing

- **2D-1 (this slice):** the method config + `accrueEarnedLeave` + `openLeaveYear` skip-earned + the
  admin method selector + a "run accrual" admin action, on a **calendar** cycle (1 Jan – 31 Dec). Demo
  seeds one type as earned so partial balances are visible. Gated by the per-policy method, so every
  existing lump-sum company is unaffected.
- **2D-2 (follow-up):** the **join-date anniversary** cycle option, and a monthly cron that runs
  `accrueEarnedLeave` unattended (reusing the same idempotent service the admin action calls).

## Consequences

- Earned employees show a *growing* balance through the year instead of a full balance on day one —
  the behavior the consultant asked for. Lump-sum stays the default, so nothing regresses.
- The ledger remains the single source of truth; `accrueEarnedLeave` only ever appends the shortfall,
  so it is safe to run any number of times (cron, admin button, or after a policy change).
